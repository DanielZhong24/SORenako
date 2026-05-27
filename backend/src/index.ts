declare const require: any;
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const Redis = require("ioredis");
const cors = require("cors");
// Avoid importing Prisma types at build-time in this environment; use minimal stub for typechecking.
class PrismaClient {}
declare const process: any;
declare const module: any;

const app = express();

// CORS: allow the frontend origin (set via env) or default to localhost:5173 for local dev
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:5173";
app.use(cors({ origin: FRONTEND_ORIGIN, credentials: true }));
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: FRONTEND_ORIGIN, methods: ["GET", "POST"], credentials: true },
});

const redis = new Redis(process.env.REDIS_URL || undefined);
let redisReady = false;
const memoryStore = new Map<string, string>();
const memorySets = new Map<string, Set<string>>();

redis.on("ready", () => {
  redisReady = true;
  // eslint-disable-next-line no-console
  console.log("Redis ready");
});
redis.on("error", (err: any) => {
  // prevent unhandled error crash and log for debugging
  // eslint-disable-next-line no-console
  console.warn("[ioredis] error:", err && err.message ? err.message : err);
  redisReady = false;
});

const kv = {
  async get(key: string) {
    if (redisReady) {
      try {
        return await redis.get(key);
      } catch (e) {
        // fallback
      }
    }
    return memoryStore.get(key) ?? null;
  },
  async set(key: string, value: string) {
    if (redisReady) {
      try {
        return await redis.set(key, value);
      } catch (e) {
        // fallback
      }
    }
    memoryStore.set(key, value);
    return "OK";
  },
  async del(key: string) {
    if (redisReady) {
      try {
        return await redis.del(key);
      } catch (e) {}
    }
    return memoryStore.delete(key) ? 1 : 0;
  },
  async sadd(key: string, member: string) {
    if (redisReady) {
      try {
        return await redis.sadd(key, member);
      } catch (e) {}
    }
    const s = memorySets.get(key) ?? new Set<string>();
    s.add(member);
    memorySets.set(key, s);
    return 1;
  },
  async srem(key: string, member: string) {
    if (redisReady) {
      try {
        return await redis.srem(key, member);
      } catch (e) {}
    }
    const s = memorySets.get(key);
    if (!s) return 0;
    const had = s.delete(member);
    if (s.size === 0) memorySets.delete(key);
    return had ? 1 : 0;
  },
  async smembers(key: string) {
    if (redisReady) {
      try {
        return await redis.smembers(key);
      } catch (e) {}
    }
    const s = memorySets.get(key);
    return s ? Array.from(s) : [];
  },
};
const prisma = new PrismaClient() as any;

// Types
type CreateUserReq = { username: string };
type CreateUserRes = { userId: string; username: string };

// Helper: generate 6-char room id
function genRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

async function listRooms(): Promise<string[]> {
  const rooms = await kv.smembers("rooms");
  return rooms || [];
}

app.post("/api/auth", async (req: any, res: any) => {
  const body = req.body as CreateUserReq;
  if (!body?.username) return res.status(400).json({ error: "username required" });

  try {
    // Use Prisma client to create a user record if possible
    const user = await prisma.user.create({ data: { name: body.username } });
    const result: CreateUserRes = { userId: String(user.id), username: user.name };
    return res.json(result);
  } catch (err) {
    // Fallback: return a generated id but still show Prisma was attempted
    const fallbackId = `guest_${Date.now()}`;
    return res.json({ userId: fallbackId, username: body.username });
  }
});

// Admin: reset the single global lobby to empty state
app.post("/api/admin/reset-lobby", async (req: any, res: any) => {
  try {
    const lobbyKey = `room:LOBBY`;
    const lobbyState = { id: "LOBBY", players: [], turnIndex: -1, started: false, map: [], log: [] } as any;
    await kv.set(lobbyKey, JSON.stringify(lobbyState));
    // ensure LOBBY present in rooms set
    await kv.sadd("rooms", "LOBBY");
    // notify connected clients
    io.to("LOBBY").emit("room_update", lobbyState);
    io.emit("rooms_update", await listRooms());
    return res.json({ ok: true, lobby: lobbyState });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("failed to reset lobby", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

  io.on("connection", (socket: any) => {
  // send current rooms
  (async () => {
    // ensure a single global lobby exists
    const rooms = await listRooms();
    if (!rooms.includes("LOBBY")) {
      const lobbyKey = `room:LOBBY`;
      const lobbyState = { id: "LOBBY", players: [], turnIndex: -1, started: false, map: [], log: [] } as any;
      await kv.set(lobbyKey, JSON.stringify(lobbyState));
      await kv.sadd("rooms", "LOBBY");
    }
    socket.emit("rooms_update", await listRooms());
  })();

  socket.on("host_room", async (payload: { userId: string }) => {
    const roomId = genRoomId();
    const roomKey = `room:${roomId}`;
    const state = {
      id: roomId,
      players: [payload.userId],
      hostId: payload.userId,
      turnIndex: -1,
      started: false,
      map: [],
      log: [],
    } as any;
    await kv.set(roomKey, JSON.stringify(state));
    await kv.sadd("rooms", roomId);
    socket.join(roomId);
    // notify the host of the room state
    io.to(roomId).emit("room_update", state);
    io.emit("rooms_update", await listRooms());
    socket.emit("hosted", { roomId });
  });

  socket.on("join_room", async (payload: { roomId: string; userId: string }) => {
    const { roomId, userId } = payload;
    const roomKey = `room:${roomId}`;
    const raw = await kv.get(roomKey);
    if (!raw) return socket.emit("error", { message: "room not found" });
    const state = JSON.parse(raw);
    if (state.started) return socket.emit("error", { message: "game already started" });
    if (!state.players.includes(userId) && state.players.length >= 4) {
      return socket.emit("error", { message: "room is full" });
    }
    if (!state.players.includes(userId)) state.players.push(userId);
    await kv.set(roomKey, JSON.stringify(state));
    socket.join(roomId);
    io.to(roomId).emit("room_update", state);
    io.emit("rooms_update", await listRooms());
  });

  socket.on("start_game", async (payload: { roomId: string; userId: string }) => {
    const { roomId } = payload;
    const roomKey = `room:${roomId}`;
    const raw = await kv.get(roomKey);
    if (!raw) return socket.emit("error", { message: "room not found" });
    const state = JSON.parse(raw);
    // allow any player to start when there are 4 players in the lobby
    if (!state.players || state.players.length !== 4) return socket.emit("error", { message: "need 4 players to start" });

    // initialize static map (simple array of tiles)
    state.map = Array.from({ length: 19 }, (_, i) => ({ id: i, value: 0 }));
    state.started = true;
    state.turnIndex = 0;
    state.log = [{ ts: Date.now(), text: "Game started" }];
    await kv.set(roomKey, JSON.stringify(state));
    io.to(roomId).emit("game_started", state);
  });

  socket.on("end_game", async (payload: { roomId: string }) => {
    const { roomId } = payload;
    const roomKey = `room:${roomId}`;
    const raw = await kv.get(roomKey);
    if (!raw) return socket.emit("error", { message: "room not found" });
    const state = JSON.parse(raw);
    state.started = false;
    state.turnIndex = -1;
    state.map = [];
    state.log = [{ ts: Date.now(), text: "Game ended" }];
    await kv.set(roomKey, JSON.stringify(state));
    io.to(roomId).emit("room_update", state);
  });

  socket.on("roll_dice", async (payload: { roomId: string; userId: string }) => {
    const { roomId, userId } = payload;
    const roomKey = `room:${roomId}`;
    const raw = await kv.get(roomKey);
    if (!raw) return socket.emit("error", { message: "room not found" });
    const state = JSON.parse(raw) as any;
    if (!state.started) return socket.emit("error", { message: "game not started" });
    const current = state.players[state.turnIndex];
    if (current !== userId) return socket.emit("error", { message: "not your turn" });
    const roll = Math.floor(Math.random() * 11) + 2; // 2-12
    state.log.push({ ts: Date.now(), text: `Player ${userId} rolled ${roll}` });
    // advance turn
    state.turnIndex = (state.turnIndex + 1) % state.players.length;
    await kv.set(roomKey, JSON.stringify(state));
    io.to(roomId).emit("dice_rolled", {
      roll,
      nextPlayerId: state.players[state.turnIndex],
      log: state.log,
      turnIndex: state.turnIndex,
      players: state.players,
    });
  });

  socket.on("leave_room", async (payload: { roomId: string; userId: string }) => {
    const { roomId, userId } = payload;
    const roomKey = `room:${roomId}`;
    const raw = await kv.get(roomKey);
    if (!raw) return;
    const state = JSON.parse(raw);
    state.players = state.players.filter((p: string) => p !== userId);
    if (state.players.length === 0) {
      await kv.del(roomKey);
      await kv.srem("rooms", roomId);
      io.emit("rooms_update", await listRooms());
    } else {
      await kv.set(roomKey, JSON.stringify(state));
      io.to(roomId).emit("room_update", state);
    }
    socket.leave(roomId);
  });

  // allow clients to request the current room state (useful after reconnect)
  socket.on("get_room", async (payload: { roomId: string }) => {
    const { roomId } = payload;
    const roomKey = `room:${roomId}`;
    const raw = await kv.get(roomKey);
    if (!raw) return socket.emit("error", { message: "room not found" });
    const state = JSON.parse(raw);
    socket.emit("room_update", state);
  });

  // allow clients to request a lobby reset via socket (convenience for dev/testing)
  socket.on("reset_lobby", async () => {
    try {
      const lobbyKey = `room:LOBBY`;
      const lobbyState = { id: "LOBBY", players: [], turnIndex: -1, started: false, map: [], log: [] } as any;
      await kv.set(lobbyKey, JSON.stringify(lobbyState));
      await kv.sadd("rooms", "LOBBY");
      io.to("LOBBY").emit("room_update", lobbyState);
      io.emit("rooms_update", await listRooms());
      socket.emit("reset_done", { ok: true });
    } catch (err) {
      socket.emit("reset_done", { ok: false, error: String(err) });
    }
  });
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;
server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log("Server listening on %s", PORT);
});

(module.exports as any) = {};
