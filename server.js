const MAX_PLAYERS = 4;
const MAX_STREAM_SIGNAL_CHARS = 48000;
const MAX_AXIS_VALUE = 0x7fff;
const SNAPSHOT_EVERY_TICKS = 2;
const INPUT_KEYS = ["up", "down", "left", "right", "dUp", "dDown", "dLeft", "dRight", "a", "b", "z", "start", "l", "r", "cUp", "cDown", "cLeft", "cRight"];
const activeLobbies = new Map();
const connectionLobbies = new Map();

export const schema = `
  CREATE TABLE IF NOT EXISTS lobbies (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    username TEXT NOT NULL,
    visibility TEXT NOT NULL,
    max_players INTEGER NOT NULL DEFAULT 4,
    status TEXT NOT NULL DEFAULT 'open',
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS lobbies_open ON lobbies (status, visibility, created_at);
  CREATE TABLE IF NOT EXISTS lobby_runtime (
    lobby_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    rom_key TEXT NOT NULL,
    patch_profile TEXT NOT NULL,
    host_ready INTEGER NOT NULL DEFAULT 0,
    state_version INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );
`;

function reply(data, status = 200) {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}

function currentUser(request) {
  const userId = request.headers.get("x-websim-user-id");
  const username = request.headers.get("x-websim-username") || "player";
  return userId ? { userId, username } : null;
}

function newLobbyCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i += 1) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return code;
}

function safeLobbyId(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
}

function lobbySummary(lobby) {
  return {
    id: lobby.id,
    visibility: lobby.visibility,
    maxPlayers: MAX_PLAYERS,
    playerCount: lobby.members ? lobby.members.size : 0,
    host: lobby.username,
    romKey: lobby.romKey || null,
    patchProfile: lobby.patchProfile || null,
    stateVersion: lobby.stateVersion || 0,
    hostReady: Boolean(lobby.hostReady),
  };
}

function memberSummary(member) {
  return { id: member.conn.id, username: member.username, slot: member.slot, ready: true, lastSeq: member.lastSeq };
}

function publicPlayers(lobby) {
  return [...lobby.members.values()].sort((a, b) => a.slot - b.slot).map(memberSummary);
}

async function broadcastLobby(lobby, room) {
  const message = { type: "lobby_state", lobby: lobbySummary(lobby), players: publicPlayers(lobby), serverTime: Date.now() };
  if (room?.broadcast) room.broadcast(message);
  else for (const member of lobby.members.values()) member.conn.send(message);
}

function sanitizeInput(raw, lastSeq) {
  if (!raw || typeof raw !== "object") return null;
  const seq = Number(raw.seq);
  if (!Number.isSafeInteger(seq) || seq < 0 || seq <= lastSeq || seq > lastSeq + 120) return null;
  const buttons = {};
  for (const key of INPUT_KEYS) buttons[key] = raw.buttons && raw.buttons[key] === true;
  const clampAxis = (value) => Math.max(-MAX_AXIS_VALUE, Math.min(MAX_AXIS_VALUE, Number.isFinite(Number(value)) ? Number(value) : 0));
  return { seq, buttons, axisX: clampAxis(raw.axisX), axisY: clampAxis(raw.axisY), receivedAt: Date.now() };
}

function sanitizeStreamSignal(value) {
  if (!value || typeof value !== "object") return null;
  if (value.kind === "description") {
    const type = value.description?.type;
    const sdp = String(value.description?.sdp || "");
    if ((type !== "offer" && type !== "answer") || !sdp || sdp.length > MAX_STREAM_SIGNAL_CHARS) return null;
    return { kind: "description", description: { type, sdp } };
  }
  if (value.kind === "candidate") {
    const candidate = String(value.candidate?.candidate || "");
    const sdpMid = value.candidate?.sdpMid == null ? null : String(value.candidate.sdpMid).slice(0, 80);
    const rawMLineIndex = value.candidate?.sdpMLineIndex;
    const sdpMLineIndex = rawMLineIndex == null || rawMLineIndex === "" ? null : Number(rawMLineIndex);
    if (!candidate || candidate.length > 4000 || (!sdpMid && sdpMLineIndex == null) || (sdpMLineIndex != null && (!Number.isSafeInteger(sdpMLineIndex) || sdpMLineIndex < 0 || sdpMLineIndex > 64))) return null;
    return { kind: "candidate", candidate: { candidate, sdpMid, sdpMLineIndex, usernameFragment: String(value.candidate?.usernameFragment || "").slice(0, 256) } };
  }
  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const user = currentUser(request);

    if (request.method === "GET" && url.pathname === "/api/health") {
      return reply({ ok: true, service: "gauntlet-netplay", protocol: "host-authority/1.0", maxPlayers: MAX_PLAYERS });
    }

    if (request.method === "GET" && url.pathname === "/api/lobbies") {
      const { results } = await env.DB.prepare(
        "SELECT id, username, visibility, max_players, created_at FROM lobbies WHERE status = 'open' AND visibility = 'public' ORDER BY created_at DESC LIMIT 40"
      ).all();
      const now = Date.now();
      return reply(results.filter((row) => now - Number(row.created_at) < 1000 * 60 * 60).map((row) => {
        const active = activeLobbies.get(row.id);
        return { id: row.id, visibility: row.visibility, maxPlayers: row.max_players, playerCount: active ? active.members.size : 0, host: row.username };
      }));
    }

    if (request.method === "POST" && url.pathname === "/api/lobbies") {
      if (!user) return reply({ error: "Sign in to create a lobby." }, 401);
      let body = {};
      try { body = await request.json(); } catch { return reply({ error: "Expected JSON." }, 400); }
      const visibility = body.visibility === "private" ? "private" : "public";
      let id = newLobbyCode();
      for (let tries = 0; tries < 4; tries += 1) {
        const exists = await env.DB.prepare("SELECT id FROM lobbies WHERE id = ?").bind(id).first();
        if (!exists) break;
        id = newLobbyCode();
      }
      const now = Date.now();
      await env.DB.prepare(
        "INSERT INTO lobbies (id, user_id, username, visibility, max_players, status, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, 'open', ?, ?)"
      ).bind(id, user.userId, user.username, visibility, MAX_PLAYERS, now, now).run();
      console.log(JSON.stringify({ event: "lobby_created", lobbyId: id, userId: user.userId, visibility }));
      return reply({ lobby: { id, visibility, maxPlayers: MAX_PLAYERS, playerCount: 0, host: user.username } }, 201);
    }

    if (request.method === "DELETE" && url.pathname.startsWith("/api/lobbies/")) {
      if (!user) return reply({ error: "Sign in required." }, 401);
      const id = safeLobbyId(url.pathname.split("/").pop());
      const row = await env.DB.prepare("SELECT user_id FROM lobbies WHERE id = ?").bind(id).first();
      if (!row) return reply({ error: "Lobby not found." }, 404);
      if (row.user_id !== user.userId) return reply({ error: "Only the host can close this lobby." }, 403);
      await env.DB.prepare("UPDATE lobbies SET status = 'closed', last_seen_at = ? WHERE id = ?").bind(Date.now(), id).run();
      activeLobbies.delete(id);
      return reply({ ok: true });
    }

    return new Response("Not found", { status: 404 });
  },
};

export const room = {
  tickMs: 50,

  async onConnect(conn) {
    if (conn.identity !== "user") {
      conn.close(4001, "Sign in to play");
      return;
    }
    conn.send({ type: "connected", connectionId: conn.id, protocol: "host-authority/1.0", serverTime: Date.now() });
    console.log(JSON.stringify({ event: "room_connected", connectionId: conn.id, userId: conn.userId, username: conn.username }));
  },

  async onMessage(conn, message, room, env) {
    let input;
    try { input = typeof message === "string" ? JSON.parse(message) : message; } catch { conn.send({ type: "protocol_error", code: "BAD_JSON" }); return; }
    if (!input || typeof input.type !== "string") return;

    if (input.type === "join_lobby") {
      const lobbyId = safeLobbyId(input.lobbyId);
      const row = await env.DB.prepare("SELECT id, username, visibility, max_players, status FROM lobbies WHERE id = ?").bind(lobbyId).first();
      if (!row || row.status !== "open") { conn.send({ type: "join_rejected", code: "LOBBY_NOT_FOUND", message: "That lobby is closed or missing." }); return; }
      const runtime = await env.DB.prepare("SELECT rom_key, patch_profile, host_ready, state_version FROM lobby_runtime WHERE lobby_id = ?").bind(lobbyId).first();
      let lobby = activeLobbies.get(lobbyId);
      if (!lobby) {
        lobby = { id: lobbyId, visibility: row.visibility, username: row.username, members: new Map(), createdAt: Date.now(), tick: 0, stateVersion: Number(runtime?.state_version || 0), hostConnectionId: null, hostReady: runtime?.host_ready === 1, romKey: runtime?.rom_key || null, patchProfile: runtime?.patch_profile || null };
        activeLobbies.set(lobbyId, lobby);
      } else if (runtime) {
        lobby.hostReady = runtime.host_ready === 1;
        lobby.stateVersion = Math.max(lobby.stateVersion || 0, Number(runtime.state_version || 0));
        if (!lobby.romKey) lobby.romKey = runtime.rom_key;
        if (!lobby.patchProfile) lobby.patchProfile = runtime.patch_profile;
      }
      if (lobby.members.size >= MAX_PLAYERS) { conn.send({ type: "join_rejected", code: "LOBBY_FULL", message: "That lobby already has four players." }); return; }
      for (const member of lobby.members.values()) if (member.userId === conn.userId) { conn.send({ type: "join_rejected", code: "ALREADY_JOINED", message: "You are already in this lobby." }); return; }
      const usedSlots = new Set([...lobby.members.values()].map((member) => member.slot));
      const slot = [1, 2, 3, 4].find((candidate) => !usedSlots.has(candidate));
      const romKey = String(input.romKey || "").toLowerCase();
      const patchProfile = String(input.patchProfile || "").slice(0, 80);
      if (input.romValid !== true || !/^[a-f0-9]{64}$/.test(romKey)) { conn.send({ type: "join_rejected", code: "ROM_REQUIRED", message: "Load and validate the Gauntlet Legends ROM before joining." }); return; }
      if (lobby.romKey && lobby.romKey !== romKey) { conn.send({ type: "join_rejected", code: "ROM_MISMATCH", message: "Your ROM fingerprint does not match the host's ROM." }); return; }
      if (!lobby.romKey) { lobby.romKey = romKey; lobby.patchProfile = patchProfile || "gl-n64-websim-bridge-0.1"; }
      const member = { conn, userId: conn.userId, username: conn.username || "player", slot, lastSeq: -1, latestInput: null, joinedAt: Date.now(), romKey, patchProfile };
      lobby.members.set(conn.id, member);
      connectionLobbies.set(conn.id, lobbyId);
      if (!lobby.hostConnectionId || slot === 1) lobby.hostConnectionId = slot === 1 ? conn.id : lobby.hostConnectionId;
      await env.DB.prepare("UPDATE lobbies SET last_seen_at = ? WHERE id = ?").bind(Date.now(), lobbyId).run();
      conn.send({ type: "joined_lobby", lobby: lobbySummary(lobby), self: memberSummary(member), players: publicPlayers(lobby), serverTime: Date.now() });
      await broadcastLobby(lobby, room);
      console.log(JSON.stringify({ event: "lobby_joined", lobbyId, connectionId: conn.id, slot, playerCount: lobby.members.size }));
      return;
    }

    const lobbyId = connectionLobbies.get(conn.id);
    const lobby = lobbyId ? activeLobbies.get(lobbyId) : null;
    const me = lobby ? lobby.members.get(conn.id) : null;
    if (!me) { conn.send({ type: "protocol_error", code: "JOIN_REQUIRED" }); return; }

    if (input.type === "input") {
      const sanitized = sanitizeInput(input, me.lastSeq);
      if (!sanitized) { conn.send({ type: "input_rejected", code: "INVALID_SEQUENCE_OR_RANGE", lastSeq: me.lastSeq }); return; }
      me.lastSeq = sanitized.seq;
      me.latestInput = sanitized;
      conn.send({ type: "input_ack", seq: me.lastSeq, serverTime: Date.now() });
      const host = lobby.members.get(lobby.hostConnectionId);
      if (host && host.conn.id !== conn.id) host.conn.send({ type: "input_relay", lobbyId: lobby.id, serverTick: lobby.tick, player: { id: conn.id, username: me.username, slot: me.slot, seq: me.lastSeq, input: { seq: sanitized.seq, buttons: sanitized.buttons, axisX: sanitized.axisX, axisY: sanitized.axisY } } });
      return;
    }

    if (input.type === "stream_signal") {
      const targetId = String(input.targetId || "");
      const target = lobby.members.get(targetId);
      const signal = sanitizeStreamSignal(input.signal);
      const host = lobby.members.get(lobby.hostConnectionId);
      if (!target || !host || !signal || target.conn.id === conn.id || (me.slot !== 1 && target.conn.id !== host.conn.id) || (me.slot === 1 && target.slot === 1)) {
        conn.send({ type: "protocol_error", code: "BAD_STREAM_SIGNAL" });
        return;
      }
      room.broadcast({ type: "stream_signal", lobbyId: lobby.id, targetId: target.conn.id, fromId: conn.id, signal });
      console.log(JSON.stringify({ event: "stream_signal_relay", lobbyId: lobby.id, fromId: conn.id, toId: target.conn.id, kind: signal.kind, descriptionType: signal.description?.type || null }));
      return;
    }

    if (input.type === "stream_request") {
      const host = lobby.members.get(lobby.hostConnectionId);
      if (!host || me.slot === 1 || host.conn.id === conn.id) {
        conn.send({ type: "protocol_error", code: "BAD_STREAM_REQUEST" });
        return;
      }
      room.broadcast({ type: "stream_request", lobbyId: lobby.id, targetId: host.conn.id, fromId: conn.id, player: memberSummary(me) });
      console.log(JSON.stringify({ event: "stream_request_relay", lobbyId: lobby.id, fromId: conn.id, hostId: host.conn.id }));
      return;
    }

    if (input.type === "host_emulator_ready") {
      if (me.slot !== 1 || lobby.hostConnectionId !== conn.id) { conn.send({ type: "protocol_error", code: "HOST_ONLY" }); return; }
      if (String(input.romKey || "").toLowerCase() !== lobby.romKey) { conn.send({ type: "protocol_error", code: "ROM_MISMATCH" }); return; }
      lobby.hostReady = true;
      await env.DB.prepare("INSERT INTO lobby_runtime (lobby_id, user_id, rom_key, patch_profile, host_ready, state_version, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?) ON CONFLICT(lobby_id) DO UPDATE SET user_id = excluded.user_id, rom_key = excluded.rom_key, patch_profile = excluded.patch_profile, host_ready = 1, state_version = excluded.state_version, updated_at = excluded.updated_at")
        .bind(lobby.id, me.userId, lobby.romKey, lobby.patchProfile || "gl-n64-websim-bridge-0.1", lobby.stateVersion || 0, Date.now()).run();
      room.broadcast({ type: "host_emulator_ready", lobbyId: lobby.id, romKey: lobby.romKey, patchProfile: lobby.patchProfile, stateVersion: lobby.stateVersion || 0, serverTime: Date.now() });
      await broadcastLobby(lobby, room);
      console.log(JSON.stringify({ event: "host_emulator_ready", lobbyId: lobby.id, userId: me.userId }));
      return;
    }

    if (input.type === "ping") { conn.send({ type: "pong", clientTime: input.clientTime, serverTime: Date.now() }); }
  },

  async onTick(room) {
    const serverTime = Date.now();
    for (const lobby of activeLobbies.values()) {
      if (!lobby.members.size) continue;
      lobby.tick += 1;
      if (lobby.tick % SNAPSHOT_EVERY_TICKS !== 0) continue;
      const players = [...lobby.members.values()].sort((a, b) => a.slot - b.slot).map((member) => ({
        id: member.conn.id,
        username: member.username,
        slot: member.slot,
        seq: member.lastSeq,
        input: member.latestInput ? { seq: member.latestInput.seq, buttons: member.latestInput.buttons, axisX: member.latestInput.axisX, axisY: member.latestInput.axisY } : null,
      }));
      const snapshot = { type: "snapshot", lobbyId: lobby.id, tick: lobby.tick, stateVersion: lobby.stateVersion || 0, serverTime, players };
      room.broadcast(snapshot);
    }
  },

  async onClose(conn, room, env) {
    const lobbyId = connectionLobbies.get(conn.id);
    connectionLobbies.delete(conn.id);
    const lobby = lobbyId ? activeLobbies.get(lobbyId) : null;
    if (!lobby) return;
    lobby.members.delete(conn.id);
    if (lobby.hostConnectionId === conn.id && lobby.members.size) {
      for (const member of lobby.members.values()) member.conn.close(4002, "Host left; create a new lobby");
      await env.DB.prepare("UPDATE lobbies SET status = 'closed', last_seen_at = ? WHERE id = ?").bind(Date.now(), lobby.id).run();
      activeLobbies.delete(lobby.id);
      console.log(JSON.stringify({ event: "lobby_closed", lobbyId: lobby.id, reason: "host_left" }));
      return;
    }
    if (!lobby.members.size) {
      activeLobbies.delete(lobby.id);
      await env.DB.prepare("UPDATE lobbies SET status = 'closed', last_seen_at = ? WHERE id = ?").bind(Date.now(), lobby.id).run();
      console.log(JSON.stringify({ event: "lobby_closed", lobbyId: lobby.id, reason: "empty" }));
      return;
    }
    await broadcastLobby(lobby, room);
    console.log(JSON.stringify({ event: "room_disconnected", lobbyId: lobby.id, connectionId: conn.id, playerCount: lobby.members.size }));
  },
};
