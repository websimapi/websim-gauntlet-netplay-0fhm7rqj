// Use EmulatorJS's default N64 core. Mupen64Plus-Next uses the GLideN64
// renderer and is the better general-compatibility path for this game.
const EMULATOR_CORE = "mupen64plus_next";
// Keep WebSocket payloads comfortably below browser/proxy message-size
// boundaries. 16,000 packed bytes become at most ~21,334 base64url chars.
const STATE_CHUNK_BYTES = 16000;

const state = {
  user: null,
  selectedVisibility: "public",
  rom: null,
  romMeta: null,
  romUrl: null,
  romLaunchBlob: null,
  patchManifest: null,
  room: null,
  lobby: null,
  self: null,
  players: [],
  logs: [],
  input: { up: false, down: false, left: false, right: false, dUp: false, dDown: false, dLeft: false, dRight: false, a: false, b: false, z: false, start: false, l: false, r: false, cUp: false, cDown: false, cLeft: false, cRight: false },
  seq: 0,
  lastSentInput: "",
  lastLoggedInput: "",
  lastAck: null,
  emulatorStarted: false,
  emulatorReady: false,
  emulatorScript: null,
  incomingStateSync: null,
  pendingHostState: null,
  stateSyncInFlight: false,
  lastPlayerCount: 0,
  hostCheckpointTimer: null,
  hostCheckpointPending: null,
  hostStateRetryCount: 0,
  hostAwaitingPeerSync: false,
  hostBarrierPaused: false,
  hostReadySignalSent: false,
  hostSyncBarrierId: null,
  hostSyncTargetVersion: 0,
  peerSyncHold: false,
  peerSyncPaused: false,
  peerSyncBarrierId: null,
  peerSyncTargetVersion: 0,
  lastResyncRequestAt: 0,
  lastAppliedStateVersion: 0,
};

const $ = (id) => document.getElementById(id);
const logOutput = $("logOutput");

function nowStamp() {
  return new Date().toISOString().slice(11, 23);
}

function log(event, detail = {}, level = "INFO") {
  const line = `[${nowStamp()}] ${level.padEnd(5)} ${event} ${Object.keys(detail).length ? JSON.stringify(detail) : ""}`.trimEnd();
  state.logs.push(line);
  if (state.logs.length > 250) state.logs.shift();
  logOutput.textContent = state.logs.join("\n");
  logOutput.scrollTop = logOutput.scrollHeight;
  $("logCount").textContent = `${state.logs.length} EVENTS`;
}

function toast(message) {
  const node = $("toast");
  node.textContent = message;
  node.classList.add("show");
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => node.classList.remove("show"), 2300);
}

async function copyText(value, success = "Copied to clipboard") {
  try { await navigator.clipboard.writeText(value); toast(success); log("clipboard_copy", { characters: value.length }); }
  catch (error) { log("clipboard_error", { message: error.message }, "WARN"); toast("Clipboard permission unavailable"); }
}

function setConnection(status, label) {
  const node = $("connectionState");
  node.className = `connection-state ${status}`;
  node.innerHTML = `<i></i> ${label}`;
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function readAscii(bytes, start, length) {
  return [...bytes.slice(start, start + length)].map((value) => value >= 32 && value <= 126 ? String.fromCharCode(value) : " ").join("").replace(/\s+/g, " ").trim();
}

async function sha256Hex(value) {
  const data = value instanceof ArrayBuffer ? value : value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hashBuffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function extractZipRom(file) {
  const header = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
  const findSignature = (bytes, signature, fromEnd = false) => {
    const start = fromEnd ? bytes.length - 4 : 0;
    for (let index = start; fromEnd ? index >= 0 : index < bytes.length - 4; index += fromEnd ? -1 : 1) {
      if (bytes[index] === signature[0] && bytes[index + 1] === signature[1] && bytes[index + 2] === signature[2] && bytes[index + 3] === signature[3]) return index;
    }
    return -1;
  };
  let localOffset = findSignature(header, [0x50, 0x4b, 0x03, 0x04]);
  if (localOffset < 0) throw new Error("ZIP has no readable local file entry");
  const local = new DataView(header.buffer, localOffset);
  let compression = local.getUint16(8, true);
  let compressedSize = local.getUint32(18, true);
  const fileNameLength = local.getUint16(26, true);
  const extraLength = local.getUint16(28, true);
  let dataOffset = localOffset + 30 + fileNameLength + extraLength;
  if (!compressedSize) {
    const tailStart = Math.max(0, file.size - 131072);
    const tail = new Uint8Array(await file.slice(tailStart).arrayBuffer());
    const centralOffset = findSignature(tail, [0x50, 0x4b, 0x01, 0x02], true);
    if (centralOffset >= 0) {
      const central = new DataView(tail.buffer, centralOffset);
      compression = central.getUint16(10, true);
      compressedSize = central.getUint32(20, true);
      localOffset = central.getUint32(42, true);
      const localHeader = new DataView(header.buffer, localOffset);
      const localNameLength = localHeader.getUint16(26, true);
      const localExtraLength = localHeader.getUint16(28, true);
      dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    }
  }
  if (!compressedSize || dataOffset + compressedSize > file.size) throw new Error("ZIP entry is incomplete or uses an unsupported layout");
  const compressed = await file.slice(dataOffset, dataOffset + compressedSize).arrayBuffer();
  if (compression === 0) return new Uint8Array(compressed);
  if (compression !== 8 || typeof DecompressionStream === "undefined") throw new Error("ZIP compression is not browser-decompressible");
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function hexBytes(value) {
  const normalized = String(value || "").replace(/[^0-9a-f]/gi, "");
  if (normalized.length % 2) throw new Error("Patch hex must contain whole bytes");
  return new Uint8Array(normalized.match(/.{2}/g)?.map((pair) => parseInt(pair, 16)) || []);
}

function applyPatchManifest(bytes, manifest, rawHash) {
  const profile = manifest?.id || "gl-n64-websim-bridge-0.1";
  if (manifest?.romSha256 && manifest.romSha256.toLowerCase() !== rawHash) return { bytes, profile, status: "HASH NOT TARGETED", applied: 0 };
  const patches = Array.isArray(manifest?.patches) ? manifest.patches : [];
  const patched = new Uint8Array(bytes);
  let applied = 0;
  for (const patch of patches) {
    const offset = Number(patch.offset);
    const expected = hexBytes(patch.expectHex);
    const replacement = hexBytes(patch.replaceHex);
    if (!Number.isSafeInteger(offset) || offset < 0 || expected.length === 0 || expected.length !== replacement.length || offset + expected.length > patched.length) return { bytes, profile, status: "PATCH REJECTED", applied: 0, error: `Invalid patch: ${patch.label || "unnamed"}` };
    for (let index = 0; index < expected.length; index += 1) if (patched[offset + index] !== expected[index]) return { bytes, profile, status: "PATCH REJECTED", applied: 0, error: `Signature mismatch: ${patch.label || `offset ${offset}`}` };
    patched.set(replacement, offset);
    applied += 1;
  }
  return { bytes: patched, profile, status: patches.length ? `PATCHED ${applied}/${patches.length}` : "READY / NO PATCHES", applied };
}

function identifyRom(file, bytes) {
  const magic = [...bytes.slice(0, 4)].map((value) => value.toString(16).padStart(2, "0")).join("").toUpperCase();
  const extension = file.name.split(".").pop()?.toLowerCase() || "";
  let format = "UNKNOWN";
  if (magic === "80371240") format = "Z64 / BIG-ENDIAN";
  else if (magic === "37804012") format = "V64 / BYTE-SWAPPED";
  else if (magic === "40123780") format = "N64 / LITTLE-ENDIAN";
  else if (magic.startsWith("504B03")) format = "ZIP CONTAINER";
  else if (extension === "7z") format = "7Z CONTAINER";
  const title = format.includes("CONTAINER") ? "INSIDE CONTAINER" : (readAscii(bytes, 0x20, 20) || "NO TITLE FOUND");
  const looksLikeGauntlet = /GAUNTLET\s*LEGENDS/i.test(title) || /GAUNTLET/i.test(file.name);
  return { magic, format, title, looksLikeGauntlet, headerOk: !format.startsWith("UNKNOWN") };
}

async function handleRom(file) {
  if (!file) return;
  try {
    state.rom = file;
    const signature = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    const isZip = file.name.toLowerCase().endsWith(".zip") || (signature[0] === 0x50 && signature[1] === 0x4b && signature[2] === 0x03 && signature[3] === 0x04);
    const rawBytes = isZip ? await extractZipRom(file) : new Uint8Array(await file.arrayBuffer());
    const rawMeta = identifyRom(file, rawBytes);
    const rawHash = await sha256Hex(rawBytes);
    const fileHash = await sha256Hex(await file.arrayBuffer());
    const manifestResponse = await fetch("/rom-patches/gauntlet-legends-n64.json", { cache: "no-store" });
    state.patchManifest = manifestResponse.ok ? await manifestResponse.json() : { id: "gl-n64-websim-bridge-0.1", patches: [] };
    const patch = applyPatchManifest(rawBytes, state.patchManifest, rawHash);
    const valid = rawMeta.headerOk && rawMeta.looksLikeGauntlet && !patch.error;
    state.romLaunchBlob = patch.applied ? new Blob([patch.bytes], { type: "application/octet-stream" }) : file;
    state.romMeta = { ...rawMeta, containerFormat: isZip ? "ZIP CONTAINER" : rawMeta.format, hash: fileHash, rawSha256: rawHash, romKey: rawHash, size: file.size, name: file.name, lastModified: file.lastModified, valid, patchProfile: patch.profile, patchStatus: patch.status, patchError: patch.error || null };
    $("romFormat").textContent = isZip ? `ZIP → ${rawMeta.format.split(" /")[0]}` : rawMeta.format;
    $("romCard").classList.remove("hidden");
    $("romName").textContent = file.name;
    $("romSize").textContent = formatBytes(file.size);
    $("romHash").textContent = rawHash.slice(0, 18) + "…";
    $("romTitle").textContent = rawMeta.title;
    $("romPatch").textContent = patch.status;
    $("romPatch").className = patch.error ? "amber" : "ready";
    $("romCheck").textContent = valid ? "VALID GAUNTLET ROM" : "ROM REJECTED";
    $("romCheck").classList.toggle("warn", !valid);
    $("launchButton").disabled = !valid;
    $("bridgeRomState").textContent = valid ? "VALID" : "REJECT";
    $("bridgeRomState").className = valid ? "ready" : "amber";
    log("rom_inspected", { name: file.name, bytes: file.size, rawBytes: rawBytes.byteLength, magic: rawMeta.magic, format: rawMeta.format, title: rawMeta.title, rawSha256: rawHash, fileSha256: fileHash, valid, patchProfile: patch.profile, patchStatus: patch.status, patchError: patch.error || null });
    if (!valid) throw new Error(patch.error || "This file is not a validated Gauntlet Legends N64 ROM.");
  } catch (error) {
    state.romMeta = { name: file.name, size: file.size, valid: false, patchStatus: "FAILED", patchError: error.message };
    $("launchButton").disabled = true;
    $("romCheck").textContent = "ROM REJECTED";
    $("romCheck").classList.add("warn");
    log("rom_validation_error", { name: file.name, message: error.message }, "ERROR");
    toast(error.message);
    return;
  }
}

function buildReport() {
  return JSON.stringify({
    report: "gauntlet-netplay-debug/0.1",
    generatedAt: new Date().toISOString(),
    browser: navigator.userAgent,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    rom: state.romMeta ? { ...state.romMeta } : null,
    connection: { lobby: state.lobby?.id || null, self: state.self, players: state.players.map(({ id, username, slot, seq }) => ({ id, username, slot, seq })), lastAck: state.lastAck },
    emulator: { core: EMULATOR_CORE, started: state.emulatorStarted, ready: state.emulatorReady, hostReadySignalSent: state.hostReadySignalSent, EJS: Boolean(window.EJS_emulator), gameManager: Boolean(window.EJS_emulator?.gameManager), simulateInput: typeof window.EJS_emulator?.gameManager?.simulateInput === "function", globalSimulateInput: typeof window.simulate_input === "function", inputHook: Boolean(getInputHook()), getState: typeof window.EJS_emulator?.gameManager?.getState === "function", loadState: typeof window.EJS_emulator?.gameManager?.loadState === "function", compressionStream: typeof CompressionStream === "function", decompressionStream: typeof DecompressionStream === "function", crossOriginIsolated: Boolean(window.crossOriginIsolated), threads: Boolean(window.EJS_threads), volume: window.EJS_volume ?? null },
    stateSync: { incoming: state.incomingStateSync ? { syncId: state.incomingStateSync.syncId, received: state.incomingStateSync.received, totalChunks: state.incomingStateSync.totalChunks, bytes: state.incomingStateSync.totalBytes, rawBytes: state.incomingStateSync.rawBytes, encoding: state.incomingStateSync.encoding, chunkEncoding: state.incomingStateSync.chunkEncoding, stateVersion: state.incomingStateSync.stateVersion, barrierId: state.incomingStateSync.barrierId } : null, pending: state.pendingHostState ? { syncId: state.pendingHostState.syncId, stateVersion: state.pendingHostState.stateVersion, barrierId: state.pendingHostState.barrierId } : null, sending: state.stateSyncInFlight, hostAwaitingPeerSync: state.hostAwaitingPeerSync, hostBarrierPaused: state.hostBarrierPaused, hostSyncTargetVersion: state.hostSyncTargetVersion, peerSyncHold: state.peerSyncHold, peerSyncPaused: state.peerSyncPaused, peerSyncTargetVersion: state.peerSyncTargetVersion, lastAppliedStateVersion: state.lastAppliedStateVersion },
    protocol: { name: "input-authority/0.1", serverTickMs: 16, inputSendMs: 16, stateSyncPolicy: "join-barrier-only", inputSequence: state.seq, currentInput: state.input },
    recentLogs: state.logs.slice(-80),
  }, null, 2);
}

function renderPlayers() {
  const slots = $("playerSlots");
  const playersBySlot = new Map(state.players.map((player) => [player.slot, player]));
  slots.innerHTML = [1, 2, 3, 4].map((slot) => {
    const player = playersBySlot.get(slot);
    const label = player ? (player.id === state.self?.id ? `${player.username || "YOU"} · YOU${slot === 1 ? " · HOST" : ""}` : `${player.username || "PLAYER"}${slot === 1 ? " · HOST" : ""}`) : "OPEN SLOT";
    return `<div class="player-slot ${player ? "active" : ""}"><span class="slot-number">P${slot}</span><span class="slot-name">${escapeHtml(label)}</span></div>`;
  }).join("");
}

function mergePlayers(existing, incoming) {
  const merged = new Map((existing || []).map((player) => [player.id, player]));
  for (const player of incoming || []) merged.set(player.id, { ...merged.get(player.id), ...player });
  return [...merged.values()].sort((a, b) => a.slot - b.slot);
}

function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char])); }

function renderLobbyList(lobbies) {
  const list = $("lobbyList");
  if (!lobbies.length) { list.innerHTML = '<div class="empty-state">No public lobbies in range.</div>'; return; }
  list.innerHTML = lobbies.map((lobby) => `<div class="lobby-item"><div><div class="lobby-item-code">${escapeHtml(lobby.id)}</div><div class="lobby-item-meta">${lobby.playerCount}/${lobby.maxPlayers} PLAYERS · HOST ${escapeHtml(lobby.host || "—")}</div></div><button class="outline-button" data-join-code="${escapeHtml(lobby.id)}">Join</button></div>`).join("");
  list.querySelectorAll("[data-join-code]").forEach((button) => button.addEventListener("click", () => joinLobby(button.dataset.joinCode)));
}

async function refreshLobbies() {
  try {
    const response = await fetch("/api/lobbies", { cache: "no-store" });
    if (!response.ok) throw new Error(`lobbies ${response.status}`);
    const lobbies = await response.json();
    renderLobbyList(lobbies);
    log("public_lobbies_refreshed", { count: lobbies.length });
  } catch (error) { log("public_lobbies_error", { message: error.message }, "WARN"); }
}

async function createLobby() {
  if (!state.user) { toast("Sign in to create a lobby"); log("lobby_create_blocked", { reason: "signed_out" }, "WARN"); return; }
  if (!state.romMeta?.valid) { toast("Load a valid Gauntlet ROM first"); log("lobby_create_blocked", { reason: "valid_rom_required" }, "WARN"); return; }
  try {
    const response = await fetch("/api/lobbies", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ visibility: state.selectedVisibility }) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || `create ${response.status}`);
    log("lobby_created", body.lobby);
    $("lobbyCodeInput").value = body.lobby.id;
    await joinLobby(body.lobby.id);
    toast(`${state.selectedVisibility} lobby ${body.lobby.id} ready`);
  } catch (error) { log("lobby_create_error", { message: error.message }, "ERROR"); toast(error.message); }
}

async function connectRoom() {
  if (state.room) return state.room;
  if (!window.WebsimSocket) throw new Error("Realtime room client is unavailable in this preview.");
  state.room = await window.WebsimSocket.joinRoom();
  setConnection("live", "ROOM CONNECTED");
  $("bridgeInputState").textContent = "READY";
  $("bridgeInputState").className = "ready";
  log("room_connected", { transport: "WebsimSocket" });
  state.room.onmessage = (event) => handleRoomMessage(event.data);
  state.room.onreconnect = () => {
    log("room_reconnected", {}, "WARN");
    setConnection("live", "ROOM RECONNECTED");
    state.self = null;
    state.players = [];
    state.seq = 0;
    state.lastAck = null;
    state.lastSentInput = "";
    state.lastLoggedInput = "";
    state.hostAwaitingPeerSync = false;
    state.hostBarrierPaused = false;
    state.hostReadySignalSent = false;
    state.hostSyncBarrierId = null;
    state.hostSyncTargetVersion = 0;
    state.peerSyncHold = false;
    state.peerSyncPaused = false;
    state.peerSyncBarrierId = null;
    state.peerSyncTargetVersion = 0;
    state.lastAppliedStateVersion = 0;
    if (state.lobby && state.romMeta?.valid) {
      state.room.send({ type: "join_lobby", lobbyId: state.lobby.id, romKey: state.romMeta.romKey, romValid: true, patchProfile: state.romMeta.patchProfile });
      log("join_lobby_replay", { lobbyId: state.lobby.id, romKey: state.romMeta.romKey, patchProfile: state.romMeta.patchProfile });
    } else if (state.lobby) {
      log("join_lobby_replay_blocked", { reason: "valid_rom_required" }, "WARN");
    }
  };
  state.room.onclose = (event) => { log("room_closed", { code: event.code, reason: event.reason }, "WARN"); setConnection("error", "ROOM CLOSED"); state.room = null; state.self = null; };
  return state.room;
}

async function joinLobby(code) {
  const lobbyId = String(code || $("lobbyCodeInput").value).trim().toUpperCase();
  if (!lobbyId) { toast("Enter a lobby code"); return; }
  if (!state.user) { toast("Sign in to join a lobby"); log("lobby_join_blocked", { reason: "signed_out", lobbyId }, "WARN"); return; }
  if (!state.romMeta?.valid) { toast("Load a valid Gauntlet ROM first"); log("lobby_join_blocked", { reason: "valid_rom_required", lobbyId }, "WARN"); return; }
  try {
    const room = await connectRoom();
    room.send({ type: "join_lobby", lobbyId, romKey: state.romMeta.romKey, romValid: true, patchProfile: state.romMeta.patchProfile });
    log("join_lobby_sent", { lobbyId, romKey: state.romMeta.romKey, patchProfile: state.romMeta.patchProfile });
  } catch (error) { log("room_connect_error", { message: error.message }, "ERROR"); setConnection("error", "CONNECT ERROR"); toast(error.message); }
}

function handleRoomMessage(raw) {
  let message;
  try { message = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { log("room_bad_message", { raw: String(raw).slice(0, 200) }, "ERROR"); return; }
  if (message.type === "connected") { log("server_hello", { protocol: message.protocol, connectionId: message.connectionId }); return; }
  if (message.type === "joined_lobby") {
    const previousCount = state.players.length;
    state.lobby = message.lobby;
    state.self = message.self;
    state.players = mergePlayers([], message.players);
    state.seq = 0;
    state.lastAck = null;
    state.lastSentInput = "";
    state.lastLoggedInput = "";
    state.hostAwaitingPeerSync = false;
    state.hostBarrierPaused = false;
    state.hostReadySignalSent = false;
    state.hostSyncBarrierId = null;
    state.hostSyncTargetVersion = 0;
    state.peerSyncHold = false;
    state.peerSyncPaused = false;
    state.peerSyncBarrierId = null;
    state.peerSyncTargetVersion = 0;
    state.lastAppliedStateVersion = 0;
    $("partyStatus").classList.remove("hidden");
    $("activeLobbyCode").textContent = state.lobby.id;
    $("partyStatusLabel").textContent = `${state.lobby.visibility.toUpperCase()} LOBBY · P${state.self.slot}`;
    renderPlayers();
    log("lobby_joined", { lobbyId: state.lobby.id, slot: state.self.slot, playerCount: state.players.length });
    toast(`Joined ${state.lobby.id} as P${state.self.slot}`);
    if (state.self.slot === 1 && state.players.length > 1) {
      state.hostAwaitingPeerSync = true;
      state.hostSyncTargetVersion = Number(state.lobby.stateVersion || 0) + 1;
      log("peer_sync_barrier_started", { lobbyId: state.lobby.id, playerCount: state.players.length, reason: "joined_lobby" });
    }
    if (state.self.slot === 1 && state.players.length > previousCount) scheduleHostCheckpoint("joiner_connected");
    if (state.lobby.hostReady && state.self.slot !== 1 && !state.emulatorStarted) { log("host_boot_replay", { lobbyId: state.lobby.id, romKey: state.lobby.romKey }); launchEmulator("host_boot_replay"); }
    return;
  }
  if (message.type === "lobby_state") {
    if (!state.lobby || message.lobby.id !== state.lobby.id) return;
    const previousCount = state.players.length;
    state.lobby = message.lobby;
    state.players = mergePlayers(state.players, message.players);
    renderPlayers();
    log("lobby_state", { lobbyId: message.lobby.id, playerCount: state.players.length, stateVersion: message.lobby.stateVersion || 0 });
    if (state.self?.slot === 1 && state.players.length < 2 && state.hostAwaitingPeerSync) {
      state.hostAwaitingPeerSync = false;
      state.hostSyncBarrierId = null;
      state.hostSyncTargetVersion = 0;
      if (state.hostBarrierPaused && typeof window.EJS_emulator?.play === "function") window.EJS_emulator.play();
      state.hostBarrierPaused = false;
      log("peer_sync_barrier_released", { lobbyId: message.lobby.id, reason: "peer_left" });
    }
    if (state.self?.slot === 1 && state.players.length > previousCount) {
      state.hostAwaitingPeerSync = true;
      state.hostSyncTargetVersion = Number(message.lobby.stateVersion || 0) + 1;
      log("peer_sync_barrier_started", { lobbyId: message.lobby.id, playerCount: state.players.length, reason: "peer_joined" });
      scheduleHostCheckpoint("joiner_connected");
    }
    return;
  }
  if (message.type === "peer_sync_required") {
    if (!state.lobby || message.lobbyId !== state.lobby.id) return;
    const targetVersion = Number(message.targetVersion);
    state.peerSyncBarrierId = String(message.barrierId || "");
    state.peerSyncTargetVersion = Number.isSafeInteger(targetVersion) ? targetVersion : 0;
    if (state.self?.slot === 1) {
      state.hostAwaitingPeerSync = true;
      state.hostSyncBarrierId = state.peerSyncBarrierId;
      state.hostSyncTargetVersion = state.peerSyncTargetVersion;
      log("peer_sync_barrier_started", { lobbyId: message.lobbyId, memberId: message.memberId, barrierId: state.hostSyncBarrierId, targetVersion: state.hostSyncTargetVersion, reason: "server_required" });
      scheduleHostCheckpoint("joiner_connected", 150);
    } else {
      state.peerSyncHold = true;
      if (state.emulatorReady && typeof window.EJS_emulator?.pause === "function") {
        try { window.EJS_emulator.pause(); state.peerSyncPaused = true; log("peer_sync_hold_started", { lobbyId: message.lobbyId, barrierId: state.peerSyncBarrierId, targetVersion: state.peerSyncTargetVersion }); }
        catch (error) { log("peer_sync_hold_error", { message: error.message }, "WARN"); }
      } else log("peer_sync_hold_started", { lobbyId: message.lobbyId, barrierId: state.peerSyncBarrierId, targetVersion: state.peerSyncTargetVersion, emulatorReady: state.emulatorReady });
    }
    return;
  }
  if (message.type === "join_rejected") { log("join_rejected", { code: message.code, message: message.message }, "WARN"); toast(message.message); return; }
  if (message.type === "input_ack") { state.lastAck = message.seq; return; }
  if (message.type === "input_rejected") { log("input_rejected", message, "WARN"); return; }
  if (message.type === "protocol_error") { log("protocol_error", message, "ERROR"); return; }
  if (message.type === "state_sync_rejected") { log("state_sync_rejected", message, "ERROR"); return; }
  if (message.type === "host_state_committed") { log("host_state_committed", { syncId: message.syncId, bytes: message.bytes, rawBytes: message.rawBytes, encoding: message.encoding, stateVersion: message.stateVersion }); return; }
  if (message.type === "peer_sync_status") {
    if (!state.lobby || message.lobbyId !== state.lobby.id) return;
    const messageVersion = Number(message.stateVersion);
    const targetVersion = Number(message.targetVersion || state.peerSyncTargetVersion || 0);
    if (state.peerSyncBarrierId && message.barrierId && state.peerSyncBarrierId !== message.barrierId) return;
    log("peer_sync_status", { readyCount: message.readyCount, peerCount: message.peerCount, stateVersion: messageVersion, targetVersion, allReady: message.allReady });
    const barrierReady = state.self?.slot === 1
      ? (!state.hostSyncTargetVersion || messageVersion >= state.hostSyncTargetVersion)
      : (!targetVersion || state.lastAppliedStateVersion >= targetVersion);
    if (!message.allReady || !barrierReady) return;
    if (state.self?.slot === 1 && state.hostAwaitingPeerSync) {
      state.hostAwaitingPeerSync = false;
      state.hostSyncBarrierId = null;
      state.hostSyncTargetVersion = 0;
      if (state.hostBarrierPaused && typeof window.EJS_emulator?.play === "function") { try { window.EJS_emulator.play(); } catch (error) { log("host_sync_resume_error", { message: error.message }, "WARN"); } }
      state.hostBarrierPaused = false;
      $("emulatorStatus").textContent = "N64 core ready · synchronized";
      log("peer_sync_barrier_released", { lobbyId: message.lobbyId, barrierId: message.barrierId, stateVersion: messageVersion });
    } else if (state.self?.slot !== 1 && state.peerSyncHold) {
      state.peerSyncHold = false;
      if (state.peerSyncPaused && typeof window.EJS_emulator?.play === "function") { try { window.EJS_emulator.play(); } catch (error) { log("peer_sync_resume_error", { message: error.message }, "WARN"); } }
      state.peerSyncPaused = false;
      state.peerSyncBarrierId = null;
      state.peerSyncTargetVersion = 0;
      $("emulatorStatus").textContent = "N64 core ready · synchronized";
      log("peer_sync_barrier_released", { lobbyId: message.lobbyId, barrierId: message.barrierId, stateVersion: messageVersion });
    }
    return;
  }
  if (message.type === "host_emulator_ready") {
    if (!state.lobby || message.lobbyId !== state.lobby.id || message.romKey !== state.romMeta?.romKey) return;
    state.lobby.hostReady = true;
    log("host_boot_signal", { lobbyId: message.lobbyId, stateVersion: message.stateVersion || 0 });
    if (state.self?.slot !== 1 && !state.emulatorStarted) launchEmulator("host_boot_signal");
    return;
  }
  if (message.type === "input_relay") {
    if (!state.lobby || message.lobbyId !== state.lobby.id || !message.player) return;
    state.players = mergePlayers(state.players, [message.player]);
    renderPlayers();
    applyRemoteInputs([message.player]);
    return;
  }
  if (message.type === "host_state_begin") {
    if (!state.lobby || message.lobbyId !== state.lobby.id) return;
    if (message.romKey !== state.romMeta?.romKey) { log("host_state_rom_mismatch", { expected: state.romMeta?.romKey, received: message.romKey }, "ERROR"); return; }
    const stateVersion = Number(message.stateVersion || 0);
    if (state.lastAppliedStateVersion && stateVersion && stateVersion < state.lastAppliedStateVersion) { log("host_state_ignored", { syncId: message.syncId, stateVersion, lastAppliedStateVersion: state.lastAppliedStateVersion, reason: "stale_begin" }, "WARN"); return; }
    if (state.incomingStateSync && state.incomingStateSync.stateVersion > stateVersion) { log("host_state_ignored", { syncId: message.syncId, stateVersion, activeStateVersion: state.incomingStateSync.stateVersion, reason: "older_than_active" }, "WARN"); return; }
    state.incomingStateSync = { syncId: message.syncId, totalBytes: message.totalBytes, rawBytes: message.rawBytes, totalChunks: message.totalChunks, encoding: message.encoding || "identity", chunkEncoding: message.chunkEncoding || "base64url", stateTick: message.stateTick, stateVersion, barrierId: message.barrierId || null, chunks: new Array(message.totalChunks), received: 0 };
    if (state.self?.slot !== 1 && (state.peerSyncHold || (state.peerSyncTargetVersion > 0 && stateVersion >= state.peerSyncTargetVersion) || (stateVersion > 0 && stateVersion > state.lastAppliedStateVersion))) {
      state.peerSyncHold = true;
      if (state.emulatorReady && typeof window.EJS_emulator?.pause === "function" && !state.peerSyncPaused) {
        try { window.EJS_emulator.pause(); state.peerSyncPaused = true; } catch (error) { log("peer_sync_hold_error", { message: error.message }, "WARN"); }
      }
    }
    log("host_state_begin", { syncId: message.syncId, bytes: message.totalBytes, rawBytes: message.rawBytes, totalChunks: message.totalChunks, encoding: state.incomingStateSync.encoding, chunkEncoding: state.incomingStateSync.chunkEncoding, stateTick: message.stateTick, stateVersion, barrierId: message.barrierId || null });
    return;
  }
  if (message.type === "host_state_chunk") {
    if (!state.lobby || message.lobbyId !== state.lobby.id) return;
    const sync = state.incomingStateSync;
    const index = Number(message.index);
    if (!sync || sync.syncId !== message.syncId || !Number.isSafeInteger(index) || index < 0 || index >= sync.totalChunks || sync.chunks[index]) return;
    sync.chunks[index] = message.data;
    sync.received += 1;
    if (sync.received === sync.totalChunks || sync.received % 25 === 0) log("host_state_progress", { syncId: sync.syncId, received: sync.received, totalChunks: sync.totalChunks });
    return;
  }
  if (message.type === "host_state_end") {
    if (!state.lobby || message.lobbyId !== state.lobby.id) return;
    const sync = state.incomingStateSync;
    if (sync && sync.syncId !== message.syncId && Number(message.stateVersion || 0) < sync.stateVersion) {
      log("host_state_ignored", { syncId: message.syncId, stateVersion: Number(message.stateVersion || 0), activeSyncId: sync.syncId, activeStateVersion: sync.stateVersion, reason: "stale_end" }, "WARN");
      return;
    }
    if (!sync || sync.syncId !== message.syncId || sync.received !== sync.totalChunks) {
      log("host_state_incomplete", { syncId: message.syncId, received: sync?.received || 0, expected: sync?.totalChunks || 0 }, "ERROR");
      requestHostStateResync(message.syncId, "incomplete");
      return;
    }
    const packedBytes = new Uint8Array(sync.totalBytes);
    let offset = 0;
    try {
      for (let index = 0; index < sync.chunks.length; index += 1) {
        const chunk = sync.chunks[index];
        let decoded;
        try { decoded = bytesFromTransport(chunk, sync.chunkEncoding); }
        catch (error) { throw new Error(`state chunk ${index} has an invalid ${sync.chunkEncoding} payload: ${error.message}`); }
        if (offset + decoded.length > packedBytes.byteLength) throw new Error("state chunks exceed declared size");
        packedBytes.set(decoded, offset);
        offset += decoded.length;
      }
      if (offset !== packedBytes.byteLength) throw new Error(`state chunks are ${offset} bytes; expected ${packedBytes.byteLength}`);
    }
    catch (error) {
      state.incomingStateSync = null;
      log("host_state_decode_error", { syncId: sync.syncId, message: error.message }, "ERROR");
      requestHostStateResync(sync.syncId, "chunk_decode");
      return;
    }
    state.incomingStateSync = null;
    decompressState(packedBytes, sync.encoding).then((bytes) => {
      if (sync.rawBytes && bytes.byteLength !== sync.rawBytes) throw new Error(`decoded state is ${bytes.byteLength} bytes; expected ${sync.rawBytes}`);
      const stateVersion = Number(message.stateVersion || sync.stateVersion || 0);
      if ((state.lastAppliedStateVersion && stateVersion && stateVersion < state.lastAppliedStateVersion) || (state.pendingHostState && state.pendingHostState.stateVersion > stateVersion)) {
        log("host_state_ignored", { syncId: message.syncId, stateVersion, lastAppliedStateVersion: state.lastAppliedStateVersion, pendingStateVersion: state.pendingHostState?.stateVersion || 0, reason: "stale_complete" }, "WARN");
        return;
      }
      state.pendingHostState = { syncId: message.syncId, bytes, stateTick: message.stateTick, stateVersion, barrierId: message.barrierId || sync.barrierId || null, attempts: 0 };
      log("host_state_received", { syncId: message.syncId, bytes: packedBytes.byteLength, rawBytes: bytes.byteLength, encoding: sync.encoding, chunkEncoding: sync.chunkEncoding, stateTick: message.stateTick, stateVersion });
      return applyPendingHostState();
    }).catch((error) => {
      log("host_state_decode_error", { syncId: sync.syncId, encoding: sync.encoding, message: error.message }, "ERROR");
      requestHostStateResync(sync.syncId, "state_decode");
    });
    return;
  }
  if (message.type === "snapshot") {
    if (!state.lobby || message.lobbyId !== state.lobby.id) return;
    state.lastServerTick = message.tick;
    state.players = mergePlayers(state.players, message.players);
    renderPlayers();
    const selfFrame = state.players.find((player) => player.id === state.self?.id);
    if (selfFrame) $("inputReadout").innerHTML = `P${selfFrame.slot} INPUT <span>SEQ ${selfFrame.seq}</span>`;
    applyRemoteInputs(state.players);
    if (message.tick % 60 === 0) log("authoritative_snapshot", { lobbyId: message.lobbyId, tick: message.tick, players: state.players.length, serverTime: message.serverTime });
  }
}

function requestHostStateResync(syncId, reason) {
  if (state.self?.slot === 1 || !state.room || !state.lobby) return;
  const now = Date.now();
  if (now - state.lastResyncRequestAt < 2000) return;
  state.lastResyncRequestAt = now;
  state.room.send({ type: "request_host_state", syncId });
  log("host_state_resync_requested", { syncId, reason });
}

function applyRemoteInputs(players) {
  const hook = getInputHook();
  if (!hook) return;
  for (const player of players) {
    if (player.id === state.self?.id || !player.input) continue;
    for (const [key, value] of Object.entries(player.input.buttons || {})) {
      if (!(key in controllerButtonMap)) continue;
      try { hook(Math.max(0, player.slot - 1), controllerButtonMap[key], value ? 1 : 0); } catch (error) { log("remote_input_hook_error", { player: player.slot, key, message: error.message }, "WARN"); }
    }
  }
}

const controllerButtonMap = { a: 0, b: 8, z: 12, start: 3, l: 10, r: 11, dUp: 4, dDown: 5, dLeft: 6, dRight: 7, up: 19, down: 18, left: 17, right: 16, cUp: 23, cDown: 22, cLeft: 21, cRight: 20 };

function applyLocalInput() {
  const hook = getInputHook();
  if (!hook || !state.self) return;
  for (const [key, value] of Object.entries(state.input)) {
    if (!(key in controllerButtonMap)) continue;
    try { hook(Math.max(0, state.self.slot - 1), controllerButtonMap[key], value ? 1 : 0); } catch (error) { log("local_input_hook_error", { player: state.self.slot, key, message: error.message }, "WARN"); }
  }
}

function getInputHook() {
  if (typeof window.EJS_emulator?.gameManager?.simulateInput === "function") return (port, input, value) => window.EJS_emulator.gameManager.simulateInput(port, input, value);
  if (typeof window.simulate_input === "function") return (port, input, value) => window.simulate_input(port, input, value);
  return null;
}

async function waitForEmulatorCapabilities() {
  const startedAt = performance.now();
  let stateCapabilitiesLogged = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const capabilities = { inputHook: Boolean(getInputHook()), getState: typeof window.EJS_emulator?.gameManager?.getState === "function", loadState: typeof window.EJS_emulator?.gameManager?.loadState === "function" };
    if (capabilities.getState && capabilities.loadState && !stateCapabilitiesLogged) {
      stateCapabilitiesLogged = true;
      log("emulator_state_capabilities_ready", { ...capabilities, waitMs: Math.round(performance.now() - startedAt) });
      applyPendingHostState();
      if (state.self?.slot === 1 && state.players.length > 1) scheduleHostCheckpoint("capabilities_ready");
    }
    if (capabilities.inputHook) applyLocalInput();
    if (capabilities.inputHook && capabilities.getState && capabilities.loadState) {
      log("emulator_capabilities_ready", { ...capabilities, waitMs: Math.round(performance.now() - startedAt) });
      if (state.self?.slot === 1 && !state.hostReadySignalSent) {
        state.hostReadySignalSent = true;
        state.room?.send({ type: "host_emulator_ready", romKey: state.romMeta?.romKey, patchProfile: state.romMeta?.patchProfile });
        log("host_ready_signal_sent", { lobbyId: state.lobby?.id || null, core: EMULATOR_CORE });
      }
      applyPendingHostState();
      return;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 100));
  }
  log("emulator_capabilities_timeout", { inputHook: Boolean(getInputHook()), getState: typeof window.EJS_emulator?.gameManager?.getState === "function", loadState: typeof window.EJS_emulator?.gameManager?.loadState === "function", waitMs: Math.round(performance.now() - startedAt) }, "WARN");
  applyPendingHostState();
}

function hexFromBytes(bytes) {
  let output = "";
  for (const byte of bytes) output += byte.toString(16).padStart(2, "0");
  return output;
}

function bytesFromTransport(value, encoding = "base64url") {
  if (encoding === "hex") {
    const normalized = String(value || "").trim().replace(/\s+/g, "");
    if (!normalized || normalized.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(normalized)) throw new Error(`malformed hex payload (${normalized.length} chars)`);
    const bytes = new Uint8Array(normalized.length / 2);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = parseInt(normalized.slice(index * 2, index * 2 + 2), 16);
    return bytes;
  }
  const normalized = String(value || "").trim().replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  if (!normalized || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 === 1) throw new Error(`malformed payload (${normalized.length} chars)`);
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function compressState(bytes) {
  if (typeof CompressionStream === "undefined") return { bytes, encoding: "identity" };
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return { bytes: new Uint8Array(await new Response(stream).arrayBuffer()), encoding: "gzip" };
}

async function decompressState(bytes, encoding) {
  if (encoding !== "gzip") return bytes;
  if (typeof DecompressionStream === "undefined") throw new Error("gzip decompression is unavailable in this browser");
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function scheduleHostCheckpoint(reason, delayMs = 150) {
  if (state.hostCheckpointTimer) window.clearTimeout(state.hostCheckpointTimer);
  state.hostCheckpointTimer = window.setTimeout(() => sendHostCheckpoint(reason), delayMs);
}

function base64urlFromBytes(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sendHostCheckpoint(reason = "periodic") {
  if (state.stateSyncInFlight) { state.hostCheckpointPending = reason; return; }
  if (!state.self || state.self.slot !== 1 || !state.lobby || !state.emulatorReady || state.players.length < 2) return;
  const gameManager = window.EJS_emulator?.gameManager;
  if (typeof gameManager?.getState !== "function") { log("host_state_unavailable", { reason, getState: false }, "WARN"); return; }
  state.stateSyncInFlight = true;
  let checkpointSent = false;
  try {
    if (state.hostAwaitingPeerSync) {
      if (typeof window.EJS_emulator?.pause !== "function") throw new Error("Emulator pause API unavailable for synchronization barrier");
      try { window.EJS_emulator.pause(); state.hostBarrierPaused = true; log("host_sync_barrier_paused", { reason, stateTick: state.lastServerTick || 0 }); }
      catch (error) { throw new Error(`Unable to pause host emulator: ${error.message}`); }
    }
    let rawState;
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      try {
        rawState = gameManager.getState();
        break;
      } catch (error) {
        if (attempt === 6) throw error;
        log("host_state_capture_retry", { reason, attempt, delayMs: 120, message: error?.message || String(error) }, "WARN");
        await new Promise((resolve) => window.setTimeout(resolve, 120));
      }
    }
    const bytes = new Uint8Array(rawState instanceof Uint8Array ? rawState : new Uint8Array(rawState));
    if (!bytes.byteLength) throw new Error("Emulator returned an empty savestate");
    const packed = await compressState(bytes);
    if (packed.bytes.byteLength > 20 * 1024 * 1024) throw new Error(`Compressed savestate is ${packed.bytes.byteLength} bytes; room limit is 20 MB`);
    const chunkSize = STATE_CHUNK_BYTES;
    const totalChunks = Math.ceil(packed.bytes.byteLength / chunkSize);
    if (totalChunks > 900) throw new Error(`Compressed savestate needs ${totalChunks} chunks; room limit is 900`);
    const syncId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    state.room.send({ type: "host_state_begin", syncId, totalBytes: packed.bytes.byteLength, rawBytes: bytes.byteLength, totalChunks, encoding: packed.encoding, chunkEncoding: "base64url", barrierId: state.hostSyncBarrierId, stateTick: state.lastServerTick || 0 });
    for (let index = 0; index < totalChunks; index += 1) {
      state.room.send({ type: "host_state_chunk", syncId, index, data: base64urlFromBytes(packed.bytes.subarray(index * chunkSize, Math.min(packed.bytes.byteLength, (index + 1) * chunkSize))) });
      await new Promise((resolve) => window.setTimeout(resolve, 1));
    }
    state.room.send({ type: "host_state_end", syncId, stateTick: state.lastServerTick || 0 });
    checkpointSent = true;
    state.hostStateRetryCount = 0;
    log("host_state_sent", { reason, syncId, bytes: packed.bytes.byteLength, rawBytes: bytes.byteLength, compression: `${Math.round((packed.bytes.byteLength / bytes.byteLength) * 100)}%`, encoding: packed.encoding, chunkEncoding: "base64url", totalChunks });
  } catch (error) {
    const message = error?.message || String(error);
    log("host_state_error", { reason, message }, "ERROR");
    if (state.hostBarrierPaused && !checkpointSent && typeof window.EJS_emulator?.play === "function") {
      try { window.EJS_emulator.play(); state.hostBarrierPaused = false; log("host_sync_barrier_resumed", { reason: "checkpoint_failed" }, "WARN"); } catch (resumeError) { log("host_sync_resume_error", { message: resumeError.message }, "ERROR"); }
    }
    if (state.hostAwaitingPeerSync && state.hostStateRetryCount < 4) {
      state.hostStateRetryCount += 1;
      const delayMs = Math.min(5000, 600 * (2 ** (state.hostStateRetryCount - 1)));
      log("host_state_retry_scheduled", { reason: "barrier_checkpoint_retry", attempt: state.hostStateRetryCount, delayMs }, "WARN");
      scheduleHostCheckpoint("barrier_checkpoint_retry", delayMs);
    }
  }
  finally {
    state.stateSyncInFlight = false;
    if (state.hostBarrierPaused && !state.hostAwaitingPeerSync && typeof window.EJS_emulator?.play === "function") {
      try { window.EJS_emulator.play(); } catch (error) { log("host_sync_resume_error", { message: error.message }, "WARN"); }
      state.hostBarrierPaused = false;
    }
    if (state.hostCheckpointPending) {
      const pendingReason = state.hostCheckpointPending;
      state.hostCheckpointPending = null;
      scheduleHostCheckpoint(pendingReason);
    }
  }
}

async function applyPendingHostState() {
  if (!state.pendingHostState || !state.emulatorReady) return;
  const gameManager = window.EJS_emulator?.gameManager;
  if (typeof gameManager?.loadState !== "function") { log("host_state_apply_unavailable", { loadState: false }, "ERROR"); return; }
  const pending = state.pendingHostState;
  if (pending.stateVersion && state.lastAppliedStateVersion && pending.stateVersion < state.lastAppliedStateVersion) {
    if (state.pendingHostState === pending) state.pendingHostState = null;
    log("host_state_ignored", { syncId: pending.syncId, stateVersion: pending.stateVersion, lastAppliedStateVersion: state.lastAppliedStateVersion, reason: "stale_apply" }, "WARN");
    return;
  }
  try {
    await gameManager.loadState(pending.bytes);
    if (state.pendingHostState === pending) state.pendingHostState = null;
    if (pending.stateVersion) state.lastAppliedStateVersion = Math.max(state.lastAppliedStateVersion, pending.stateVersion);
    state.room?.send({ type: "host_state_applied", syncId: pending.syncId, stateVersion: pending.stateVersion, barrierId: pending.barrierId });
    $("emulatorStatus").textContent = `Synced to host · state ${pending.stateVersion}`;
    $("bridgeBadge").textContent = "HOST SYNCED";
    log("host_state_applied", { bytes: pending.bytes.byteLength, stateTick: pending.stateTick, stateVersion: pending.stateVersion });
  } catch (error) {
    const message = error?.message || String(error);
    log("host_state_apply_error", { message, attempt: pending.attempts + 1 }, "ERROR");
    if (pending.attempts < 3 && state.pendingHostState === pending) {
      pending.attempts += 1;
      window.setTimeout(applyPendingHostState, 500);
      log("host_state_apply_retry_scheduled", { attempt: pending.attempts, delayMs: 500 }, "WARN");
    }
  }
}

function inputSignature() { return JSON.stringify(state.input); }

function sendInput(force = false) {
  if (!state.room || !state.self) return;
  const signature = inputSignature();
  if (!force && signature === state.lastSentInput) return;
  state.lastSentInput = signature;
  state.seq += 1;
  state.room.send({ type: "input", seq: state.seq, buttons: state.input, axisX: 0, axisY: 0 });
  const buttons = Object.entries(state.input).filter(([, value]) => value).map(([key]) => key);
  if (signature !== state.lastLoggedInput || state.seq % 20 === 0) { state.lastLoggedInput = signature; log("input_sent", { seq: state.seq, buttons }); }
}

function setKey(key, pressed) {
  if (!(key in state.input) || state.input[key] === pressed) return;
  if (state.self?.slot === 1 && state.hostBarrierPaused) {
    if (pressed) log("host_input_blocked", { key, reason: "peer_sync_barrier" }, "WARN");
    return;
  }
  state.input[key] = pressed;
  applyLocalInput();
  sendInput(true);
}

function setupKeyboard() {
  const keys = { w: "up", arrowup: "up", s: "down", arrowdown: "down", a: "left", arrowleft: "left", d: "right", arrowright: "right", t: "dUp", g: "dDown", f: "dLeft", h: "dRight", j: "a", " ": "a", x: "a", k: "b", shift: "b", q: "z", z: "z", enter: "start", e: "l", r: "r", u: "cUp", i: "cRight", o: "cDown", p: "cLeft" };
  const releaseKeys = () => { let changed = false; for (const key of Object.keys(state.input)) { if (state.input[key]) { state.input[key] = false; changed = true; } } if (changed) { applyLocalInput(); sendInput(true); log("input_reset", { reason: "window_blur" }); } };
  window.addEventListener("keydown", (event) => { const key = keys[event.key.toLowerCase()]; if (!key) return; event.preventDefault(); setKey(key, true); });
  window.addEventListener("keyup", (event) => { const key = keys[event.key.toLowerCase()]; if (!key) return; event.preventDefault(); setKey(key, false); });
  const gameSurface = $("game");
  gameSurface.addEventListener("pointerdown", (event) => {
    if (!state.self || event.button !== 0) return;
    // Mirror a click on EmulatorJS's game/control surface as a shared A press.
    // This covers the on-screen A/continue control, which does not pass
    // through the page keyboard listeners.
    setKey("a", true);
    window.setTimeout(() => setKey("a", false), 80);
    log("pointer_input_sent", { button: "a", slot: state.self.slot });
  }, { passive: true });
  window.addEventListener("blur", releaseKeys);
  document.addEventListener("visibilitychange", () => { if (document.hidden) releaseKeys(); });
  window.setInterval(() => { if (state.self) sendInput(true); }, 16);
}

async function launchEmulator(reason = "manual") {
  if (!state.rom) return;
  if (typeof window.EJS_terminate === "function") { try { window.EJS_terminate(); } catch {} }
  if (state.romUrl) URL.revokeObjectURL(state.romUrl);
  state.romUrl = URL.createObjectURL(state.romLaunchBlob || state.rom);
  const game = $("game");
  game.innerHTML = "";
  state.emulatorStarted = true;
  state.emulatorReady = false;
  state.hostStateRetryCount = 0;
  state.hostReadySignalSent = false;
  state.hostCheckpointPending = null;
  $("bridgeCoreState").textContent = "LOADING";
  $("bridgeCoreState").className = "amber";
  $("bridgeBadge").textContent = "BOOTING";
  $("emulatorStatus").textContent = "Loading Mupen64Plus-Next core…";
  log("emulator_boot_requested", { reason, core: EMULATOR_CORE, dataPath: "https://cdn.emulatorjs.org/stable/data/", rom: state.rom.name });
  window.EJS_player = "#game";
  window.EJS_core = EMULATOR_CORE;
  window.EJS_gameUrl = state.romUrl;
  window.EJS_gameName = state.rom.name;
  window.EJS_biosUrl = "";
  window.EJS_pathtodata = "https://cdn.emulatorjs.org/stable/data/";
  window.EJS_gameID = 64;
  window.EJS_volume = 0.8;
  window.EJS_threads = Boolean(window.crossOriginIsolated && window.SharedArrayBuffer);
  window.EJS_disableLocalStorage = true;
  // Let Mupen64Plus-Next select its supported WebGL path. The old
  // webgl2Enabled internal flag could force a mismatched renderer and cause
  // corrupted N64 frames on some browsers.
  window.EJS_forceLegacyCores = false;
  window.EJS_defaultOptions = { ...(window.EJS_defaultOptions || {}), vsync: "enabled", shader: "disabled" };
  window.EJS_startOnLoaded = true;
  window.EJS_DEBUG_XX = true;
  window.EJS_controlScheme = "n64";
  window.EJS_ready = () => { state.emulatorReady = true; $("bridgeCoreState").textContent = "READY"; $("bridgeCoreState").className = "ready"; $("bridgeBadge").textContent = "CORE READY"; $("bridgeBadge").classList.add("live"); $("emulatorStatus").textContent = "N64 core ready · local frame"; if (state.peerSyncHold && typeof window.EJS_emulator?.pause === "function") { try { window.EJS_emulator.pause(); state.peerSyncPaused = true; } catch (error) { log("peer_sync_hold_error", { message: error.message }, "WARN"); } } log("emulator_ready", { core: EMULATOR_CORE, inputHook: Boolean(getInputHook()), getState: typeof window.EJS_emulator?.gameManager?.getState === "function", loadState: typeof window.EJS_emulator?.gameManager?.loadState === "function", threads: Boolean(window.EJS_threads), crossOriginIsolated: Boolean(window.crossOriginIsolated), vsync: window.EJS_defaultOptions?.vsync, volume: window.EJS_volume }); waitForEmulatorCapabilities(); };
  window.EJS_onExit = () => { state.emulatorStarted = false; state.emulatorReady = false; $("emulatorStatus").textContent = "Emulator exited"; log("emulator_exit"); };
  if (state.emulatorScript) state.emulatorScript.remove();
  const script = document.createElement("script");
  script.src = `https://cdn.emulatorjs.org/stable/data/loader.js?bridge=${Date.now()}`;
  script.async = true;
  state.emulatorScript = script;
  script.onerror = () => { $("bridgeCoreState").textContent = "ERROR"; $("bridgeCoreState").className = "amber"; $("bridgeBadge").textContent = "LOAD ERROR"; $("emulatorStatus").textContent = "Could not load the browser core"; log("emulator_loader_error", { src: script.src }, "ERROR"); };
  document.body.appendChild(script);
}

async function leaveLobby() {
  if (!state.lobby) return;
  const id = state.lobby.id;
  state.room?.close?.();
  state.room = null; state.lobby = null; state.self = null; state.players = [];
  $("partyStatus").classList.add("hidden"); renderPlayers(); setConnection("", "OFFLINE"); $("bridgeInputState").textContent = "LOCKED"; $("bridgeInputState").className = "";
  log("lobby_left", { lobbyId: id });
}

function tickClock() { $("emulatorClock").textContent = new Date().toISOString().slice(11, 19); }

function bindUI() {
  $("romInput").addEventListener("change", (event) => handleRom(event.target.files[0]));
  const dropZone = $("dropZone");
  ["dragenter", "dragover"].forEach((type) => dropZone.addEventListener(type, (event) => { event.preventDefault(); dropZone.classList.add("dragging"); }));
  ["dragleave", "drop"].forEach((type) => dropZone.addEventListener(type, (event) => { event.preventDefault(); dropZone.classList.remove("dragging"); }));
  dropZone.addEventListener("drop", (event) => handleRom(event.dataTransfer.files[0]));
  $("launchButton").addEventListener("click", launchEmulator);
  $("createLobbyButton").addEventListener("click", createLobby);
  $("joinLobbyButton").addEventListener("click", () => joinLobby());
  $("lobbyCodeInput").addEventListener("keydown", (event) => { if (event.key === "Enter") joinLobby(); });
  $("refreshLobbiesButton").addEventListener("click", refreshLobbies);
  $("leaveLobbyButton").addEventListener("click", leaveLobby);
  $("copyLobbyButton").addEventListener("click", () => copyText(state.lobby?.id || "", "Lobby code copied"));
  $("copyLogsButton").addEventListener("click", () => copyText(state.logs.join("\n"), "Logs copied"));
  $("copyReportButton").addEventListener("click", () => copyText(buildReport(), "Debug report copied"));
  $("clearLogsButton").addEventListener("click", () => { state.logs = []; logOutput.innerHTML = '<span class="log-muted">Logs cleared.</span>'; $("logCount").textContent = "0 EVENTS"; });
  document.querySelectorAll("[data-visibility]").forEach((button) => button.addEventListener("click", () => { state.selectedVisibility = button.dataset.visibility; document.querySelectorAll("[data-visibility]").forEach((node) => node.classList.toggle("active", node === button)); log("visibility_selected", { visibility: state.selectedVisibility }); }));
}

async function boot() {
  bindUI(); setupKeyboard(); window.setInterval(tickClock, 1000); refreshLobbies();
  try { state.user = await window.websim?.getUser?.(); log("identity_loaded", { signedIn: Boolean(state.user), username: state.user?.username || null }); }
  catch (error) { log("identity_error", { message: error.message }, "WARN"); }
  log("client_ready", { browser: navigator.userAgent, protocol: "input-authority/0.1" });
}

boot();
