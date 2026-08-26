const state = {
  user: null,
  selectedVisibility: "public",
  rom: null,
  romMeta: null,
  romUrl: null,
  room: null,
  lobby: null,
  self: null,
  players: [],
  logs: [],
  input: { up: false, down: false, left: false, right: false, a: false, b: false, z: false, start: false, cUp: false, cDown: false, cLeft: false, cRight: false },
  seq: 0,
  lastSentInput: "",
  lastAck: null,
  emulatorStarted: false,
  emulatorReady: false,
  emulatorScript: null,
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
  state.rom = file;
  const bytes = new Uint8Array(await file.slice(0, Math.min(file.size, 1024 * 1024)).arrayBuffer());
  const meta = identifyRom(file, bytes);
  const hashBuffer = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  const hash = [...new Uint8Array(hashBuffer)].map((value) => value.toString(16).padStart(2, "0")).join("");
  state.romMeta = { ...meta, hash, size: file.size, name: file.name, lastModified: file.lastModified };
  $("romCard").classList.remove("hidden");
  $("romName").textContent = file.name;
  $("romSize").textContent = formatBytes(file.size);
  $("romFormat").textContent = meta.format;
  $("romHash").textContent = hash.slice(0, 18) + "…";
  $("romTitle").textContent = meta.title;
  $("romCheck").textContent = meta.looksLikeGauntlet ? "GAUNTLET MATCH" : (meta.headerOk ? "N64 HEADER FOUND" : "CHECK FILE");
  $("romCheck").classList.toggle("warn", !meta.looksLikeGauntlet);
  $("launchButton").disabled = false;
  $("bridgeRomState").textContent = meta.looksLikeGauntlet ? "MATCH" : "VERIFY";
  $("bridgeRomState").className = meta.looksLikeGauntlet ? "ready" : "amber";
  log("rom_inspected", { name: file.name, bytes: file.size, magic: meta.magic, format: meta.format, title: meta.title, sha256: hash, gauntletNameMatch: meta.looksLikeGauntlet });
}

function buildReport() {
  return JSON.stringify({
    report: "gauntlet-netplay-debug/0.1",
    generatedAt: new Date().toISOString(),
    browser: navigator.userAgent,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    rom: state.romMeta ? { ...state.romMeta } : null,
    connection: { lobby: state.lobby?.id || null, self: state.self, players: state.players.map(({ id, username, slot, seq }) => ({ id, username, slot, seq })), lastAck: state.lastAck },
    emulator: { started: state.emulatorStarted, ready: state.emulatorReady, EJS: Boolean(window.EJS_emulator), gameManager: Boolean(window.EJS_emulator?.gameManager), simulateInput: typeof window.EJS_emulator?.gameManager?.simulateInput === "function" },
    protocol: { name: "input-authority/0.1", inputSequence: state.seq, currentInput: state.input },
    recentLogs: state.logs.slice(-80),
  }, null, 2);
}

function renderPlayers() {
  const slots = $("playerSlots");
  const playersBySlot = new Map(state.players.map((player) => [player.slot, player]));
  slots.innerHTML = [1, 2, 3, 4].map((slot) => {
    const player = playersBySlot.get(slot);
    const label = player ? (player.id === state.self?.id ? `${player.username || "YOU"} · YOU` : player.username || "PLAYER") : "OPEN SLOT";
    return `<div class="player-slot ${player ? "active" : ""}"><span class="slot-number">P${slot}</span><span class="slot-name">${escapeHtml(label)}</span></div>`;
  }).join("");
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
  state.room.onreconnect = () => { log("room_reconnected", {}, "WARN"); setConnection("live", "ROOM RECONNECTED"); if (state.lobby) state.room.send({ type: "join_lobby", lobbyId: state.lobby.id }); };
  state.room.onclose = (event) => { log("room_closed", { code: event.code, reason: event.reason }, "WARN"); setConnection("error", "ROOM CLOSED"); state.room = null; state.self = null; };
  return state.room;
}

async function joinLobby(code) {
  const lobbyId = String(code || $("lobbyCodeInput").value).trim().toUpperCase();
  if (!lobbyId) { toast("Enter a lobby code"); return; }
  if (!state.user) { toast("Sign in to join a lobby"); log("lobby_join_blocked", { reason: "signed_out", lobbyId }, "WARN"); return; }
  try {
    const room = await connectRoom();
    room.send({ type: "join_lobby", lobbyId });
    log("join_lobby_sent", { lobbyId });
  } catch (error) { log("room_connect_error", { message: error.message }, "ERROR"); setConnection("error", "CONNECT ERROR"); toast(error.message); }
}

function handleRoomMessage(raw) {
  let message;
  try { message = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { log("room_bad_message", { raw: String(raw).slice(0, 200) }, "ERROR"); return; }
  if (message.type === "connected") { log("server_hello", { protocol: message.protocol, connectionId: message.connectionId }); return; }
  if (message.type === "joined_lobby") {
    state.lobby = message.lobby;
    state.self = message.self;
    state.players = message.players || [];
    $("partyStatus").classList.remove("hidden");
    $("activeLobbyCode").textContent = state.lobby.id;
    $("partyStatusLabel").textContent = `${state.lobby.visibility.toUpperCase()} LOBBY · P${state.self.slot}`;
    renderPlayers();
    log("lobby_joined", { lobbyId: state.lobby.id, slot: state.self.slot, playerCount: state.players.length });
    toast(`Joined ${state.lobby.id} as P${state.self.slot}`);
    return;
  }
  if (message.type === "lobby_state") { state.lobby = message.lobby; state.players = message.players || []; renderPlayers(); log("lobby_state", { lobbyId: message.lobby.id, playerCount: state.players.length }); return; }
  if (message.type === "join_rejected") { log("join_rejected", { code: message.code, message: message.message }, "WARN"); toast(message.message); return; }
  if (message.type === "input_ack") { state.lastAck = message.seq; return; }
  if (message.type === "input_rejected") { log("input_rejected", message, "WARN"); return; }
  if (message.type === "protocol_error") { log("protocol_error", message, "ERROR"); return; }
  if (message.type === "snapshot") {
    state.players = message.players || state.players;
    renderPlayers();
    const selfFrame = state.players.find((player) => player.id === state.self?.id);
    if (selfFrame) $("inputReadout").innerHTML = `P${selfFrame.slot} INPUT <span>SEQ ${selfFrame.seq}</span>`;
    applyRemoteInputs(state.players);
    if (message.tick % 20 === 0) log("authoritative_snapshot", { lobbyId: message.lobbyId, tick: message.tick, players: state.players.length, serverTime: message.serverTime });
  }
}

function applyRemoteInputs(players) {
  if (!window.EJS_emulator?.gameManager?.simulateInput) return;
  const map = { a: 0, b: 8, z: 12, start: 3, up: 4, down: 5, left: 6, right: 7, cUp: 13, cDown: 14, cLeft: 15, cRight: 16 };
  for (const player of players) {
    if (player.id === state.self?.id || !player.input) continue;
    for (const [key, value] of Object.entries(player.input.buttons || {})) {
      if (!(key in map)) continue;
      try { window.EJS_emulator.gameManager.simulateInput(Math.max(0, player.slot - 1), map[key], value ? 1 : 0); } catch (error) { log("remote_input_hook_error", { player: player.slot, key, message: error.message }, "WARN"); }
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
  log("input_sent", { seq: state.seq, buttons: Object.entries(state.input).filter(([, value]) => value).map(([key]) => key) });
}

function setKey(key, pressed) { if (!(key in state.input)) return; state.input[key] = pressed; sendInput(true); }

function setupKeyboard() {
  const keys = { w: "up", arrowup: "up", s: "down", arrowdown: "down", a: "left", arrowleft: "left", d: "right", arrowright: "right", j: "a", k: "b", q: "z", enter: "start", u: "cUp", i: "cRight", o: "cDown", p: "cLeft" };
  window.addEventListener("keydown", (event) => { const key = keys[event.key.toLowerCase()]; if (!key) return; event.preventDefault(); setKey(key, true); });
  window.addEventListener("keyup", (event) => { const key = keys[event.key.toLowerCase()]; if (!key) return; event.preventDefault(); setKey(key, false); });
  window.setInterval(() => { if (state.self) sendInput(true); }, 100);
}

async function launchEmulator() {
  if (!state.rom) return;
  if (typeof window.EJS_terminate === "function") { try { window.EJS_terminate(); } catch {} }
  if (state.romUrl) URL.revokeObjectURL(state.romUrl);
  state.romUrl = URL.createObjectURL(state.rom);
  const game = $("game");
  game.innerHTML = "";
  state.emulatorStarted = true;
  state.emulatorReady = false;
  $("bridgeCoreState").textContent = "LOADING";
  $("bridgeCoreState").className = "amber";
  $("bridgeBadge").textContent = "BOOTING";
  $("emulatorStatus").textContent = "Loading Mupen64Plus Next core…";
  log("emulator_boot_requested", { core: "mupen64plus_next", dataPath: "https://cdn.emulatorjs.org/stable/data/", rom: state.rom.name });
  window.EJS_player = "#game";
  window.EJS_core = "n64";
  window.EJS_gameUrl = state.romUrl;
  window.EJS_gameName = state.rom.name;
  window.EJS_biosUrl = "";
  window.EJS_pathtodata = "https://cdn.emulatorjs.org/stable/data/";
  window.EJS_startOnLoaded = true;
  window.EJS_DEBUG_XX = true;
  window.EJS_controlScheme = "n64";
  window.EJS_ready = () => { state.emulatorReady = true; $("bridgeCoreState").textContent = "READY"; $("bridgeCoreState").className = "ready"; $("bridgeBadge").textContent = "CORE READY"; $("bridgeBadge").classList.add("live"); $("emulatorStatus").textContent = "N64 core ready · local frame"; log("emulator_ready", { simulateInput: typeof window.EJS_emulator?.gameManager?.simulateInput === "function" }); };
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
