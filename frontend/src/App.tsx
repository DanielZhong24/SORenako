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
  pendingTrade: {
    authorId: string;
    offer: Partial<Record<Resource, number>>;
    request: Partial<Record<Resource, number>>;
  } | null;
  robberTileId: number;
  longestRoadHolder: string | null;
  largestArmyHolder: string | null;
  winnerId: string | null;
  lastRoll: { die1: number; die2: number; total: number } | null;
  pendingSetupPlacement: { userId: string; vertexId: number } | null;
  board: Board;
  devDeckCount: number;
  playedDevCardThisTurn: boolean;
  resourceBank: Record<Resource, number>;
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

type DevPlayState =
  | { card: "knight" }
  | { card: "roadBuilding"; selectedEdges: number[] }
  | { card: "yearOfPlenty"; selectedResources: Resource[] }
  | { card: "monopoly"; selectedResource: Resource | null };

type Camera = {
  scale: number;
  offsetX: number;
  offsetY: number;
};

type DragState = {
  active: boolean;
  moved: boolean;
  startX: number;
  startY: number;
  startCamera: Camera | null;
};

function terrainColor(terrain: string): string {
  if (terrain === "forest") return "#3E6B3A";
  if (terrain === "hills") return "#A75D36";
  if (terrain === "pasture") return "#7CBF5A";
  if (terrain === "fields") return "#E0B83E";
  if (terrain === "mountains") return "#7B808B";
  return "#D9C29C";
}

type PortInfo = { type: Resource | "any"; rate: 2 | 3 };

function portColor(type: Resource | "any"): string {
  if (type === "any") return "#d1d5db";
  if (type === "wood") return "#22c55e";
  if (type === "brick") return "#b45309";
  if (type === "sheep") return "#d4d4d8";
  if (type === "wheat") return "#eab308";
  return "#6b7280";
}

function samePort(a: PortInfo | undefined, b: PortInfo | undefined): boolean {
  return !!a && !!b && a.type === b.type && a.rate === b.rate;
}

function portEmoji(type: Resource | "any"): string {
  if (type === "any") return "❓";
  if (type === "wood") return "🌲";
  if (type === "brick") return "🧱";
  if (type === "sheep") return "🐑";
  if (type === "wheat") return "🌾";
  return "🪨";
}

function resourceEmoji(resource: Resource): string {
  if (resource === "wood") return "🌲";
  if (resource === "brick") return "🧱";
  if (resource === "sheep") return "🐑";
  if (resource === "wheat") return "🌾";
  return "⛰️";
}

function pipCountForNumber(value: number): number {
  if (value === 2 || value === 12) return 1;
  if (value === 3 || value === 11) return 2;
  if (value === 4 || value === 10) return 3;
  if (value === 5 || value === 9) return 4;
  if (value === 6 || value === 8) return 5;
  return 0;
}

function drawProbabilityPips(ctx: CanvasRenderingContext2D, centerX: number, centerY: number, count: number) {
  const dotRadius = 1.6;
  const dotFill = "#2f241c";
  const drawDot = (x: number, y: number) => {
    ctx.beginPath();
    ctx.arc(x, y, dotRadius, 0, Math.PI * 2);
    ctx.fill();
  };

  ctx.fillStyle = dotFill;

  const spacing = count === 1 ? 0 : count === 2 ? 7 : count === 3 ? 7 : count === 4 ? 6 : 5.5;
  const start = centerX - spacing * (count - 1) * 0.5;
  for (let i = 0; i < count; i += 1) {
    drawDot(start + spacing * i, centerY);
  }
}

function drawPortGraphic(
  ctx: CanvasRenderingContext2D,
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  port: PortInfo,
  boardCenter: { x: number; y: number },
) {
  const bridgeMid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
  const outwardDx = bridgeMid.x - boardCenter.x;
  const outwardDy = bridgeMid.y - boardCenter.y;
  const outwardLength = Math.hypot(outwardDx, outwardDy) || 1;
  const outX = outwardDx / outwardLength;
  const outY = outwardDy / outwardLength;

  const boatCenter = {
    x: bridgeMid.x + outX * 42,
    y: bridgeMid.y + outY * 42,
  };

  const bridgeLength = 34;
  const leftBridgeVector = { x: boatCenter.x - p1.x, y: boatCenter.y - p1.y };
  const rightBridgeVector = { x: boatCenter.x - p2.x, y: boatCenter.y - p2.y };
  const leftBridgeVectorLength = Math.hypot(leftBridgeVector.x, leftBridgeVector.y) || 1;
  const rightBridgeVectorLength = Math.hypot(rightBridgeVector.x, rightBridgeVector.y) || 1;
  const leftBridgeEnd = {
    x: p1.x + (leftBridgeVector.x / leftBridgeVectorLength) * bridgeLength,
    y: p1.y + (leftBridgeVector.y / leftBridgeVectorLength) * bridgeLength,
  };
  const rightBridgeEnd = {
    x: p2.x + (rightBridgeVector.x / rightBridgeVectorLength) * bridgeLength,
    y: p2.y + (rightBridgeVector.y / rightBridgeVectorLength) * bridgeLength,
  };

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  const drawBridgeArm = (start: { x: number; y: number }, end: { x: number; y: number }) => {
    const armDx = end.x - start.x;
    const armDy = end.y - start.y;
    const armLength = Math.hypot(armDx, armDy) || 1;
    const plankCount = Math.max(2, Math.floor(armLength / 14));

    ctx.strokeStyle = "rgba(122, 77, 33, 0.95)";
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();

    ctx.strokeStyle = "rgba(255, 255, 255, 0.4)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();

    for (let i = 1; i < plankCount; i += 1) {
      const t = i / plankCount;
      const x = start.x + armDx * t;
      const y = start.y + armDy * t;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(Math.atan2(armDy, armDx));
      ctx.fillStyle = "rgba(85, 54, 20, 0.95)";
      ctx.fillRect(-1.1, -4.2, 2.2, 8.4);
      ctx.restore();
    }
  };

  drawBridgeArm(p1, leftBridgeEnd);
  drawBridgeArm(p2, rightBridgeEnd);

  const approachLength = 10;
  ctx.strokeStyle = "rgba(85, 54, 20, 0.9)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(p1.x, p1.y);
  ctx.lineTo(p1.x + outX * approachLength, p1.y + outY * approachLength);
  ctx.moveTo(p2.x, p2.y);
  ctx.lineTo(p2.x + outX * approachLength, p2.y + outY * approachLength);
  ctx.stroke();

  const portFill = portColor(port.type);
  const tradeEmoji = portEmoji(port.type);

  ctx.save();
  ctx.translate(boatCenter.x, boatCenter.y);

  ctx.fillStyle = "rgba(53, 40, 28, 0.95)";
  ctx.beginPath();
  ctx.ellipse(0, 15, 28, 11, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "rgba(122, 77, 33, 0.95)";
  ctx.beginPath();
  ctx.moveTo(-22, 14);
  ctx.quadraticCurveTo(0, 2, 22, 14);
  ctx.lineTo(16, 21);
  ctx.lineTo(-16, 21);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = "rgba(33, 37, 41, 0.95)";
  ctx.fillRect(-1.5, -26, 3, 31);

  ctx.fillStyle = portFill;
  ctx.beginPath();
  ctx.moveTo(1, -24);
  ctx.lineTo(42, -30);
  ctx.lineTo(42, -2);
  ctx.lineTo(1, -7);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = "rgba(17, 24, 39, 0.95)";
  ctx.lineWidth = 1.2;
  ctx.stroke();

  ctx.fillStyle = "rgba(255, 255, 255, 0.98)";
  ctx.font = "bold 10px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(`${port.rate}:1`, 22, -34);
  ctx.font = "bold 18px sans-serif";
  ctx.fillText(tradeEmoji, 22, -16);

  ctx.restore();

  ctx.restore();
  ctx.restore();
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

function getFitCamera(canvas: HTMLCanvasElement, game: GameState): Camera {
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

  return { scale, offsetX, offsetY };
}

function getBoardTransform(camera: Camera) {
  return {
    scale: camera.scale,
    offsetX: camera.offsetX,
    offsetY: camera.offsetY,
    toScreen(x: number, y: number) {
      return { x: x * camera.scale + camera.offsetX, y: y * camera.scale + camera.offsetY };
    },
  };
}

const DiceFace = ({ value }: { value: number }) => {
  const dots = [];
  if (value === 1) dots.push("g");
  else if (value === 2) dots.push("a", "b");
  else if (value === 3) dots.push("a", "g", "b");
  else if (value === 4) dots.push("a", "c", "d", "b");
  else if (value === 5) dots.push("a", "c", "g", "d", "b");
  else if (value === 6) dots.push("a", "c", "e", "f", "d", "b");

  return (
    <div className="dice-face">
      {dots.map(area => <div key={area} className="dice-dot" style={{ gridArea: area }} />)}
    </div>
  );
};

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
  const [selectedHandCards, setSelectedHandCards] = useState<Resource[]>([]);
  const [selectedDevCard, setSelectedDevCard] = useState<Exclude<DevCard, "victoryPoint"> | null>(null);
  const [devPlayState, setDevPlayState] = useState<DevPlayState | null>(null);
  const [tradeModalOpen, setTradeModalOpen] = useState(false);
  const [tradeRequest, setTradeRequest] = useState<Record<Resource, number>>({ wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 });
  const [robberHexSelection, setRobberHexSelection] = useState<number | null>(null);
  const [robberVictimSelection, setRobberVictimSelection] = useState<string | null>(null);
  const [robberSelectionSource, setRobberSelectionSource] = useState<"board" | "knight" | null>(null);
  const [camera, setCamera] = useState<Camera | null>(null);
  const dragStateRef = useRef<DragState>({ active: false, moved: false, startX: 0, startY: 0, startCamera: null });
  const suppressNextClickRef = useRef(false);

  const isMyTurn = !!user && !!game && game.activePlayerId === user.userId;
  const requiredDiscard = user && game ? game.pendingDiscards[user.userId] || 0 : 0;
  const ownPlayer = getOwnPlayer();
  const canRollDice = !!game && !!user && game.phase === "main" && isMyTurn && game.mustRoll && requiredDiscard === 0 && !game.pendingRobber;
  const canPlayDevCard = (card: Exclude<DevCard, "victoryPoint">) =>
    !!game &&
    !!user &&
    game.phase === "main" &&
    isMyTurn &&
    !game.mustRoll &&
    requiredDiscard === 0 &&
    !game.pendingRobber &&
    !game.playedDevCardThisTurn &&
    (ownPlayer?.devCards?.[card] ?? 0) > 0;

  const selectedDevCardPlayable = selectedDevCard ? canPlayDevCard(selectedDevCard) : false;
  const canBuyDevCard =
    !!game &&
    !!user &&
    game.phase === "main" &&
    isMyTurn &&
    !game.mustRoll &&
    requiredDiscard === 0 &&
    !game.pendingRobber &&
    (game.devDeckCount ?? 0) > 0 &&
    (ownPlayer?.resources?.sheep ?? 0) >= 1 &&
    (ownPlayer?.resources?.wheat ?? 0) >= 1 &&
    (ownPlayer?.resources?.ore ?? 0) >= 1;

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
  }, [theme]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previousHtmlOverflow = document.documentElement.style.overflow;

    if (route === "game") {
      document.body.style.overflow = "hidden";
      document.documentElement.style.overflow = "hidden";
      window.scrollTo(0, 0);
    } else {
      document.body.style.overflow = previousOverflow;
      document.documentElement.style.overflow = previousHtmlOverflow;
    }

    return () => {
      document.body.style.overflow = previousOverflow;
      document.documentElement.style.overflow = previousHtmlOverflow;
    };
  }, [route]);

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
      if (isMyTurn) {
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
    if (!canvas || !game) {
      setCamera(null);
      return;
    }

    setCamera((current) => current ?? getFitCamera(canvas, game));
  }, [game?.id]);

  useEffect(() => {
    if (!game) return;

    const onWindowMouseMove = (event: MouseEvent) => {
      const drag = dragStateRef.current;
      if (!drag.active || !drag.startCamera) return;

      const deltaX = event.clientX - drag.startX;
      const deltaY = event.clientY - drag.startY;
      if (!drag.moved && Math.hypot(deltaX, deltaY) > 4) {
        drag.moved = true;
      }

      setCamera({
        scale: drag.startCamera.scale,
        offsetX: drag.startCamera.offsetX + deltaX,
        offsetY: drag.startCamera.offsetY + deltaY,
      });
    };

    const onWindowMouseUp = () => {
      const drag = dragStateRef.current;
      if (!drag.active) return;

      drag.active = false;
      drag.startCamera = null;
      suppressNextClickRef.current = drag.moved;
      drag.moved = false;
    };

    window.addEventListener("mousemove", onWindowMouseMove);
    window.addEventListener("mouseup", onWindowMouseUp);
    return () => {
      window.removeEventListener("mousemove", onWindowMouseMove);
      window.removeEventListener("mouseup", onWindowMouseUp);
    };
  }, [game]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !game) return;

    const onWheel = (event: WheelEvent) => {
      handleCanvasWheel(event);
    };

    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      canvas.removeEventListener("wheel", onWheel);
    };
  }, [game, camera]);

  useEffect(() => {
    let animationFrameId: number;

    const render = (time: number) => {
      const canvas = canvasRef.current;
      if (!canvas || !game) return;

      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      canvas.width = width;
      canvas.height = height;
      const activeCamera = camera ?? getFitCamera(canvas, game);
      const transform = getBoardTransform(activeCamera);
      const boardCenter = transform.toScreen(0, 0);

      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = "#2751e8";
      ctx.fillRect(0, 0, width, height);

      const pulse = (Math.sin(time / 250) + 1) / 2; // 0 to 1

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
        
        const isRobberTarget = game.phase === "main" && isMyTurn && game.pendingRobber && requiredDiscard === 0 && tile.terrain !== "desert" && tile.id !== game.robberTileId;
        if (isRobberTarget) {
          ctx.fillStyle = `rgba(16, 185, 129, ${0.2 + 0.3 * pulse})`; // green pulse
          ctx.fill();
        }
        
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
          ctx.font = "bold 15px Georgia";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(String(tile.number), center.x, center.y - 3.5);
          drawProbabilityPips(ctx, center.x, center.y + 6, pipCountForNumber(tile.number));
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

        if (vertex.port) {
          const pairedVertex = game.board.vertices.find((candidate) => candidate.id !== vertex.id && samePort(candidate.port, vertex.port) && vertex.adjacentVertices.includes(candidate.id));
          if (pairedVertex && vertex.id < pairedVertex.id) {
            const pairedPoint = transform.toScreen(pairedVertex.x, pairedVertex.y);
            drawPortGraphic(ctx, point, pairedPoint, vertex.port, boardCenter);
          }
        }

        const isSetupVertexTarget = game.phase === "setup" && setupStage === "settlement" && !game.buildings[vertex.id] && !vertex.adjacentVertices.some((n) => !!game.buildings[n]) && (!game.pendingSetupPlacement || game.pendingSetupPlacement.userId === user?.userId);
        
        if (isSetupVertexTarget) {
          ctx.fillStyle = `rgba(16, 185, 129, ${0.4 + 0.5 * pulse})`;
          ctx.beginPath();
          ctx.arc(point.x, point.y, 8 + 4 * pulse, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.fillStyle = hoverTarget?.kind === "vertex" && hoverTarget.id === vertex.id ? "#0f766e" : "rgba(17, 24, 39, 0.35)";
          ctx.beginPath();
          ctx.arc(point.x, point.y, 3, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      const isSetupRoadTarget = game.phase === "setup" && setupStage === "road" && setupAnchorVertex !== null;
      if (isSetupRoadTarget) {
        for (const edge of game.board.edges) {
          if (!game.roads[edge.id] && (edge.v1 === setupAnchorVertex || edge.v2 === setupAnchorVertex)) {
            const v1 = game.board.vertices[edge.v1];
            const v2 = game.board.vertices[edge.v2];
            const p1 = transform.toScreen(v1.x, v1.y);
            const p2 = transform.toScreen(v2.x, v2.y);
            const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
            ctx.fillStyle = `rgba(16, 185, 129, ${0.4 + 0.5 * pulse})`;
            ctx.beginPath();
            ctx.arc(mid.x, mid.y, 8 + 4 * pulse, 0, Math.PI * 2);
            ctx.fill();
          }
        }
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
          ctx.fillStyle = pendingBuild ? "rgba(245, 158, 11, 0.8)" : "rgba(15, 118, 110, 0.8)";
          ctx.beginPath();
          ctx.arc(point.x, point.y, pendingBuild ? 12 : 10, 0, Math.PI * 2);
          ctx.fill();
        } else if (target.kind === "hex") {
          ctx.fillStyle = pendingBuild ? "rgba(200, 50, 50, 0.4)" : "rgba(100, 100, 100, 0.4)";
          ctx.beginPath();
          ctx.arc(point.x, point.y, 25, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      animationFrameId = requestAnimationFrame(render);
    };

    animationFrameId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animationFrameId);
  }, [game, camera, hoverTarget, pendingBuild, user?.userId, setupStage, setupAnchorVertex, isMyTurn, requiredDiscard]);

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

  function cancelDevPlay() {
    setDevPlayState(null);
    setRobberHexSelection(null);
    setRobberVictimSelection(null);
    setRobberSelectionSource(null);
    setSelectedDevCard(null);
  }

  function startDevPlay(card: Exclude<DevCard, "victoryPoint">) {
    if (!selectedDevCard || selectedDevCard !== card) return;
    if (!canPlayDevCard(card)) return;
    if (card === "knight") {
      setDevPlayState({ card: "knight" });
      setRobberHexSelection(null);
      setRobberVictimSelection(null);
      return;
    }
    if (card === "roadBuilding") {
      setDevPlayState({ card: "roadBuilding", selectedEdges: [] });
      return;
    }
    if (card === "yearOfPlenty") {
      setDevPlayState({ card: "yearOfPlenty", selectedResources: [] });
      return;
    }
    setDevPlayState({ card: "monopoly", selectedResource: null });
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
    return getBoardTransform(camera ?? getFitCamera(canvas, game));
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

  function buildableRoad(edgeId: number, allowSetup = false, freeBuild = false) {
    if (!game || !user) return false;
    if (game.roads[edgeId]) return false;
    const edge = game.board.edges[edgeId];
    if (allowSetup) return true;
    if (game.phase !== "main" || !isMyTurn || game.mustRoll) return false;
    const touchesOwnBuilding = [edge.v1, edge.v2].some((vertexId) => game.buildings[vertexId]?.ownerId === user.userId);
    const touchesOwnRoad = [edge.v1, edge.v2].some((vertexId) => {
      if (game.buildings[vertexId] && game.buildings[vertexId]?.ownerId !== user.userId) return false;
      return game.board.vertices[vertexId].adjacentEdges.some((candidateEdgeId) => game.roads[candidateEdgeId]?.ownerId === user.userId);
    });
    return (touchesOwnBuilding || touchesOwnRoad) && (freeBuild || canAfford({ wood: 1, brick: 1 }));
  }

  function resolveHoverTarget(clientX: number, clientY: number): BuildTarget | null {
    if (!game || !user) return null;
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const transform = getTransform();
    if (!transform) return null;

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

    if ((game.pendingRobber || devPlayState?.card === "knight") && requiredDiscard === 0) {
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

    if (devPlayState?.card === "knight") return null;

    if (game.mustRoll || game.pendingRobber || requiredDiscard > 0) return null;

    if (devPlayState?.card !== "roadBuilding") {
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
    }

    const edgeId = pickEdge();
    if (edgeId !== null && buildableRoad(edgeId, false, devPlayState?.card === "roadBuilding")) {
      const point = getEdgePoint(edgeId);
      if (point) return { kind: "edge", id: edgeId, x: point.x, y: point.y, buildKind: "road" };
    }

    return null;
  }

  function handleCanvasMove(evt: React.MouseEvent<HTMLCanvasElement>) {
    const drag = dragStateRef.current;
    if (drag.active && drag.startCamera) {
      const deltaX = evt.clientX - drag.startX;
      const deltaY = evt.clientY - drag.startY;
      if (!drag.moved && Math.hypot(deltaX, deltaY) > 4) {
        drag.moved = true;
      }

      setCamera({
        scale: drag.startCamera.scale,
        offsetX: drag.startCamera.offsetX + deltaX,
        offsetY: drag.startCamera.offsetY + deltaY,
      });
      return;
    }

    const target = resolveHoverTarget(evt.clientX, evt.clientY);
    setHoverTarget(target);
    if (!pendingBuild) {
      return;
    }
  }

  function handleCanvasMouseDown(evt: React.MouseEvent<HTMLCanvasElement>) {
    if (evt.button !== 0 || !game) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    dragStateRef.current = {
      active: true,
      moved: false,
      startX: evt.clientX,
      startY: evt.clientY,
      startCamera: camera ?? getFitCamera(canvas, game),
    };
    suppressNextClickRef.current = false;
    setHoverTarget(null);
  }

  function handleCanvasWheel(evt: WheelEvent) {
    if (!game) return;
    evt.preventDefault();

    const canvas = canvasRef.current;
    if (!canvas) return;

    const currentCamera = camera ?? getFitCamera(canvas, game);
    const rect = canvas.getBoundingClientRect();
    const x = evt.clientX - rect.left;
    const y = evt.clientY - rect.top;

    const zoomFactor = evt.deltaY > 0 ? 0.88 : 1.14;
    const fitCamera = getFitCamera(canvas, game);
    const minScale = fitCamera.scale * 0.35;
    const maxScale = fitCamera.scale * 4.5;
    const nextScale = Math.min(maxScale, Math.max(minScale, currentCamera.scale * zoomFactor));
    const worldX = (x - currentCamera.offsetX) / currentCamera.scale;
    const worldY = (y - currentCamera.offsetY) / currentCamera.scale;
    const nextCamera = {
      scale: nextScale,
      offsetX: x - worldX * nextScale,
      offsetY: y - worldY * nextScale,
    };

    setCamera(nextCamera);
  }

  function handleCanvasClick(evt: React.MouseEvent<HTMLCanvasElement>) {
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false;
      return;
    }

    const target = resolveHoverTarget(evt.clientX, evt.clientY);
    if (!target) {
      setPendingBuild(null);
      return;
    }
    setPendingBuild(target);
  }

  function confirmBuild() {
    if (!game || !user || !pendingBuild) return;

    if (devPlayState?.card === "roadBuilding" && pendingBuild.buildKind === "road") {
      if (devPlayState.selectedEdges.includes(pendingBuild.id)) {
        setPendingBuild(null);
        return;
      }

      const selectedEdges = [...devPlayState.selectedEdges, pendingBuild.id].slice(0, 2);
      if (selectedEdges.length < 2) {
        setDevPlayState({ card: "roadBuilding", selectedEdges });
        setPendingBuild(null);
        return;
      }

      emitAction({ type: "play_dev_card", card: "roadBuilding", payload: { edgeIds: selectedEdges } });
      setPendingBuild(null);
      cancelDevPlay();
      return;
    }

    if (devPlayState?.card === "knight" && pendingBuild.buildKind === "robber") {
      const tileId = pendingBuild.id;
      const tile = game.board.tiles.find((t) => t.id === tileId);
      if (tile) {
        const victims = tile.vertexIds
          .map((vid) => game.buildings[vid]?.ownerId)
          .filter((id) => id && id !== user.userId)
          .filter((id, i, arr) => arr.indexOf(id) === i)
          .filter((id) => (game.players.find((p) => p.id === id)?.resourceCount ?? 0) > 0);

        if (victims.length === 0) {
          emitAction({ type: "play_dev_card", card: "knight", payload: { tileId } });
          cancelDevPlay();
        } else {
          setRobberSelectionSource("knight");
          setRobberHexSelection(tileId);
        }
      }

      setPendingBuild(null);
      return;
    }

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
          setRobberSelectionSource("board");
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
  const waitingDiscardNames = Object.keys(game.pendingDiscards).length > 0
    ? game.players.filter((player) => game.pendingDiscards[player.id]).map((player) => player.username)
    : [];
  const globalStatusText = waitingDiscardNames.length > 0
    ? `Waiting to discard: ${waitingDiscardNames.join(", ")}.`
    : game.pendingRobber
      ? `${currentTurnName} is robbing someone.`
      : null;

  return (
    <Shell theme={theme} setTheme={setTheme} title="Catan Room" user={user.username} onHome={() => goTo("/lobby")}>
      <div className="relative z-0" style={{ minHeight: "calc(100vh - 4rem)", overflow: "hidden" }}>
        <canvas
          ref={canvasRef}
          className="w-full h-full cursor-grab ocean-canvas"
          onMouseDown={handleCanvasMouseDown}
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

        {game.phase === "setup" && (
          <div className="absolute top-20 left-1/2 -translate-x-1/2 bg-base-100/80 backdrop-blur px-4 py-2 rounded-box border border-base-300 text-sm opacity-90 shadow-lg pointer-events-none z-10">
            Setup: place the settlement first, then confirm the adjacent road. Second settlements grant starting resources after the road is placed.
          </div>
        )}

        {globalStatusText ? (
          <div className="fixed top-16 left-1/2 z-50 -translate-x-1/2 rounded-box border border-base-300 bg-base-100/95 px-4 py-2 text-sm shadow-2xl backdrop-blur">
            {globalStatusText}
          </div>
        ) : null}
      </div>

      <div className="fixed top-16 right-4 z-20 flex h-[calc(100vh-5rem)] w-80 flex-col gap-4 overflow-hidden pb-4">
        <section className="card bg-base-100/90 backdrop-blur border border-base-300 shadow-xl">
          <div className="px-4 py-2 border-b border-base-300 bg-base-200/50 flex flex-col gap-1">
            <div className="flex justify-between items-center">
              <h2 className="text-lg font-semibold leading-tight">Room {game.id}</h2>
              <button className="btn btn-xs btn-ghost text-error" onClick={resetLobby}>Reset</button>
            </div>
            <div className="flex justify-between items-center text-xs">
              <span className="opacity-70">{user.username}</span>
              <span className={`badge badge-sm ${isMyTurn ? "badge-success" : "badge-neutral"}`}>
                {game.phase === "setup" ? `Setup: ${setupStage === "road" ? "road" : "settlement"}` : isMyTurn ? "Your Turn" : `Active: ${currentTurnName}`}
              </span>
            </div>
          </div>
        </section>

        <section className="card bg-base-100/90 backdrop-blur border border-base-300 shadow-xl">
          <div className="card-body p-2">
            <h3 className="card-title text-xs mb-1">Bank</h3>
            <div className="flex gap-3 items-end text-[11px] flex-wrap">
              {resourceKeys().map((resource) => (
                <div key={resource} className="bank-pill">
                  <div className={`bank-card card-display small ${resource}`}>
                    <div className="emoji">{resourceEmoji(resource)}</div>
                    <div className="label">{resource.charAt(0).toUpperCase() + resource.slice(1)}</div>
                    <div className="card-count-badge">{game.resourceBank?.[resource] ?? 0}</div>
                  </div>
                </div>
              ))}
              <div className="bank-pill">
                <div className="bank-card card-display small devcard">
                  <div className="emoji">🃏</div>
                  <div className="label">Dev</div>
                  <div className="card-count-badge">{game.devDeckCount ?? 0}</div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="card bg-base-100/90 backdrop-blur border border-base-300 shadow-xl">
          <div className="card-body p-2">
            <h3 className="card-title text-xs mb-1">Players</h3>
            <div className="space-y-1 pr-1">
              {game.players.map((player, index) => {
                const palette = ["#e11d48", "#0284c7", "#16a34a", "#ca8a04"];
                const playerColor = palette[index % palette.length];
                const isYou = player.id === user.userId;
                const publicVP = (player as any).publicVictoryPoints ?? player.victoryPoints;
                const hidden = Math.max(0, player.victoryPoints - publicVP);
                const vpDisplay = isYou && hidden > 0 ? `${publicVP}(${player.victoryPoints})` : `${publicVP}`;

                return (
                  <div 
                    key={player.id} 
                    className="p-1 rounded-md border border-base-300 bg-base-200/80 text-xs relative overflow-hidden player-box-neon"
                    style={isYou ? { boxShadow: `0 0 10px ${playerColor}` } : {}}
                  >
                    <div className="absolute left-0 top-0 bottom-0 w-1" style={{ backgroundColor: playerColor }}></div>
                    <div className="pl-3">
                      <div className="font-semibold text-xs">{player.username} {isYou && <span className="opacity-70 font-normal">(you)</span>}</div>
                      <div className="text-[10px]">VP: {vpDisplay} | Knights: {player.playedKnights}</div>
                      <div className="mt-1 grid grid-cols-3 gap-1 text-[9px]">
                        <div className="rounded border border-base-300 bg-base-100/50 px-1 py-0.5 text-center">
                          <div className="opacity-55">Road</div>
                          <div className="font-semibold">{pieceInventory(player).roadsBuilt}/15</div>
                        </div>
                        <div className="rounded border border-base-300 bg-base-100/50 px-1 py-0.5 text-center">
                          <div className="opacity-55">Set</div>
                          <div className="font-semibold">{pieceInventory(player).settlementsBuilt}/5</div>
                        </div>
                        <div className="rounded border border-base-300 bg-base-100/50 px-1 py-0.5 text-center">
                          <div className="opacity-55">City</div>
                          <div className="font-semibold">{pieceInventory(player).citiesBuilt}/4</div>
                        </div>
                      </div>
                      {isYou ? null : (
                        <div className="mt-1 text-[10px]">Cards: {player.resourceCount ?? 0}, Dev: {player.devCardCount ?? 0}</div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      </div>

      <section className="fixed top-16 left-4 z-20 w-80 card bg-base-100/90 backdrop-blur border border-base-300 shadow-xl">
        <div className="card-body p-3">
          <h3 className="card-title text-sm mb-1">Log</h3>
          <div className="space-y-1 overflow-y-auto pr-1 max-h-[calc(100vh-8rem)]">
            {[...game.log].slice(-4).reverse().map((item, idx) => (
              <div key={`${item.ts}-${idx}`} className="py-1 text-[10px] border-b border-base-300/50 last:border-0 opacity-80">
                <span className="opacity-50 mr-1">{new Date(item.ts).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit', second:'2-digit'})}</span>
                {item.text}
              </div>
            ))}
          </div>
        </div>
      </section>

      <div className="fixed bottom-2 left-4 right-4 z-40 flex items-end gap-3">
        <div className="relative min-w-0 flex-1 overflow-visible">
          {requiredDiscard > 0 ? (
            <div className="absolute bottom-full left-0 mb-3 w-88 rounded-box border border-base-300 bg-base-100/95 backdrop-blur p-4 shadow-2xl">
              <div className="text-xs font-bold text-error mb-1">Discard required</div>
              <div className="text-sm mb-2">Select {requiredDiscard} cards from your hand.</div>
              <div className="text-xs font-semibold mb-2">Selected: {selectedHandCards.length}</div>
              <button
                className="btn btn-sm btn-error w-full mb-2"
                disabled={selectedHandCards.length !== requiredDiscard}
                onClick={() => {
                  const discardObj = selectedHandCards.reduce((acc, resource) => {
                    acc[resource] = (acc[resource] || 0) + 1;
                    return acc;
                  }, {} as Record<Resource, number>);
                  emitAction({ type: "discard_resources", discard: discardObj });
                  setSelectedHandCards([]);
                }}
              >
                Discard
              </button>
              {selectedHandCards.length > 0 ? (
                <button className="btn btn-sm btn-outline w-full" onClick={() => setSelectedHandCards([])}>
                  Clear Selection
                </button>
              ) : null}
            </div>
          ) : null}

          {tradeModalOpen ? (
            <div className="absolute bottom-full left-0 mb-3 w-88 rounded-box border border-base-300 bg-base-100/95 backdrop-blur p-4 shadow-2xl flex flex-col gap-3">
              <h4 className="font-bold text-sm">Requesting (Receive):</h4>
              <div className="grid grid-cols-5 gap-2">
                {resourceKeys().map((resource) => {
                  return (
                    <button
                      key={resource}
                      className={`card-display ${resource} cursor-pointer trade-card-mini`}
                      onClick={() => setTradeRequest({ ...tradeRequest, [resource]: (tradeRequest[resource] || 0) + 1 })}
                    >
                      <div className="text-[1rem] leading-none">{resourceEmoji(resource)}</div>
                      <div className="mt-1 text-[9px] leading-none uppercase tracking-[0.18em]">{resource}</div>
                    </button>
                  );
                })}
              </div>

              <div className="space-y-1">
                <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-base-content/60">Requested Cards</div>
                <div className="card-bar hand-bar-raise w-full px-0 py-0" style={{ padding: 0, minHeight: "96px" }}>
                  {resourceKeys().map((resource) => {
                    const count = tradeRequest[resource] || 0;
                    if (count === 0) return null;

                    const cards = Array.from({ length: count }, (_, index) => (
                      <div
                        key={`${resource}-${index}`}
                        className={`card-display ${resource} stack-offset-${Math.min(index, 9)} selectable`}
                        onClick={() => setTradeRequest({ ...tradeRequest, [resource]: Math.max(0, count - 1) })}
                      >
                        <div className="text-2xl leading-none">{resourceEmoji(resource)}</div>
                        <div className="mt-1 text-center leading-none">{resource.charAt(0).toUpperCase() + resource.slice(1)}</div>
                        {index === 0 ? <div className="card-count-badge">{count}</div> : null}
                      </div>
                    ));

                    return (
                      <div key={resource} className="hand-stack" style={{ width: `${64 + Math.max(0, count - 1) * 16}px`, marginTop: "0.45rem" }}>
                        {cards}
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="space-y-1">
                <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-base-content/60">Giving</div>
                <div className="card-bar hand-bar-raise w-full px-0 py-0" style={{ padding: 0, minHeight: "82px" }}>
                  {resourceKeys().map((resource) => {
                    const count = selectedHandCards.filter((card) => card === resource).length;
                    if (count === 0) return null;

                    const cards = Array.from({ length: count }, (_, index) => (
                      <div
                        key={`${resource}-give-${index}`}
                        className={`card-display ${resource} stack-offset-${Math.min(index, 9)} selectable selected`}
                        onClick={() => {
                          const next = [...selectedHandCards];
                          const removeIndex = next.lastIndexOf(resource);
                          if (removeIndex >= 0) {
                            next.splice(removeIndex, 1);
                            setSelectedHandCards(next);
                          }
                        }}
                      >
                        <div className="text-2xl leading-none">{resourceEmoji(resource)}</div>
                        <div className="mt-1 text-center leading-none">{resource.charAt(0).toUpperCase() + resource.slice(1)}</div>
                        {index === 0 ? <div className="card-count-badge">{count}</div> : null}
                      </div>
                    ));

                    return (
                      <div key={resource} className="hand-stack" style={{ width: `${64 + Math.max(0, count - 1) * 16}px`, marginTop: "0.35rem" }}>
                        {cards}
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="flex flex-col gap-2 mt-2">
                <button
                  className="btn btn-sm btn-primary w-full"
                  disabled={selectedHandCards.length === 0 || Object.values(tradeRequest).every((value) => !value)}
                  onClick={() => {
                    const offer = selectedHandCards.reduce((acc, resource) => {
                      acc[resource] = (acc[resource] || 0) + 1;
                      return acc;
                    }, {} as Record<Resource, number>);

                    emitAction({
                      type: "maritime_trade",
                      give: offer,
                      receive: tradeRequest,
                    });
                    setSelectedHandCards([]);
                    setTradeRequest({ wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 });
                    setTradeModalOpen(false);
                  }}
                >
                  Trade with Bank/Port
                </button>
                <button
                  className="btn btn-sm btn-secondary w-full"
                  disabled={selectedHandCards.length === 0 || Object.values(tradeRequest).every((value) => !value)}
                  onClick={() => {
                    const offer = selectedHandCards.reduce((acc, resource) => {
                      acc[resource] = (acc[resource] || 0) + 1;
                      return acc;
                    }, {} as Record<Resource, number>);
                    emitAction({ type: "offer_trade", offer, request: tradeRequest });
                    setSelectedHandCards([]);
                    setTradeRequest({ wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 });
                    setTradeModalOpen(false);
                  }}
                >
                  Propose to Player
                </button>
              </div>
            </div>
          ) : null}

          <section className="card bg-base-100/95 backdrop-blur border border-base-300 shadow-2xl h-[9.5rem] overflow-visible">
            <div className="card-body gap-3 p-2 pt-2 h-full overflow-visible">
              <div className="flex h-full min-w-0 gap-6 overflow-visible">
                <div className="min-w-0 flex-[1.45] space-y-1.5 overflow-visible">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.24em] text-base-content/60">Resources</div>
                  <div className="card-bar hand-bar-raise w-full px-0 py-0" style={{ padding: 0, minHeight: "118px" }}>
                    {resourceKeys().map((res) => {
                      const count = ownPlayer?.resources?.[res] ?? 0;
                      if (count === 0) return null;
                      const selectedCount = selectedHandCards.filter((r) => r === res).length;
                      const canStartTrade = !!isMyTurn && game.phase === "main" && !game.mustRoll && !game.pendingRobber && requiredDiscard === 0;
                      const isSelectable = requiredDiscard > 0 || tradeModalOpen || canStartTrade;
                      const label = res.charAt(0).toUpperCase() + res.slice(1);
                      const visibleCount = Math.max(0, count - selectedCount);

                        const cards = Array.from({ length: visibleCount }, (_, i) => {
                        return (
                          <div
                            key={i}
                              className={`card-display ${res} stack-offset-${Math.min(i, 9)} ${isSelectable ? "selectable" : ""}`}
                            onClick={() => {
                              if (!isSelectable) return;
                              if (!tradeModalOpen && requiredDiscard === 0 && canStartTrade) {
                                setTradeModalOpen(true);
                              }
                                if (requiredDiscard > 0 && selectedHandCards.length >= requiredDiscard) return;
                                setSelectedHandCards([...selectedHandCards, res]);
                            }}
                          >
                            <div className="text-2xl leading-none">{resourceEmoji(res)}</div>
                            <div className="mt-1 text-center leading-none">{label}</div>
                              {i === 0 ? <div className="card-count-badge">{visibleCount}</div> : null}
                          </div>
                        );
                      });

                      return (
                          <div key={res} className="hand-stack" style={{ width: `${64 + Math.max(0, visibleCount - 1) * 16}px`, marginTop: "0.45rem" }}>
                          {cards}
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="min-w-0 flex-[1] space-y-1.5 overflow-visible">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.24em] text-base-content/60">Development Cards</div>
                  </div>
                  <div className="card-bar hand-bar-raise w-full px-0 py-0" style={{ padding: 0, minHeight: "118px" }}>
                    {Object.entries(ownPlayer?.devCards ?? {}).map(([dev, count]) => {
                      const playableCount = count as number;
                      const newCount = ownPlayer?.newDevCards?.[dev as DevCard] ?? 0;
                      const num = playableCount + newCount;
                      if (num === 0) return null;

                      const devCard = dev as Exclude<DevCard, "victoryPoint">;
                      const label = dev.replace(/([a-z])([A-Z])/g, "$1 $2");
                      const isPlayable = dev !== "victoryPoint" && playableCount > 0 && canPlayDevCard(devCard);

                      const cards = Array.from({ length: num }, (_, i) => (
                        <div
                          key={i}
                          className={`card-display devcard stack-offset-${Math.min(i, 9)} ${isPlayable ? "selectable" : ""} ${selectedDevCard === devCard ? "selected" : ""}`}
                          style={{ width: "58px", height: "96px", top: "0.75rem", fontSize: "0.62rem" }}
                          onClick={() => {
                            if (!isPlayable) return;
                            setSelectedDevCard(devCard);
                          }}
                        >
                          <div className="text-[1.2rem] leading-none">{dev === "knight" ? "⚔️" : dev === "roadBuilding" ? "🛣️" : dev === "yearOfPlenty" ? "🎁" : dev === "monopoly" ? "🪙" : "⭐"}</div>
                          <div className="mt-1 text-center leading-none">{label.charAt(0).toUpperCase() + label.slice(1)}</div>
                          {i === 0 ? <div className="card-count-badge">{num}</div> : null}
                          {isPlayable ? <div className="mt-1 text-[9px] uppercase tracking-[0.2em] opacity-70">Play</div> : newCount > 0 ? <div className="mt-1 text-[9px] uppercase tracking-[0.2em] opacity-70">Next turn</div> : null}
                        </div>
                      ));

                      return (
                        <div key={dev} className="hand-stack" style={{ width: `${64 + Math.max(0, num - 1) * 16}px`, marginTop: "0.45rem" }}>
                          {cards}
                        </div>
                      );
                    })}
                  </div>
                  <div className="pt-1 text-[10px] text-base-content/60 truncate">
                    {selectedDevCard ? (
                      <>
                        Selected: <span className="font-semibold text-base-content">{selectedDevCard === "roadBuilding" ? "Road Building" : selectedDevCard === "yearOfPlenty" ? "Year of Plenty" : selectedDevCard === "monopoly" ? "Monopoly" : "Knight"}</span>
                        {!selectedDevCardPlayable ? <span className="ml-2 opacity-75">(available next turn)</span> : null}
                      </>
                    ) : (
                      "Select one development card"
                    )}
                  </div>
                </div>
              </div>
            </div>
          </section>
        </div>

        <button
          className="btn btn-primary h-20 min-h-20 w-20 shrink-0 rounded-box p-0 text-[11px] leading-none shadow-lg"
          disabled={!isMyTurn || game.phase !== "main" || game.mustRoll || requiredDiscard > 0 || game.pendingRobber}
          onClick={() => {
            if (!isMyTurn || game.phase !== "main" || game.mustRoll || requiredDiscard > 0 || game.pendingRobber) return;
            setTradeModalOpen((value) => !value);
          }}
        >
          <span className="text-center">Trade</span>
        </button>
        <button
          className="btn btn-secondary h-20 min-h-20 w-20 shrink-0 rounded-box p-0 text-[11px] leading-none shadow-lg"
          disabled={!canBuyDevCard}
          onClick={() => {
            if (!canBuyDevCard) return;
            emitAction({ type: "buy_dev_card" });
          }}
          title="Buy a development card"
        >
          <span className="text-center">Buy<br />Dev<br />Card</span>
        </button>
        <div className="flex h-full flex-col items-center justify-end gap-2">
          {game.phase === "main" ? (
            <button
              type="button"
              className={`dice-inline pointer-events-auto flex items-center gap-3 rounded-none border-0 bg-transparent p-0 shadow-none transition-transform ${canRollDice ? "dice-breathe cursor-pointer hover:scale-[1.02]" : "cursor-default"}`}
              onClick={canRollDice ? () => emitAction({ type: "roll_dice" }) : undefined}
              title={canRollDice ? "Click to roll dice" : "Dice waiting"}
            >
              <DiceFace value={dice?.die1 ?? 1} />
              <DiceFace value={dice?.die2 ?? 1} />
            </button>
          ) : null}
          <button
            className="btn btn-secondary h-20 min-h-20 w-20 shrink-0 rounded-box p-0 text-[11px] leading-none shadow-lg"
            onClick={() => emitAction({ type: "end_turn" })}
            disabled={!isMyTurn || game.phase !== "main" || game.mustRoll || requiredDiscard > 0 || game.pendingRobber}
            title={!isMyTurn ? "Waiting for another player" : "Advance turn"}
          >
            <span className="text-center">End<br />Turn</span>
          </button>
        </div>
      </div>

      {selectedDevCard && !devPlayState ? (
        <div className="fixed inset-0 z-[45] flex items-center justify-center bg-black/25 px-4 backdrop-blur-[1px]">
          <div className="w-full max-w-md rounded-box border border-base-300 bg-base-100/95 p-4 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-base-content/60">Confirm Development Card</div>
                <div className="text-xl font-semibold">
                  {selectedDevCard === "roadBuilding" ? "Road Building" : selectedDevCard === "yearOfPlenty" ? "Year of Plenty" : selectedDevCard === "monopoly" ? "Monopoly" : "Knight"}
                </div>
              </div>
              <button
                className="btn btn-sm btn-ghost"
                onClick={() => setSelectedDevCard(null)}
              >
                Cancel
              </button>
            </div>

            <div className="mt-4 space-y-3 text-sm">
              {selectedDevCard === "knight" ? (
                <p>Move the robber to a new hex and choose a player on that hex to rob.</p>
              ) : null}
              {selectedDevCard === "roadBuilding" ? (
                <p>Choose two free road edges to build immediately.</p>
              ) : null}
              {selectedDevCard === "yearOfPlenty" ? (
                <p>Choose any two resources from the bank.</p>
              ) : null}
              {selectedDevCard === "monopoly" ? (
                <p>Choose one resource type to take from every other player.</p>
              ) : null}

              <div className="rounded-box border border-base-300 bg-base-200/70 p-3 text-xs opacity-90">
                Clicking the check mark will play this card and open the effect actions.
              </div>

              <div className="flex items-center justify-end gap-2">
                <button className="btn btn-sm btn-ghost" onClick={() => setSelectedDevCard(null)}>
                  Back
                </button>
                <button
                  className="btn btn-sm btn-success"
                  disabled={!selectedDevCardPlayable}
                  onClick={() => {
                    if (!selectedDevCardPlayable || !selectedDevCard) return;
                    startDevPlay(selectedDevCard);
                  }}
                >
                  ✓ Play Card
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {devPlayState ? (
        devPlayState.card === "knight" || devPlayState.card === "roadBuilding" ? (
          <div className="fixed top-4 left-1/2 z-[45] -translate-x-1/2 pointer-events-none">
            <div className="rounded-box border border-base-300 bg-base-100/95 px-3 py-2 shadow-2xl pointer-events-auto">
              <div className="flex items-center gap-3">
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-base-content/60">Play Development Card</div>
                  <div className="text-sm font-semibold">
                    {devPlayState.card === "roadBuilding" ? "Road Building" : "Knight"}
                  </div>
                  <div className="text-[11px] opacity-80">
                    {devPlayState.card === "knight"
                      ? "Click a hex on the board, then choose a victim if one exists."
                      : `Click two road edges on the board. ${devPlayState.selectedEdges.length}/2 chosen.`}
                  </div>
                </div>
                <button
                  className="btn btn-xs btn-ghost"
                  onClick={() => {
                    cancelDevPlay();
                    setSelectedDevCard(null);
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="fixed inset-0 z-[45] flex items-end justify-center bg-black/20 px-4 pb-24 backdrop-blur-[1px]">
            <div className="w-full max-w-md rounded-box border border-base-300 bg-base-100/95 p-4 shadow-2xl">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-bold uppercase tracking-[0.2em] text-base-content/60">Play Development Card</div>
                  <div className="text-xl font-semibold capitalize">
                    {devPlayState.card === "yearOfPlenty" ? "Year of Plenty" : devPlayState.card === "monopoly" ? "Monopoly" : "Knight"}
                  </div>
                </div>
                <button
                  className="btn btn-sm btn-ghost"
                  onClick={() => {
                    cancelDevPlay();
                    setSelectedDevCard(null);
                  }}
                >
                  Cancel
                </button>
              </div>

              {devPlayState.card === "yearOfPlenty" ? (
                <div className="mt-4">
                  <div className="text-sm opacity-80 mb-3">Choose two resources.</div>
                  <div className="grid grid-cols-2 gap-2">
                    {resourceKeys().map((resource) => {
                      const selectedCount = devPlayState.selectedResources.filter((entry) => entry === resource).length;
                      return (
                        <button
                          key={resource}
                          className={`btn btn-outline ${selectedCount > 0 ? "btn-primary" : ""}`}
                          onClick={() => {
                            if (devPlayState.selectedResources.length >= 2 && selectedCount === 0) return;
                            const next = [...devPlayState.selectedResources];
                            next.push(resource);
                            setDevPlayState({ card: "yearOfPlenty", selectedResources: next.slice(0, 2) });
                          }}
                        >
                          <span className="mr-2 text-lg">{resourceEmoji(resource)}</span>
                          {resource.charAt(0).toUpperCase() + resource.slice(1)} {selectedCount > 0 ? `x${selectedCount}` : ""}
                        </button>
                      );
                    })}
                  </div>
                  <button
                    className="btn btn-primary btn-sm mt-4 w-full"
                    disabled={devPlayState.selectedResources.length !== 2}
                    onClick={() => {
                      emitAction({ type: "play_dev_card", card: "yearOfPlenty", payload: { resources: devPlayState.selectedResources } });
                      cancelDevPlay();
                      setSelectedDevCard(null);
                    }}
                  >
                    Play Card
                  </button>
                </div>
              ) : null}

              {devPlayState.card === "monopoly" ? (
                <div className="mt-4">
                  <div className="text-sm opacity-80 mb-3">Choose one resource to take from other players.</div>
                  <div className="grid grid-cols-2 gap-2">
                    {resourceKeys().map((resource) => {
                      const isSelected = devPlayState.selectedResource === resource;
                      return (
                        <button
                          key={resource}
                          className={`btn btn-outline ${isSelected ? "btn-primary" : ""}`}
                          onClick={() => setDevPlayState({ card: "monopoly", selectedResource: resource })}
                        >
                          <span className="mr-2 text-lg">{resourceEmoji(resource)}</span>
                          {resource.charAt(0).toUpperCase() + resource.slice(1)}
                        </button>
                      );
                    })}
                  </div>
                  <button
                    className="btn btn-primary btn-sm mt-4 w-full"
                    disabled={!devPlayState.selectedResource}
                    onClick={() => {
                      if (!devPlayState.selectedResource) return;
                      emitAction({ type: "play_dev_card", card: "monopoly", payload: { resource: devPlayState.selectedResource } });
                      cancelDevPlay();
                      setSelectedDevCard(null);
                    }}
                  >
                    Play Card
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        )
      ) : null}

      {game.pendingTrade && game.pendingTrade.authorId !== user.userId && game.phase === "main" && (
         <div className="fixed top-20 right-4 z-50 w-72">
           <div className="card bg-base-100 border border-base-300 shadow-2xl">
             <div className="card-body p-4 gap-2">
               <h3 className="font-bold text-lg text-primary">Trade Offer!</h3>
               <p className="text-sm opacity-80">Player {game.players.find(p => p.id === game.pendingTrade?.authorId)?.username} is offering a trade.</p>
               <div className="text-xs bg-base-200 p-2 rounded-box">
                 <strong>Offer:</strong> {Object.entries(game.pendingTrade.offer).filter(([_,v]) => v).map(([k,v]) => `${v} ${k}`).join(', ')}<br/>
                 <strong>Request:</strong> {Object.entries(game.pendingTrade.request).filter(([_,v]) => v).map(([k,v]) => `${v} ${k}`).join(', ')}
               </div>
               <button 
                 className="btn btn-sm btn-success mt-2" 
                 onClick={() => emitAction({ type: "accept_trade" })}
               >
                 Accept Trade
               </button>
             </div>
           </div>
         </div>
      )}
      
      {game.pendingTrade && game.pendingTrade.authorId === user.userId && game.phase === "main" && (
         <div className="fixed top-20 right-4 z-50 w-72">
           <div className="card bg-base-100 border border-base-300 shadow-2xl">
             <div className="card-body p-4 gap-2">
               <h3 className="font-bold text-lg text-primary">Waiting for Trade...</h3>
               <button 
                 className="btn btn-sm btn-error mt-2" 
                 onClick={() => emitAction({ type: "cancel_trade" })}
               >
                 Cancel Trade
               </button>
             </div>
           </div>
         </div>
      )}

      {robberHexSelection !== null && (
        <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center">
          <div className="card bg-base-100 w-full max-w-sm shadow-2xl border border-base-300 p-4">
            <h3 className="text-xl font-bold mb-4">{robberSelectionSource === "knight" ? "Select a Victim" : "Select Player to Rob"}</h3>
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
              <button
                className="btn btn-outline"
                onClick={() => {
                  setRobberHexSelection(null);
                  setRobberVictimSelection(null);
                  if (robberSelectionSource === "knight") {
                    cancelDevPlay();
                  } else {
                    setRobberSelectionSource(null);
                  }
                }}
              >
                Cancel
              </button>
              <button
                className="btn btn-primary"
                disabled={!robberVictimSelection}
                onClick={() => {
                  if (robberSelectionSource === "knight") {
                    emitAction({ type: "play_dev_card", card: "knight", payload: { tileId: robberHexSelection, targetPlayerId: robberVictimSelection } });
                    cancelDevPlay();
                  } else {
                    emitAction({ type: "move_robber", tileId: robberHexSelection, targetPlayerId: robberVictimSelection });
                  }
                  setRobberHexSelection(null);
                  setRobberVictimSelection(null);
                  setRobberSelectionSource(null);
                }}
              >
                Confirm
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
