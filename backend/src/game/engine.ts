declare const require: any;
declare const module: any;

const { createBoard, terrainToResource } = require("./board");

type Resource = "wood" | "brick" | "sheep" | "wheat" | "ore";
type DevCard = "knight" | "roadBuilding" | "yearOfPlenty" | "monopoly" | "victoryPoint";
type Phase = "lobby" | "setup" | "main" | "ended";

type ResourceBank = Record<Resource, number>;
type DevBank = Record<DevCard, number>;

type PlayerState = {
  id: string;
  username: string;
  resources: ResourceBank;
  roads: number[];
  settlements: number[];
  cities: number[];
  devCards: DevBank;
  newDevCards: DevBank;
  playedKnights: number;
};

type Board = {
  tiles: Array<{ id: number; terrain: string; number: number | null; vertexIds: number[]; edgeIds: number[] }>;
  vertices: Array<{
    id: number;
    adjacentTiles: number[];
    adjacentVertices: number[];
    adjacentEdges: number[];
    port?: { type: Resource | "any"; rate: 2 | 3 };
    x: number;
    y: number;
  }>;
  edges: Array<{ id: number; v1: number; v2: number; adjacentTiles: number[] }>;
};

type GameLog = { ts: number; text: string };

type PendingDiscards = Record<string, number>;

type TradeOffer = {
  authorId: string;
  offer: Partial<ResourceBank>;
  request: Partial<ResourceBank>;
};

type RoomState = {
  id: string;
  started: boolean;
  phase: Phase;
  players: PlayerState[];
  playerOrder: string[];
  activePlayerIndex: number;
  setupRound: 1 | 2;
  mustRoll: boolean;
  playedDevCardThisTurn: boolean;
  pendingDiscards: PendingDiscards;
  pendingRobber: boolean;
  pendingSetupPlacement: { userId: string; vertexId: number } | null;
  pendingTrade: TradeOffer | null;
  robberTileId: number;
  longestRoadHolder: string | null;
  largestArmyHolder: string | null;
  winnerId: string | null;
  lastRoll: { die1: number; die2: number; total: number } | null;
  board: Board;
  resourceBank: ResourceBank;
  buildings: Record<number, { ownerId: string; kind: "settlement" | "city" }>;
  roads: Record<number, { ownerId: string }>;
  log: GameLog[];
  devDeck: DevCard[];
};

type ActionResult = {
  ok: boolean;
  state: RoomState;
  error?: string;
};

function emptyResources(): ResourceBank {
  return { wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 };
}

function emptyDevCards(): DevBank {
  return {
    knight: 0,
    roadBuilding: 0,
    yearOfPlenty: 0,
    monopoly: 0,
    victoryPoint: 0,
  };
}

function fullResourceBank(): ResourceBank {
  return {
    wood: 19,
    brick: 19,
    sheep: 19,
    wheat: 19,
    ore: 19,
  };
}

function shuffle<T>(arr: T[]): T[] {
  const clone = [...arr];
  for (let i = clone.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = clone[i];
    clone[i] = clone[j] as T;
    clone[j] = temp as T;
  }
  return clone;
}

function createDevDeck(): DevCard[] {
  return shuffle([
    ...Array.from({ length: 14 }, () => "knight" as DevCard),
    ...Array.from({ length: 2 }, () => "roadBuilding" as DevCard),
    ...Array.from({ length: 2 }, () => "yearOfPlenty" as DevCard),
    ...Array.from({ length: 2 }, () => "monopoly" as DevCard),
    ...Array.from({ length: 5 }, () => "victoryPoint" as DevCard),
  ]);
}

function createLobbyState(roomId: string): RoomState {
  const board = createBoard() as Board;
  const desert = board.tiles.find((tile) => tile.terrain === "desert");
  return {
    id: roomId,
    started: false,
    phase: "lobby",
    players: [],
    playerOrder: [],
    activePlayerIndex: 0,
    setupRound: 1,
    mustRoll: false,
    playedDevCardThisTurn: false,
    pendingDiscards: {},
    pendingRobber: false,
    pendingSetupPlacement: null,
    pendingTrade: null,
    robberTileId: desert ? desert.id : 0,
    longestRoadHolder: null,
    largestArmyHolder: null,
    winnerId: null,
    lastRoll: null,
    board,
    resourceBank: fullResourceBank(),
    buildings: {},
    roads: {},
    log: [],
    devDeck: [],
  };
}

function joinLobby(state: RoomState, userId: string, username: string): ActionResult {
  const exists = state.players.some((player) => player.id === userId);
  if (exists) return { ok: true, state };

  if (state.phase !== "lobby") {
    return { ok: false, state, error: "game already started" };
  }

  if (state.players.length >= 4) {
    return { ok: false, state, error: "lobby is full" };
  }

  const nextState = cloneState(state);
  nextState.players.push({
    id: userId,
    username,
    resources: emptyResources(),
    roads: [],
    settlements: [],
    cities: [],
    devCards: emptyDevCards(),
    newDevCards: emptyDevCards(),
    playedKnights: 0,
  });
  nextState.playerOrder = nextState.players.map((player) => player.id);
  pushLog(nextState, `${username} joined lobby`);
  return { ok: true, state: nextState };
}

function leaveLobbyOrGame(state: RoomState, userId: string): ActionResult {
  const nextState = cloneState(state);
  nextState.players = nextState.players.filter((player) => player.id !== userId);
  nextState.playerOrder = nextState.players.map((player) => player.id);

  if (nextState.phase !== "lobby") {
    if (nextState.players.length === 0) {
      return { ok: true, state: createLobbyState(state.id) };
    }
    nextState.phase = "ended";
    nextState.started = false;
    nextState.winnerId = null;
    nextState.pendingSetupPlacement = null;
    pushLog(nextState, "A player left. Game ended and returned to lobby.");
    nextState.phase = "lobby";
    resetPlayersForLobby(nextState);
  }

  return { ok: true, state: nextState };
}

function startGame(state: RoomState, actingUserId: string): ActionResult {
  if (state.phase !== "lobby") {
    return { ok: false, state, error: "game already started" };
  }
  if (state.players.length !== 4) {
    return { ok: false, state, error: "need exactly 4 players" };
  }
  if (!state.players.some((player) => player.id === actingUserId)) {
    return { ok: false, state, error: "only players in lobby can start" };
  }

  const nextState = cloneState(state);
  nextState.started = true;
  nextState.phase = "setup";
  nextState.setupRound = 1;
  nextState.activePlayerIndex = 0;
  nextState.mustRoll = false;
  nextState.playedDevCardThisTurn = false;
  nextState.pendingDiscards = {};
  nextState.pendingRobber = false;
  nextState.pendingSetupPlacement = null;
  nextState.pendingTrade = null;
  nextState.longestRoadHolder = null;
  nextState.largestArmyHolder = null;
  nextState.winnerId = null;
  nextState.lastRoll = null;
  nextState.devDeck = createDevDeck();
  nextState.resourceBank = fullResourceBank();
  nextState.buildings = {};
  nextState.roads = {};

  for (const player of nextState.players) {
    player.resources = emptyResources();
    player.roads = [];
    player.settlements = [];
    player.cities = [];
    player.devCards = emptyDevCards();
    player.newDevCards = emptyDevCards();
    player.playedKnights = 0;
  }

  pushLog(nextState, "Game started. Setup round 1 begins.");
  return { ok: true, state: nextState };
}

function endGame(state: RoomState): ActionResult {
  const nextState = createLobbyState(state.id);
  nextState.players = state.players.map((player) => ({
    id: player.id,
    username: player.username,
    resources: emptyResources(),
    roads: [],
    settlements: [],
    cities: [],
    devCards: emptyDevCards(),
    newDevCards: emptyDevCards(),
    playedKnights: 0,
  }));
  nextState.playerOrder = nextState.players.map((player) => player.id);
  nextState.lastRoll = null;
  nextState.resourceBank = fullResourceBank();
  pushLog(nextState, "Game ended. Back in lobby.");
  return { ok: true, state: nextState };
}

function getActivePlayer(state: RoomState): PlayerState {
  return state.players[state.activePlayerIndex] as PlayerState;
}

function getPlayer(state: RoomState, userId: string): PlayerState | null {
  const found = state.players.find((player) => player.id === userId);
  return found || null;
}

function isAdjacentToOwnedRoad(state: RoomState, userId: string, vertexId: number): boolean {
  const vertex = state.board.vertices[vertexId]!;
  return vertex.adjacentEdges.some((edgeId) => state.roads[edgeId]?.ownerId === userId);
}

function hasNeighborBuilding(state: RoomState, vertexId: number): boolean {
  const vertex = state.board.vertices[vertexId]!;
  return vertex.adjacentVertices.some((neighborId) => !!state.buildings[neighborId]);
}

function isBlockedRoadVertex(state: RoomState, userId: string, vertexId: number): boolean {
  return !!state.buildings[vertexId] && state.buildings[vertexId]?.ownerId !== userId;
}

function canPlaceRoad(state: RoomState, userId: string, edgeId: number): boolean {
  if (state.roads[edgeId]) return false;
  const edge = state.board.edges[edgeId]!;

  const touchOwnBuilding = [edge.v1, edge.v2].some((vertexId) => state.buildings[vertexId]?.ownerId === userId);
  if (touchOwnBuilding) return true;

  const touchOwnRoad = [edge.v1, edge.v2].some((vertexId) => {
    if (isBlockedRoadVertex(state, userId, vertexId)) return false;
    return state.board.vertices[vertexId]!.adjacentEdges.some((candidateEdgeId) => state.roads[candidateEdgeId]?.ownerId === userId);
  });

  return touchOwnRoad;
}

function hasResources(resources: ResourceBank, cost: Partial<ResourceBank>): boolean {
  return (Object.keys(cost) as Resource[]).every((resource) => {
    const required = cost[resource] || 0;
    return resources[resource] >= required;
  });
}

function spendResources(resources: ResourceBank, cost: Partial<ResourceBank>): void {
  for (const resource of Object.keys(cost) as Resource[]) {
    resources[resource] -= cost[resource] || 0;
  }
}

function gainResource(resources: ResourceBank, resource: Resource, amount: number): void {
  resources[resource] += amount;
}

function hasBankResources(bank: ResourceBank, cost: Partial<ResourceBank>): boolean {
  return (Object.keys(cost) as Resource[]).every((resource) => (bank[resource] || 0) >= (cost[resource] || 0));
}

function spendBankResources(bank: ResourceBank, cost: Partial<ResourceBank>): void {
  for (const resource of Object.keys(cost) as Resource[]) {
    bank[resource] -= cost[resource] || 0;
  }
}

function gainBankResources(bank: ResourceBank, gain: Partial<ResourceBank>): void {
  for (const resource of Object.keys(gain) as Resource[]) {
    bank[resource] += gain[resource] || 0;
  }
}

function distributeResourcesForRoll(state: RoomState, roll: number): void {
  if (roll === 7) return;

  for (const tile of state.board.tiles) {
    if (tile.number !== roll) continue;
    if (tile.id === state.robberTileId) continue;

    const resource = terrainToResource(tile.terrain as any) as Resource | null;
    if (!resource) continue;

    const recipients: Array<{ owner: PlayerState; amount: number }> = [];

    for (const vertexId of tile.vertexIds) {
      const building = state.buildings[vertexId];
      if (!building) continue;
      const owner = getPlayer(state, building.ownerId);
      if (!owner) continue;

      const amount = building.kind === "city" ? 2 : 1;
      recipients.push({ owner, amount });
    }

    const totalNeeded = recipients.reduce((sum, entry) => sum + entry.amount, 0);
    if (totalNeeded === 0) continue;
    if (!hasBankResources(state.resourceBank, { [resource]: totalNeeded })) {
      pushLog(state, `Bank ran out of ${resource}. No ${resource} was distributed.`);
      continue;
    }

    spendBankResources(state.resourceBank, { [resource]: totalNeeded });
    for (const entry of recipients) {
      gainResource(entry.owner.resources, resource, entry.amount);
    }
  }
}

function updateLongestRoadHolder(state: RoomState): void {
  const lengths: Record<string, number> = {};
  for (const player of state.players) {
    lengths[player.id] = computeLongestRoadForPlayer(state, player.id);
  }

  const sorted = Object.entries(lengths).sort((a, b) => b[1] - a[1]);
  if (sorted.length === 0) {
    state.longestRoadHolder = null;
    return;
  }

  const best = sorted[0];
  const second = sorted[1];
  const bestLen = best ? best[1] : 0;
  const secondLen = second ? second[1] : 0;

  if (bestLen < 5) {
    state.longestRoadHolder = null;
    return;
  }

  if (bestLen === secondLen) {
    if (state.longestRoadHolder && lengths[state.longestRoadHolder] === bestLen) {
      return;
    }
    return;
  }

  state.longestRoadHolder = best ? best[0] : null;
}

function computeLongestRoadForPlayer(state: RoomState, userId: string): number {
  const playerEdges = Object.keys(state.roads)
    .map((id) => Number(id))
    .filter((edgeId) => state.roads[edgeId]?.ownerId === userId);

  if (playerEdges.length === 0) return 0;

  const blockedVertices = new Set<number>();
  for (const [vertexIdRaw, building] of Object.entries(state.buildings)) {
    if (building.ownerId !== userId) {
      blockedVertices.add(Number(vertexIdRaw));
    }
  }

  let best = 0;

  const edgeSet = new Set<number>(playerEdges);
  const adjacency = new Map<number, number[]>();
  for (const edgeId of playerEdges) {
    const edge = state.board.edges[edgeId]!;
    const list1 = adjacency.get(edge.v1) || [];
    list1.push(edgeId);
    adjacency.set(edge.v1, list1);

    const list2 = adjacency.get(edge.v2) || [];
    list2.push(edgeId);
    adjacency.set(edge.v2, list2);
  }

  function dfs(vertexId: number, used: Set<number>): number {
    let localBest = 0;
    const options = adjacency.get(vertexId) || [];

    for (const edgeId of options) {
      if (!edgeSet.has(edgeId) || used.has(edgeId)) continue;

      const edge = state.board.edges[edgeId]!;
      const nextVertex = edge.v1 === vertexId ? edge.v2 : edge.v1;
      const canContinue = !blockedVertices.has(nextVertex);

      used.add(edgeId);
      const candidate = 1 + (canContinue ? dfs(nextVertex, used) : 0);
      if (candidate > localBest) localBest = candidate;
      used.delete(edgeId);
    }

    return localBest;
  }

  for (const edgeId of playerEdges) {
    const edge = state.board.edges[edgeId]!;
    const a = dfs(edge.v1, new Set<number>());
    const b = dfs(edge.v2, new Set<number>());
    best = Math.max(best, a, b);
  }

  return best;
}

function updateLargestArmyHolder(state: RoomState): void {
  const sorted = [...state.players].sort((a, b) => b.playedKnights - a.playedKnights);
  if (sorted.length === 0) {
    state.largestArmyHolder = null;
    return;
  }

  const best = sorted[0]!;
  const second = sorted[1];

  if (best.playedKnights < 3) {
    state.largestArmyHolder = null;
    return;
  }

  if (second && second.playedKnights === best.playedKnights) {
    if (state.largestArmyHolder === best.id) return;
    return;
  }

  state.largestArmyHolder = best.id;
}

function getVictoryPoints(state: RoomState, playerId: string): number {
  const player = getPlayer(state, playerId);
  if (!player) return 0;
  let points = player.settlements.length + player.cities.length * 2 + player.devCards.victoryPoint + player.newDevCards.victoryPoint;
  if (state.longestRoadHolder === playerId) points += 2;
  if (state.largestArmyHolder === playerId) points += 2;
  return points;
}

function getPublicVictoryPoints(state: RoomState, playerId: string): number {
  const player = getPlayer(state, playerId);
  if (!player) return 0;
  // Public VP includes settlements, cities and public awards (longest road, largest army)
  let points = player.settlements.length + player.cities.length * 2;
  if (state.longestRoadHolder === playerId) points += 2;
  if (state.largestArmyHolder === playerId) points += 2;
  return points;
}

function checkWinner(state: RoomState): void {
  for (const player of state.players) {
    const points = getVictoryPoints(state, player.id);
    if (points >= 10) {
      state.winnerId = player.id;
      state.phase = "ended";
      state.started = false;
      pushLog(state, `${player.username} reached ${points} points and won!`);
      return;
    }
  }
}

function getPortRateForPlayer(state: RoomState, player: PlayerState, resource: Resource): number {
  let bestRate = 4;
  for (const vertexId of [...player.settlements, ...player.cities]) {
    const port = state.board.vertices[vertexId]!.port;
    if (!port) continue;
    if (port.type === "any") {
      bestRate = Math.min(bestRate, 3);
      continue;
    }
    if (port.type === resource) {
      bestRate = Math.min(bestRate, 2);
    }
  }
  return bestRate;
}

function pushLog(state: RoomState, text: string): void {
  state.log.push({ ts: Date.now(), text });
}

function cloneState(state: RoomState): RoomState {
  return JSON.parse(JSON.stringify(state));
}

function advanceTurn(state: RoomState): void {
  state.activePlayerIndex = (state.activePlayerIndex + 1) % state.players.length;
  state.mustRoll = true;
  state.playedDevCardThisTurn = false;
  for (const player of state.players) {
    for (const card of Object.keys(player.newDevCards) as DevCard[]) {
      player.devCards[card] += player.newDevCards[card];
      player.newDevCards[card] = 0;
    }
  }
}

function setupPlace(state: RoomState, userId: string, vertexId: number, edgeId: number): ActionResult {
  const placedSettlement = setupPlaceSettlement(state, userId, vertexId);
  if (!placedSettlement.ok) return placedSettlement;
  return setupPlaceRoad(placedSettlement.state, userId, edgeId);
}

function setupPlaceSettlement(state: RoomState, userId: string, vertexId: number): ActionResult {
  if (state.phase !== "setup") return { ok: false, state, error: "not in setup phase" };
  const active = getActivePlayer(state);
  if (active.id !== userId) return { ok: false, state, error: "not your setup turn" };
  if (state.pendingSetupPlacement) return { ok: false, state, error: "finish the current setup placement first" };

  if (state.buildings[vertexId]) return { ok: false, state, error: "vertex already occupied" };
  if (hasNeighborBuilding(state, vertexId)) return { ok: false, state, error: "distance rule violated" };

  const next = cloneState(state);
  const acting = getPlayer(next, userId) as PlayerState;

  next.buildings[vertexId] = { ownerId: userId, kind: "settlement" };
  acting.settlements.push(vertexId);
  next.pendingSetupPlacement = { userId, vertexId };

  pushLog(next, `${acting.username} placed a setup settlement.`);
  return { ok: true, state: next };
}

function setupPlaceRoad(state: RoomState, userId: string, edgeId: number): ActionResult {
  if (state.phase !== "setup") return { ok: false, state, error: "not in setup phase" };
  const active = getActivePlayer(state);
  if (active.id !== userId) return { ok: false, state, error: "not your setup turn" };

  const pending = state.pendingSetupPlacement;
  if (!pending || pending.userId !== userId) {
    return { ok: false, state, error: "place a settlement before attaching a road" };
  }

  const vertexId = pending.vertexId;
  const edge = state.board.edges[edgeId];
  if (!edge) return { ok: false, state, error: "invalid edge" };
  if (!(edge.v1 === vertexId || edge.v2 === vertexId)) {
    return { ok: false, state, error: "road must touch settlement" };
  }
  if (state.roads[edgeId]) return { ok: false, state, error: "edge occupied" };

  const next = cloneState(state);
  const acting = getPlayer(next, userId) as PlayerState;
  const placedVertex = next.board.vertices[vertexId]!;

  next.roads[edgeId] = { ownerId: userId };
  acting.roads.push(edgeId);
  next.pendingSetupPlacement = null;

  if (next.setupRound === 2) {
    for (const tileId of placedVertex.adjacentTiles) {
      const tile = next.board.tiles[tileId]!;
      const resource = terrainToResource(tile.terrain as any) as Resource | null;
      if (resource) {
        if (!hasBankResources(next.resourceBank, { [resource]: 1 })) {
          pushLog(next, `Bank ran out of ${resource}. No starting resource was distributed.`);
          continue;
        }
        spendBankResources(next.resourceBank, { [resource]: 1 });
        gainResource(acting.resources, resource, 1);
      }
    }
  }

  pushLog(next, `${acting.username} placed a setup road.`);

  if (next.setupRound === 1) {
    if (next.activePlayerIndex < next.players.length - 1) {
      next.activePlayerIndex += 1;
    } else {
      next.setupRound = 2;
    }
  } else {
    if (next.activePlayerIndex > 0) {
      next.activePlayerIndex -= 1;
    } else {
      next.phase = "main";
      next.setupRound = 1;
      next.activePlayerIndex = 0;
      next.mustRoll = true;
      pushLog(next, "Setup complete. Main game begins.");
    }
  }

  return { ok: true, state: next };
}

function rollDice(state: RoomState, userId: string): ActionResult {
  if (state.phase !== "main") return { ok: false, state, error: "not in main phase" };
  if (!state.mustRoll) return { ok: false, state, error: "already rolled this turn" };

  const active = getActivePlayer(state);
  if (active.id !== userId) return { ok: false, state, error: "not your turn" };

  const next = cloneState(state);
  const die1 = Math.floor(Math.random() * 6) + 1;
  const die2 = Math.floor(Math.random() * 6) + 1;
  const roll = die1 + die2;
  next.mustRoll = false;
  next.lastRoll = { die1, die2, total: roll };

  if (roll === 7) {
    next.pendingDiscards = {};
    for (const player of next.players) {
      const handSize = sumResources(player.resources);
      if (handSize >= 8) {
        next.pendingDiscards[player.id] = Math.floor(handSize / 2);
      }
    }
    if (Object.keys(next.pendingDiscards).length === 0) {
      next.pendingRobber = true;
      pushLog(next, `${active.username} rolled 7. ${active.username} is robbing someone.`);
    } else {
      const waitingNames = next.players.filter((player) => next.pendingDiscards[player.id]).map((player) => player.username);
      pushLog(next, `${active.username} rolled 7. Waiting to discard: ${waitingNames.join(", ")}.`);
    }
  } else {
    distributeResourcesForRoll(next, roll);
    pushLog(next, `${active.username} rolled ${roll}. Resources distributed.`);
  }

  return { ok: true, state: next };
}

function sumResources(resources: ResourceBank): number {
  return resources.wood + resources.brick + resources.sheep + resources.wheat + resources.ore;
}

function discardResources(state: RoomState, userId: string, discard: Partial<ResourceBank>): ActionResult {
  const required = state.pendingDiscards[userId] || 0;
  if (required <= 0) return { ok: false, state, error: "no discard required" };

  const next = cloneState(state);
  const player = getPlayer(next, userId);
  if (!player) return { ok: false, state, error: "player not found" };

  const discardCount = (Object.keys(discard) as Resource[]).reduce((sum, resource) => sum + (discard[resource] || 0), 0);
  if (discardCount !== required) {
    return { ok: false, state, error: `must discard exactly ${required}` };
  }

  for (const resource of Object.keys(discard) as Resource[]) {
    const amount = discard[resource] || 0;
    if (player.resources[resource] < amount) {
      return { ok: false, state, error: "cannot discard more than owned" };
    }
  }

  for (const resource of Object.keys(discard) as Resource[]) {
    player.resources[resource] -= discard[resource] || 0;
  }
  gainBankResources(next.resourceBank, discard);

  delete next.pendingDiscards[userId];
  const waitingNames = next.players.filter((pendingPlayer) => next.pendingDiscards[pendingPlayer.id]).map((pendingPlayer) => pendingPlayer.username);
  pushLog(next, `${player.username} discarded cards due to robber. Waiting to discard: ${waitingNames.length > 0 ? waitingNames.join(", ") : "none"}.`);

  if (Object.keys(next.pendingDiscards).length === 0) {
    next.pendingRobber = true;
    const activePlayer = getActivePlayer(next);
    pushLog(next, `${activePlayer.username} is robbing someone.`);
  }

  return { ok: true, state: next };
}

function moveRobber(state: RoomState, userId: string, tileId: number, targetPlayerId?: string): ActionResult {
  if (!state.pendingRobber) return { ok: false, state, error: "robber is not pending" };
  if (Object.keys(state.pendingDiscards).length > 0) {
    return { ok: false, state, error: "waiting on discards" };
  }

  const active = getActivePlayer(state);
  if (active.id !== userId) return { ok: false, state, error: "only active player can move robber" };

  const tile = state.board.tiles[tileId];
  if (!tile) return { ok: false, state, error: "invalid tile" };

  const next = cloneState(state);
  next.robberTileId = tileId;
  next.pendingRobber = false;

  const actor = getPlayer(next, userId) as PlayerState;

  if (targetPlayerId && targetPlayerId !== userId) {
    const victim = getPlayer(next, targetPlayerId);
    if (victim) {
      const adjacentHasVictim = tile.vertexIds.some((vertexId) => next.buildings[vertexId]?.ownerId === targetPlayerId);
      if (adjacentHasVictim) {
        const pool = resourcesToArray(victim.resources);
        if (pool.length > 0) {
          const resource = pool[Math.floor(Math.random() * pool.length)] as Resource;
          victim.resources[resource] -= 1;
          actor.resources[resource] += 1;
          pushLog(next, `${actor.username} moved robber and stole 1 resource from ${victim.username}.`);
        }
      }
    }
  } else {
    pushLog(next, `${actor.username} is robbing someone.`);
  }

  return { ok: true, state: next };
}

function resourcesToArray(resources: ResourceBank): Resource[] {
  const out: Resource[] = [];
  for (const resource of Object.keys(resources) as Resource[]) {
    for (let i = 0; i < resources[resource]; i += 1) {
      out.push(resource);
    }
  }
  return out;
}

function buildRoad(state: RoomState, userId: string, edgeId: number, freeBuild?: boolean): ActionResult {
  if (state.phase !== "main") return { ok: false, state, error: "not in main phase" };
  if (state.mustRoll) return { ok: false, state, error: "roll dice first" };
  if (state.pendingRobber || Object.keys(state.pendingDiscards).length > 0) {
    return { ok: false, state, error: "resolve robber first" };
  }

  const active = getActivePlayer(state);
  if (active.id !== userId) return { ok: false, state, error: "not your turn" };

  if (!canPlaceRoad(state, userId, edgeId)) {
    return { ok: false, state, error: "invalid road placement" };
  }

  const next = cloneState(state);
  const player = getPlayer(next, userId) as PlayerState;

  if (!freeBuild) {
    const cost = { wood: 1, brick: 1 };
    if (!hasResources(player.resources, cost)) {
      return { ok: false, state, error: "not enough resources" };
    }
    spendResources(player.resources, cost);
    gainBankResources(next.resourceBank, cost);
  }

  next.roads[edgeId] = { ownerId: userId };
  player.roads.push(edgeId);
  pushLog(next, `${player.username} built a road.`);

  updateLongestRoadHolder(next);
  checkWinner(next);
  return { ok: true, state: next };
}

function buildSettlement(state: RoomState, userId: string, vertexId: number): ActionResult {
  if (state.phase !== "main") return { ok: false, state, error: "not in main phase" };
  if (state.mustRoll) return { ok: false, state, error: "roll dice first" };
  if (state.pendingRobber || Object.keys(state.pendingDiscards).length > 0) {
    return { ok: false, state, error: "resolve robber first" };
  }

  const active = getActivePlayer(state);
  if (active.id !== userId) return { ok: false, state, error: "not your turn" };

  if (state.buildings[vertexId]) return { ok: false, state, error: "vertex occupied" };
  if (hasNeighborBuilding(state, vertexId)) return { ok: false, state, error: "distance rule violated" };
  if (!isAdjacentToOwnedRoad(state, userId, vertexId)) {
    return { ok: false, state, error: "must connect to your road" };
  }

  const next = cloneState(state);
  const player = getPlayer(next, userId) as PlayerState;
  const cost = { wood: 1, brick: 1, sheep: 1, wheat: 1 };
  if (!hasResources(player.resources, cost)) {
    return { ok: false, state, error: "not enough resources" };
  }

  spendResources(player.resources, cost);
  gainBankResources(next.resourceBank, cost);
  next.buildings[vertexId] = { ownerId: userId, kind: "settlement" };
  player.settlements.push(vertexId);
  pushLog(next, `${player.username} built a settlement.`);
  checkWinner(next);
  return { ok: true, state: next };
}

function buildCity(state: RoomState, userId: string, vertexId: number): ActionResult {
  if (state.phase !== "main") return { ok: false, state, error: "not in main phase" };
  if (state.mustRoll) return { ok: false, state, error: "roll dice first" };

  const active = getActivePlayer(state);
  if (active.id !== userId) return { ok: false, state, error: "not your turn" };

  const building = state.buildings[vertexId];
  if (!building || building.ownerId !== userId || building.kind !== "settlement") {
    return { ok: false, state, error: "must upgrade your own settlement" };
  }

  const next = cloneState(state);
  const player = getPlayer(next, userId) as PlayerState;
  const cost = { wheat: 2, ore: 3 };
  if (!hasResources(player.resources, cost)) {
    return { ok: false, state, error: "not enough resources" };
  }

  spendResources(player.resources, cost);
  gainBankResources(next.resourceBank, cost);
  next.buildings[vertexId] = { ownerId: userId, kind: "city" };
  player.settlements = player.settlements.filter((id) => id !== vertexId);
  player.cities.push(vertexId);
  pushLog(next, `${player.username} upgraded to a city.`);
  checkWinner(next);
  return { ok: true, state: next };
}

function buyDevCard(state: RoomState, userId: string): ActionResult {
  if (state.phase !== "main") return { ok: false, state, error: "not in main phase" };
  if (state.mustRoll) return { ok: false, state, error: "roll dice first" };

  const active = getActivePlayer(state);
  if (active.id !== userId) return { ok: false, state, error: "not your turn" };

  if (state.devDeck.length === 0) return { ok: false, state, error: "dev deck is empty" };

  const next = cloneState(state);
  const player = getPlayer(next, userId) as PlayerState;
  const cost = { sheep: 1, wheat: 1, ore: 1 };
  if (!hasResources(player.resources, cost)) return { ok: false, state, error: "not enough resources" };

  spendResources(player.resources, cost);
  gainBankResources(next.resourceBank, cost);
  const drawn = next.devDeck.shift() as DevCard;
  player.newDevCards[drawn] += 1;
  pushLog(next, `${player.username} bought a development card.`);
  checkWinner(next);
  return { ok: true, state: next };
}

function playDevCard(state: RoomState, userId: string, card: DevCard, payload: any): ActionResult {
  if (state.phase !== "main") return { ok: false, state, error: "not in main phase" };

  const active = getActivePlayer(state);
  if (active.id !== userId) return { ok: false, state, error: "not your turn" };

  if (state.playedDevCardThisTurn) return { ok: false, state, error: "already played a dev card this turn" };

  const player = getPlayer(state, userId);
  if (!player || player.devCards[card] <= 0) return { ok: false, state, error: "card not available" };

  const next = cloneState(state);
  const nextPlayer = getPlayer(next, userId) as PlayerState;
  nextPlayer.devCards[card] -= 1;
  next.playedDevCardThisTurn = true;

  if (card === "knight") {
    nextPlayer.playedKnights += 1;
    updateLargestArmyHolder(next);
    next.pendingRobber = true;
    pushLog(next, `${nextPlayer.username} played Knight. ${nextPlayer.username} is robbing someone.`);
    const moved = moveRobber(next, userId, payload.tileId, payload.targetPlayerId);
    if (!moved.ok) return moved;
    moved.state.pendingRobber = false;
    checkWinner(moved.state);
    return moved;
  }

  if (card === "yearOfPlenty") {
    const resources = payload.resources as Resource[];
    if (!Array.isArray(resources) || resources.length !== 2) {
      return { ok: false, state, error: "year of plenty needs 2 resources" };
    }
    for (const resource of resources) {
      if (!["wood", "brick", "sheep", "wheat", "ore"].includes(resource)) {
        return { ok: false, state, error: "invalid resource" };
      }
      if (!hasBankResources(next.resourceBank, { [resource]: 1 })) {
        return { ok: false, state, error: `bank is out of ${resource}` };
      }
    }
    for (const resource of resources) {
      spendBankResources(next.resourceBank, { [resource]: 1 });
      nextPlayer.resources[resource] += 1;
    }
    pushLog(next, `${nextPlayer.username} played Year of Plenty.`);
    checkWinner(next);
    return { ok: true, state: next };
  }

  if (card === "monopoly") {
    const resource = payload.resource as Resource;
    if (!["wood", "brick", "sheep", "wheat", "ore"].includes(resource)) {
      return { ok: false, state, error: "invalid resource" };
    }
    let total = 0;
    for (const other of next.players) {
      if (other.id === userId) continue;
      total += other.resources[resource];
      other.resources[resource] = 0;
    }
    nextPlayer.resources[resource] += total;
    pushLog(next, `${nextPlayer.username} played Monopoly (${resource}).`);
    checkWinner(next);
    return { ok: true, state: next };
  }

  if (card === "roadBuilding") {
    const edgeIds = payload.edgeIds as number[];
    if (!Array.isArray(edgeIds) || edgeIds.length !== 2) {
      return { ok: false, state, error: "road building needs 2 edges" };
    }
    let stepState = next;
    for (const edgeId of edgeIds) {
      const result = buildRoad(stepState, userId, Number(edgeId), true);
      if (!result.ok) return result;
      stepState = result.state;
    }
    pushLog(stepState, `${nextPlayer.username} played Road Building.`);
    checkWinner(stepState);
    return { ok: true, state: stepState };
  }

  return { ok: false, state, error: "cannot play this card" };
}

function maritimeTrade(state: RoomState, userId: string, give: Partial<ResourceBank>, receive: Partial<ResourceBank>): ActionResult {
  if (state.phase !== "main") return { ok: false, state, error: "not in main phase" };
  if (state.mustRoll) return { ok: false, state, error: "roll dice first" };

  const active = getActivePlayer(state);
  if (active.id !== userId) return { ok: false, state, error: "not your turn" };

  let totalReceive = 0;
  for (const res of Object.keys(receive) as Resource[]) {
    const count = receive[res] || 0;
    if (count < 0 || !Number.isInteger(count)) return { ok: false, state, error: "invalid receive quantity" };
    totalReceive += count;
  }
  if (totalReceive <= 0) return { ok: false, state, error: "must receive at least 1 resource" };

  let totalTradeValue = 0;
  for (const res of Object.keys(give) as Resource[]) {
    const count = give[res] || 0;
    if (count < 0 || !Number.isInteger(count)) return { ok: false, state, error: "invalid give quantity" };
    if (count === 0) continue;
    if ((receive[res] || 0) > 0) {
      return { ok: false, state, error: "cannot trade resource for itself" };
    }
  }

  const next = cloneState(state);
  const player = getPlayer(next, userId) as PlayerState;

  for (const res of Object.keys(give) as Resource[]) {
    const count = give[res] || 0;
    if (count === 0) continue;
    const rate = getPortRateForPlayer(next, player, res);
    if (count % rate !== 0) {
      return { ok: false, state, error: `invalid trade quantity for ${res}, need multiples of ${rate}` };
    }
    totalTradeValue += count / rate;
  }

  if (totalTradeValue === 0) return { ok: false, state, error: "must give at least some resources" };
  if (totalTradeValue !== totalReceive) {
    return { ok: false, state, error: `trade values do not match: giving enough for ${totalTradeValue}, requesting ${totalReceive}` };
  }

  if (!hasResources(player.resources, give)) {
    return { ok: false, state, error: "not enough resources to trade" };
  }
  if (!hasBankResources(next.resourceBank, receive)) {
    return { ok: false, state, error: "bank does not have requested resources" };
  }

  spendResources(player.resources, give);
  gainBankResources(next.resourceBank, give);

  for (const res of Object.keys(receive) as Resource[]) {
    gainResource(player.resources, res, receive[res] || 0);
  }
  spendBankResources(next.resourceBank, receive);

  const giveStr = Object.keys(give).filter(r => (give[r as Resource]||0) > 0).map(r => `${give[r as Resource]} ${r}`).join(", ");
  const recStr = Object.keys(receive).filter(r => (receive[r as Resource]||0) > 0).map(r => `${receive[r as Resource]} ${r}`).join(", ");
  pushLog(next, `${player.username} traded ${giveStr} for ${recStr}.`);

  return { ok: true, state: next };
}

function offerTrade(state: RoomState, userId: string, offer: Partial<ResourceBank>, request: Partial<ResourceBank>): ActionResult {
  if (state.phase !== "main") return { ok: false, state, error: "not in main phase" };
  if (state.mustRoll) return { ok: false, state, error: "roll dice first" };
  if (state.pendingRobber || Object.keys(state.pendingDiscards).length > 0) return { ok: false, state, error: "resolve robber first" };

  const active = getActivePlayer(state);
  if (active.id !== userId) return { ok: false, state, error: "not your turn" };
  
  for (const resource of ["wood", "brick", "sheep", "wheat", "ore"] as Resource[]) {
    if (offer[resource] && request[resource]) {
      return { ok: false, state, error: "cannot request a trade that contains the same type of card" };
    }
  }

  const next = cloneState(state);
  const player = getPlayer(next, userId) as PlayerState;

  if (!hasResources(player.resources, offer)) {
    return { ok: false, state, error: "you do not have the resources to offer" };
  }

  next.pendingTrade = { authorId: userId, offer, request };
  pushLog(next, `${player.username} offered a domestic trade.`);
  return { ok: true, state: next };
}

function acceptTrade(state: RoomState, userId: string): ActionResult {
  if (state.phase !== "main") return { ok: false, state, error: "not in main phase" };
  const trade = state.pendingTrade;
  if (!trade) return { ok: false, state, error: "no pending trade" };
  if (trade.authorId === userId) return { ok: false, state, error: "cannot accept your own trade" };

  const active = getActivePlayer(state);
  if (active.id !== trade.authorId) return { ok: false, state, error: "active player changed" };

  const next = cloneState(state);
  const offerer = getPlayer(next, trade.authorId) as PlayerState;
  const acceptor = getPlayer(next, userId) as PlayerState;

  if (!hasResources(offerer.resources, trade.offer)) {
    return { ok: false, state, error: "offerer no longer has the resources" };
  }
  if (!hasResources(acceptor.resources, trade.request)) {
    return { ok: false, state, error: "you do not have the requested resources" };
  }

  spendResources(offerer.resources, trade.offer);
  spendResources(acceptor.resources, trade.request);
  
  for (const resource of Object.keys(trade.offer) as Resource[]) {
    gainResource(acceptor.resources, resource, trade.offer[resource] || 0);
  }
  for (const resource of Object.keys(trade.request) as Resource[]) {
    gainResource(offerer.resources, resource, trade.request[resource] || 0);
  }

  next.pendingTrade = null;
  pushLog(next, `${acceptor.username} accepted the trade with ${offerer.username}.`);
  return { ok: true, state: next };
}

function cancelTrade(state: RoomState, userId: string): ActionResult {
  if (!state.pendingTrade) return { ok: false, state, error: "no pending trade" };
  if (state.pendingTrade.authorId !== userId) return { ok: false, state, error: "only the author can cancel the trade" };

  const next = cloneState(state);
  next.pendingTrade = null;
  const player = getPlayer(next, userId) as PlayerState;
  pushLog(next, `${player.username} cancelled their trade offer.`);
  return { ok: true, state: next };
}

function endTurn(state: RoomState, userId: string): ActionResult {
  if (state.phase !== "main") return { ok: false, state, error: "not in main phase" };

  const active = getActivePlayer(state);
  if (active.id !== userId) return { ok: false, state, error: "not your turn" };
  if (state.mustRoll) return { ok: false, state, error: "roll before ending turn" };
  if (state.pendingRobber || Object.keys(state.pendingDiscards).length > 0) {
    return { ok: false, state, error: "resolve robber sequence first" };
  }

  const next = cloneState(state);
  next.pendingTrade = null;
  const player = getPlayer(next, userId) as PlayerState;
  pushLog(next, `${player.username} ended their turn.`);
  advanceTurn(next);
  return { ok: true, state: next };
}

function sanitizeStateForUser(state: RoomState, viewerUserId: string) {
  const active = state.players[state.activePlayerIndex];
  return {
    ...state,
    activePlayerId: active ? active.id : null,
    devDeckCount: state.devDeck.length,
    resourceBank: state.resourceBank,
    players: state.players.map((player) => {
      const fullVP = getVictoryPoints(state, player.id);
      const publicVP = getPublicVictoryPoints(state, player.id);

      const visible = {
        id: player.id,
        username: player.username,
        roads: player.roads,
        settlements: player.settlements,
        cities: player.cities,
        playedKnights: player.playedKnights,
        publicVictoryPoints: publicVP,
      } as any;

      if (player.id === viewerUserId) {
        // Owner sees full details
        visible.victoryPoints = fullVP;
        visible.resources = player.resources;
        visible.devCards = player.devCards;
        visible.newDevCards = player.newDevCards;
      } else {
        // Others only see counts, not private resources/devcards
        visible.resourceCount = sumResources(player.resources);
        visible.devCardCount = sumDevCards(player.devCards) + sumDevCards(player.newDevCards);
      }
      return visible;
    }),
  };
}

function sumDevCards(cards: DevBank): number {
  return cards.knight + cards.roadBuilding + cards.yearOfPlenty + cards.monopoly + cards.victoryPoint;
}

function applyGameAction(state: RoomState, userId: string, action: any): ActionResult {
  const actionType = action?.type;

  if (actionType === "setup_place") {
    return setupPlace(state, userId, Number(action.vertexId), Number(action.edgeId));
  }
  if (actionType === "setup_place_settlement") {
    return setupPlaceSettlement(state, userId, Number(action.vertexId));
  }
  if (actionType === "setup_place_road") {
    return setupPlaceRoad(state, userId, Number(action.edgeId));
  }
  if (actionType === "roll_dice") {
    return rollDice(state, userId);
  }
  if (actionType === "discard_resources") {
    return discardResources(state, userId, action.discard || {});
  }
  if (actionType === "move_robber") {
    return moveRobber(state, userId, Number(action.tileId), action.targetPlayerId || undefined);
  }
  if (actionType === "build_road") {
    return buildRoad(state, userId, Number(action.edgeId), false);
  }
  if (actionType === "build_settlement") {
    return buildSettlement(state, userId, Number(action.vertexId));
  }
  if (actionType === "build_city") {
    return buildCity(state, userId, Number(action.vertexId));
  }
  if (actionType === "buy_dev_card") {
    return buyDevCard(state, userId);
  }
  if (actionType === "play_dev_card") {
    return playDevCard(state, userId, action.card, action.payload || {});
  }
  if (actionType === "maritime_trade") {
    return maritimeTrade(state, userId, action.give || {}, action.receive || {});
  }
  if (actionType === "offer_trade") {
    return offerTrade(state, userId, action.offer || {}, action.request || {});
  }
  if (actionType === "accept_trade") {
    return acceptTrade(state, userId);
  }
  if (actionType === "cancel_trade") {
    return cancelTrade(state, userId);
  }
  if (actionType === "end_turn") {
    return endTurn(state, userId);
  }

  return { ok: false, state, error: "unknown action" };
}

function resetPlayersForLobby(state: RoomState): void {
  for (const player of state.players) {
    player.resources = emptyResources();
    player.roads = [];
    player.settlements = [];
    player.cities = [];
    player.devCards = emptyDevCards();
    player.newDevCards = emptyDevCards();
    player.playedKnights = 0;
  }
  state.started = false;
  state.phase = "lobby";
  state.activePlayerIndex = 0;
  state.setupRound = 1;
  state.mustRoll = false;
  state.playedDevCardThisTurn = false;
  state.pendingDiscards = {};
  state.pendingRobber = false;
  state.pendingSetupPlacement = null;
  state.pendingTrade = null;
  state.longestRoadHolder = null;
  state.largestArmyHolder = null;
  state.winnerId = null;
  state.buildings = {};
  state.roads = {};
  state.devDeck = [];
  state.resourceBank = fullResourceBank();
}

module.exports = {
  createLobbyState,
  joinLobby,
  leaveLobbyOrGame,
  startGame,
  endGame,
  applyGameAction,
  sanitizeStateForUser,
};
