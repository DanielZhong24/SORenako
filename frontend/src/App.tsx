import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { io, type Socket } from "socket.io-client";

type Resource = "wood" | "brick" | "sheep" | "wheat" | "ore";
type DevCard = "knight" | "roadBuilding" | "yearOfPlenty" | "monopoly" | "victoryPoint";
type Phase = "lobby" | "setup" | "main" | "ended";
type User = { userId: string; username: string } | null;

type Board = {
  tiles: Array<{ id: number; terrain: string; number: number | null; vertexIds: number[]; edgeIds: number[]; q: number; r: number }>;
  vertices: Array<{
    id: number;
    x: number;
    y: number;
    adjacentTiles: number[];
    adjacentVertices: number[];
    adjacentEdges: number[];
    port?: { type: Resource | "any"; rate: 2 | 3 };
  }>;
  edges: Array<{ id: number; v1: number; v2: number; adjacentTiles: number[] }>;
};

type VisiblePlayer = {
  id: string;
  username: string;
  roads: number[];
  settlements: number[];
  cities: number[];
  playedKnights: number;
  victoryPoints: number;
  resources?: Record<Resource, number>;
  devCards?: Record<DevCard, number>;
  newDevCards?: Record<DevCard, number>;
  resourceCount?: number;
  devCardCount?: number;
};

type GameState = {
  id: string;
  started: boolean;
  phase: Phase;
  players: VisiblePlayer[];
  playerOrder: string[];
  activePlayerId: string | null;
  activePlayerIndex: number;
  setupRound: 1 | 2;
  mustRoll: boolean;
  pendingDiscards: Record<string, number>;
  pendingRobber: boolean;
  robberTileId: number;
  longestRoadHolder: string | null;
  largestArmyHolder: string | null;
  winnerId: string | null;
  lastRoll: { die1: number; die2: number; total: number } | null;
  pendingSetupPlacement: { userId: string; vertexId: number } | null;
  board: Board;
  buildings: Record<number, { ownerId: string; kind: "settlement" | "city" }>;
  roads: Record<number, { ownerId: string }>;
  log: Array<{ ts: number; text: string }>;
};

type Route = "login" | "lobby" | "game";
type BuildTarget = {
  kind: "vertex" | "edge" | "hex";
  id: number;
  x: number;
  y: number;
  buildKind: "road" | "settlement" | "city" | "robber";
};

function terrainColor(terrain: string): string {
  if (terrain === "forest") return "#3E6B3A";
  if (terrain === "hills") return "#A75D36";
  if (terrain === "pasture") return "#7CBF5A";
  if (terrain === "fields") return "#E0B83E";
  if (terrain === "mountains") return "#7B808B";
  return "#D9C29C";
}

function resourceKeys(): Resource[] {
  return ["wood", "brick", "sheep", "wheat", "ore"];
}

function pieceInventory(player: VisiblePlayer) {
  const roadsBuilt = player.roads.length;
  const settlementsBuilt = player.settlements.length;
  const citiesBuilt = player.cities.length;
  return {
    roadsBuilt,
    roadsLeft: Math.max(0, 15 - roadsBuilt),
    settlementsBuilt,
    settlementsLeft: Math.max(0, 5 - settlementsBuilt),
    citiesBuilt,
    citiesLeft: Math.max(0, 4 - citiesBuilt),
  };
}

function getBoardTransform(canvas: HTMLCanvasElement, game: GameState) {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;

  const { minX, maxX, minY, maxY } = game.board.vertices.reduce(
    (acc, vertex) => ({
      minX: Math.min(acc.minX, vertex.x),
      maxX: Math.max(acc.maxX, vertex.x),
      minY: Math.min(acc.minY, vertex.y),
      maxY: Math.max(acc.maxY, vertex.y),
    }),
    { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity },
  );

  const boardWidth = maxX - minX;
  const boardHeight = maxY - minY;
  const scale = Math.min(width / (boardWidth + 2), height / (boardHeight + 2));
  const offsetX = width / 2 - ((minX + maxX) / 2) * scale;
  const offsetY = height / 2 - ((minY + maxY) / 2) * scale;

  return {
    scale,
    offsetX,
    offsetY,
    toScreen(x: number, y: number) {
      return { x: x * scale + offsetX, y: y * scale + offsetY };
    },
  };
}

export default function App() {
  const backendUrl = (import.meta as any).env?.VITE_BACKEND_URL ?? "http://localhost:4000";
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const socketRef = useRef<Socket | null>(null);

  const [user, setUser] = useState<User>(() => {
    try {
      return JSON.parse(sessionStorage.getItem("user") || "null");
    } catch {
      return null;
    }
  });
  const [username, setUsername] = useState("");
  const [game, setGame] = useState<GameState | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [theme, setTheme] = useState<string>(() => {
    const saved = localStorage.getItem("theme");
    if (saved) return saved;
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    return prefersDark ? "discord-dark" : "catan-pink";
  });
  const [route, setRoute] = useState<Route>(() => {
    const path = window.location.pathname.replace(/\/$/, "");
    if (path === "/game") return "game";
    if (path === "/lobby") return "lobby";
    return "login";
  });
  const [hoverTarget, setHoverTarget] = useState<BuildTarget | null>(null);
  const [pendingBuild, setPendingBuild] = useState<BuildTarget | null>(null);
  const [setupStage, setSetupStage] = useState<"settlement" | "road" | null>(null);
  const [setupAnchorVertex, setSetupAnchorVertex] = useState<number | null>(null);
  const [discardSelection, setDiscardSelection] = useState<Resource[]>([]);
  const [robberHexSelection, setRobberHexSelection] = useState<number | null>(null);
  const [robberVictimSelection, setRobberVictimSelection] = useState<string | null>(null);

  const isMyTurn = !!user && !!game && game.activePlayerId === user.userId;
  const requiredDiscard = user && game ? game.pendingDiscards[user.userId] || 0 : 0;

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
  }, [theme]);

  useEffect(() => {
    const onPopState = () => {
      const path = window.location.pathname.replace(/\/$/, "");
      if (path === "/game") setRoute("game");
      else if (path === "/lobby") setRoute("lobby");
      else setRoute(user ? "lobby" : "login");
    };

    window.addEventListener("popstate", onPopState);
    onPopState();
    return () => window.removeEventListener("popstate", onPopState);
  }, [user]);

  useEffect(() => {
    if (!user) {
      setRoute("login");
      window.history.replaceState({}, "", "/");
      return;
    }

    if (route === "login") {
      setRoute("lobby");
      window.history.replaceState({}, "", "/lobby");
    }
  }, [route, user]);

  useEffect(() => {
    if (!user) return;
    const socket = io(backendUrl);
    socketRef.current = socket;

    socket.on("connect", () => {
      socket.emit("register_user", { userId: user.userId });
      socket.emit("join_room", { roomId: "LOBBY", userId: user.userId });
      socket.emit("get_room", { roomId: "LOBBY", userId: user.userId });
    });

    socket.on("connect_error", () => {
      setErrorMsg("Connecting to the game server...");
    });

    socket.on("room_update", (state: GameState) => {
      setGame(state);
      setErrorMsg("");

      if (state.started) {
        if (window.location.pathname !== "/game") {
          window.history.pushState({}, "", "/game");
        }
        setRoute("game");
      } else {
        if (window.location.pathname !== "/lobby") {
          window.history.pushState({}, "", "/lobby");
        }
        setRoute("lobby");
      }
    });

    socket.on("error", (payload: { message?: string }) => {
      setErrorMsg(payload?.message || "Game action failed");
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [backendUrl, user]);

  useEffect(() => {
    if (game?.phase === "setup") {
      if (user && (!game.pendingSetupPlacement || game.pendingSetupPlacement.userId === user.userId)) {
        setSetupStage(game.pendingSetupPlacement ? "road" : "settlement");
        setSetupAnchorVertex(game.pendingSetupPlacement?.vertexId ?? null);
      } else {
        setSetupStage(null);
        setSetupAnchorVertex(null);
      }
      return;
    }

    setSetupStage(null);
    setSetupAnchorVertex(null);
    setPendingBuild(null);
  }, [game?.phase, user, game?.pendingSetupPlacement]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !game) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    canvas.width = width;
    canvas.height = height;
    const transform = getBoardTransform(canvas, game);

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#f5edd8";
    ctx.fillRect(0, 0, width, height);

    for (const tile of game.board.tiles) {
      const points = tile.vertexIds.map((id) => {
        const vertex = game.board.vertices[id];
        return transform.toScreen(vertex.x, vertex.y);
      });

      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i += 1) {
        ctx.lineTo(points[i].x, points[i].y);
      }
      ctx.closePath();

      ctx.fillStyle = terrainColor(tile.terrain);
      ctx.fill();
      ctx.strokeStyle = "rgba(28, 21, 17, 0.35)";
      ctx.lineWidth = 2;
      ctx.stroke();

      const center = points.reduce((acc, point) => ({ x: acc.x + point.x / 6, y: acc.y + point.y / 6 }), { x: 0, y: 0 });

      if (tile.number !== null) {
        ctx.fillStyle = "#fef3c7";
        ctx.beginPath();
        ctx.arc(center.x, center.y, 17, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#3f2f22";
        ctx.stroke();
        ctx.fillStyle = tile.number === 6 || tile.number === 8 ? "#b42318" : "#2f241c";
        ctx.font = "bold 16px Georgia";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(tile.number), center.x, center.y + 1);
      }
      
      if (tile.id === game.robberTileId) {
        ctx.fillStyle = "#2a2a2a";
        ctx.beginPath();
        ctx.arc(center.x, center.y - 12, 10, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    for (const [edgeIdRaw, road] of Object.entries(game.roads)) {
      const edgeId = Number(edgeIdRaw);
      const edge = game.board.edges[edgeId];
      const v1 = game.board.vertices[edge.v1];
      const v2 = game.board.vertices[edge.v2];
      const p1 = transform.toScreen(v1.x, v1.y);
      const p2 = transform.toScreen(v2.x, v2.y);

      const ownerIdx = game.players.findIndex((p) => p.id === road.ownerId);
      const palette = ["#fb7185", "#38bdf8", "#4ade80", "#facc15"];
      ctx.strokeStyle = palette[Math.max(0, ownerIdx) % palette.length];
      ctx.lineWidth = 7;
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
    }

    for (const [vertexIdRaw, building] of Object.entries(game.buildings)) {
      const vertex = game.board.vertices[Number(vertexIdRaw)];
      const point = transform.toScreen(vertex.x, vertex.y);
      const ownerIdx = game.players.findIndex((p) => p.id === building.ownerId);
      const palette = ["#e11d48", "#0284c7", "#16a34a", "#ca8a04"];
      ctx.fillStyle = palette[Math.max(0, ownerIdx) % palette.length];

      if (building.kind === "city") {
        ctx.fillRect(point.x - 12, point.y - 12, 24, 24);
      } else {
        ctx.beginPath();
        ctx.arc(point.x, point.y, 11, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    for (const vertex of game.board.vertices) {
      const point = transform.toScreen(vertex.x, vertex.y);
      ctx.fillStyle = hoverTarget?.kind === "vertex" && hoverTarget.id === vertex.id ? "#0f766e" : "rgba(17, 24, 39, 0.35)";
      ctx.beginPath();
      ctx.arc(point.x, point.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    const target = pendingBuild || hoverTarget;
    if (target) {
      const point = { x: target.x, y: target.y };
      if (target.kind === "vertex") {
        ctx.strokeStyle = pendingBuild ? "#f59e0b" : "#0f766e";
        ctx.lineWidth = pendingBuild ? 4 : 2;
        ctx.beginPath();
        ctx.arc(point.x, point.y, 14, 0, Math.PI * 2);
        ctx.stroke();
      } else if (target.kind === "edge") {
        ctx.strokeStyle = pendingBuild ? "#f59e0b" : "#0f766e";
        ctx.lineWidth = pendingBuild ? 8 : 5;
        const edge = game.board.edges[target.id];
        const v1 = game.board.vertices[edge.v1];
        const v2 = game.board.vertices[edge.v2];
        const p1 = transform.toScreen(v1.x, v1.y);
        const p2 = transform.toScreen(v2.x, v2.y);
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
      } else if (target.kind === "hex") {
        ctx.fillStyle = pendingBuild ? "rgba(200, 50, 50, 0.4)" : "rgba(100, 100, 100, 0.4)";
        ctx.beginPath();
        ctx.arc(point.x, point.y, 25, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }, [game, hoverTarget, pendingBuild]);

  async function createUser() {
    const trimmed = username.trim();
    if (!trimmed) return;
    const res = await fetch(`${backendUrl}/api/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: trimmed }),
    });
    const data = await res.json();
    sessionStorage.setItem("user", JSON.stringify(data));
    setUser(data);
    setRoute("lobby");
    window.history.pushState({}, "", "/lobby");
  }

  function emitAction(action: any) {
    if (!socketRef.current || !user) return;
    socketRef.current.emit("game_action", { roomId: "LOBBY", userId: user.userId, action }, (result: { ok: boolean; error?: string }) => {
      if (!result?.ok) {
        setErrorMsg(result?.error || "Action rejected by server");
      }
    });
  }

  function getOwnPlayer() {
    return game?.players.find((player) => player.id === user?.userId) || null;
  }

  function canAfford(cost: Partial<Record<Resource, number>>): boolean {
    const player = getOwnPlayer();
    if (!player || !player.resources) return false;
    return (Object.keys(cost) as Resource[]).every((resource) => (player.resources?.[resource] ?? 0) >= (cost[resource] || 0));
  }

  function goTo(path: "/" | "/lobby" | "/game") {
    window.history.pushState({}, "", path);
    if (path === "/") setRoute("login");
    if (path === "/lobby") setRoute("lobby");
    if (path === "/game") setRoute("game");
  }

  function getTransform() {
    const canvas = canvasRef.current;
    if (!canvas || !game) return null;
    return getBoardTransform(canvas, game);
  }

  function getVertexPoint(vertexId: number) {
    const transform = getTransform();
    if (!transform || !game) return null;
    const vertex = game.board.vertices[vertexId];
    return transform.toScreen(vertex.x, vertex.y);
  }

  function getEdgePoint(edgeId: number) {
    const transform = getTransform();
    if (!transform || !game) return null;
    const edge = game.board.edges[edgeId];
    const v1 = game.board.vertices[edge.v1];
    const v2 = game.board.vertices[edge.v2];
    return {
      x: (transform.toScreen(v1.x, v1.y).x + transform.toScreen(v2.x, v2.y).x) / 2,
      y: (transform.toScreen(v1.x, v1.y).y + transform.toScreen(v2.x, v2.y).y) / 2,
    };
  }

  function buildableSettlement(vertexId: number, allowSetup = false) {
    if (!game || !user) return false;
    if (game.buildings[vertexId]) return false;
    if (game.board.vertices[vertexId].adjacentVertices.some((neighborId) => !!game.buildings[neighborId])) return false;
    if (allowSetup) return true;
    if (game.phase !== "main" || !isMyTurn || game.mustRoll) return false;
    const connected = game.board.vertices[vertexId].adjacentEdges.some((edgeId) => game.roads[edgeId]?.ownerId === user.userId);
    return connected && canAfford({ wood: 1, brick: 1, sheep: 1, wheat: 1 });
  }

  function buildableCity(vertexId: number) {
    if (!game || !user) return false;
    const building = game.buildings[vertexId];
    if (!building || building.ownerId !== user.userId || building.kind !== "settlement") return false;
    return game.phase === "main" && isMyTurn && !game.mustRoll && canAfford({ wheat: 2, ore: 3 });
  }

  function buildableRoad(edgeId: number, allowSetup = false) {
    if (!game || !user) return false;
    if (game.roads[edgeId]) return false;
    const edge = game.board.edges[edgeId];
    if (allowSetup) return true;
    if (game.phase !== "main" || !isMyTurn || game.mustRoll) return false;
    const touchesOwnBuilding = [edge.v1, edge.v2].some((vertexId) => game.buildings[vertexId]?.ownerId === user.userId);
    const touchesOwnRoad = [edge.v1, edge.v2].some((vertexId) => game.board.vertices[vertexId].adjacentEdges.some((candidateEdgeId) => game.roads[candidateEdgeId]?.ownerId === user.userId));
    return (touchesOwnBuilding || touchesOwnRoad) && canAfford({ wood: 1, brick: 1 });
  }

  function resolveHoverTarget(clientX: number, clientY: number): BuildTarget | null {
    if (!game || !user) return null;
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const transform = getBoardTransform(canvas, game);

    const pickVertex = () => {
      let nearest: number | null = null;
      let nearestDist = Number.POSITIVE_INFINITY;
      for (const vertex of game.board.vertices) {
        const point = transform.toScreen(vertex.x, vertex.y);
        const dist = Math.hypot(point.x - x, point.y - y);
        if (dist < nearestDist) {
          nearest = vertex.id;
          nearestDist = dist;
        }
      }
      return nearestDist <= 50 ? nearest : null;
    };

    const pickEdge = () => {
      let nearest: number | null = null;
      let nearestDist = Number.POSITIVE_INFINITY;
      for (const edge of game.board.edges) {
        const v1 = game.board.vertices[edge.v1];
        const v2 = game.board.vertices[edge.v2];
        const p1 = transform.toScreen(v1.x, v1.y);
        const p2 = transform.toScreen(v2.x, v2.y);
        const dist = pointToSegmentDistance(x, y, p1.x, p1.y, p2.x, p2.y);
        if (dist < nearestDist) {
          nearest = edge.id;
          nearestDist = dist;
        }
      }
      return nearestDist <= 45 ? nearest : null;
    };

    const pickHex = () => {
      let nearest: number | null = null;
      let nearestDist = Number.POSITIVE_INFINITY;
      for (const tile of game.board.tiles) {
        const points = tile.vertexIds.map((id) => transform.toScreen(game.board.vertices[id].x, game.board.vertices[id].y));
        const center = points.reduce((acc, point) => ({ x: acc.x + point.x / points.length, y: acc.y + point.y / points.length }), { x: 0, y: 0 });
        const dist = Math.hypot(center.x - x, center.y - y);
        if (dist < nearestDist) {
          nearest = tile.id;
          nearestDist = dist;
        }
      }
      return nearestDist <= 40 ? nearest : null;
    };

    if (game.phase === "setup") {
      if (setupStage === "settlement") {
        const vertexId = pickVertex();
        if (vertexId === null || !buildableSettlement(vertexId, true)) return null;
        const point = getVertexPoint(vertexId);
        return point ? { kind: "vertex", id: vertexId, x: point.x, y: point.y, buildKind: "settlement" } : null;
      }

      const edgeId = pickEdge();
      if (edgeId === null || setupAnchorVertex === null) return null;
      const edge = game.board.edges[edgeId];
      if (edge.v1 !== setupAnchorVertex && edge.v2 !== setupAnchorVertex) return null;
      const point = getEdgePoint(edgeId);
      return point ? { kind: "edge", id: edgeId, x: point.x, y: point.y, buildKind: "road" } : null;
    }

    if (game.phase !== "main" || !isMyTurn) return null;

    if (game.pendingRobber && requiredDiscard === 0) {
      const hexId = pickHex();
      if (hexId !== null && hexId !== game.robberTileId) {
        const tile = game.board.tiles.find(t => t.id === hexId);
        if (tile && tile.terrain !== "desert") {
          const points = tile.vertexIds.map((id) => transform.toScreen(game.board.vertices[id].x, game.board.vertices[id].y));
          const center = points.reduce((acc, point) => ({ x: acc.x + point.x / points.length, y: acc.y + point.y / points.length }), { x: 0, y: 0 });
          return { kind: "hex", id: hexId, x: center.x, y: center.y, buildKind: "robber" };
        }
      }
      return null;
    }

    if (game.mustRoll || game.pendingRobber || requiredDiscard > 0) return null;

    const vertexId = pickVertex();
    if (vertexId !== null) {
      if (buildableCity(vertexId)) {
        const point = getVertexPoint(vertexId);
        if (point) return { kind: "vertex", id: vertexId, x: point.x, y: point.y, buildKind: "city" };
      }
      if (buildableSettlement(vertexId)) {
        const point = getVertexPoint(vertexId);
        if (point) return { kind: "vertex", id: vertexId, x: point.x, y: point.y, buildKind: "settlement" };
      }
    }

    const edgeId = pickEdge();
    if (edgeId !== null && buildableRoad(edgeId)) {
      const point = getEdgePoint(edgeId);
      if (point) return { kind: "edge", id: edgeId, x: point.x, y: point.y, buildKind: "road" };
    }

    return null;
  }

  function handleCanvasMove(evt: React.MouseEvent<HTMLCanvasElement>) {
    const target = resolveHoverTarget(evt.clientX, evt.clientY);
    setHoverTarget(target);
    if (!pendingBuild) {
      return;
    }
  }

  function handleCanvasClick(evt: React.MouseEvent<HTMLCanvasElement>) {
    const target = resolveHoverTarget(evt.clientX, evt.clientY);
    if (!target) {
      setPendingBuild(null);
      return;
    }
    setPendingBuild(target);
  }

  function confirmBuild() {
    if (!game || !user || !pendingBuild) return;

    if (game.phase === "setup") {
      if (setupStage === "settlement" && pendingBuild.buildKind === "settlement") {
        emitAction({ type: "setup_place_settlement", vertexId: pendingBuild.id });
        setSetupAnchorVertex(pendingBuild.id);
        setSetupStage("road");
        setPendingBuild(null);
        return;
      }

      if (setupStage === "road" && pendingBuild.buildKind === "road" && setupAnchorVertex !== null) {
        emitAction({ type: "setup_place_road", edgeId: pendingBuild.id });
        setPendingBuild(null);
        setSetupAnchorVertex(null);
        setSetupStage("settlement");
        return;
      }
    }

    if (pendingBuild.buildKind === "road") {
      emitAction({ type: "build_road", edgeId: pendingBuild.id });
    } else if (pendingBuild.buildKind === "settlement") {
      emitAction({ type: "build_settlement", vertexId: pendingBuild.id });
    } else if (pendingBuild.buildKind === "city") {
      emitAction({ type: "build_city", vertexId: pendingBuild.id });
    } else if (pendingBuild.buildKind === "robber") {
      const tileId = pendingBuild.id;
      const tile = game.board.tiles.find((t) => t.id === tileId);
      if (tile) {
        const victims = tile.vertexIds
          .map((vid) => game.buildings[vid]?.ownerId)
          .filter((id) => id && id !== user.userId)
          .filter((id, i, arr) => arr.indexOf(id) === i)
          .filter((id) => (game.players.find((p) => p.id === id)?.resourceCount ?? 0) > 0);

        if (victims.length === 0) {
          emitAction({ type: "move_robber", tileId });
        } else {
          setRobberHexSelection(tileId);
        }
      }
    }

    setPendingBuild(null);
  }

  function startGame() {
    if (!socketRef.current || !user) return;
    socketRef.current.emit("start_game", { roomId: "LOBBY", userId: user.userId });
  }

  function resetLobby() {
    socketRef.current?.emit("reset_lobby");
  }
  if (!user) {
    return (
      <Shell theme={theme} setTheme={setTheme} title="Catan Room">
        <div className="grid place-items-center p-6 min-h-[calc(100vh-5rem)]">
          <section className="card w-full max-w-md bg-base-100 shadow-2xl border border-base-300">
            <div className="card-body">
              <h1 className="text-3xl font-bold text-base-content">Catan Room</h1>
              <p className="text-sm opacity-75">Enter a guest name to join the shared lobby.</p>
              <input
                className="input input-bordered w-full"
                placeholder="Guest name"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
              />
              <button className="btn btn-primary" onClick={createUser} disabled={!username.trim()}>
                Enter Lobby
              </button>
            </div>
          </section>
        </div>
      </Shell>
    );
  }

  if (route === "lobby" || !game || game.phase === "lobby") {
    const lobbyPlayers = game?.players ?? [];
    const slots = Array.from({ length: 4 }, (_, index) => lobbyPlayers[index] ?? null);

    return (
      <Shell theme={theme} setTheme={setTheme} title="Catan Room" user={user.username} onHome={() => goTo("/lobby")}>
        <div className="mx-auto max-w-345 grid gap-4 lg:grid-cols-[1fr_360px]">
          <section className="card bg-base-100 border border-base-300 shadow-xl">
            <div className="card-body">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h1 className="text-3xl font-bold">Lobby</h1>
                  <p className="opacity-75">Signed in as {user.username}. Wait here until four players join, then start the game.</p>
                </div>
                <span className="badge badge-info">{errorMsg || "Connected"}</span>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <button className="btn btn-primary" onClick={() => socketRef.current?.emit("get_room", { roomId: "LOBBY", userId: user.userId })}>
                  Refresh Lobby
                </button>
                <button className="btn btn-outline btn-error" onClick={resetLobby}>
                  Reset Lobby
                </button>
              </div>
              <div className="mt-4 grid gap-3">
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div className="badge badge-outline">Phase: {game?.phase ?? "lobby"}</div>
                  <div className="badge badge-outline">Players: {lobbyPlayers.length}/4</div>
                </div>
                <button className="btn btn-primary" onClick={startGame} disabled={lobbyPlayers.length !== 4}>
                  Start Game
                </button>
              </div>
            </div>
          </section>

          <section className="card bg-base-100 border border-base-300 shadow-xl">
            <div className="card-body">
              <h2 className="card-title text-lg">Connection</h2>
              <p className="text-sm opacity-75">The game board opens only after someone starts the match.</p>
              <div className="skeleton h-4 w-3/4 mt-4" />
              <div className="skeleton h-4 w-1/2" />
              <div className="skeleton h-4 w-5/6" />
            </div>
          </section>
        </div>

        <section className="max-w-5xl mx-auto mt-4">
          <div className="card bg-base-100 border border-base-300 shadow-xl">
            <div className="card-body p-4">
              <h3 className="card-title text-lg">Players</h3>
              <div className="grid grid-cols-2 gap-2 mt-3">
                {slots.map((player, index) => (
                  <div key={index} className="rounded-box border border-base-300 bg-base-200 px-3 py-2 text-sm">
                    <div className="font-semibold">Slot {index + 1}</div>
                    <div className="opacity-75">{player ? player.username : "Waiting..."}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>
      </Shell>
    );
  }

  const currentTurnName = game.players.find((player) => player.id === game.activePlayerId)?.username ?? "-";
  const dice = game.lastRoll;

  return (
    <Shell theme={theme} setTheme={setTheme} title="Catan Room" user={user.username} onHome={() => goTo("/lobby")}>
      <div className="mx-auto max-w-345 grid gap-4 lg:grid-cols-[1fr_320px]">
        <section className="card bg-base-100 border border-base-300 shadow-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-base-300 bg-base-200 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-2xl font-semibold">Room {game.id}</h2>
              <p className="text-sm opacity-70">{user.username} ({user.userId})</p>
            </div>
            <div className="flex items-center gap-2">
              <span className={`badge ${isMyTurn ? "badge-success" : "badge-neutral"}`}>
                {game.phase === "setup" ? `Setup: ${setupStage === "road" ? "place road" : "place settlement"}` : isMyTurn ? "Your Turn" : `Active: ${currentTurnName}`}
              </span>
              <button className="btn btn-sm btn-outline btn-error" onClick={resetLobby}>Reset Lobby</button>
            </div>
          </div>

          <div className="relative">
            <canvas
              ref={canvasRef}
              className="w-full h-[68vh] lg:h-[78vh] cursor-crosshair"
              onMouseMove={handleCanvasMove}
              onMouseLeave={() => setHoverTarget(null)}
              onClick={handleCanvasClick}
            />

            {pendingBuild ? (
              <div
                className="absolute z-10 -translate-x-1/2 -translate-y-full"
                style={{ left: pendingBuild.x, top: pendingBuild.y - 8 }}
              >
                <div className="card bg-base-100 border border-base-300 shadow-2xl min-w-28">
                  <div className="card-body p-2 items-center text-center gap-2">
                    <div className="text-2xl leading-none">
                      {pendingBuild.buildKind === "road" ? "🛣️" : pendingBuild.buildKind === "city" ? "🏛️" : "🏠"}
                    </div>
                    <div className="text-[11px] uppercase tracking-[0.2em] opacity-60">{pendingBuild.buildKind}</div>
                    <button className="btn btn-xs btn-primary" onClick={confirmBuild}>
                      Confirm
                    </button>
                  </div>
                </div>
              </div>
            ) : hoverTarget ? (
              <div
                className="absolute z-10 -translate-x-1/2 -translate-y-full"
                style={{ left: hoverTarget.x, top: hoverTarget.y - 8 }}
              >
                <div className="badge badge-outline bg-base-100/95 shadow-lg p-3 text-sm">
                  Click to build {hoverTarget.buildKind}
                </div>
              </div>
            ) : null}
          </div>

          {game.phase === "setup" ? (
            <div className="px-4 pb-4 text-sm opacity-75">
              Setup: place the settlement first, then confirm the adjacent road. Second settlements grant starting resources after the road is placed.
            </div>
          ) : null}
        </section>

        <aside className="space-y-4">
          <section className="card bg-base-100 border border-base-300 shadow-xl">
            <div className="card-body p-4">
              <h3 className="card-title text-lg">Log</h3>
              <div className="space-y-2 overflow-y-auto pr-1 h-[250px]">
                {[...game.log].slice(-50).reverse().map((item, idx) => (
                  <div key={`${item.ts}-${idx}`} className="alert py-2 text-xs bg-base-200 border-base-300">
                    {new Date(item.ts).toLocaleTimeString()} - {item.text}
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section className="card bg-base-100 border border-base-300 shadow-xl">
            <div className="card-body p-4">
              <h3 className="card-title text-lg">Players</h3>
              <div className="space-y-2 pr-1">
                {game.players.map((player, index) => {
                  const palette = ["#e11d48", "#0284c7", "#16a34a", "#ca8a04"];
                  const playerColor = palette[index % palette.length];
                  return (
                    <div key={player.id} className="p-2 rounded-md border border-base-300 bg-base-200 text-sm relative overflow-hidden">
                      <div className="absolute left-0 top-0 bottom-0 w-2" style={{ backgroundColor: playerColor }}></div>
                      <div className="pl-3">
                        <div className="font-semibold">{player.username}</div>
                        <div>VP: {player.victoryPoints} | Knights: {player.playedKnights}</div>
                        <div className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
                          <div className="rounded-box border border-base-300 bg-base-100 px-2 py-1 text-center">
                            <div className="uppercase opacity-55">Roads</div>
                            <div className="font-semibold">{pieceInventory(player).roadsBuilt}/15</div>
                          </div>
                          <div className="rounded-box border border-base-300 bg-base-100 px-2 py-1 text-center">
                            <div className="uppercase opacity-55">Settlements</div>
                            <div className="font-semibold">{pieceInventory(player).settlementsBuilt}/5</div>
                          </div>
                          <div className="rounded-box border border-base-300 bg-base-100 px-2 py-1 text-center">
                            <div className="uppercase opacity-55">Cities</div>
                            <div className="font-semibold">{pieceInventory(player).citiesBuilt}/4</div>
                          </div>
                        </div>
                        {player.id === user.userId ? null : (
                          <div className="mt-2 text-xs">Cards: {player.resourceCount ?? 0}, Dev: {player.devCardCount ?? 0}</div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </section>
        </aside>
      </div>

      <div className="fixed bottom-4 right-4 z-30 w-56">
        <div className="card bg-base-100 border border-base-300 shadow-2xl">
          <div className="card-body p-3 gap-3">
            <div className="flex items-center justify-between text-sm">
              <span className="font-semibold">Dice</span>
              <span className="badge badge-outline">{game.phase}</span>
            </div>

            {game.phase === "main" && isMyTurn && game.mustRoll ? (
              <button className="btn btn-primary w-full" onClick={() => emitAction({ type: "roll_dice" })}>
                Roll Dice
              </button>
            ) : null}

            {dice ? (
              <div className="grid grid-cols-3 gap-2 items-center">
                <div className="rounded-box border border-base-300 bg-base-200 py-3 text-center text-xl font-bold">{dice.die1}</div>
                <div className="text-center text-xs opacity-60">+</div>
                <div className="rounded-box border border-base-300 bg-base-200 py-3 text-center text-xl font-bold">{dice.die2}</div>
                <div className="col-span-3 rounded-box border border-base-300 bg-base-200 py-2 text-center text-sm font-semibold">Total {dice.total}</div>
              </div>
            ) : null}

            {game.phase === "main" && isMyTurn && !game.mustRoll ? (
              <button className="btn btn-secondary w-full" onClick={() => emitAction({ type: "end_turn" })}>
                End Turn
              </button>
            ) : null}

            {requiredDiscard > 0 ? (
              <div className="text-xs text-warning-content bg-warning rounded-box p-2">
                Discard {requiredDiscard} cards before continuing.
              </div>
            ) : null}

            {game.phase === "main" && isMyTurn && !game.mustRoll ? (
              <div className="text-[11px] leading-4 opacity-70">
                Use the board to build roads, settlements, and cities.
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {getOwnPlayer() ? (
        <div className="fixed bottom-4 left-4 z-40 bg-base-100/95 backdrop-blur border border-base-300 rounded-box px-4 pb-2 pt-2 flex items-end gap-2 shadow-2xl card-bar overflow-x-auto max-w-[calc(100vw-18rem)] min-h-[80px]">
          {resourceKeys().map((res) => {
            const count = getOwnPlayer()?.resources?.[res] ?? 0;
            if (count === 0) return null;
            return (
              <div key={res} className={`card-display ${res}`}>
                {res.charAt(0).toUpperCase() + res.slice(1)}
                <div className="card-count">{count}</div>
              </div>
            );
          })}
          {Object.entries(getOwnPlayer()?.devCards ?? {}).map(([dev, count]) => {
            const num = (count as number) + (getOwnPlayer()?.newDevCards?.[dev as DevCard] ?? 0);
            if (num === 0) return null;
            return (
              <div key={dev} className="card-display devcard">
                {dev.charAt(0).toUpperCase() + dev.slice(1)}
                <div className="card-count">{num}</div>
              </div>
            );
          })}
        </div>
      ) : null}

      {robberHexSelection !== null && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center">
          <div className="card bg-base-100 w-full max-w-sm shadow-2xl border border-base-300 p-4">
            <h3 className="text-xl font-bold mb-4">Select Player to Rob</h3>
            <div className="robber-victim-select">
              {(() => {
                const tile = game.board.tiles.find((t) => t.id === robberHexSelection);
                if (!tile) return null;
                const victims = tile.vertexIds
                  .map((vid) => game.buildings[vid]?.ownerId)
                  .filter((id) => id && id !== user.userId)
                  .filter((id, i, arr) => arr.indexOf(id) === i)
                  .filter((id) => (game.players.find((p) => p.id === id)?.resourceCount ?? 0) > 0);

                if (victims.length === 0) return <div className="text-center opacity-70 p-4">No victims available</div>;

                return victims.map((id) => {
                  const p = game.players.find(p => p.id === id);
                  return (
                    <div
                      key={id as string}
                      className={`robber-victim-option ${robberVictimSelection === id ? 'active' : ''}`}
                      onClick={() => setRobberVictimSelection(id as string)}
                    >
                      {p?.username} ({p?.resourceCount} cards)
                    </div>
                  );
                });
              })()}
            </div>
            <div className="mt-6 flex gap-2 justify-end">
              <button className="btn btn-outline" onClick={() => { setRobberHexSelection(null); setRobberVictimSelection(null); }}>Cancel</button>
              <button
                className="btn btn-primary"
                disabled={!robberVictimSelection}
                onClick={() => {
                  emitAction({ type: "move_robber", tileId: robberHexSelection, targetPlayerId: robberVictimSelection });
                  setRobberHexSelection(null);
                  setRobberVictimSelection(null);
                }}
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}

      {requiredDiscard > 0 && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center">
          <div className="card bg-base-100 w-full max-w-lg shadow-2xl border border-base-300 p-4">
            <h2 className="text-2xl font-bold mb-2 text-error">Discard Cards</h2>
            <p className="opacity-75 mb-4">You rolled a 7. Please select {requiredDiscard} cards to discard.</p>
            <div className="discard-grid">
              {resourceKeys().map((res) => {
                const count = getOwnPlayer()?.resources?.[res] ?? 0;
                if (count === 0) return null;
                const selectedCount = discardSelection.filter(r => r === res).length;
                return (
                  <div key={res} className="text-center">
                    <div
                      className={`discard-card ${res} ${selectedCount > 0 ? "selected" : ""}`}
                      onClick={() => {
                        if (discardSelection.length < requiredDiscard && selectedCount < count) {
                          setDiscardSelection([...discardSelection, res]);
                        }
                      }}
                    >
                      {res} ({count})
                    </div>
                    {selectedCount > 0 && (
                      <div className="text-xs mt-1 text-primary cursor-pointer font-bold select-none" onClick={() => {
                        const idx = discardSelection.indexOf(res);
                        if (idx >= 0) {
                          const next = [...discardSelection];
                          next.splice(idx, 1);
                          setDiscardSelection(next);
                        }
                      }}>
                        -{selectedCount}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="mt-6 flex justify-between items-center">
              <span className="font-semibold">Selected: {discardSelection.length} / {requiredDiscard}</span>
              <button
                className="btn btn-error"
                disabled={discardSelection.length !== requiredDiscard}
                onClick={() => {
                  const discardObj = discardSelection.reduce((acc, r) => {
                    acc[r] = (acc[r] || 0) + 1;
                    return acc;
                  }, {} as Record<Resource, number>);
                  emitAction({ type: "discard_resources", discard: discardObj });
                  setDiscardSelection([]);
                }}
              >
                Confirm Discard
              </button>
            </div>
          </div>
        </div>
      )}
    </Shell>
  );
}

function Shell({
  title,
  user,
  theme,
  setTheme,
  onHome,
  children,
}: {
  title: string;
  user?: string;
  theme: string;
  setTheme: (value: string) => void;
  onHome?: () => void;
  children: ReactNode;
}) {
  return (
    <main className="min-h-screen">
      <div className="navbar bg-base-100/85 backdrop-blur border-b border-base-300 sticky top-0 z-20 px-4">
        <div className="flex-1 gap-3">
          <button className="btn btn-ghost btn-sm text-lg font-semibold" onClick={onHome} type="button">
            {title}
          </button>
          {user ? <span className="badge badge-outline hidden sm:inline-flex">{user}</span> : null}
        </div>
        <div className="flex-none gap-2">
          <button className="btn btn-sm btn-outline" onClick={() => setTheme(theme === "catan-pink" ? "discord-dark" : "catan-pink")} type="button">
            {theme === "catan-pink" ? "Dark mode" : "Light mode"}
          </button>
        </div>
      </div>
      {children}
    </main>
  );
}

function pointToSegmentDistance(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (dx === 0 && dy === 0) return Math.hypot(px - x1, py - y1);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
  const projX = x1 + t * dx;
  const projY = y1 + t * dy;
  return Math.hypot(px - projX, py - projY);
}
