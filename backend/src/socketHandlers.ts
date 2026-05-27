declare const require: any;
declare const module: any;

type KvStore = {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string) => Promise<string>;
  del: (key: string) => Promise<number>;
  sadd: (key: string, member: string) => Promise<number>;
  srem: (key: string, member: string) => Promise<number>;
  smembers: (key: string) => Promise<string[]>;
};

const {
  createLobbyState,
  joinLobby,
  leaveLobbyOrGame,
  startGame,
  endGame,
  applyGameAction,
  sanitizeStateForUser,
} = require("./game/engine");

async function ensureLobby(kv: KvStore) {
  const key = "room:LOBBY";
  const current = await kv.get(key);
  if (current) return;
  const state = createLobbyState("LOBBY");
  await kv.set(key, JSON.stringify(state));
  await kv.sadd("rooms", "LOBBY");
}

async function loadState(kv: KvStore, roomId: string) {
  const key = `room:${roomId}`;
  const raw = await kv.get(key);
  if (!raw) return null;
  return JSON.parse(raw);
}

async function saveState(kv: KvStore, roomId: string, state: any) {
  const key = `room:${roomId}`;
  await kv.set(key, JSON.stringify(state));
}

async function listRooms(kv: KvStore): Promise<string[]> {
  return (await kv.smembers("rooms")) || [];
}

function createSocketHandlers(io: any, kv: KvStore, usersById: Map<string, string>) {
  return async function onConnection(socket: any) {
    await ensureLobby(kv);
    socket.emit("rooms_update", await listRooms(kv));

    socket.on("join_room", async (payload: { roomId: string; userId: string }) => {
      try {
        await ensureLobby(kv);
        const roomId = payload.roomId || "LOBBY";
        const userId = payload.userId;
        const username = usersById.get(userId) || userId;

        const current = await loadState(kv, roomId);
        if (!current) {
          socket.emit("error", { message: "room not found" });
          return;
        }

        const joined = joinLobby(current, userId, username);
        if (!joined.ok) {
          socket.emit("error", { message: joined.error });
          return;
        }

        await saveState(kv, roomId, joined.state);
        socket.join(roomId);

        const sockets = await io.in(roomId).fetchSockets();
        for (const member of sockets) {
          const memberUserId = member.data?.userId as string | undefined;
          if (memberUserId) {
            member.emit("room_update", sanitizeStateForUser(joined.state, memberUserId));
          } else {
            member.emit("room_update", sanitizeStateForUser(joined.state, userId));
          }
        }
        io.emit("rooms_update", await listRooms(kv));
      } catch (err) {
        socket.emit("error", { message: String(err) });
      }
    });

    socket.on("register_user", (payload: { userId: string }) => {
      socket.data.userId = payload.userId;
    });

    socket.on("get_room", async (payload: { roomId: string; userId?: string }) => {
      try {
        const roomId = payload.roomId || "LOBBY";
        const userId = payload.userId || socket.data.userId;
        const current = await loadState(kv, roomId);
        if (!current) {
          socket.emit("error", { message: "room not found" });
          return;
        }
        socket.emit("room_update", sanitizeStateForUser(current, userId || ""));
      } catch (err) {
        socket.emit("error", { message: String(err) });
      }
    });

    socket.on("start_game", async (payload: { roomId: string; userId: string }) => {
      try {
        const roomId = payload.roomId || "LOBBY";
        const state = await loadState(kv, roomId);
        if (!state) {
          socket.emit("error", { message: "room not found" });
          return;
        }

        const started = startGame(state, payload.userId);
        if (!started.ok) {
          socket.emit("error", { message: started.error });
          return;
        }

        await saveState(kv, roomId, started.state);

        const sockets = await io.in(roomId).fetchSockets();
        for (const member of sockets) {
          const memberUserId = member.data?.userId as string | undefined;
          member.emit("room_update", sanitizeStateForUser(started.state, memberUserId || payload.userId));
        }
      } catch (err) {
        socket.emit("error", { message: String(err) });
      }
    });

    socket.on("end_game", async (payload: { roomId: string }) => {
      try {
        const roomId = payload.roomId || "LOBBY";
        const state = await loadState(kv, roomId);
        if (!state) {
          socket.emit("error", { message: "room not found" });
          return;
        }
        const ended = endGame(state);
        await saveState(kv, roomId, ended.state);

        const sockets = await io.in(roomId).fetchSockets();
        for (const member of sockets) {
          const memberUserId = member.data?.userId as string | undefined;
          member.emit("room_update", sanitizeStateForUser(ended.state, memberUserId || ""));
        }
      } catch (err) {
        socket.emit("error", { message: String(err) });
      }
    });

    socket.on("game_action", async (payload: { roomId: string; userId: string; action: any }, ack?: (result: any) => void) => {
      try {
        const roomId = payload.roomId || "LOBBY";
        const state = await loadState(kv, roomId);
        if (!state) {
          if (ack) ack({ ok: false, error: "room not found" });
          return;
        }

        const result = applyGameAction(state, payload.userId, payload.action);
        if (!result.ok) {
          if (ack) ack({ ok: false, error: result.error });
          return;
        }

        await saveState(kv, roomId, result.state);

        const sockets = await io.in(roomId).fetchSockets();
        for (const member of sockets) {
          const memberUserId = member.data?.userId as string | undefined;
          member.emit("room_update", sanitizeStateForUser(result.state, memberUserId || payload.userId));
        }

        if (ack) ack({ ok: true });
      } catch (err) {
        if (ack) ack({ ok: false, error: String(err) });
      }
    });

    socket.on("leave_room", async (payload: { roomId: string; userId: string }) => {
      try {
        const roomId = payload.roomId || "LOBBY";
        const state = await loadState(kv, roomId);
        if (!state) return;

        const result = leaveLobbyOrGame(state, payload.userId);
        if (!result.ok) {
          socket.emit("error", { message: result.error });
          return;
        }

        await saveState(kv, roomId, result.state);
        socket.leave(roomId);

        const sockets = await io.in(roomId).fetchSockets();
        for (const member of sockets) {
          const memberUserId = member.data?.userId as string | undefined;
          member.emit("room_update", sanitizeStateForUser(result.state, memberUserId || payload.userId));
        }
      } catch (err) {
        socket.emit("error", { message: String(err) });
      }
    });

    socket.on("reset_lobby", async () => {
      try {
        const reset = createLobbyState("LOBBY");
        await saveState(kv, "LOBBY", reset);
        await kv.sadd("rooms", "LOBBY");

        const sockets = await io.in("LOBBY").fetchSockets();
        for (const member of sockets) {
          const memberUserId = member.data?.userId as string | undefined;
          member.emit("room_update", sanitizeStateForUser(reset, memberUserId || ""));
        }

        socket.emit("reset_done", { ok: true });
      } catch (err) {
        socket.emit("reset_done", { ok: false, error: String(err) });
      }
    });
  };
}

module.exports = {
  createSocketHandlers,
};
