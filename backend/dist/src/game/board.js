"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const TERRAIN_COUNTS = [
    "forest", "forest", "forest", "forest",
    "hills", "hills", "hills",
    "pasture", "pasture", "pasture", "pasture",
    "fields", "fields", "fields", "fields",
    "mountains", "mountains", "mountains",
    "desert",
];
const NUMBER_TOKENS = [5, 2, 6, 3, 8, 10, 9, 12, 11, 4, 8, 10, 9, 4, 5, 6, 3, 11];
function shuffle(items) {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = copy[i];
        copy[i] = copy[j];
        copy[j] = tmp;
    }
    return copy;
}
function getHexCoords(radius) {
    const coords = [];
    for (let q = -radius; q <= radius; q += 1) {
        const r1 = Math.max(-radius, -q - radius);
        const r2 = Math.min(radius, -q + radius);
        for (let r = r1; r <= r2; r += 1) {
            coords.push({ q, r });
        }
    }
    coords.sort((a, b) => {
        if (a.r === b.r)
            return a.q - b.q;
        return a.r - b.r;
    });
    return coords;
}
function axialToPixel(q, r, size) {
    const x = size * (Math.sqrt(3) * q + (Math.sqrt(3) / 2) * r);
    const y = size * ((3 / 2) * r);
    return { x, y };
}
function terrainToResource(terrain) {
    if (terrain === "forest")
        return "wood";
    if (terrain === "hills")
        return "brick";
    if (terrain === "pasture")
        return "sheep";
    if (terrain === "fields")
        return "wheat";
    if (terrain === "mountains")
        return "ore";
    return null;
}
function createBoard() {
    const coords = getHexCoords(2);
    const terrainBag = shuffle(TERRAIN_COUNTS);
    const vertexMap = new Map();
    const vertices = [];
    const edgeMap = new Map();
    const edges = [];
    const tiles = coords.map((coord, idx) => ({
        id: idx,
        q: coord.q,
        r: coord.r,
        terrain: terrainBag[idx],
        number: null,
        vertexIds: [],
        edgeIds: [],
    }));
    const size = 1;
    for (const tile of tiles) {
        const center = axialToPixel(tile.q, tile.r, size);
        const localVertices = [];
        for (let i = 0; i < 6; i += 1) {
            const angle = (Math.PI / 180) * (60 * i - 30);
            const vx = center.x + size * Math.cos(angle);
            const vy = center.y + size * Math.sin(angle);
            const key = `${Math.round(vx * 10000)}:${Math.round(vy * 10000)}`;
            let vertexId = vertexMap.get(key);
            if (vertexId === undefined) {
                vertexId = vertices.length;
                vertexMap.set(key, vertexId);
                vertices.push({
                    id: vertexId,
                    x: vx,
                    y: vy,
                    adjacentTiles: [],
                    adjacentVertices: [],
                    adjacentEdges: [],
                });
            }
            vertices[vertexId].adjacentTiles.push(tile.id);
            localVertices.push(vertexId);
        }
        tile.vertexIds = localVertices;
        for (let i = 0; i < 6; i += 1) {
            const v1 = localVertices[i];
            const v2 = localVertices[(i + 1) % 6];
            const minV = Math.min(v1, v2);
            const maxV = Math.max(v1, v2);
            const edgeKey = `${minV}:${maxV}`;
            let edgeId = edgeMap.get(edgeKey);
            if (edgeId === undefined) {
                edgeId = edges.length;
                edgeMap.set(edgeKey, edgeId);
                edges.push({ id: edgeId, v1: minV, v2: maxV, adjacentTiles: [] });
                vertices[minV].adjacentVertices.push(maxV);
                vertices[maxV].adjacentVertices.push(minV);
            }
            edges[edgeId].adjacentTiles.push(tile.id);
            vertices[minV].adjacentEdges.push(edgeId);
            vertices[maxV].adjacentEdges.push(edgeId);
            tile.edgeIds.push(edgeId);
        }
    }
    const numbers = shuffle(NUMBER_TOKENS);
    let numberIdx = 0;
    for (const tile of tiles) {
        if (tile.terrain === "desert") {
            tile.number = null;
        }
        else {
            tile.number = numbers[numberIdx];
            numberIdx += 1;
        }
    }
    const perimeter = vertices
        .filter((vertex) => vertex.adjacentTiles.length < 3)
        .sort((a, b) => {
        const angleA = Math.atan2(a.y, a.x);
        const angleB = Math.atan2(b.y, b.x);
        return angleA - angleB;
    });
    const portAssignments = [
        { type: "wood", rate: 2 },
        { type: "brick", rate: 2 },
        { type: "sheep", rate: 2 },
        { type: "wheat", rate: 2 },
        { type: "ore", rate: 2 },
        { type: "any", rate: 3 },
        { type: "any", rate: 3 },
        { type: "any", rate: 3 },
        { type: "any", rate: 3 },
    ];
    if (perimeter.length >= 18) {
        const step = Math.floor(perimeter.length / 9);
        for (let i = 0; i < 9; i += 1) {
            const base = (i * step) % perimeter.length;
            const assignment = portAssignments[i];
            const vA = perimeter[base];
            const vB = perimeter[(base + 1) % perimeter.length];
            vertices[vA.id].port = assignment;
            vertices[vB.id].port = assignment;
        }
    }
    return { tiles, vertices, edges };
}
module.exports = {
    createBoard,
    terrainToResource,
};
//# sourceMappingURL=board.js.map