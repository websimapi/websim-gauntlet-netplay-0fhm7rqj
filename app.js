// Use EmulatorJS's default N64 core. Mupen64Plus-Next uses the GLideN64
// renderer and is the better general-compatibility path for this game.
const EMULATOR_CORE = "mupen64plus_next";
const INPUT_HEARTBEAT_MS = 33;
const ANALOG_MAX = 0x7fff;
// GLideN64 documents legacy blending as a faster path for slow GPUs. Keep
// this explicit so performance logs and support reports identify the tradeoff.
const FAST_RENDER_PROFILE = true;
// The host core is single-threaded in the static Websim page. Capturing a
// second 60fps copy of its canvas can starve that same thread, so use a stable
// 30fps stream with a modest bitrate. The emulator itself still runs at its
// normal cadence; this only controls the peer feed.
const STREAM_CAPTURE_FPS = 30;
const STREAM_MAX_BITRATE = 1400000;
const STREAM_AUDIO_MAX_BITRATE = 96000;
const STREAM_CONFIG = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }], bundlePolicy: "max-bundle", rtcpMuxPolicy: "require" };

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
  hostReadySignalSent: false,
  hostStream: null,
  hostAudioMixer: null,
  hostAudioDestination: null,
  hostAudioCaptureMode: "none",
  hostStreamPeers: new Map(),
  hostStreamOfferPromises: new Map(),
  remoteStreamConnection: null,
  remoteStreamCandidates: [],
  remoteAppliedInputSeq: new Map(),
  remoteInputState: new Map(),
  localInputState: null,
  hostStreamRequestTimer: null,
  hostStreamTimer: null,
  playerLayoutKey: "",
  logRenderTimer: null,
  mainThreadMonitorTimer: null,
  mainThreadLastWarnAt: 0,
  emulatorPerfTimer: null,
  emulatorPerfStartTimer: null,
  emulatorPerfLastFrame: null,
  emulatorPerfLastAt: 0,
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
  // Log collection must not compete with the emulator for the main thread.
  // Batch the visible console updates; state.logs remains complete in memory.
  if (!state.logRenderTimer) {
    state.logRenderTimer = window.setTimeout(() => {
      state.logRenderTimer = null;
      logOutput.textContent = state.logs.join("\n");
      logOutput.scrollTop = logOutput.scrollHeight;
      $("logCount").textContent = `${state.logs.length} EVENTS`;
    }, 100);
  }
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
    emulator: { core: EMULATOR_CORE, renderProfile: FAST_RENDER_PROFILE ? "legacy-blending" : "compatibility", started: state.emulatorStarted, ready: state.emulatorReady, hostReadySignalSent: state.hostReadySignalSent, EJS: Boolean(window.EJS_emulator), gameManager: Boolean(window.EJS_emulator?.gameManager), simulateInput: typeof window.EJS_emulator?.gameManager?.simulateInput === "function", globalSimulateInput: typeof window.simulate_input === "function", inputHook: Boolean(getInputHook()), getState: typeof window.EJS_emulator?.gameManager?.getState === "function", loadState: typeof window.EJS_emulator?.gameManager?.loadState === "function", compressionStream: typeof CompressionStream === "function", decompressionStream: typeof DecompressionStream === "function", crossOriginIsolated: Boolean(window.crossOriginIsolated), threads: Boolean(window.EJS_threads), volume: window.EJS_volume ?? null },
    stream: { hostTracks: state.hostStream?.getTracks().map((track) => ({ kind: track.kind, state: track.readyState })) || [], audioCapture: state.hostAudioCaptureMode, peerConnections: state.hostStreamPeers.size, receiving: Boolean(state.remoteStreamConnection), remoteVideo: Boolean($("remoteGame")?.srcObject) },
    protocol: { name: "host-authority/1.0", serverTickMs: 50, inputSendMs: INPUT_HEARTBEAT_MS, videoTransport: "WebRTC", inputSequence: state.seq, currentInput: state.input },
    recentLogs: state.logs.slice(-80),
  }, null, 2);
}

function renderPlayers() {
  const slots = $("playerSlots");
  const layoutKey = state.players.map((player) => `${player.id}:${player.slot}:${player.username || ""}`).join("|");
  if (layoutKey === state.playerLayoutKey && slots.childElementCount === 4) return;
  state.playerLayoutKey = layoutKey;
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
    state.hostReadySignalSent = false;
    closeAllStreams();
    if (state.lobby && state.romMeta?.valid) {
      state.room.send({ type: "join_lobby", lobbyId: state.lobby.id, romKey: state.romMeta.romKey, romValid: true, patchProfile: state.romMeta.patchProfile });
      log("join_lobby_replay", { lobbyId: state.lobby.id, romKey: state.romMeta.romKey, patchProfile: state.romMeta.patchProfile });
    } else if (state.lobby) {
      log("join_lobby_replay_blocked", { reason: "valid_rom_required" }, "WARN");
    }
  };
  state.room.onclose = (event) => { log("room_closed", { code: event.code, reason: event.reason }, "WARN"); closeAllStreams(); setConnection("error", "ROOM CLOSED"); state.room = null; state.self = null; };
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

function isHost() { return state.self?.slot === 1; }

function streamSignal(targetId, signal) {
  if (state.room && state.lobby) state.room.send({ type: "stream_signal", targetId, signal });
}

function requestHostStream() {
  if (isHost() || !state.room || !state.lobby) return;
  if (state.hostStreamRequestTimer) window.clearTimeout(state.hostStreamRequestTimer);
  state.room.send({ type: "stream_request" });
  log("host_stream_request_sent", { lobbyId: state.lobby.id });
  state.hostStreamRequestTimer = window.setTimeout(() => {
    const video = $("remoteGame");
    if (!video?.srcObject) requestHostStream();
  }, 4000);
}

function closeHostStreamPeer(peerId) {
  const connection = state.hostStreamPeers.get(peerId);
  if (connection) connection.close();
  state.hostStreamPeers.delete(peerId);
}

function closeRemoteStream(clearCandidates = true) {
  if (state.remoteStreamConnection) state.remoteStreamConnection.close();
  state.remoteStreamConnection = null;
  if (clearCandidates) state.remoteStreamCandidates = [];
  const video = $("remoteGame");
  video.pause();
  video.srcObject = null;
  video.classList.add("hidden");
}

function closeAllStreams() {
  if (state.hostStreamTimer) window.clearTimeout(state.hostStreamTimer);
  state.hostStreamTimer = null;
  if (state.hostStreamRequestTimer) window.clearTimeout(state.hostStreamRequestTimer);
  state.hostStreamRequestTimer = null;
  for (const peerId of state.hostStreamPeers.keys()) closeHostStreamPeer(peerId);
  state.hostStreamOfferPromises.clear();
  state.remoteAppliedInputSeq.clear();
  state.remoteInputState.clear();
  state.localInputState = null;
  releaseHostMediaCapture();
  closeRemoteStream();
}

function releaseHostMediaCapture() {
  if (state.hostStream) state.hostStream.getTracks().forEach((track) => track.stop());
  state.hostStream = null;
  try { state.hostAudioMixer?.disconnect(); } catch {}
  try { state.hostAudioDestination?.disconnect?.(); } catch {}
  state.hostAudioMixer = null;
  state.hostAudioDestination = null;
  state.hostAudioCaptureMode = "none";
}

function scheduleHostStreams(delayMs = 120) {
  if (!isHost() || !state.emulatorReady) return;
  if (state.hostStreamTimer) window.clearTimeout(state.hostStreamTimer);
  state.hostStreamTimer = window.setTimeout(() => ensureHostStreams(), delayMs);
}

function announceHostReady() {
  if (!isHost() || !state.emulatorReady || state.hostReadySignalSent) return;
  state.hostReadySignalSent = true;
  state.room?.send({ type: "host_emulator_ready", romKey: state.romMeta?.romKey, patchProfile: state.romMeta?.patchProfile });
  log("host_ready_signal_sent", { lobbyId: state.lobby?.id || null, core: EMULATOR_CORE });
}

function captureHostMedia(canvas) {
  const stream = canvas.captureStream(STREAM_CAPTURE_FPS);
  stream.getVideoTracks().forEach((track) => { track.contentHint = "motion"; });

  // EmulatorJS's built-in capture helper creates a channel-merger with one
  // output channel per OpenAL source. Gauntlet can have many sources active;
  // that unnecessarily creates a multichannel WebAudio graph and makes the
  // main thread compete with the core. Mix those sources into one normal
  // stereo destination instead, preserving peer audio with less graph work.
  try {
    const audioContext = window.EJS_emulator?.Module?.AL?.currentCtx?.audioCtx;
    const sources = window.EJS_emulator?.Module?.AL?.currentCtx?.sources || {};
    const gainNodes = Object.values(sources).map((source) => source?.gain).filter((gain) => gain && typeof gain.connect === "function");
    if (audioContext && gainNodes.length && typeof audioContext.createGain === "function" && typeof audioContext.createMediaStreamDestination === "function") {
      const mixer = audioContext.createGain();
      mixer.gain.value = 1;
      mixer.channelCount = 2;
      mixer.channelCountMode = "max";
      const destination = audioContext.createMediaStreamDestination();
      gainNodes.forEach((gain) => gain.connect(mixer));
      mixer.connect(destination);
      const audioTrack = destination.stream.getAudioTracks()[0];
      if (audioTrack?.readyState === "live") {
        audioTrack.contentHint = "music";
        stream.addTrack(audioTrack);
        state.hostAudioMixer = mixer;
        state.hostAudioDestination = destination;
        state.hostAudioCaptureMode = "optimized-mix";
        log("host_audio_capture_mix", { sourceCount: gainNodes.length, channels: 2, mode: "summed_gain_nodes" });
        return stream;
      }
    }
  } catch (error) {
    log("host_audio_capture_mix_failed", { message: error.message }, "WARN");
  }

  // Keep a compatibility fallback for EmulatorJS releases that do not expose
  // OpenAL's source graph. This is only used when the optimized mixer cannot
  // be constructed.
  try {
    const capture = window.EJS_emulator?.collectScreenRecordingMediaTracks;
    if (typeof capture === "function") {
      const captured = capture.call(window.EJS_emulator, canvas, STREAM_CAPTURE_FPS);
      const audioTrack = captured?.getAudioTracks?.()[0];
      // We already own the primary canvas video track above; do not leave the
      // fallback helper's duplicate video capture running in the background.
      captured?.getVideoTracks?.().forEach((track) => track.stop());
      if (audioTrack?.readyState === "live") {
        audioTrack.contentHint = "music";
        stream.addTrack(audioTrack);
        state.hostAudioCaptureMode = "emulatorjs-fallback";
        log("host_audio_capture_fallback", { mode: "emulatorjs_capture" }, "WARN");
      }
    }
  } catch (error) { log("host_audio_capture_fallback_failed", { message: error.message }, "WARN"); }
  return stream;
}

function refreshEmulatorLayout() {
  const emulator = window.EJS_emulator;
  try { if (typeof emulator?.handleResize === "function") emulator.handleResize(); } catch (error) { log("emulator_resize_error", { message: error.message }, "WARN"); }
}

async function ensureHostStreams() {
  if (!isHost() || !state.emulatorReady || !state.room) return;
  if (typeof window.RTCPeerConnection !== "function") {
    log("host_stream_unavailable", { reason: "WebRTC unavailable" }, "ERROR");
    return;
  }
  const peers = state.players.filter((player) => player.id !== state.self?.id);
  for (const peerId of state.hostStreamPeers.keys()) if (!peers.some((player) => player.id === peerId)) closeHostStreamPeer(peerId);
  if (!peers.length) {
    releaseHostMediaCapture();
    return;
  }
  const canvas = $("game")?.querySelector("canvas");
  if (!canvas?.captureStream) {
    scheduleHostStreams(250);
    return;
  }
  if (!state.hostStream || !state.hostStream.getVideoTracks().some((track) => track.readyState === "live")) state.hostStream = captureHostMedia(canvas);
  await Promise.all(peers.map((player) => startHostStreamForPeer(player)));
}

async function startHostStreamForPeer(peer, force = false) {
  const pending = state.hostStreamOfferPromises.get(peer.id);
  if (pending) return pending;
  const existing = state.hostStreamPeers.get(peer.id);
  if (existing && !force && !["failed", "closed"].includes(existing.connectionState)) return;
  if (existing) closeHostStreamPeer(peer.id);
  const connection = new window.RTCPeerConnection(STREAM_CONFIG);
  state.hostStreamPeers.set(peer.id, connection);
  for (const track of state.hostStream.getTracks()) {
    const sender = connection.addTrack(track, state.hostStream);
    if (typeof sender.setParameters === "function") {
      const parameters = sender.getParameters();
      parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}];
      parameters.encodings[0].maxBitrate = track.kind === "audio" ? STREAM_AUDIO_MAX_BITRATE : STREAM_MAX_BITRATE;
      parameters.encodings[0].priority = "high";
      parameters.encodings[0].networkPriority = "high";
      if (track.kind === "video") {
        parameters.encodings[0].maxFramerate = STREAM_CAPTURE_FPS;
        parameters.degradationPreference = "maintain-framerate";
      }
      try { Promise.resolve(sender.setParameters(parameters)).catch(() => {}); } catch {}
    }
  }
  connection.onicecandidate = ({ candidate }) => {
    if (candidate) streamSignal(peer.id, { kind: "candidate", candidate: candidate.toJSON ? candidate.toJSON() : candidate });
  };
  connection.onconnectionstatechange = () => {
    log("host_stream_connection_state", { peerId: peer.id, state: connection.connectionState });
    if (connection.connectionState === "failed") {
      log("host_stream_failed", { peerId: peer.id }, "WARN");
      closeHostStreamPeer(peer.id);
      scheduleHostStreams(1000);
    }
  };
  const offerPromise = (async () => {
    try {
      const offer = await connection.createOffer();
      await connection.setLocalDescription(offer);
      if (state.hostStreamPeers.get(peer.id) !== connection) { connection.close(); return; }
      connection.offerSentAt = Date.now();
      streamSignal(peer.id, { kind: "description", description: { type: connection.localDescription.type, sdp: connection.localDescription.sdp } });
      log("host_stream_offer_sent", { peerId: peer.id, slot: peer.slot });
    } catch (error) {
      log("host_stream_offer_error", { peerId: peer.id, message: error.message }, "ERROR");
      closeHostStreamPeer(peer.id);
    }
  })();
  state.hostStreamOfferPromises.set(peer.id, offerPromise);
  try { await offerPromise; } finally {
    if (state.hostStreamOfferPromises.get(peer.id) === offerPromise) state.hostStreamOfferPromises.delete(peer.id);
  }
}

async function handleStreamRequest(message) {
  if (message.targetId && message.targetId !== state.self?.id) return;
  if (!isHost() || !state.lobby || message.lobbyId !== state.lobby.id || !message.fromId) return;
  const peer = state.players.find((player) => player.id === message.fromId) || message.player;
  if (!peer) return;
  if (!state.players.some((player) => player.id === peer.id)) {
    state.players = mergePlayers(state.players, [peer]);
    renderPlayers();
  }
  log("host_stream_request_received", { peerId: message.fromId, slot: peer.slot });
  if (!state.emulatorReady) {
    scheduleHostStreams(250);
    return;
  }
  await ensureHostStreams();
  const existing = state.hostStreamPeers.get(peer.id);
  const retry = !existing || ["failed", "closed"].includes(existing.connectionState) || Date.now() - Number(existing.offerSentAt || 0) > 5000;
  if (state.hostStream) await startHostStreamForPeer(peer, retry);
}

function showRemoteStream(stream) {
  const video = $("remoteGame");
  if (state.hostStreamRequestTimer) window.clearTimeout(state.hostStreamRequestTimer);
  state.hostStreamRequestTimer = null;
  video.srcObject = stream;
  video.muted = false;
  video.volume = 1;
  video.defaultPlaybackRate = 1;
  video.playbackRate = 1;
  video.classList.remove("hidden");
  video.play().catch((error) => log("host_stream_play_error", { message: error.message }, "WARN"));
  $("emulatorStatus").textContent = "Live host feed · controller connected";
  $("bridgeBadge").textContent = "HOST STREAM";
  $("bridgeBadge").classList.add("live");
  log("host_stream_live", { tracks: stream.getTracks().map((track) => track.kind) });
}

async function handleStreamSignal(message) {
  if (message.targetId && message.targetId !== state.self?.id) return;
  if (!state.lobby || message.lobbyId !== state.lobby.id || !message.fromId || !message.signal) return;
  const { signal, fromId } = message;
  if (isHost()) {
    const connection = state.hostStreamPeers.get(fromId);
    if (!connection) return;
    try {
      if (signal.kind === "description" && signal.description?.type === "answer") await connection.setRemoteDescription(signal.description);
      if (signal.kind === "candidate") await connection.addIceCandidate(signal.candidate);
    } catch (error) { log("host_stream_signal_error", { fromId, message: error.message }, "WARN"); }
    return;
  }
  if (typeof window.RTCPeerConnection !== "function") {
    log("host_stream_unavailable", { reason: "WebRTC unavailable" }, "ERROR");
    return;
  }
  try {
    if (signal.kind === "description" && signal.description?.type === "offer") {
      // Trickle ICE can arrive before the offer over the room transport.
      // Keep those candidates until this description has been installed.
      closeRemoteStream(false);
      const connection = new window.RTCPeerConnection(STREAM_CONFIG);
      state.remoteStreamConnection = connection;
      connection.onicecandidate = ({ candidate }) => {
        if (candidate) streamSignal(fromId, { kind: "candidate", candidate: candidate.toJSON ? candidate.toJSON() : candidate });
      };
      connection.ontrack = ({ streams, track }) => showRemoteStream(streams[0] || new MediaStream([track]));
      connection.onconnectionstatechange = () => {
        log("remote_stream_connection_state", { hostId: fromId, state: connection.connectionState });
        if (connection.connectionState === "failed") log("host_stream_failed", { peerId: fromId }, "ERROR");
      };
      await connection.setRemoteDescription(signal.description);
      for (const candidate of state.remoteStreamCandidates.splice(0)) await connection.addIceCandidate(candidate);
      const answer = await connection.createAnswer();
      await connection.setLocalDescription(answer);
      streamSignal(fromId, { kind: "description", description: { type: connection.localDescription.type, sdp: connection.localDescription.sdp } });
      log("host_stream_answer_sent", { hostId: fromId });
      return;
    }
    if (signal.kind === "candidate") {
      if (state.remoteStreamConnection?.remoteDescription) await state.remoteStreamConnection.addIceCandidate(signal.candidate);
      else state.remoteStreamCandidates.push(signal.candidate);
    }
  } catch (error) { log("host_stream_signal_error", { fromId, message: error.message }, "ERROR"); }
}

function handleRoomMessage(raw) {
  let message;
  try { message = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { log("room_bad_message", { raw: String(raw).slice(0, 200) }, "ERROR"); return; }
  if (message.type === "connected") { log("server_hello", { protocol: message.protocol, connectionId: message.connectionId }); return; }
  if (message.type === "joined_lobby") {
    state.lobby = message.lobby;
    state.self = message.self;
    state.players = mergePlayers([], message.players);
    state.seq = 0;
    state.lastAck = null;
    state.lastSentInput = "";
    state.lastLoggedInput = "";
    $("partyStatus").classList.remove("hidden");
    $("activeLobbyCode").textContent = state.lobby.id;
    $("partyStatusLabel").textContent = `${state.lobby.visibility.toUpperCase()} LOBBY · P${state.self.slot}`;
    renderPlayers();
    log("lobby_joined", { lobbyId: state.lobby.id, slot: state.self.slot, playerCount: state.players.length, authority: isHost() ? "host" : "host_stream" });
    toast(`Joined ${state.lobby.id} as P${state.self.slot}`);
    if (!isHost() && state.lobby.hostReady) $("emulatorStatus").textContent = "Waiting for live host feed…";
    if (!isHost()) requestHostStream();
    announceHostReady();
    scheduleHostStreams();
    return;
  }
  if (message.type === "lobby_state") {
    if (!state.lobby || message.lobby.id !== state.lobby.id) return;
    state.lobby = message.lobby;
    state.players = mergePlayers(state.players, message.players);
    renderPlayers();
    log("lobby_state", { lobbyId: message.lobby.id, playerCount: state.players.length, authority: isHost() ? "host" : "host_stream" });
    scheduleHostStreams();
    return;
  }
  if (message.type === "join_rejected") { log("join_rejected", { code: message.code, message: message.message }, "WARN"); toast(message.message); return; }
  if (message.type === "input_ack") { state.lastAck = message.seq; return; }
  if (message.type === "input_rejected") { log("input_rejected", message, "WARN"); return; }
  if (message.type === "protocol_error") { log("protocol_error", message, "ERROR"); return; }
  if (message.type === "stream_request") { handleStreamRequest(message); return; }
  if (message.type === "stream_signal") {
    if (!message.targetId || message.targetId === state.self?.id) log("host_stream_signal_received", { fromId: message.fromId, kind: message.signal?.kind, descriptionType: message.signal?.description?.type || null });
    handleStreamSignal(message);
    return;
  }
  if (message.type === "host_emulator_ready") {
    if (!state.lobby || message.lobbyId !== state.lobby.id || message.romKey !== state.romMeta?.romKey) return;
    state.lobby.hostReady = true;
    log("host_boot_signal", { lobbyId: message.lobbyId, authority: "host_stream" });
    if (!isHost()) {
      $("emulatorStatus").textContent = "Waiting for live host feed…";
      $("bridgeBadge").textContent = "HOST STREAM";
      requestHostStream();
    }
    scheduleHostStreams();
    return;
  }
  if (message.type === "input_relay") {
    if (!state.lobby || message.lobbyId !== state.lobby.id || !message.player || !isHost()) return;
    state.players = mergePlayers(state.players, [message.player]);
    renderPlayers();
    applyRemoteInputs([message.player]);
    return;
  }
  if (message.type === "snapshot") {
    if (!state.lobby || message.lobbyId !== state.lobby.id) return;
    state.lastServerTick = message.tick;
    state.players = mergePlayers(state.players, message.players);
    renderPlayers();
    const selfFrame = state.players.find((player) => player.id === state.self?.id);
    if (selfFrame) $("inputReadout").innerHTML = `P${selfFrame.slot} INPUT <span>SEQ ${selfFrame.seq}</span>`;
    // The relay is low-latency, while snapshots are the reliable recovery
    // path if a single room message is missed. Sequence de-duplication keeps
    // this from applying the same controller frame twice.
    if (isHost()) applyRemoteInputs(state.players);
    if (message.tick % 20 === 0) log("authoritative_snapshot", { lobbyId: message.lobbyId, tick: message.tick, players: state.players.length, serverTime: message.serverTime });
  }
}

function analogAxes(input) {
  const axisX = input?.right && !input?.left ? ANALOG_MAX : input?.left && !input?.right ? -ANALOG_MAX : 0;
  const axisY = input?.down && !input?.up ? ANALOG_MAX : input?.up && !input?.down ? -ANALOG_MAX : 0;
  return { axisX, axisY };
}

function applyAnalogInput(port, axisX, axisY) {
  const hook = getInputHook();
  if (!hook) return;
  const x = Math.max(-ANALOG_MAX, Math.min(ANALOG_MAX, Number(axisX) || 0));
  const y = Math.max(-ANALOG_MAX, Math.min(ANALOG_MAX, Number(axisY) || 0));
  // EmulatorJS maps the N64 left stick to four signed half-axis inputs:
  // 16=X+, 17=X-, 18=Y+, 19=Y-. Values are signed 16-bit magnitudes.
  hook(port, 16, x > 0 ? x : 0);
  hook(port, 17, x < 0 ? -x : 0);
  hook(port, 18, y > 0 ? y : 0);
  hook(port, 19, y < 0 ? -y : 0);
}

function applyRemoteInputs(players) {
  const hook = getInputHook();
  if (!hook) return;
  const activeIds = new Set((players || []).filter((player) => player.id !== state.self?.id).map((player) => player.id));
  for (const [playerId, previous] of state.remoteInputState) {
    if (activeIds.has(playerId)) continue;
    applyControllerInput(Math.max(0, previous.slot - 1), { buttons: {}, axisX: 0, axisY: 0 }, previous);
    state.remoteInputState.delete(playerId);
    state.remoteAppliedInputSeq.delete(playerId);
  }
  for (const player of players || []) {
    if (player.id === state.self?.id || !player.input) continue;
    const previous = state.remoteInputState.get(player.id);
    if (previous?.seq === player.input.seq) continue;
    const applied = applyControllerInput(Math.max(0, player.slot - 1), player.input, previous);
    state.remoteInputState.set(player.id, { ...applied, seq: player.input.seq, slot: player.slot });
    state.remoteAppliedInputSeq.set(player.id, player.input.seq);
  }
}

function applyControllerInput(port, input, previous = null) {
  const hook = getInputHook();
  if (!hook) return previous || { axisX: 0, axisY: 0, buttons: {}, slot: port + 1 };
  const axisX = Number(input?.axisX) || 0;
  const axisY = Number(input?.axisY) || 0;
  const previousButtons = previous?.buttons || {};
  const buttons = input?.buttons || {};
  if (!previous || previous.axisX !== axisX || previous.axisY !== axisY) applyAnalogInput(port, axisX, axisY);
  for (const key of Object.keys(controllerButtonMap)) {
    const pressed = buttons[key] === true;
    if (previous && previousButtons[key] === pressed) continue;
    try { hook(port, controllerButtonMap[key], pressed ? 1 : 0); } catch (error) { log("input_hook_error", { player: port + 1, key, message: error.message }, "WARN"); }
  }
  return { axisX, axisY, buttons: Object.fromEntries(Object.keys(controllerButtonMap).map((key) => [key, buttons[key] === true])) };
}

const controllerButtonMap = { a: 0, b: 8, z: 12, start: 3, l: 10, r: 11, dUp: 4, dDown: 5, dLeft: 6, dRight: 7, cUp: 23, cDown: 22, cLeft: 21, cRight: 20 };

function applyLocalInput() {
  if (!getInputHook() || !state.self) return;
  const axes = analogAxes(state.input);
  state.localInputState = applyControllerInput(Math.max(0, state.self.slot - 1), { buttons: state.input, axisX: axes.axisX, axisY: axes.axisY }, state.localInputState);
}

function getInputHook() {
  if (typeof window.EJS_emulator?.gameManager?.simulateInput === "function") return (port, input, value) => window.EJS_emulator.gameManager.simulateInput(port, input, value);
  if (typeof window.simulate_input === "function") return (port, input, value) => window.simulate_input(port, input, value);
  return null;
}

async function waitForEmulatorCapabilities() {
  const startedAt = performance.now();
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const capabilities = { inputHook: Boolean(getInputHook()), getState: typeof window.EJS_emulator?.gameManager?.getState === "function", loadState: typeof window.EJS_emulator?.gameManager?.loadState === "function" };
    if (capabilities.inputHook) applyLocalInput();
    if (capabilities.inputHook) {
      log("emulator_input_ready", { ...capabilities, waitMs: Math.round(performance.now() - startedAt) });
      announceHostReady();
      scheduleHostStreams(250);
      return;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 100));
  }
  log("emulator_capabilities_timeout", { inputHook: Boolean(getInputHook()), getState: typeof window.EJS_emulator?.gameManager?.getState === "function", loadState: typeof window.EJS_emulator?.gameManager?.loadState === "function", waitMs: Math.round(performance.now() - startedAt) }, "WARN");
  scheduleHostStreams(250);
}

function inputSignature() { return JSON.stringify(state.input); }

function sendInput(force = false) {
  if (!state.room || !state.self) return;
  const signature = inputSignature();
  if (!force && signature === state.lastSentInput) return;
  state.lastSentInput = signature;
  state.seq += 1;
  const axes = analogAxes(state.input);
  state.room.send({ type: "input", seq: state.seq, buttons: state.input, axisX: axes.axisX, axisY: axes.axisY });
  const buttons = Object.entries(state.input).filter(([, value]) => value).map(([key]) => key);
  if (signature !== state.lastLoggedInput || state.seq % 20 === 0) { state.lastLoggedInput = signature; log("input_sent", { seq: state.seq, buttons, axisX: axes.axisX, axisY: axes.axisY }); }
}

function setKey(key, pressed) {
  if (!(key in state.input) || state.input[key] === pressed) return;
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
  window.setInterval(() => { if (state.self) sendInput(true); }, INPUT_HEARTBEAT_MS);
}

async function launchEmulator(reason = "manual") {
  if (!state.rom) return;
  if (state.lobby && !isHost()) {
    toast("The host core is live — use your controller inputs here");
    log("emulator_boot_blocked", { reason: "host_authoritative_peer" }, "WARN");
    return;
  }
  if (isHost()) closeAllStreams();
  stopEmulatorFrameMonitor();
  if (typeof window.EJS_terminate === "function") { try { window.EJS_terminate(); } catch {} }
  if (state.romUrl) URL.revokeObjectURL(state.romUrl);
  state.romUrl = URL.createObjectURL(state.romLaunchBlob || state.rom);
  const game = $("game");
  game.innerHTML = "";
  state.emulatorStarted = true;
  state.emulatorReady = false;
  state.hostReadySignalSent = false;
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
  window.EJS_threads = Boolean(window.crossOriginIsolated && typeof window.SharedArrayBuffer === "function");
  window.EJS_disableLocalStorage = true;
  // Let Mupen64Plus-Next select its supported WebGL path. The old
  // webgl2Enabled internal flag could force a mismatched renderer and cause
  // corrupted N64 frames on some browsers.
  window.EJS_forceLegacyCores = false;
  window.EJS_defaultOptions = {
    ...(window.EJS_defaultOptions || {}),
    // Keep the core synchronized to the browser's display/audio cadence.
    // With this WebAssembly/RetroArch path, disabling VSync can present at
    // an apparent half-rate even while the internal frame counter advances.
    vsync: "enabled",
    fastForward: "disabled",
    slowMotion: "disabled",
    shader: "disabled",
    // Mupen64Plus-Next performance profile. The prefix and option values
    // match the current libretro core (mupen64plus_next).
    "mupen64plus_next-rdp-plugin": "gliden64",
    "mupen64plus_next-cpucore": "dynamic_recompiler",
    "mupen64plus_next-rsp-plugin": "hle",
    // 640x480 is four times the native N64 pixel count. 320x240 materially
    // reduces GL work while preserving the 4:3 image and framebuffer effects.
    "mupen64plus_next-43screensize": "320x240",
    "mupen64plus_next-aspect": "4:3",
    "mupen64plus_next-EnableNativeResFactor": "0",
    // Use the threaded renderer only when the core can actually create
    // pthread workers. The stable CDN build is single-threaded on Websim
    // because crossOriginIsolated is currently false.
    "mupen64plus_next-ThreadedRenderer": window.EJS_threads ? "True" : "False",
    // Gauntlet's HUD is composed of native-resolution texrects. The
    // optimized path prevents the player panels from being split or clipped
    // while avoiding the slower unoptimized 2D path.
    "mupen64plus_next-EnableNativeResTexrects": "Optimized",
    "mupen64plus_next-BilinearMode": "3point",
    // The hybrid integer filter is enabled by default in some GLideN64
    // builds and can be expensive on a browser GPU. The native 320x240
    // output does not need it.
    "mupen64plus_next-HybridFilter": "False",
    // Per-pixel texture LOD is useful for texture packs, not this native
    // resolution ROM, and adds shader work during the 3D scenes.
    "mupen64plus_next-EnableLODEmulation": "False",
    // GLideN64's legacy blend path avoids shader-based N64 blend emulation.
    // It is explicitly documented as faster on slow GPUs, with some visual
    // accuracy tradeoffs; framebuffer emulation and the native HUD path stay
    // enabled because Gauntlet relies on them.
    "mupen64plus_next-EnableLegacyBlending": FAST_RENDER_PROFILE ? "True" : "False",
    "mupen64plus_next-Framerate": "Original",
    "mupen64plus_next-MultiSampling": "0",
    "mupen64plus_next-FXAA": "0",
    "mupen64plus_next-EnableFBEmulation": "True",
    "mupen64plus_next-EnableCopyColorToRDRAM": "Async",
    "mupen64plus_next-EnableCopyDepthToRDRAM": "Off",
    "mupen64plus_next-EnableHWLighting": "False",
    "mupen64plus_next-EnableShadersStorage": "True",
    "mupen64plus_next-EnableTextureCache": "True",
    "mupen64plus_next-txHiresEnable": "False",
  };
  window.EJS_startOnLoaded = true;
  window.EJS_DEBUG_XX = false;
  window.EJS_controlScheme = "n64";
  window.EJS_onGameStart = () => { log("emulator_game_started", { core: EMULATOR_CORE, threads: Boolean(window.EJS_threads), vsync: window.EJS_defaultOptions?.vsync, renderProfile: FAST_RENDER_PROFILE ? "legacy-blending" : "compatibility" }); startEmulatorFrameMonitor(); };
  window.EJS_ready = () => { state.emulatorReady = true; refreshEmulatorLayout(); $("bridgeCoreState").textContent = "READY"; $("bridgeCoreState").className = "ready"; $("bridgeBadge").textContent = "CORE READY"; $("bridgeBadge").classList.add("live"); $("emulatorStatus").textContent = "N64 host core ready"; log("emulator_ready", { core: EMULATOR_CORE, inputHook: Boolean(getInputHook()), getState: typeof window.EJS_emulator?.gameManager?.getState === "function", loadState: typeof window.EJS_emulator?.gameManager?.loadState === "function", threads: Boolean(window.EJS_threads), crossOriginIsolated: Boolean(window.crossOriginIsolated), hardwareConcurrency: navigator.hardwareConcurrency || null, vsync: window.EJS_defaultOptions?.vsync, internalResolution: window.EJS_defaultOptions?.[`${EMULATOR_CORE}-43screensize`], cpuCore: window.EJS_defaultOptions?.[`${EMULATOR_CORE}-cpucore`], rsp: window.EJS_defaultOptions?.[`${EMULATOR_CORE}-rsp-plugin`], nativeHud: window.EJS_defaultOptions?.[`${EMULATOR_CORE}-EnableNativeResTexrects`], legacyBlending: window.EJS_defaultOptions?.[`${EMULATOR_CORE}-EnableLegacyBlending`], framebufferEmulation: window.EJS_defaultOptions?.[`${EMULATOR_CORE}-EnableFBEmulation`], streamFps: STREAM_CAPTURE_FPS, streamBitrate: STREAM_MAX_BITRATE, volume: window.EJS_volume, renderProfile: FAST_RENDER_PROFILE ? "legacy-blending" : "compatibility" }); startEmulatorFrameMonitor(); waitForEmulatorCapabilities(); };
  window.EJS_onExit = () => { state.emulatorStarted = false; state.emulatorReady = false; stopEmulatorFrameMonitor(); if (isHost()) closeAllStreams(); $("emulatorStatus").textContent = "Emulator exited"; log("emulator_exit"); };
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
  closeAllStreams();
  state.room = null; state.lobby = null; state.self = null; state.players = [];
  $("partyStatus").classList.add("hidden"); renderPlayers(); setConnection("", "OFFLINE"); $("bridgeInputState").textContent = "LOCKED"; $("bridgeInputState").className = "";
  log("lobby_left", { lobbyId: id });
}

function tickClock() { $("emulatorClock").textContent = new Date().toISOString().slice(11, 19); }

function stopEmulatorFrameMonitor() {
  if (state.emulatorPerfTimer) window.clearInterval(state.emulatorPerfTimer);
  if (state.emulatorPerfStartTimer) window.clearTimeout(state.emulatorPerfStartTimer);
  state.emulatorPerfTimer = null;
  state.emulatorPerfStartTimer = null;
  state.emulatorPerfLastFrame = null;
  state.emulatorPerfLastAt = 0;
}

function startEmulatorFrameMonitor(attempt = 0) {
  if (state.emulatorPerfTimer || state.emulatorPerfStartTimer) return;
  const gameManager = window.EJS_emulator?.gameManager;
  if (typeof gameManager?.getFrameNum !== "function") {
    if (attempt < 20) {
      state.emulatorPerfStartTimer = window.setTimeout(() => {
        state.emulatorPerfStartTimer = null;
        startEmulatorFrameMonitor(attempt + 1);
      }, 500);
    } else {
      log("emulator_frame_rate_unavailable", { reason: "getFrameNum_not_exposed" }, "WARN");
    }
    return;
  }
  const getFrameNum = () => gameManager.getFrameNum();
  try { state.emulatorPerfLastFrame = Number(getFrameNum()); } catch { state.emulatorPerfLastFrame = 0; }
  state.emulatorPerfLastAt = performance.now();
  state.emulatorPerfTimer = window.setInterval(() => {
    const now = performance.now();
    let frame;
    try { frame = Number(getFrameNum()); } catch { return; }
    const elapsedMs = now - state.emulatorPerfLastAt;
    const frameDelta = frame - state.emulatorPerfLastFrame;
    const fps = elapsedMs > 0 ? frameDelta * 1000 / elapsedMs : 0;
    state.emulatorPerfLastFrame = frame;
    state.emulatorPerfLastAt = now;
    log("emulator_frame_rate", { fps: Math.round(fps * 10) / 10, frameDelta, elapsedMs: Math.round(elapsedMs), vsync: window.EJS_defaultOptions?.vsync }, fps < 50 ? "WARN" : "INFO");
  }, 5000);
}

function startMainThreadMonitor() {
  if (state.mainThreadMonitorTimer) window.clearInterval(state.mainThreadMonitorTimer);
  let expected = performance.now() + 1000;
  state.mainThreadMonitorTimer = window.setInterval(() => {
    const now = performance.now();
    const driftMs = Math.max(0, Math.round(now - expected));
    expected = now + 1000;
    if (driftMs < 250 || now - state.mainThreadLastWarnAt < 5000) return;
    state.mainThreadLastWarnAt = now;
    log("main_thread_stall", { driftMs, hidden: document.hidden, emulatorReady: state.emulatorReady, threads: Boolean(window.EJS_threads) }, "WARN");
  }, 1000);
}

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
  bindUI(); setupKeyboard(); startMainThreadMonitor(); window.setInterval(tickClock, 1000);
  let resizeTimer = null;
  window.addEventListener("resize", () => { window.clearTimeout(resizeTimer); resizeTimer = window.setTimeout(refreshEmulatorLayout, 80); }, { passive: true });
  refreshLobbies();
  try { state.user = await window.websim?.getUser?.(); log("identity_loaded", { signedIn: Boolean(state.user), username: state.user?.username || null }); }
  catch (error) { log("identity_error", { message: error.message }, "WARN"); }
  log("client_ready", { browser: navigator.userAgent, protocol: "host-authority/1.0", crossOriginIsolated: Boolean(window.crossOriginIsolated), sharedArrayBuffer: typeof window.SharedArrayBuffer === "function", serviceWorkerControlled: Boolean(navigator.serviceWorker?.controller) });
}

boot();
