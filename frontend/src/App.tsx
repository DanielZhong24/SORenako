import { useEffect, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import "./App.css";

type RoomList = string[];

type User = { userId: string; username: string } | null;

type GameState = {
  id: string;
  players: string[];
  hostId?: string;
  turnIndex: number;
  started: boolean;
  map: any[];
  log: { ts: number; text: string }[];
};

export default function App() {
  const [user, setUser] = useState<User>(() => {
    try {
      return JSON.parse(localStorage.getItem("user") || "null");
    } catch {
      return null;
    }
  });
  const [username, setUsername] = useState("");
  const [connectedRoom, setConnectedRoom] = useState<string | null>(null);
  const [game, setGame] = useState<GameState | null>(null);
  const socketRef = useRef<Socket | null>(null);

  const backendUrl = (import.meta as any).env?.VITE_BACKEND_URL ?? "http://localhost:4000";

  useEffect(() => {
    if (!user) return;
    const socket = io(backendUrl);
    socketRef.current = socket;

    socket.on("connect", () => {
      // join the single global lobby on connect
      socket.emit("join_room", { roomId: "LOBBY", userId: user.userId });
      setConnectedRoom("LOBBY");
      // request current room state to recover from any missed events
      socket.emit("get_room", { roomId: "LOBBY" });
    });

    // rooms list and hosted event are not used in single global lobby flow
    socket.on("room_update", (s: GameState) => setGame(s));
    socket.on("game_started", (s: GameState) => {
      setGame(s);
      setConnectedRoom(s.id);
    });
    socket.on("dice_rolled", (p: { roll: number; nextPlayerId: string; log: any[]; turnIndex?: number; players?: string[] }) => {
      // debug log for missed-event diagnosis
      // eslint-disable-next-line no-console
      console.log("dice_rolled received:", p);
      setGame((g) =>
        g ? { ...g, log: p.log, turnIndex: typeof p.turnIndex === "number" ? p.turnIndex : g.turnIndex, players: p.players ?? g.players } : g
      );
      // If server didn't include turnIndex (old server), request authoritative state
      if (typeof p.turnIndex !== "number") {
        // eslint-disable-next-line no-console
        console.log("dice_rolled missing turnIndex — requesting room state");
        socketRef.current?.emit("get_room", { roomId: connectedRoom ?? "LOBBY" });
      }
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [user]);

    async function createUser() {
    const res = await fetch(`${backendUrl}/api/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username }),
    });
    const data = await res.json();
    localStorage.setItem("user", JSON.stringify(data));
    setUser(data);
  }

  // hostRoom removed: single global lobby auto-join is used instead

  function joinRoom(roomId: string) {
    if (!user) return;
    socketRef.current?.emit("join_room", { roomId, userId: user.userId });
  }

  function startGame() {
    if (!connectedRoom) return;
    socketRef.current?.emit("start_game", { roomId: connectedRoom });
  }

  function endGame() {
    if (!connectedRoom) return;
    socketRef.current?.emit("end_game", { roomId: connectedRoom });
  }

  function rollDice() {
    if (!connectedRoom || !user) return;
    socketRef.current?.emit("roll_dice", { roomId: connectedRoom, userId: user.userId });
  }

  async function resetLobby() {
    // prefer socket-based reset (works without HTTP/CORS issues)
    try {
      socketRef.current?.emit("reset_lobby");
      socketRef.current?.once("reset_done", (r: any) => {
        // eslint-disable-next-line no-console
        console.log("reset_done", r);
        socketRef.current?.emit("get_room", { roomId: "LOBBY" });
      });
    } catch (err) {
      // fallback: try HTTP endpoint
      try {
        const res = await fetch(`${backendUrl}/api/admin/reset-lobby`, { method: "POST" });
        if (!res.ok) {
          // eslint-disable-next-line no-console
          console.warn("reset lobby failed", await res.text());
        }
        socketRef.current?.emit("get_room", { roomId: "LOBBY" });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error("resetLobby error", e);
      }
    }
  }

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="card p-6 shadow-md">
          <h2 className="text-xl font-bold mb-2">Join as Guest</h2>
          <input className="input input-bordered w-full mb-2" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="username" />
          <div className="flex gap-2">
            <button className="btn btn-primary" onClick={createUser} disabled={!username}>Enter</button>
          </div>
        </div>
      </div>
    );
  }

  if (game && game.started) {
    const currentPlayerId = game.players[game.turnIndex];
    const isMyTurn = currentPlayerId === user.userId;
    return (
      <div className="p-4">
        <div className="flex justify-between items-center mb-4">
          <div>
            <h3 className="text-lg font-bold">Room {game.id}</h3>
            <p>Players: {game.players.join(", ")}</p>
          </div>
          <div>
            <span className="badge">{isMyTurn ? "Your turn" : "Waiting..."}</span>
            {isMyTurn && <button className="btn btn-secondary ml-2" onClick={rollDice}>Dice Roll</button>}
            <button className="btn btn-outline btn-error ml-2" onClick={resetLobby}>Reset Lobby</button>
            <button className="btn btn-outline ml-2" onClick={endGame}>End Game</button>
          </div>
        </div>
        <div className="card p-4">
          <h4 className="font-bold">Game Log</h4>
          <div className="mt-2 space-y-2">
            {game.log.map((l, idx) => (
              <div key={idx} className="alert">
                <div>{new Date(l.ts).toLocaleTimeString()}: {l.text}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }
  // If user is in a room but game not started, show room lobby UI (4 slots)
  if (connectedRoom === "LOBBY") {
    const lobbyPlayers = game?.players ?? [];
    const slots = Array.from({ length: 4 }, (_, i) => lobbyPlayers[i] ?? null);
    return (
      <div className="p-4">
        <div className="flex justify-between items-center mb-4">
          <div>
            <h2 className="text-xl font-bold">Lobby</h2>
            <div className="text-sm">Logged in as {user.username} ({user.userId})</div>
          </div>
          <div className="flex items-center gap-2">
            <button className="btn" onClick={() => startGame()} disabled={lobbyPlayers.length !== 4}>Start Game</button>
            <button className="btn btn-outline btn-error" onClick={resetLobby}>Reset Lobby</button>
          </div>
        </div>

        <div className="card p-4">
          <div className="flex items-center justify-between gap-2 mb-2">
            <h3 className="font-bold">Players (4 required)</h3>
            <span className="badge">{lobbyPlayers.length}/4</span>
          </div>
          <ul className="grid grid-cols-2 gap-2">
            {slots.map((p, idx) => (
              <li key={idx} className="border rounded p-2 flex items-center justify-between">
                <div>{p ?? <span className="text-muted">Waiting...</span>}</div>
              </li>
            ))}
          </ul>
          <div className="mt-4 flex gap-2">
            <span className="badge badge-outline">Auto-joined</span>
            <button className="btn btn-outline" onClick={() => socketRef.current?.emit("get_room", { roomId: "LOBBY" })}>Refresh Lobby</button>
          </div>
        </div>
      </div>
    );
  }

  if (connectedRoom && game && !game.started) {
    const slots = Array.from({ length: 4 }, (_, i) => game.players[i] ?? null);
    return (
      <div className="p-4">
        <div className="flex justify-between items-center mb-4">
          <div>
            <h2 className="text-xl font-bold">Room Lobby {game.id}</h2>
            <div className="text-sm">Logged in as {user.username} ({user.userId})</div>
          </div>
          <div className="flex items-center gap-2">
            {/* any player may start when lobby is full */}
            <button className="btn" onClick={() => startGame()} disabled={game.players.length !== 4}>Start Game</button>
            <button className="btn btn-outline btn-error" onClick={resetLobby}>Reset Lobby</button>
            <button className="btn btn-outline" onClick={endGame}>End Game</button>
          </div>
        </div>

        <div className="card p-4">
          <div className="flex items-center justify-between gap-2 mb-2">
            <h3 className="font-bold">Players (4 required)</h3>
            <button className="btn btn-sm btn-outline btn-error" onClick={resetLobby}>Reset Lobby</button>
          </div>
          <ul className="grid grid-cols-2 gap-2">
            {slots.map((p, idx) => (
              <li key={idx} className="border rounded p-2 flex items-center justify-between">
                <div>{p ?? <span className="text-muted">Waiting...</span>}</div>
                <div>{p === game.hostId ? <span className="badge">Host</span> : null}</div>
              </li>
            ))}
          </ul>
          <div className="mt-4">
            {!game.players.includes(user.userId) && <button className="btn" onClick={() => joinRoom(game.id)}>Join Room</button>}
          </div>
        </div>
      </div>
    );
  }

  // Default screen before the lobby state arrives.
  return (
    <div className="p-4">
      <div className="flex justify-between items-center mb-4">
        <div>
          <h2 className="text-xl font-bold">Lobby</h2>
          <div className="text-sm">Logged in as {user.username} ({user.userId})</div>
        </div>
      </div>

      <div className="card p-4">
        <h3 className="font-bold mb-2">Global Lobby</h3>
        <p className="mb-4">Loading the lobby state...</p>
        <div className="flex items-center gap-2">
          {connectedRoom === "LOBBY" || (game && game.id === "LOBBY") ? (
            <span className="badge">Joined</span>
          ) : (
            <button className="btn" onClick={() => joinRoom("LOBBY")}>Join Lobby</button>
          )}
          <button className="btn btn-outline btn-error" onClick={resetLobby}>Reset Lobby</button>
        </div>
      </div>
    </div>
  );
}
