// Game creation, the client snapshot and the invariants checked by the simulations.
import cardsData from "../shared/cards.json" with { type: "json" };
import { RULES, BOARD } from "../shared/rent.js";
import { DEFAULT_RULES, type GameRules } from "../shared/settings.js";
import type { GameEvent, GameErrorCode } from "../shared/events.js";
import { Rng, seedToState } from "./rng.js";
import type { GameSnapshot, GameState } from "./types.js";

export interface NewGameInput {
  /** Seated players (any order: the turn order is shuffled with the seed). */
  players: { id: string; characterId: string | null }[];
  /** The room's rule settings (frozen for the game). Missing keys use the defaults. */
  rules?: Partial<GameRules>;
  /** Shortcut for rules.startingCash. */
  startingCash?: number;
  seed: number | string;
}

export type CreateResult = { ok: true; state: GameState; events: GameEvent[] } | { ok: false; error: GameErrorCode };

export function createGame(input: NewGameInput): CreateResult {
  if (input.players.length < 2) return { ok: false, error: "NEED_2_PLAYERS" };
  const rules: GameRules = { ...DEFAULT_RULES, ...input.rules, ...(input.startingCash !== undefined ? { startingCash: input.startingCash } : {}) };
  const rng = new Rng(seedToState(input.seed));
  const order = rng.shuffle(input.players);
  const decks = {
    fortune: rng.shuffle(cardsData.fortune.map((c) => c.id)),
    vault: rng.shuffle(cardsData.vault.map((c) => c.id)),
  };
  const state: GameState = {
    phase: "awaitingRoll",
    currentPlayerId: order[0]!.id,
    turnNumber: 1,
    players: order.map((p) => ({ id: p.id, characterId: p.characterId, cash: rules.startingCash, position: 0, inJail: false, jailTurns: 0, bankrupt: false })),
    properties: {},
    rules,
    oasisPool: 0,
    auction: null,
    pendingDebt: null,
    debtThen: null,
    trades: [],
    lastRoll: null,
    pendingDecision: null,
    seq: 0,
    winnerPlayerId: null,
    tradeSeq: 0,
    rng: rng.state,
    decks,
    deckPos: { fortune: 0, vault: 0 },
    bank: 0,
    processed: [],
  };
  const events: GameEvent[] = [
    { type: "GAME_STARTED", players: state.players.map((p) => ({ id: p.id, characterId: p.characterId, cash: p.cash })), rules: { ...rules } },
    { type: "TURN_STARTED", playerId: order[0]!.id, turnNumber: 1, phase: "awaitingRoll" },
  ];
  return { ok: true, state, events };
}

/** What clients may see: no seed, no deck order, no bank, no action ids. */
export function toSnapshot(state: GameState): GameSnapshot {
  return {
    phase: state.phase,
    currentPlayerId: state.currentPlayerId,
    turnNumber: state.turnNumber,
    players: state.players.map((p) => ({ ...p })),
    properties: Object.fromEntries(Object.entries(state.properties).map(([k, v]) => [k, { ...v }])) as GameSnapshot["properties"],
    rules: { ...state.rules },
    oasisPool: state.oasisPool,
    auction: state.auction ? { ...state.auction, withdrawnIds: [...state.auction.withdrawnIds] } : null,
    pendingDebt: state.pendingDebt ? { ...state.pendingDebt } : null,
    trades: state.trades.map((t) => ({ ...t, give: { ...t.give, tiles: [...t.give.tiles] }, get: { ...t.get, tiles: [...t.get.tiles] } })),
    lastRoll: state.lastRoll ? { values: [state.lastRoll.values[0], state.lastRoll.values[1]], total: state.lastRoll.total } : null,
    pendingDecision: state.pendingDecision ? { ...state.pendingDecision } : null,
    seq: state.seq,
    winnerPlayerId: state.winnerPlayerId,
  };
}

/** Returns a list of violated invariants (empty when the state is healthy). */
export function checkInvariants(state: GameState): string[] {
  const problems: string[] = [];
  const active = state.players.filter((p) => !p.bankrupt);
  for (const p of state.players) {
    if (p.cash < 0) problems.push(`negative cash for ${p.id}: ${p.cash}`);
    if (!Number.isInteger(p.cash)) problems.push(`non-integer cash for ${p.id}`);
    if (p.position < 0 || p.position >= RULES.boardSize) problems.push(`bad position ${p.position}`);
    if (p.bankrupt && p.cash !== 0) problems.push(`bankrupt player ${p.id} still has cash`);
  }
  const total = state.players.reduce((s, p) => s + p.cash, 0) + state.bank + state.oasisPool;
  const expected = state.players.length * state.rules.startingCash;
  if (total !== expected) problems.push(`money not conserved: ${total} vs ${expected}`);
  if (state.oasisPool < 0) problems.push("negative Oasis pool");
  if (state.oasisPool > 0 && !state.rules.oasisJackpot) problems.push("Oasis pool filled while the rule is off");
  if ((state.phase === "auction") !== (state.auction !== null)) problems.push("auction phase and auction state disagree");
  if ((state.phase === "raisingFunds") !== (state.pendingDebt !== null)) problems.push("raisingFunds phase and pendingDebt disagree");
  if (state.pendingDebt && state.pendingDebt.amount <= 0) problems.push("empty debt");
  if (state.auction) {
    const a = state.auction;
    if (state.properties[a.tileIndex]) problems.push("auctioned tile already has an owner");
    if (a.highestBidderId && a.withdrawnIds.includes(a.highestBidderId)) problems.push("the auction leader is withdrawn");
    const leader = state.players.find((p) => p.id === a.highestBidderId);
    if (a.highestBidderId && (!leader || leader.bankrupt || leader.cash < a.currentBid)) problems.push("the auction leader cannot pay the bid");
  }
  for (const [k, prop] of Object.entries(state.properties)) {
    const tile = BOARD[Number(k)];
    if (!tile || (tile.kind !== "property" && tile.kind !== "harbor" && tile.kind !== "utility")) problems.push(`owned tile ${k} is not buyable`);
    if (prop.level < 0 || prop.level > 5) problems.push(`bad level ${prop.level} on ${k}`);
    if (prop.mortgaged && prop.level !== 0) problems.push(`mortgaged tile ${k} has buildings`);
    if (prop.mortgaged && !state.rules.mortgage) problems.push(`mortgaged tile ${k} while the rule is off`);
    if (tile && tile.kind !== "property" && prop.level !== 0) problems.push(`building on non-property ${k}`);
    const owner = state.players.find((p) => p.id === prop.ownerId);
    if (!owner || owner.bankrupt) problems.push(`tile ${k} owned by missing or bankrupt ${prop.ownerId}`);
  }
  for (const t of state.trades) {
    if (t.status !== "pending") continue;
    const from = state.players.find((p) => p.id === t.fromId);
    const to = state.players.find((p) => p.id === t.toId);
    if (!from || !to || from.bankrupt || to.bankrupt) problems.push(`pending trade ${t.id} involves a player who is out`);
  }
  if (state.phase !== "gameOver") {
    const cur = state.players.find((p) => p.id === state.currentPlayerId);
    if (!cur || (cur.bankrupt && state.phase !== "auction")) problems.push("current player missing or bankrupt");
    if (active.length < 2) problems.push("fewer than 2 active players but game not over");
  } else if (!state.winnerPlayerId || active.length !== 1 || active[0]!.id !== state.winnerPlayerId) {
    problems.push("gameOver without a single winner");
  }
  return problems;
}
