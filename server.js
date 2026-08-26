const MAX_PLAYERS = 4;
const INPUT_KEYS = ["up", "down", "left", "right", "a", "b", "z", "start", "cUp", "cDown", "cLeft", "cRight"];
const activeLobbies = new Map();

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
  };
}

function memberSummary(member) {
  return { id: member.conn.id, username: member.username, slot: member.slot, ready: true, lastSeq: member.lastSeq };
}

function publicPlayers(lobby) {
  return [...lobby.members.values()].sort((a, b) => a.slot - b.slot).map(memberSummary);
}

async function broadcastLobby(lobby) {
  const message = { type: "lobby_state", lobby: lobbySummary(lobby), players: publicPlayers(lobby), serverTime: Date.now() };
  for (const member of lobby.members.values()) member.conn.send(message);
}

function sanitizeInput(raw, lastSeq) {
  if (!raw || typeof raw !== "object") return null;
  const seq = Number(raw.seq);
  if (!Number.isSafeInteger(seq) || seq < 0 || seq <= lastSeq || seq > lastSeq + 120) return null;
  const buttons = {};
  for (const key of INPUT_KEYS) buttons[key] = raw.buttons && raw.buttons[key] === true;
  const clampAxis = (value) => Math.max(-80, Math.min(80, Number.isFinite(Number(value)) ? Number(value) : 0));
  return { seq, buttons, axisX: clampAxis(raw.axisX), axisY: clampAxis(raw.axisY), receivedAt: Date.now() };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const user = currentUser(request);

    if (request.method === "GET" && url.pathname === "/api/health") {
      return reply({ ok: true, service: "gauntlet-netplay", protocol: "input-authority/0.1", maxPlayers: MAX_PLAYERS });
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
    conn.send({ type: "connected", connectionId: conn.id, protocol: "input-authority/0.1", serverTime: Date.now() });
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
      let lobby = activeLobbies.get(lobbyId);
      if (!lobby) {
        lobby = { id: lobbyId, visibility: row.visibility, username: row.username, members: new Map(), createdAt: Date.now(), tick: 0 };
        activeLobbies.set(lobbyId, lobby);
      }
      if (lobby.members.size >= MAX_PLAYERS) { conn.send({ type: "join_rejected", code: "LOBBY_FULL", message: "That lobby already has four players." }); return; }
      for (const member of lobby.members.values()) if (member.userId === conn.userId) { conn.send({ type: "join_rejected", code: "ALREADY_JOINED", message: "You are already in this lobby." }); return; }
      const usedSlots = new Set([...lobby.members.values()].map((member) => member.slot));
      const slot = [1, 2, 3, 4].find((candidate) => !usedSlots.has(candidate));
      const member = { conn, userId: conn.userId, username: conn.username || "player", slot, lastSeq: -1, latestInput: null, joinedAt: Date.now() };
      lobby.members.set(conn.id, member);
      conn.lobbyId = lobbyId;
      await env.DB.prepare("UPDATE lobbies SET last_seen_at = ? WHERE id = ?").bind(Date.now(), lobbyId).run();
      conn.send({ type: "joined_lobby", lobby: lobbySummary(lobby), self: memberSummary(member), players: publicPlayers(lobby), serverTime: Date.now() });
      await broadcastLobby(lobby);
      console.log(JSON.stringify({ event: "lobby_joined", lobbyId, connectionId: conn.id, slot, playerCount: lobby.members.size }));
      return;
    }

    const lobby = conn.lobbyId ? activeLobbies.get(conn.lobbyId) : null;
    const me = lobby ? lobby.members.get(conn.id) : null;
    if (!me) { conn.send({ type: "protocol_error", code: "JOIN_REQUIRED" }); return; }

    if (input.type === "input") {
      const sanitized = sanitizeInput(input, me.lastSeq);
      if (!sanitized) { conn.send({ type: "input_rejected", code: "INVALID_SEQUENCE_OR_RANGE", lastSeq: me.lastSeq }); return; }
      me.lastSeq = sanitized.seq;
      me.latestInput = sanitized;
      conn.send({ type: "input_ack", seq: me.lastSeq, serverTime: Date.now() });
      return;
    }

    if (input.type === "ping") { conn.send({ type: "pong", clientTime: input.clientTime, serverTime: Date.now() }); }
  },

  async onTick() {
    const serverTime = Date.now();
    for (const lobby of activeLobbies.values()) {
      if (!lobby.members.size) continue;
      lobby.tick += 1;
      const players = [...lobby.members.values()].sort((a, b) => a.slot - b.slot).map((member) => ({
        id: member.conn.id,
        username: member.username,
        slot: member.slot,
        seq: member.lastSeq,
        input: member.latestInput ? { seq: member.latestInput.seq, buttons: member.latestInput.buttons, axisX: member.latestInput.axisX, axisY: member.latestInput.axisY } : null,
      }));
      const snapshot = { type: "snapshot", lobbyId: lobby.id, tick: lobby.tick, serverTime, players };
      for (const member of lobby.members.values()) member.conn.send(snapshot);
    }
  },

  async onClose(conn, room, env) {
    const lobby = conn.lobbyId ? activeLobbies.get(conn.lobbyId) : null;
    if (!lobby) return;
    lobby.members.delete(conn.id);
    if (!lobby.members.size) {
      activeLobbies.delete(lobby.id);
      await env.DB.prepare("UPDATE lobbies SET status = 'closed', last_seen_at = ? WHERE id = ?").bind(Date.now(), lobby.id).run();
      console.log(JSON.stringify({ event: "lobby_closed", lobbyId: lobby.id, reason: "empty" }));
      return;
    }
    await broadcastLobby(lobby);
    console.log(JSON.stringify({ event: "room_disconnected", lobbyId: lobby.id, connectionId: conn.id, playerCount: lobby.members.size }));
  },
};
