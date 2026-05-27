Objective
You are tasked with developing a full-stack, real-time multiplayer board game application inspired by Colonist.io. 

The repository structure, toolchains, and package versions are already locked down on my local machine. Your absolute priority is to build a working, playable, turn-based MVP game loop that can be tested locally on a single computer using multiple browser windows. Do NOT build public matchmaking queues; focus entirely on a private host-and-join room architecture.

Current Repository Blueprint
- Frontend: React 18 (TypeScript) + Vite + Tailwind v4 + DaisyUI + Howler.js + Socket.io-client.
- Backend: Node.js + Express + TypeScript (executed via 'tsx watch') + Socket.io + Prisma ORM + ioredis.

File System Workspace Layout:
├── backend/
│   ├── prisma/
│   │   └── schema.prisma (Contains baseline User model)
│   ├── src/
│   │   └── index.ts (Main Express + Socket.io configuration)
│   ├── package.json
│   └── tsconfig.json
└── frontend/
    ├── src/
    │   ├── App.tsx (Baseline layout connecting to socket server)
    │   └── main.tsx
    ├── package.json
    └── vite.config.ts

Rules of Engagement:
1. No Configuration Changes: Do NOT re-initialize the projects or install new npm dependencies. Use the modern v4 Socket.io framework and Tailwind v4 directives already present.
2. Direct Code Execution/Writing: Use your file system tools to write code directly into the existing directories. 
3. Explicit Prisma Usage: Any backend user tracking or database mutations must utilize the Prisma client instance. Do not use raw SQL.
4. Error Prevention: Every network payload must be explicitly typed in TypeScript. Before completing a step, run the project's build or dev scripts via terminal execution to confirm zero compilation errors.

---

## Technical Specifications for the MVP Loop

### Phase 1: Authentication & Room Lifecycle (Lobby System)
- Guest Sessions: Modify the frontend to show a guest entry form if no user exists. The backend should take a username, create a record via Prisma, and return a unique User ID.
- Host Match: The client clicks "Host Private Match". The backend generates a short, random 6-character Room ID, saves an empty board/game schema in Redis, links the socket to that Room ID using socket.join(roomId), and returns the Room ID to the host.
- Lobby Broadcast: Build a live room monitor dashboard. Sockets should receive a broadcast update whenever rooms are created or destroyed, rendering an active room list. Other local browser windows can click "Join Match" next to a room ID to instantly tie their sockets to that game instance.

### Phase 2: Core Turn-Based State Machine
- Game Initialization: When the host clicks "Start Game", the backend constructs a static, simplified grid of hex positions or tiles representing the map, sets an array of connected player IDs, initializes an active `turnIndex = 0`, and saves this data snapshot in Redis.
- Board Layout: Broadcast a transition event that switches all connected players in that Room ID from the lobby view to the main game board component.
- Action Sync & Loop Execution:
  1. The active player (matching players[turnIndex]) sees a "Dice Roll" button. All other players see a "Waiting for Player..." status badge.
  2. Clicking "Dice Roll" fires a socket event to the backend.
  3. The backend calculates a randomized value (2-12 roll), updates the room state in Redis, increments the `turnIndex` (looping back to 0 at the end of the array), and instantly broadcasts the roll output and the next `currentPlayerId` to all sockets in the room.
  4. The frontend listens to this broadcast, shifts the "Dice Roll" controls to the next active player, and displays the numerical roll result in a clear game log feed utilizing DaisyUI alert structures.

---

## Expected Outcome
Use your sequential thinking and file tools to fully flesh out the backend socket handlers and frontend components. When completed, verify using terminal utilities that multiple local browser tabs running on localhost can cleanly authenticate as distinct users, sit in a shared room, transition to the game screen, and execute sequential turns.