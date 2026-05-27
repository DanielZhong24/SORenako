
---

# The Settlers of Catan — Complete Engineering & Gameplay Specification

This specification codifies the layout constants, state transitions, supply limitations, and edge-case behaviors required to run a deterministic game loop of *The Settlers of Catan* for 3 to 4 players.

---

## 📊 Core Game Constants & Component Inventories

A digital game state machine must enforce these global maximum thresholds. Exceeding any of these resource, development, or structural caps is structurally illegal.

### 1. Finite Bank Resource Supplies

The bank contains exactly 95 resource cards. If a dice roll demands more cards of a single type than the bank physically holds, **no player receives that resource type on that turn** (the resource depletion block rule).

* 🪵 **Lumber (Wood):** 19 cards
* 🧱 **Brick (Clay):** 19 cards
* 🐑 **Wool (Sheep):** 19 cards
* 🌾 **Grain (Wheat):** 19 cards
* 🪨 **Ore (Rock):** 19 cards

### 2. Physical Structure Inventory per Player

Players are strictly capped by their starting piece counts. If a player's structural inventory hits 0, they cannot execute that specific build action.

* 🛣️ **Roads:** 15 units
* 🏠 **Settlements:** 5 units
* 🏛️ **Cities:** 4 units

> 🔄 **Inventory Reversion Rule:** Upgrading a Settlement to a City subtracts 1 City from the inventory and **adds 1 Settlement back to the player's available structure pool**.

### 3. Development Card Hidden Deck

The development card pile contains exactly **25 cards**, shuffled thoroughly at initialization.

| Card Type | Quantity | Resolution Logic |
| --- | --- | --- |
| **Knight** | 14 | Activates the Robber mechanism instantly. Contributes toward Largest Army. |
| **Road Building** | 2 | Forces placement of up to 2 legal roads without resource deduction. |
| **Year of Plenty** | 2 | Grants the active player any 2 arbitrary resources from available bank stock. |
| **Monopoly** | 2 | Declares a resource type; sweeps all matching cards from opponent hands. |
| **Victory Point** | 5 | Stays hidden in the player's hand array. Evaluated *only* on turn completion. |

---

## 🗺️ Board Layout & Mathematical Architecture

The Catan map is constructed as a nested hexagonal grid consisting of 19 internal terrain tiles framed by a fixed maritime boundary. Notice the layout structure below:

---

### 1. Hex Tile Manifest

The internal array contains precisely 19 terrain hexes:

* **4 Forests** (Produces 🪵)
* **4 Pastures** (Produces 🐑)
* **4 Fields** (Produces 🌾)
* **3 Hills** (Produces 🧱)
* **3 Mountains** (Produces 🪨)
* **1 Desert** (Produces nothing; spawns the Robber entity)

### 2. Number Token Array & Statistical Weighting

Eighteen tokens are distributed across the 18 non-desert hexes. The size and pips of a number determine its probability matrix using a standard two-dice ($2\text{d}6$) layout:

| Value | Distribution Frequency | Probability Weight |
| --- | --- | --- |
| **2** | 1 Token | 1 / 36 ($\approx 2.78\%$) |
| **3** | 2 Tokens | 2 / 36 ($\approx 5.56\%$) |
| **4** | 2 Tokens | 3 / 36 ($\approx 8.33\%$) |
| **5** | 2 Tokens | 4 / 36 ($\approx 11.11\%$) |
| **6 (Red)** | 2 Tokens | 5 / 36 ($\approx 13.89\%$) |
| **8 (Red)** | 2 Tokens | 5 / 36 ($\approx 13.89\%$) |
| **9** | 2 Tokens | 4 / 36 ($\approx 11.11\%$) |
| **10** | 2 Tokens | 3 / 36 ($\approx 8.33\%$) |
| **11** | 2 Tokens | 2 / 36 ($\approx 5.56\%$) |
| **12** | 1 Token | 1 / 36 ($\approx 2.78\%$) |

---

## 🚀 Initial Setup State Machine (The Placement Engine)

Before the standard turn-based game loop can begin, the client must execute a structural initialization sequence using a snake-draft mechanism.

1. **Determine Sequence:** Phase 0.
All users fire a random roll event. Sockets sort the player IDs in descending order into a permanent execution array.


2. **First Wave (Forward Setup):** Phase 1.
Proceeding from Player 1 to Player 4, each user selects one legal board intersection to construct **1 free Settlement**, and joins **1 free Road** to any adjacent open edge.


3. **Second Wave (Reverse Setup):** Phase 2.
Proceeding in inverted order from Player 4 back to Player 1, each user places their **second Settlement and attached Road**.


4. **Starting Yield Allocation:** Phase 3.
The engine reads the 3 hexes bordering each player's **second placement**. The bank automatically yields 1 resource card per matching terrain tile directly into the player's starting inventory array.


### ⚠️ Critical Geometry Logic: The Distance Rule

An intersection is defined as **illegal** for a settlement placement if any adjacent vertex connected by a single edge segment already hosts a settlement or city. There must always be at least **two empty edges** between all structures across the graph.

---

## 🔄 The Real-Time Turn Execution Loop

Once Phase 3 of setup closes, the active player turn starts. A turn is explicitly segmented into three sequentially locked system states.

```
                  ┌───────────────────────────────┐
                  │   1. RESOURCE ROLL PHASE      │
                  └───────────────┬───────────────┘
                                  │
                                  ▼
                  ┌───────────────────────────────┐
                  │   2. OPEN TRADING PHASE       │
                  └───────────────┬───────────────┘
                                  │
                                  ▼
                  ┌───────────────────────────────┐
                  │   3. SYSTEM BUILDING PHASE    │
                  └───────────────────────────────┘

```

### State 1: Resource Production

The active user triggers the dice event. The backend resolves a random distribution of $2\text{d}6$.

* **Standard Resolution (Roll 2–6, 8–12):** The server cross-references the rolled value against matching active hex tokens. For every bordering structure:
* **Settlement present:** Yields 1 matching resource card.
* **City present:** Yields 2 matching resource cards.


* **The Robber Resolution (Roll 7):** Standard resource generation is skipped entirely. The server runs the Robber sequence:
1. **Hand Purge Check:** Any socket whose player hand count is **greater than or equal to 8 cards** must forfeit exactly half their cards (rounded down) back to the bank.
2. **Relocate Entity:** The active player inputs a new target hex ID. The Robber must leave its current tile.
3. **Tile Lockout:** The chosen hex ID is flagged. It ceases to produce any resources until the Robber is moved again.
4. **Targeted Theft:** The active player selects one opponent owning an active structure touching the new Robber tile and randomly plucks 1 card out of their hand array.



### State 2: Open Trading

The active player can manipulate hand inventories via two internal methods:

* **Domestic Player Trade:** The active player creates a transaction payload (`offering` vs `requesting`). Sockets broadcast this to the lobby; any non-active player can accept or reject. Non-active players cannot trade with each other.
* **Maritime Bank Trade:** The active user directly converts cards with the automated system:
* **Default Bank Rate:** Exchange **4 matching resources** for 1 resource of choice.
* **Generic Port (3:1):** If the player possesses a settlement on a `?` coastal node, they can swap **3 matching resources** for 1.
* **Specialized Port (2:1):** If a settlement occupies a coastal node specifying a specific resource type, they can swap **2 of that explicit resource** for 1.



### State 3: Structure Construction

Players submit resource payloads to buy cards or mutate the board map.

```
🪵 + 🧱          ➔ 🛣️ ROAD: Must connect directly to a matching player road, settlement, or city edge.
🪵 + 🧱 + 🐑 + 🌾 ➔ 🏠 SETTLEMENT: Must lie on your road network and satisfy the Distance Rule.
🌾x2 + 🪨x3     ➔ 🏛️ CITY: Must target an existing settlement node owned by the active player.
🐑 + 🌾 + 🪨     ➔ 🃏 DEV CARD: Draws 1 card from the hidden deck array.

```

> 🃏 **Development Card Operational Bounds:** A player cannot execute a Development Card on the same turn it was purchased, unless it is a Victory Point card that instantly pushes the player's live tally to 10 points. Only 1 Development Card can be executed per turn.

---

## ⚔️ Multipliers, Scoring, and Termination

A player's Victory Point value is calculated dynamically on every state change using this equation:

$$\text{Victory Points} = \text{Settlements} + (2 \times \text{Cities}) + \text{Longest Road Card} + \text{Largest Army Card} + \text{Revealed VP Cards}$$

### 🏎️ Longest Road Status (2 VPs)

* The server monitors continuous, unbroken edge chains.
* The first player to reach a chain length of **at least 5 roads** gains the card.
* If another player builds an unbroken chain strictly *greater* than the current holder's length, the card transfers immediately.
* **The Break Rule:** If an opponent builds a settlement on an open vertex *inside* your continuous road chain following the Distance Rule, **your road is instantly broken into two distinct lines**. The backend must re-evaluate all global road lengths immediately.

### 🪖 Largest Army Status (2 VPs)

* Triggers when a player activates their **third face-up Knight card**.
* If an opponent activates more face-up Knights than the current holder, ownership transfers immediately.

### 🏆 Match Termination

The game loop drops into a terminal state the exact millisecond a player achieves **10 or more Victory Points** *during their own active turn duration*. Points earned out-of-turn (such as inheriting Longest Road because an opponent's road was broken by a third party) will not trigger victory conditions until that player's turn begins and they declare victory.