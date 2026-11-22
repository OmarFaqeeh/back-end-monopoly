// The rules of the game as one pure function: applyAction(state, action, ctx) -> new state + typed events.
// No I/O. All randomness comes from the seeded RNG in the state (or the injected DiceSource); the only clock is the
// optional ctx.now (auction timers). The rules switched on in the room settings are frozen in state.rules.
import cardsData from "../shared/cards.json" with { type: "json" };
import { auctionWithout, cancelTradesOf, setTradeStatus, trimTrades } from "../shared/display.js";
import type { BuildKind, DeckName, GameErrorCode, GameEvent, MoneyReason, PendingDebt, TradeOffer, TradeSide } from "../shared/events.js";
import { GROUPS, HARBOR_TILES, RULES, UTILITY_TILES, harborRent, propertyRent, tileAt, utilityRent } from "../shared/rent.js";
import { netWorth } from "./bots/valuation.js";
import { Rng } from "./rng.js";
import type { Action, ActionResult, DebtThen, EngineContext, GameState } from "./types.js";

const CARD_AMOUNT: Record<string, number> = Object.fromEntries([...cardsData.fortune, ...cardsData.vault].map((c) => [c.id, c.amount]));
const PROCESSED_KEEP = 100;
/** Payments to the bank that feed the Oasis jackpot when the rule is on. */
const POOL_REASONS = new Set<MoneyReason>(["tax", "card", "jail_fine"]);

export const mortgageValue = (price: number) => Math.floor(price / 2);
/** price / 2 plus 10 %, rounded up (integer math: no floating point surprises). */
export const unmortgageCost = (price: number) => Math.ceil((price * 11) / 20);

/** Cheap copy of everything an action may change (the card decks are never mutated, so they are shared). */
function cloneState(state: GameState): GameState {
  return {
    ...state,
    players: state.players.map((p) => ({ ...p })),
    properties: Object.fromEntries(Object.entries(state.properties).map(([k, v]) => [k, { ...v }])),
    rules: { ...state.rules },
    auction: state.auction ? { ...state.auction, withdrawnIds: [...state.auction.withdrawnIds] } : null,
    pendingDebt: state.pendingDebt ? { ...state.pendingDebt } : null,
    debtThen: state.debtThen ? { ...state.debtThen } : null,
    trades: state.trades.map((t) => ({ ...t, give: { ...t.give, tiles: [...t.give.tiles] }, get: { ...t.get, tiles: [...t.get.tiles] } })),
    lastRoll: state.lastRoll ? { values: [state.lastRoll.values[0], state.lastRoll.values[1]], total: state.lastRoll.total } : null,
    pendingDecision: state.pendingDecision ? { ...state.pendingDecision } : null,
    deckPos: { ...state.deckPos },
    processed: [...state.processed],
  };
}

class Fail extends Error {
  constructor(readonly code: GameErrorCode) {
    super(code);
  }
}

const debtReasonOf = (reason: MoneyReason): PendingDebt["reason"] => (reason === "rent_out" ? "rent" : reason === "tax" ? "tax" : reason === "card" ? "card" : "jail_fine");

/** Working copy of a state plus the events produced so far. */
class Step {
  readonly events: GameEvent[] = [];
  constructor(
    readonly g: GameState,
    readonly ctx: EngineContext,
  ) {}

  now(): number {
    return this.ctx.now ?? Date.now();
  }

  player(id: string) {
    const p = this.g.players.find((x) => x.id === id);
    if (!p) throw new Fail("PLAYER_NOT_IN_GAME");
    return p;
  }

  emit(e: GameEvent): void {
    this.events.push(e);
  }

  /**
   * The only place cash changes (apart from the Oasis payout): one MONEY_CHANGED per change. `viaBank` keeps cash +
   * oasisPool + bank conserved; with the jackpot rule on, tax / card / fine payments go to the pool instead of the bank.
   */
  change(id: string, delta: number, reason: MoneyReason, viaBank: boolean): void {
    if (delta === 0) return;
    const p = this.player(id);
    p.cash += delta;
    let pooled = 0;
    if (viaBank) {
      if (delta < 0 && this.g.rules.oasisJackpot && POOL_REASONS.has(reason)) {
        pooled = -delta;
        this.g.oasisPool += pooled;
      } else this.g.bank -= delta;
    }
    this.emit({ type: "MONEY_CHANGED", playerId: id, delta, newCash: p.cash, reason });
    if (pooled > 0) this.emit({ type: "OASIS_POOL_CHANGED", pool: this.g.oasisPool, delta: pooled });
  }

  activePlayers() {
    return this.g.players.filter((p) => !p.bankrupt);
  }

  /**
   * Debtor pays `amount` to a creditor (null = bank). With the mortgage rule on and enough mortgageable assets, a payment
   * the player cannot cover turns into a debt phase (raisingFunds) instead of bankruptcy. Otherwise a short payment pays
   * everything that is left and bankrupts the debtor.
   */
  charge(debtorId: string, creditorId: string | null, amount: number, reason: MoneyReason, then: DebtThen): { paid: number; bankrupt: boolean; pending: boolean } {
    const debtor = this.player(debtorId);
    if (debtor.cash >= amount) {
      this.change(debtorId, -amount, reason, creditorId === null);
      if (creditorId) this.change(creditorId, amount, "rent_in", false);
      return { paid: amount, bankrupt: false, pending: false };
    }
    if (this.g.rules.mortgage && mortgageableValue(this.g, debtorId) >= amount - debtor.cash) {
      this.g.phase = "raisingFunds";
      this.g.pendingDebt = { amount, creditorId, reason: debtReasonOf(reason) };
      this.g.debtThen = then;
      this.emit({ type: "DEBT_STARTED", playerId: debtorId, amount, creditorId, reason: debtReasonOf(reason) });
      return { paid: 0, bankrupt: false, pending: true };
    }
    return { ...this.payAllAndGoBankrupt(debtorId, creditorId, reason), pending: false };
  }

  /** Everything the debtor has goes to the creditor (or the bank), then they are out. */
  payAllAndGoBankrupt(debtorId: string, creditorId: string | null, reason: MoneyReason): { paid: number; bankrupt: boolean } {
    const rest = this.player(debtorId).cash;
    // Leftovers of a bankruptcy go to the bank, never into the Oasis pool.
    this.player(debtorId).cash -= rest;
    if (rest > 0) {
      if (creditorId === null) this.g.bank += rest;
      this.emit({ type: "MONEY_CHANGED", playerId: debtorId, delta: -rest, newCash: 0, reason });
      if (creditorId) this.change(creditorId, rest, "bankruptcy_in", false);
    }
    this.bankrupt(debtorId, creditorId);
    return { paid: rest, bankrupt: true };
  }

  bankrupt(id: string, creditorId: string | null, reason?: "afk"): void {
    const p = this.player(id);
    p.bankrupt = true;
    p.inJail = false;
    p.jailTurns = 0;
    for (const [k, v] of Object.entries(this.g.properties)) if (v.ownerId === id) delete this.g.properties[Number(k)];
    this.g.trades = cancelTradesOf(this.g.trades, id);
    if (this.g.auction) this.g.auction = auctionWithout(this.g.auction, id);
    // a debt owed to a player who is now out is owed to the bank instead (the removed player must never receive cash)
    if (this.g.pendingDebt && this.g.pendingDebt.creditorId === id) this.g.pendingDebt = { ...this.g.pendingDebt, creditorId: null };
    if (this.g.currentPlayerId === id) {
      this.g.pendingDecision = null;
      this.g.pendingDebt = null;
      this.g.debtThen = null;
    }
    this.emit(reason ? { type: "BANKRUPT", playerId: id, creditorId, reason } : { type: "BANKRUPT", playerId: id, creditorId });
  }

  /** Ends the game when one active player remains. Returns true when the game is over. */
  checkGameOver(): boolean {
    if (this.g.phase === "gameOver") return true;
    const active = this.activePlayers();
    if (active.length > 1) return false;
    const winner = active[0]!;
    this.g.phase = "gameOver";
    this.g.winnerPlayerId = winner.id;
    this.g.pendingDecision = null;
    this.g.pendingDebt = null;
    this.g.debtThen = null;
    this.g.auction = null;
    this.emit({ type: "GAME_OVER", winnerPlayerId: winner.id });
    return true;
  }

  startTurn(id: string): void {
    const p = this.player(id);
    this.g.currentPlayerId = id;
    this.g.turnNumber += 1;
    this.g.pendingDecision = null;
    this.g.phase = p.inJail ? "awaitingJailChoice" : "awaitingRoll";
    this.emit({ type: "TURN_STARTED", playerId: id, turnNumber: this.g.turnNumber, phase: this.g.phase });
  }

  /** Finishes the current turn and starts the next active player's. */
  endTurn(): void {
    if (this.checkGameOver()) return;
    const cur = this.g.currentPlayerId!;
    this.emit({ type: "TURN_ENDED", playerId: cur });
    const order = this.g.players;
    const from = order.findIndex((p) => p.id === cur);
    for (let i = 1; i <= order.length; i++) {
      const next = order[(from + i) % order.length]!;
      if (!next.bankrupt) return this.startTurn(next.id);
    }
  }
}

/* ---------------------------------------------------------------- mortgage helpers */

/** Tiles the player could mortgage right now: owned, not mortgaged, no buildings on the tile or anywhere in its group. */
export function mortgageableTiles(g: GameState, ownerId: string): number[] {
  const out: number[] = [];
  for (const [k, prop] of Object.entries(g.properties)) {
    const i = Number(k);
    if (prop.ownerId !== ownerId || prop.mortgaged || prop.level > 0) continue;
    const tile = tileAt(i);
    if (tile.kind === "property" && (GROUPS[tile.group!] ?? []).some((j) => (g.properties[j]?.level ?? 0) > 0)) continue;
    out.push(i);
  }
  return out;
}

function mortgageableValue(g: GameState, ownerId: string): number {
  return mortgageableTiles(g, ownerId).reduce((sum, i) => sum + mortgageValue(tileAt(i).price!), 0);
}

/* ---------------------------------------------------------------- rent and landing */

function drawCard(s: Step, deck: DeckName): { cardId: string; amount: number } {
  const order = s.g.decks[deck];
  const cardId = order[s.g.deckPos[deck] % order.length]!;
  s.g.deckPos[deck] += 1;
  return { cardId, amount: CARD_AMOUNT[cardId]! };
}

function ownsWholeGroup(g: GameState, ownerId: string, group: number): boolean {
  return (GROUPS[group] ?? []).every((i) => g.properties[i]?.ownerId === ownerId);
}

function rentFor(s: Step, tileIndex: number, ownerId: string): number {
  const tile = tileAt(tileIndex);
  const prop = s.g.properties[tileIndex]!;
  if (tile.kind === "property") {
    const rent = propertyRent(tile.price!, prop.level);
    // Doubled only for an unbuilt, unmortgaged property whose owner holds the whole country.
    const doubled = s.g.rules.doubleRentSets && prop.level === 0 && !prop.mortgaged && ownsWholeGroup(s.g, ownerId, tile.group!);
    return doubled ? rent * 2 : rent;
  }
  const ownedOf = (list: number[]) => list.filter((i) => s.g.properties[i]?.ownerId === ownerId).length; // mortgaged tiles still count
  if (tile.kind === "harbor") return harborRent(ownedOf(HARBOR_TILES));
  return utilityRent(s.g.lastRoll!.total, ownedOf(UTILITY_TILES));
}

/** Resolves the tile the current player just landed on. */
function resolveLanding(s: Step, playerId: string): void {
  const p = s.player(playerId);
  const tileIndex = p.position;
  const tile = tileAt(tileIndex);

  if (tile.kind === "property" || tile.kind === "harbor" || tile.kind === "utility") {
    const prop = s.g.properties[tileIndex];
    if (!prop) {
      const pending = { kind: "buy" as const, tileIndex, price: tile.price! };
      s.emit({ type: "LANDED", playerId, tileIndex, pending });
      s.g.pendingDecision = pending;
      s.g.phase = "awaitingDecision";
      return;
    }
    s.emit({ type: "LANDED", playerId, tileIndex, pending: null });
    if (prop.ownerId !== playerId) {
      const owner = s.player(prop.ownerId);
      if (prop.mortgaged) {
        s.emit({ type: "RENT_WAIVED", fromId: playerId, toId: prop.ownerId, tileIndex, reason: "mortgaged" });
      } else if (s.g.rules.noRentInDetention && owner.inJail) {
        s.emit({ type: "RENT_WAIVED", fromId: playerId, toId: prop.ownerId, tileIndex, reason: "owner_in_detention" });
      } else {
        const rent = rentFor(s, tileIndex, prop.ownerId);
        const rentEvent: GameEvent = { type: "RENT_PAID", fromId: playerId, toId: prop.ownerId, tileIndex, amount: rent };
        const r = s.charge(playerId, prop.ownerId, rent, "rent_out", { after: "endTurn", event: rentEvent });
        if (r.pending) return;
        s.emit({ ...rentEvent, amount: r.paid });
      }
    }
    return s.endTurn();
  }

  s.emit({ type: "LANDED", playerId, tileIndex, pending: null });
  if (tile.kind === "tax") {
    const event: GameEvent = { type: "TAX_PAID", playerId, tileIndex, amount: tile.amount! };
    const r = s.charge(playerId, null, tile.amount!, "tax", { after: "endTurn", event });
    if (r.pending) return;
    s.emit({ ...event, amount: r.paid });
  } else if (tile.kind === "fortune" || tile.kind === "vault") {
    const { cardId, amount } = drawCard(s, tile.kind);
    s.emit({ type: "CARD_DRAWN", playerId, deck: tile.kind, cardId, amount });
    if (amount >= 0) s.change(playerId, amount, "card", true);
    else if (s.charge(playerId, null, -amount, "card", { after: "endTurn" }).pending) return;
  } else if (tile.kind === "oasis") {
    // Landing (not passing) on the Oasis pays the whole jackpot, when the rule is on and the pool is not empty.
    if (s.g.rules.oasisJackpot && s.g.oasisPool > 0) {
      const pool = s.g.oasisPool;
      s.g.oasisPool = 0;
      p.cash += pool;
      s.emit({ type: "OASIS_COLLECTED", playerId, amount: pool });
      s.emit({ type: "MONEY_CHANGED", playerId, delta: pool, newCash: p.cash, reason: "oasis" });
      s.emit({ type: "OASIS_POOL_CHANGED", pool: 0, delta: -pool });
    }
  } else if (tile.kind === "goToDetention") {
    p.position = RULES.jailTileIndex;
    p.inJail = true;
    p.jailTurns = 0;
    s.emit({ type: "SENT_TO_JAIL", playerId, from: tileIndex });
  }
  s.endTurn();
}

function requireCurrent(s: Step, playerId: string): void {
  if (s.g.phase === "gameOver") throw new Fail("WRONG_PHASE");
  if (s.g.currentPlayerId !== playerId) throw new Fail("NOT_YOUR_TURN");
}

function doRoll(s: Step, playerId: string): void {
  requireCurrent(s, playerId);
  if (s.g.phase !== "awaitingRoll") throw new Fail("WRONG_PHASE");
  const rng = new Rng(s.g.rng);
  const values: [number, number] = s.ctx.dice ? s.ctx.dice() : [1 + rng.int(6), 1 + rng.int(6)];
  s.g.rng = rng.state;
  if (values.some((v) => !Number.isInteger(v) || v < 1 || v > 6)) throw new Fail("WRONG_PHASE");
  const total = values[0] + values[1];
  s.g.lastRoll = { values, total };
  s.emit({ type: "DICE_ROLLED", playerId, values, total });

  const p = s.player(playerId);
  const from = p.position;
  const path: number[] = [];
  for (let i = 1; i <= total; i++) path.push((from + i) % RULES.boardSize);
  const to = path[path.length - 1]!;
  p.position = to;
  s.emit({ type: "MOVED", playerId, from, to, path });
  if (from + total >= RULES.boardSize) {
    s.emit({ type: "PASSED_START", playerId });
    s.change(playerId, RULES.passStartSalary, "start", true);
  }
  resolveLanding(s, playerId);
}

function doBuy(s: Step, playerId: string): void {
  requireCurrent(s, playerId);
  const pending = s.g.pendingDecision;
  if (s.g.phase !== "awaitingDecision" || !pending) throw new Fail("WRONG_PHASE");
  if (s.player(playerId).cash < pending.price) throw new Fail("INSUFFICIENT_FUNDS");
  s.change(playerId, -pending.price, "buy", true);
  s.g.properties[pending.tileIndex] = { ownerId: playerId, level: 0, mortgaged: false };
  s.g.pendingDecision = null;
  s.emit({ type: "PROPERTY_BOUGHT", playerId, tileIndex: pending.tileIndex, price: pending.price });
  s.endTurn();
}

function doSkip(s: Step, playerId: string): void {
  requireCurrent(s, playerId);
  const pending = s.g.pendingDecision;
  if (s.g.phase !== "awaitingDecision" || !pending) throw new Fail("WRONG_PHASE");
  s.g.pendingDecision = null;
  s.emit({ type: "PROPERTY_SKIPPED", playerId, tileIndex: pending.tileIndex });
  if (s.g.rules.auctions) startAuction(s, pending.tileIndex);
  else s.endTurn();
}

/* ---------------------------------------------------------------- auctions */

function startAuction(s: Step, tileIndex: number): void {
  const now = s.now();
  // Players who cannot even make the minimum bid are out from the start.
  const withdrawnIds = s.activePlayers().filter((p) => p.cash < RULES.auctionMinBid).map((p) => p.id);
  s.g.phase = "auction";
  s.g.auction = { tileIndex, currentBid: 0, highestBidderId: null, withdrawnIds, endsAt: now + RULES.auctionFirstWindowMs, serverNow: now };
  s.emit({ type: "AUCTION_STARTED", auction: { ...s.g.auction, withdrawnIds: [...withdrawnIds] } });
  maybeEndAuction(s);
}

/** Ends the auction early when nobody except the leader can still outbid. Returns true when it ended. */
function maybeEndAuction(s: Step): boolean {
  const a = s.g.auction;
  if (!a) return true;
  const need = Math.max(RULES.auctionMinBid, a.currentBid + RULES.auctionBidStep);
  const canOutbid = s.activePlayers().filter((p) => !a.withdrawnIds.includes(p.id) && p.id !== a.highestBidderId && p.cash >= need);
  if (canOutbid.length > 0) return false;
  settleAuction(s);
  return true;
}

/** The highest bidder buys at the bid; with no (valid) bid the tile stays unowned. Then the turn passes on. */
function settleAuction(s: Step): void {
  const a = s.g.auction!;
  s.g.auction = null;
  const winner = a.highestBidderId ? s.g.players.find((p) => p.id === a.highestBidderId && !p.bankrupt) : undefined;
  if (winner && winner.cash >= a.currentBid && a.currentBid > 0) {
    s.change(winner.id, -a.currentBid, "auction", true);
    s.g.properties[a.tileIndex] = { ownerId: winner.id, level: 0, mortgaged: false };
    s.emit({ type: "AUCTION_ENDED", tileIndex: a.tileIndex, winnerId: winner.id, price: a.currentBid });
  } else {
    s.emit({ type: "AUCTION_ENDED", tileIndex: a.tileIndex, winnerId: null, price: 0 });
  }
  s.endTurn();
}

function requireBidder(s: Step, playerId: string) {
  if (s.g.phase !== "auction" || !s.g.auction) throw new Fail("WRONG_PHASE");
  const p = s.player(playerId);
  if (p.bankrupt) throw new Fail("PLAYER_NOT_IN_GAME");
  if (s.g.auction.withdrawnIds.includes(playerId)) throw new Fail("AUCTION_WITHDRAWN");
  return { p, a: s.g.auction };
}

function doBid(s: Step, playerId: string, amount: number): void {
  const { p, a } = requireBidder(s, playerId);
  if (!Number.isInteger(amount) || amount < Math.max(RULES.auctionMinBid, a.currentBid + RULES.auctionBidStep) || a.highestBidderId === playerId) throw new Fail("AUCTION_INVALID_BID");
  if (amount > p.cash) throw new Fail("INSUFFICIENT_FUNDS");
  const now = s.now();
  a.currentBid = amount;
  a.highestBidderId = playerId;
  a.endsAt = now + RULES.auctionBidWindowMs;
  a.serverNow = now;
  s.emit({ type: "AUCTION_BID", playerId, amount, endsAt: a.endsAt, serverNow: now });
  maybeEndAuction(s);
}

function doWithdraw(s: Step, playerId: string): void {
  const { a } = requireBidder(s, playerId);
  if (a.highestBidderId === playerId) throw new Fail("AUCTION_INVALID_BID"); // the leader cannot walk away from their bid
  a.withdrawnIds.push(playerId);
  s.emit({ type: "AUCTION_WITHDRAWN", playerId });
  maybeEndAuction(s);
}

/** Server-only: the auction timer ran out. */
function doAuctionTimeout(s: Step): void {
  const a = s.g.auction;
  if (s.g.phase !== "auction" || !a) throw new Fail("WRONG_PHASE");
  if (s.now() < a.endsAt) throw new Fail("WRONG_PHASE");
  settleAuction(s);
}

/* ---------------------------------------------------------------- detention */

function doJailPay(s: Step, playerId: string): void {
  requireCurrent(s, playerId);
  if (s.g.phase !== "awaitingJailChoice") throw new Fail("WRONG_PHASE");
  const p = s.player(playerId);
  const forced = p.jailTurns >= RULES.maxJailTurns;
  if (p.cash < RULES.jailFine) {
    if (!forced) throw new Fail("INSUFFICIENT_FUNDS");
    // A forced fine the player cannot pay: a debt phase when mortgaging can cover it, else bankrupt to the bank.
    const freed: GameEvent = { type: "JAIL_PAID", playerId, amount: RULES.jailFine };
    const r = s.charge(playerId, null, RULES.jailFine, "jail_fine", { after: "jailFreed", event: freed });
    if (r.pending) return;
    return s.endTurn();
  }
  s.change(playerId, -RULES.jailFine, "jail_fine", true);
  p.inJail = false;
  p.jailTurns = 0;
  s.g.phase = "awaitingRoll";
  s.emit({ type: "JAIL_PAID", playerId, amount: RULES.jailFine });
}

function doJailStay(s: Step, playerId: string): void {
  requireCurrent(s, playerId);
  if (s.g.phase !== "awaitingJailChoice") throw new Fail("WRONG_PHASE");
  const p = s.player(playerId);
  if (p.jailTurns >= RULES.maxJailTurns) throw new Fail("MUST_PAY_TO_LEAVE");
  p.jailTurns += 1;
  s.emit({ type: "JAIL_STAYED", playerId, jailTurns: p.jailTurns });
  s.endTurn();
}

/* ---------------------------------------------------------------- building */

function doBuild(s: Step, playerId: string, tileIndex: number, kind: BuildKind): void {
  requireCurrent(s, playerId);
  if (s.g.phase !== "awaitingRoll" && s.g.phase !== "awaitingDecision" && s.g.phase !== "awaitingJailChoice") throw new Fail("WRONG_PHASE");
  const tile = Number.isInteger(tileIndex) && tileIndex >= 0 && tileIndex < RULES.boardSize ? tileAt(tileIndex) : null;
  if (!tile) throw new Fail("INVALID_TILE");
  const prop = s.g.properties[tileIndex];
  if (tile.kind !== "property" || !prop || prop.ownerId !== playerId) throw new Fail("NOT_OWNER");
  const group = GROUPS[tile.group!]!;
  if (!group.every((i) => s.g.properties[i]?.ownerId === playerId)) throw new Fail("SET_INCOMPLETE");
  if (group.some((i) => s.g.properties[i]?.mortgaged)) throw new Fail("GROUP_MORTGAGED"); // one mortgaged tile blocks the whole group
  const levels = group.map((i) => s.g.properties[i]!.level);

  let cost: number;
  if (kind === "house") {
    if (prop.level >= RULES.maxHouses) throw new Fail("MAX_LEVEL");
    if (s.g.rules.evenBuild && prop.level > Math.min(...levels)) throw new Fail("UNEVEN_BUILD");
    cost = RULES.houseCost;
  } else {
    if (prop.level >= 5) throw new Fail("MAX_LEVEL");
    if (RULES.hotelRequiresFourHouses && prop.level < RULES.maxHouses) throw new Fail("HOTEL_NEEDS_4_HOUSES");
    if (s.g.rules.evenBuild && Math.min(...levels) < RULES.maxHouses) throw new Fail("UNEVEN_BUILD");
    cost = RULES.hotelCost;
  }
  if (s.player(playerId).cash < cost) throw new Fail("INSUFFICIENT_FUNDS");
  s.change(playerId, -cost, "build", true);
  prop.level += 1;
  s.emit({ type: "BUILT", playerId, tileIndex, level: prop.level, kind, cost });
}

/* ---------------------------------------------------------------- mortgage and debts */

function requireMortgagePhase(s: Step, playerId: string): void {
  if (!s.g.rules.mortgage) throw new Fail("MORTGAGE_DISABLED");
  requireCurrent(s, playerId);
  const ph = s.g.phase;
  if (ph !== "awaitingRoll" && ph !== "awaitingDecision" && ph !== "awaitingJailChoice" && ph !== "raisingFunds") throw new Fail("WRONG_PHASE");
}

function ownedBuyable(s: Step, playerId: string, tileIndex: number) {
  if (!Number.isInteger(tileIndex) || tileIndex < 0 || tileIndex >= RULES.boardSize) throw new Fail("INVALID_TILE");
  const kind = tileAt(tileIndex).kind;
  if (kind !== "property" && kind !== "harbor" && kind !== "utility") throw new Fail("INVALID_TILE");
  const prop = s.g.properties[tileIndex];
  if (!prop || prop.ownerId !== playerId) throw new Fail("NOT_OWNER");
  return prop;
}

function doMortgage(s: Step, playerId: string, tileIndex: number): void {
  requireMortgagePhase(s, playerId);
  const prop = ownedBuyable(s, playerId, tileIndex);
  if (!mortgageableTiles(s.g, playerId).includes(tileIndex) || prop.mortgaged) throw new Fail("NOT_MORTGAGEABLE");
  const amount = mortgageValue(tileAt(tileIndex).price!);
  s.change(playerId, amount, "mortgage", true);
  prop.mortgaged = true;
  s.emit({ type: "PROPERTY_MORTGAGED", playerId, tileIndex, amount });
}

function doUnmortgage(s: Step, playerId: string, tileIndex: number): void {
  requireMortgagePhase(s, playerId);
  const prop = ownedBuyable(s, playerId, tileIndex);
  if (!prop.mortgaged) throw new Fail("NOT_MORTGAGED");
  const cost = unmortgageCost(tileAt(tileIndex).price!);
  if (s.player(playerId).cash < cost) throw new Fail("INSUFFICIENT_FUNDS");
  s.change(playerId, -cost, "unmortgage", true);
  prop.mortgaged = false;
  s.emit({ type: "PROPERTY_UNMORTGAGED", playerId, tileIndex, cost });
}

const moneyReasonOf = (reason: PendingDebt["reason"]): MoneyReason => (reason === "rent" ? "rent_out" : reason);

/** The debtor pays the debt in full; the interrupted turn then carries on. */
function doPayDebt(s: Step, playerId: string): void {
  requireCurrent(s, playerId);
  const debt = s.g.pendingDebt;
  const then = s.g.debtThen;
  if (s.g.phase !== "raisingFunds" || !debt || !then) throw new Fail("NOT_IN_DEBT");
  const p = s.player(playerId);
  if (p.cash < debt.amount) throw new Fail("INSUFFICIENT_FUNDS");
  s.change(playerId, -debt.amount, moneyReasonOf(debt.reason), debt.creditorId === null);
  if (debt.creditorId) s.change(debt.creditorId, debt.amount, "rent_in", false);
  s.g.pendingDebt = null;
  s.g.debtThen = null;
  s.emit({ type: "DEBT_PAID", playerId, amount: debt.amount });
  if (then.event) s.emit(then.event);
  if (then.after === "jailFreed") {
    p.inJail = false;
    p.jailTurns = 0;
    s.g.phase = "awaitingRoll";
  } else s.endTurn();
}

/** The debtor gives up: everything left goes to the creditor (or the bank) and they are out. */
function doDeclareBankruptcy(s: Step, playerId: string): void {
  requireCurrent(s, playerId);
  const debt = s.g.pendingDebt;
  const then = s.g.debtThen;
  if (s.g.phase !== "raisingFunds" || !debt || !then) throw new Fail("NOT_IN_DEBT");
  const { paid } = s.payAllAndGoBankrupt(playerId, debt.creditorId, moneyReasonOf(debt.reason));
  if (then.event && (then.event.type === "RENT_PAID" || then.event.type === "TAX_PAID")) s.emit({ ...then.event, amount: paid });
  s.endTurn();
}

function doResign(s: Step, playerId: string): void {
  if (s.g.phase === "gameOver") throw new Fail("WRONG_PHASE");
  const p = s.player(playerId);
  if (p.bankrupt) throw new Fail("PLAYER_NOT_IN_GAME");
  const wasCurrent = s.g.currentPlayerId === playerId;
  const rest = p.cash;
  s.change(playerId, -rest, "bankruptcy_in", true); // whatever is left goes to the bank (never the Oasis pool)
  s.bankrupt(playerId, null);
  if (s.checkGameOver()) return;
  if (s.g.auction) {
    // The auction goes on without them; whoever ends it passes the turn.
    maybeEndAuction(s);
    return;
  }
  if (wasCurrent) s.endTurn();
}

/* ---------------------------------------------------------------- trading */

const MAX_PENDING_TRADES_PER_PLAYER = 5;
const MAX_TRADE_CASH = 1_000_000;

function cleanSide(side: TradeSide): TradeSide {
  if (!side || !Array.isArray(side.tiles) || !Number.isInteger(side.cash) || side.cash < 0 || side.cash > MAX_TRADE_CASH) throw new Fail("TRADE_INVALID");
  const tiles = [...new Set(side.tiles)].sort((a, b) => a - b);
  if (tiles.length !== side.tiles.length || tiles.length > RULES.boardSize) throw new Fail("TRADE_INVALID");
  return { tiles, cash: side.cash };
}

/** Every tile must be a buyable tile, owned by `ownerId`, without houses or a hotel, and not mortgaged. */
function checkTiles(s: Step, ownerId: string, tiles: number[]): void {
  for (const i of tiles) {
    if (!Number.isInteger(i) || i < 0 || i >= RULES.boardSize) throw new Fail("INVALID_TILE");
    const kind = tileAt(i).kind;
    if (kind !== "property" && kind !== "harbor" && kind !== "utility") throw new Fail("INVALID_TILE");
    const prop = s.g.properties[i];
    if (!prop || prop.ownerId !== ownerId) throw new Fail("NOT_OWNER");
    if (prop.level > 0) throw new Fail("TRADE_HAS_BUILDINGS");
    if (prop.mortgaged) throw new Fail("TRADE_MORTGAGED");
  }
}

function findTrade(s: Step, tradeId: string): TradeOffer {
  const trade = s.g.trades.find((t) => t.id === tradeId);
  if (!trade) throw new Fail("TRADE_NOT_FOUND");
  if (trade.status !== "pending") throw new Fail("TRADE_NOT_PENDING");
  return trade;
}

/** Trades are paused while an auction or a debt is being settled. */
function requireTradePhase(s: Step): void {
  if (s.g.phase === "gameOver" || s.g.phase === "auction" || s.g.phase === "raisingFunds") throw new Fail("WRONG_PHASE");
}

function doProposeTrade(s: Step, playerId: string, toId: string, giveRaw: TradeSide, getRaw: TradeSide): void {
  requireTradePhase(s);
  const from = s.player(playerId);
  const to = s.g.players.find((p) => p.id === toId);
  if (!to) throw new Fail("PLAYER_NOT_IN_GAME");
  if (from.bankrupt || to.bankrupt || from.id === to.id) throw new Fail("TRADE_INVALID");
  const give = cleanSide(giveRaw);
  const get = cleanSide(getRaw);
  if (give.tiles.length + get.tiles.length === 0 && give.cash === 0 && get.cash === 0) throw new Fail("TRADE_INVALID");
  if (s.g.trades.filter((t) => t.status === "pending" && t.fromId === playerId).length >= MAX_PENDING_TRADES_PER_PLAYER) throw new Fail("TOO_MANY_TRADES");
  checkTiles(s, from.id, give.tiles);
  checkTiles(s, to.id, get.tiles);
  if (give.cash > from.cash) throw new Fail("INSUFFICIENT_FUNDS");
  const trade: TradeOffer = { id: `T${++s.g.tradeSeq}`, fromId: from.id, toId: to.id, give, get, status: "pending" };
  s.g.trades = trimTrades([...s.g.trades, trade]);
  s.emit({ type: "TRADE_PROPOSED", trade: { ...trade, give: { ...give, tiles: [...give.tiles] }, get: { ...get, tiles: [...get.tiles] } } });
}

function doAcceptTrade(s: Step, playerId: string, tradeId: string): void {
  requireTradePhase(s);
  const trade = findTrade(s, tradeId);
  if (trade.toId !== playerId) throw new Fail("NOT_TRADE_PARTY");
  const from = s.player(trade.fromId);
  const to = s.player(trade.toId);
  if (from.bankrupt || to.bankrupt) throw new Fail("TRADE_INVALID");
  // The world may have changed since the offer was made: check everything again.
  checkTiles(s, from.id, trade.give.tiles);
  checkTiles(s, to.id, trade.get.tiles);
  if (from.cash < trade.give.cash || to.cash < trade.get.cash) throw new Fail("INSUFFICIENT_FUNDS");

  for (const i of trade.give.tiles) {
    s.g.properties[i]!.ownerId = to.id;
    s.emit({ type: "PROPERTY_TRANSFERRED", tileIndex: i, fromId: from.id, toId: to.id });
  }
  for (const i of trade.get.tiles) {
    s.g.properties[i]!.ownerId = from.id;
    s.emit({ type: "PROPERTY_TRANSFERRED", tileIndex: i, fromId: to.id, toId: from.id });
  }
  const net = trade.get.cash - trade.give.cash; // positive: the proposer receives money
  s.change(from.id, net, "trade", false);
  s.change(to.id, -net, "trade", false);
  s.g.trades = setTradeStatus(s.g.trades, trade.id, "accepted");
  s.emit({ type: "TRADE_ACCEPTED", tradeId: trade.id });
}

function doRejectTrade(s: Step, playerId: string, tradeId: string): void {
  const trade = findTrade(s, tradeId);
  if (trade.toId !== playerId) throw new Fail("NOT_TRADE_PARTY");
  s.g.trades = setTradeStatus(s.g.trades, trade.id, "rejected");
  s.emit({ type: "TRADE_REJECTED", tradeId: trade.id });
}

function doCancelTrade(s: Step, playerId: string, tradeId: string): void {
  const trade = findTrade(s, tradeId);
  if (trade.fromId !== playerId) throw new Fail("NOT_TRADE_PARTY");
  s.g.trades = setTradeStatus(s.g.trades, trade.id, "cancelled");
  s.emit({ type: "TRADE_CANCELLED", tradeId: trade.id });
}

/**
 * Server-only: a player was removed for inactivity. ALL their properties become unowned and clean (buildings and mortgages
 * cleared), their cash goes back to the bank (one MONEY_CHANGED, reason afk_removed), a pending debt is cancelled and the
 * creditor gets NOTHING, and the Oasis pool is untouched. (A normal bankruptcy keeps its own rules.)
 */
function doAfkKick(s: Step, targetId: string): void {
  if (s.g.phase === "gameOver") throw new Fail("WRONG_PHASE");
  const p = s.player(targetId);
  if (p.bankrupt) throw new Fail("PLAYER_NOT_IN_GAME");
  const wasCurrent = s.g.currentPlayerId === targetId;
  const tiles = Object.entries(s.g.properties).filter(([, v]) => v.ownerId === targetId).map(([k]) => Number(k)).sort((a, b) => a - b);
  if (tiles.length) {
    for (const i of tiles) delete s.g.properties[i];
    s.emit({ type: "PROPERTY_RELEASED", playerId: targetId, tiles });
  }
  if (p.cash > 0) {
    const rest = p.cash;
    p.cash = 0;
    s.g.bank += rest;
    s.emit({ type: "MONEY_CHANGED", playerId: targetId, delta: -rest, newCash: 0, reason: "afk_removed" });
  }
  s.bankrupt(targetId, null, "afk"); // clears a pending debt (nobody is paid), cancels trades, leaves any auction
  if (s.checkGameOver()) return;
  if (s.g.auction) {
    maybeEndAuction(s);
    return;
  }
  if (wasCurrent) s.endTurn();
}

/** Server-only: every human is out, so the active player with the highest net worth wins (cash + half the price of owned tiles). */
function doEndGame(s: Step): void {
  if (s.g.phase === "gameOver") throw new Fail("WRONG_PHASE");
  const snap = s.g as unknown as Parameters<typeof netWorth>[0];
  const winner = s.activePlayers().sort((a, b) => netWorth(snap, b.id) - netWorth(snap, a.id))[0];
  if (!winner) throw new Fail("WRONG_PHASE");
  s.g.phase = "gameOver";
  s.g.winnerPlayerId = winner.id;
  s.g.pendingDecision = null;
  s.g.pendingDebt = null;
  s.g.debtThen = null;
  s.g.auction = null;
  s.emit({ type: "GAME_OVER", winnerPlayerId: winner.id });
}

/** The id the server uses for system actions (auction timeout). Clients can never send it. */
export const SYSTEM_PLAYER = "system";

/** Applies one action. Never throws: failures come back as { ok: false, error }. The input state is not modified. */
export function applyAction(state: GameState, action: Action, ctx: EngineContext = {}): ActionResult {
  if (state.processed.includes(action.actionId)) return { ok: false, error: "DUPLICATE_ACTION" };
  const g = cloneState(state);
  const s = new Step(g, ctx);
  try {
    if (action.type === "auctionTimeout" || action.type === "endGame" || action.type === "afkKick") {
      if (action.playerId !== SYSTEM_PLAYER) throw new Fail("NOT_YOUR_TURN");
    } else if (!g.players.some((p) => p.id === action.playerId)) throw new Fail("PLAYER_NOT_IN_GAME");
    switch (action.type) {
      case "roll":
        doRoll(s, action.playerId);
        break;
      case "buy":
        doBuy(s, action.playerId);
        break;
      case "skip":
        doSkip(s, action.playerId);
        break;
      case "jailPay":
        doJailPay(s, action.playerId);
        break;
      case "jailStay":
        doJailStay(s, action.playerId);
        break;
      case "build":
        doBuild(s, action.playerId, action.tileIndex, action.kind);
        break;
      case "resign":
        doResign(s, action.playerId);
        break;
      case "bid":
        doBid(s, action.playerId, action.amount);
        break;
      case "withdraw":
        doWithdraw(s, action.playerId);
        break;
      case "auctionTimeout":
        doAuctionTimeout(s);
        break;
      case "endGame":
        doEndGame(s);
        break;
      case "afkKick":
        doAfkKick(s, action.targetId);
        break;
      case "mortgage":
        doMortgage(s, action.playerId, action.tileIndex);
        break;
      case "unmortgage":
        doUnmortgage(s, action.playerId, action.tileIndex);
        break;
      case "payDebt":
        doPayDebt(s, action.playerId);
        break;
      case "declareBankruptcy":
        doDeclareBankruptcy(s, action.playerId);
        break;
      case "proposeTrade":
        doProposeTrade(s, action.playerId, action.toId, action.give, action.get);
        break;
      case "acceptTrade":
        doAcceptTrade(s, action.playerId, action.tradeId);
        break;
      case "rejectTrade":
        doRejectTrade(s, action.playerId, action.tradeId);
        break;
      case "cancelTrade":
        doCancelTrade(s, action.playerId, action.tradeId);
        break;
      default:
        throw new Fail("WRONG_PHASE");
    }
  } catch (e) {
    if (e instanceof Fail) return { ok: false, error: e.code };
    throw e;
  }
  g.seq += 1;
  g.processed.push(action.actionId);
  if (g.processed.length > PROCESSED_KEEP) g.processed.splice(0, g.processed.length - PROCESSED_KEEP);
  return { ok: true, state: g, events: s.events };
}
