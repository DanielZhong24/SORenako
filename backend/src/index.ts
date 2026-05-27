declare const require: any;
declare const process: any;
declare const module: any;

const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const { createKvStore } = require("./store");
const { createSocketHandlers } = require("./socketHandlers");
const { createLobbyState } = require("./game/engine");

// Keep a minimal fallback Prisma client abstraction because schema may not be ready.
class PrismaClient {}

type CreateUserReq = { username: string };
type CreateUserRes = { userId: string; username: string };

const app = express();
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:5173";
app.use(cors({ origin: FRONTEND_ORIGIN, credentials: true }));
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: FRONTEND_ORIGIN,
    methods: ["GET", "POST"],
    credentials: true,
  },
});

const kv = createKvStore(process.env.REDIS_URL || undefined);
const prisma = new PrismaClient() as any;
const usersById = new Map<string, string>();

async function ensureLobby() {
  const key = "room:LOBBY";
  const raw = await kv.get(key);
  if (raw) return;
  const lobby = createLobbyState("LOBBY");
  await kv.set(key, JSON.stringify(lobby));
  await kv.sadd("rooms", "LOBBY");
}

app.post("/api/auth", async (req: any, res: any) => {
  const body = req.body as CreateUserReq;
  if (!body?.username || !body.username.trim()) {
    return res.status(400).json({ error: "username required" });
  }

  try {
    const user = await prisma.user.create({ data: { name: body.username.trim() } });
    const result: CreateUserRes = { userId: String(user.id), username: user.name };
    usersById.set(result.userId, result.username);
    return res.json(result);
  } catch (_err) {
    const fallbackId = `guest_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const result: CreateUserRes = { userId: fallbackId, username: body.username.trim() };
    usersById.set(result.userId, result.username);
    return res.json(result);
  }
});

app.post("/api/admin/reset-lobby", async (_req: any, res: any) => {
  try {
    const lobby = createLobbyState("LOBBY");
    await kv.set("room:LOBBY", JSON.stringify(lobby));
    await kv.sadd("rooms", "LOBBY");
    io.to("LOBBY").emit("room_update", lobby);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
});

ensureLobby()
  .then(() => {
    io.on("connection", createSocketHandlers(io, kv, usersById));

    const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;
    server.listen(PORT, () => {
      // eslint-disable-next-line no-console
      console.log("Server listening on %s", PORT);
    });
  })
  .catch((err: any) => {
    // eslint-disable-next-line no-console
    console.error("Failed to boot server", err);
    process.exit(1);
  });

(module.exports as any) = {};
