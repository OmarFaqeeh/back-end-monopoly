// The bot brain: a PURE function decide(input) that returns at most one action for a bot, from the PUBLIC snapshot only
// (never the seed or the deck order). The server plays the action through the normal action pipeline, exactly like a human.
import { BOT_MAX_COUNTER_ROUNDS, BOT_REJECTED_DEAL_COOLDOWN_MS, BOT_TRADE_COOLDOWN_MS, BOT_TRADE_MIN_GAME_MS, PERSONALITIES, type PersonalityId } from "../../config/botPersonalities.js";
import type { AuctionState, BuildKind, GameSnapshot, TradeOffer, TradeSide } from "../../shared/events.js";
import { GROUPS, RULES, rentLevels, tileAt } from "../../shared/rent.js";
import { groupInfo, ownsFullSet, tileValue } from "./valuation.js";

/** An action without its ids (the controller adds actionId and playerId). */
export type BotAction =
  | { type: "roll" | "buy" | "skip" | "jailPay" | "jailStay" | "withdraw" | "payDebt" | "declareBankruptcy" }
  | { type: "bid"; amount: number }
  | { type: "build"; tileIndex: number; kind: BuildKind }
  | { type: "mortgage" | "unmortgage"; tileIndex: number }
  | { type: "proposeTrade"; toId: string; give: TradeSide; get: TradeSide }
  | { type: "acceptTrade" | "rejectTrade"; tradeId: string };

/** What a bot remembers between decisions (kept by the controller; the brain only reads it). */
export interface BotMemory {
  lastProposalAt: number;
  /** Deal signature -> time it was rejected (or proposed): not repeated for BOT_REJECTED_DEAL_COOLDOWN_MS. */
  dealCooldown: Map<string, number>;
  /** Human id -> counter-offers made in the current negotiation. */
  counterRounds: Map<string, number>;
  /** A counter-offer waiting to be sent right after the original was declined. */
  pendingCounter: { toId: string; give: TradeSide; get: TradeSide } | null;
}

export const newMemory = (): BotMemory => ({ lastProposalAt: -Infinity, dealCooldown: new Map(), counterRounds: new Map(), pendingCounter: null });

export interface DecideInput {
  snapshot: GameSnapshot;
  botId: string;
  personality: PersonalityId;
  rng: () => number;
  /** Clock (ms) used for trade timing. */
  now: number;
  gameStartedAt: number;
  mem: BotMemory;
  /** Ids of the human players (bots are careful about handing them a complete set). */
  humanIds: ReadonlySet<string>;
}

export const dealSignature = (give: TradeSide, get: TradeSide, otherId: string): string => `${otherId}|${give.tiles.join(",")}:${give.cash}|${get.tiles.join(",")}:${get.cash}`;

/* ---------------------------------------------------------------- legal moves (mirrors the engine) */

export function buildError(snap: GameSnapshot, playerId: string, tileIndex: number, kind: BuildKind): string | null {
  const tile = tileAt(tileIndex);
  const prop = snap.properties[tileIndex];
  if (tile.kind !== "property" || !prop || prop.ownerId !== playerId) return "NOT_OWNER";
  const group = GROUPS[tile.group!] ?? [];
  if (!group.every((i) => snap.properties[i]?.ownerId === playerId)) return "SET_INCOMPLETE";
  if (group.some((i) => snap.properties[i]?.mortgaged)) return "GROUP_MORTGAGED";
  const levels = group.map((i) => snap.properties[i]!.level);
  const cash = snap.players.find((p) => p.id === playerId)?.cash ?? 0;
  if (kind === "house") {
    if (prop.level >= RULES.maxHouses) return "MAX_LEVEL";
    if (snap.rules.evenBuild && prop.level > Math.min(...levels)) return "UNEVEN_BUILD";
    return cash < RULES.houseCost ? "INSUFFICIENT_FUNDS" : null;
  }
  if (prop.level >= 5) return "MAX_LEVEL";
  if (prop.level < RULES.maxHouses) return "HOTEL_NEEDS_4_HOUSES";
  if (snap.rules.evenBuild && Math.min(...levels) < RULES.maxHouses) return "UNEVEN_BUILD";
  return cash < RULES.hotelCost ? "INSUFFICIENT_FUNDS" : null;
}

/** Tiles the player could mortgage (owned, not mortgaged, no buildings on the tile or its country). */
export function mortgageable(snap: GameSnapshot, ownerId: string): number[] {
  const out: number[] = [];
  for (const [k, prop] of Object.entries(snap.properties)) {
    const i = Number(k);
    if (prop.ownerId !== ownerId || prop.mortgaged || prop.level > 0) continue;
    const tile = tileAt(i);
    if (tile.kind === "property" && (GROUPS[tile.group!] ?? []).some((j) => (snap.properties[j]?.level ?? 0) > 0)) continue;
    out.push(i);
  }
  return out;
}

const unmortgageCost = (price: number) => Math.ceil((price * 11) / 20);

/* ---------------------------------------------------------------- decisions */

function decideAuction(inp: DecideInput, a: AuctionState): BotAction | null {
  const { snapshot, botId, rng } = inp;
  const P = PERSONALITIES[inp.personality];
  const me = snapshot.players.find((p) => p.id === botId)!;
  if (a.withdrawnIds.includes(botId) || a.highestBidderId === botId) return null;
  const price = tileAt(a.tileIndex).price ?? 0;
  const { completes } = groupInfo(snapshot, botId, a.tileIndex);
  const ceiling = Math.floor((completes ? P.auctionSetFactor : P.auctionFactor) * price);
  const keep = inp.personality === "spender" ? 0 : completes ? Math.min(P.reserve, 50) : P.reserve;
  const maxBid = Math.min(ceiling, me.cash - keep);
  const need = Math.max(RULES.auctionMinBid, a.currentBid + RULES.auctionBidStep);
  if (need > maxBid || need > me.cash) return { type: "withdraw" };
  const amount = Math.min(maxBid, me.cash, need + RULES.auctionBidStep * Math.floor(rng() * 3));
  return { type: "bid", amount };
}

function decideDebt(inp: DecideInput): BotAction {
  const { snapshot, botId } = inp;
  const debt = snapshot.pendingDebt!;
  const me = snapshot.players.find((p) => p.id === botId)!;
  if (me.cash >= debt.amount) return { type: "payDebt" };
  // Mortgage the least valuable tile first.
  const tiles = mortgageable(snapshot, botId).sort((x, y) => tileValue(snapshot, x, botId) - tileValue(snapshot, y, botId) || x - y);
  return tiles.length ? { type: "mortgage", tileIndex: tiles[0]! } : { type: "declareBankruptcy" };
}

function wantsToBuy(inp: DecideInput, tileIndex: number, price: number): boolean {
  const { snapshot, botId, personality } = inp;
  const P = PERSONALITIES[personality];
  const cash = snapshot.players.find((p) => p.id === botId)!.cash;
  if (cash < price) return false;
  const left = cash - price;
  const { owned, completes } = groupInfo(snapshot, botId, tileIndex);
  const extends_ = owned > 0;
  switch (personality) {
    case "tycoon":
    case "spender":
      return true; // buys every affordable tile (the spender even when left with almost nothing)
    case "careful":
      return left >= P.reserve || ((extends_ || completes) && left >= 100);
    case "collector":
      return extends_ || completes ? left >= 50 : left >= P.reserve;
    case "balanced":
      return (tileValue(snapshot, tileIndex, botId) / Math.max(1, price) >= 1.15 && left >= P.reserve) || (completes && left >= 0);
  }
}

function wantsToPayJail(inp: DecideInput): boolean {
  const { snapshot, botId, personality } = inp;
  const me = snapshot.players.find((p) => p.id === botId)!;
  if (me.cash < RULES.jailFine) return false;
  if (me.jailTurns >= RULES.maxJailTurns) return true; // forced
  switch (personality) {
    case "tycoon":
      return snapshot.turnNumber < 40;
    case "careful": {
      const others = Object.values(snapshot.properties).filter((p) => p.ownerId !== botId).reduce((sum, p) => sum + p.level, 0);
      return others < 6; // stays put while the opponents' buildings make the board dangerous
    }
    case "spender":
      return true;
    case "collector":
      return ownsFullSet(snapshot, botId);
    case "balanced":
      return me.cash >= 300;
  }
}

function decideBuild(inp: DecideInput): BotAction | null {
  const { snapshot, botId, personality } = inp;
  const P = PERSONALITIES[personality];
  const cash = snapshot.players.find((p) => p.id === botId)!.cash;
  const mine = Object.entries(snapshot.properties).filter(([, v]) => v.ownerId === botId).map(([k]) => Number(k)).filter((i) => tileAt(i).kind === "property");
  const options: { tileIndex: number; kind: BuildKind; cost: number; gain: number }[] = [];
  for (const tileIndex of mine) {
    for (const kind of ["house", "hotel"] as const) {
      if (buildError(snapshot, botId, tileIndex, kind) !== null) continue;
      const level = snapshot.properties[tileIndex]!.level;
      const rent = rentLevels(tileAt(tileIndex).price!);
      options.push({ tileIndex, kind, cost: kind === "house" ? RULES.houseCost : RULES.hotelCost, gain: rent[Math.min(5, level + 1)]! - rent[level]! });
    }
  }
  options.sort((x, y) => snapshot.properties[x.tileIndex]!.level - snapshot.properties[y.tileIndex]!.level || x.tileIndex - y.tileIndex);
  for (const o of options) {
    const left = cash - o.cost;
    const ok = personality === "spender" ? left >= 0 : personality === "balanced" ? left >= P.buildReserve && o.gain / o.cost >= 0.12 : left >= P.buildReserve;
    if (ok) return { type: "build", tileIndex: o.tileIndex, kind: o.kind };
  }
  return null;
}

/* ---------------------------------------------------------------- trades */

interface TradeVerdict {
  verdict: "accept" | "reject" | "counter";
  counter?: { give: TradeSide; get: TradeSide };
}

/** After the trade, which country sets does `id` own that they did not own before? */
function setsAfter(snap: GameSnapshot, id: string, gets: number[], gives: number[]): boolean {
  const owns = (tile: number, after: boolean) => {
    const was = snap.properties[tile]?.ownerId === id;
    if (!after) return was;
    return gives.includes(tile) ? false : gets.includes(tile) ? true : was;
  };
  return Object.values(GROUPS).some((g) => g.every((i) => owns(i, true)) && !g.every((i) => owns(i, false)));
}

/** Judge an offer made TO the bot (the bot is trade.toId). Value received minus value given, plus a personality margin. */
export function evaluateTrade(inp: DecideInput, trade: TradeOffer): TradeVerdict {
  const { snapshot, botId, personality, mem, humanIds } = inp;
  const P = PERSONALITIES[personality];
  const otherId = trade.fromId;
  const receiveTiles = trade.give.tiles;
  const giveTiles = trade.get.tiles;
  const receive = receiveTiles.reduce((s, t) => s + tileValue(snapshot, t, botId), 0) + trade.give.cash;
  const give = giveTiles.reduce((s, t) => s + tileValue(snapshot, t, botId), 0) + trade.get.cash;
  const net = receive - give;
  const completes = setsAfter(snapshot, botId, receiveTiles, giveTiles);
  const margin = completes ? P.tradeSetMargin : P.tradeMargin;
  // Handing a HUMAN a complete set is refused unless the compensation is large.
  const helpsHuman = humanIds.has(otherId) && setsAfter(snapshot, otherId, giveTiles, receiveTiles);
  if (helpsHuman && net < 0.5 * Math.max(give, 1)) return { verdict: "reject" };
  if (net >= margin * give && (give > 0 || receive > 0)) return { verdict: "accept" };
  // Close but not enough: ask the other side for the difference (at most BOT_MAX_COUNTER_ROUNDS times per negotiation).
  const shortfall = Math.ceil((margin * give - net) / 10) * 10;
  const other = snapshot.players.find((p) => p.id === otherId);
  const rounds = mem.counterRounds.get(otherId) ?? 0;
  if (net >= -0.3 * Math.max(give, 1) && rounds < BOT_MAX_COUNTER_ROUNDS && other && shortfall > 0 && other.cash >= trade.give.cash + shortfall) {
    return { verdict: "counter", counter: { give: { tiles: [...giveTiles], cash: trade.get.cash }, get: { tiles: [...receiveTiles], cash: trade.give.cash + shortfall } } };
  }
  return { verdict: "reject" };
}

function decideTradeResponse(inp: DecideInput): BotAction | null {
  const { snapshot, botId, mem, now } = inp;
  if (mem.pendingCounter) {
    const c = mem.pendingCounter;
    const them = snapshot.players.find((p) => p.id === c.toId);
    const sig = dealSignature(c.give, c.get, c.toId);
    if (them && !them.bankrupt && now - (mem.dealCooldown.get(sig) ?? -Infinity) > BOT_REJECTED_DEAL_COOLDOWN_MS) return { type: "proposeTrade", toId: c.toId, give: c.give, get: c.get };
    return null;
  }
  const pending = snapshot.trades.find((t) => t.status === "pending" && t.toId === botId);
  if (!pending) return null;
  // A deal this bot already rejected is not accepted-by-surprise: the same rules apply every time, so repeat offers get the same answer.
  const v = evaluateTrade(inp, pending);
  if (v.verdict === "accept") return { type: "acceptTrade", tradeId: pending.id };
  return { type: "rejectTrade", tradeId: pending.id };
}

/** Looks for a deal that helps both sides: a tile that completes one of the bot's sets, bought at a fair price. */
export function findProposal(inp: DecideInput): BotAction | null {
  const { snapshot, botId, personality, mem, now, gameStartedAt, rng, humanIds } = inp;
  const P = PERSONALITIES[personality];
  if (now - gameStartedAt < BOT_TRADE_MIN_GAME_MS) return null;
  if (now - mem.lastProposalAt < BOT_TRADE_COOLDOWN_MS) return null;
  if (snapshot.phase === "auction" || snapshot.phase === "raisingFunds" || snapshot.phase === "gameOver") return null;
  if (rng() > P.proposalChance) return null;
  const me = snapshot.players.find((p) => p.id === botId)!;
  for (const target of snapshot.players) {
    if (target.bankrupt || !humanIds.has(target.id)) continue;
    if (snapshot.trades.some((t) => t.status === "pending" && (t.fromId === target.id || t.toId === target.id))) continue;
    for (const [k, prop] of Object.entries(snapshot.properties)) {
      const tile = Number(k);
      if (prop.ownerId !== target.id || prop.level > 0 || prop.mortgaged || tileAt(tile).kind !== "property") continue;
      const { completes, others } = groupInfo(snapshot, botId, tile);
      if (!completes || others.some((i) => snapshot.properties[i]?.mortgaged)) continue;
      const worthToMe = tileValue(snapshot, tile, botId);
      const worthToThem = tileValue(snapshot, tile, target.id);
      const offer = Math.ceil(Math.max(worthToThem * 1.1, worthToMe * 0.8) / 10) * 10;
      if (offer > worthToMe * 0.97 || offer > me.cash - P.reserve) continue; // not logical for the bot, or not affordable
      const give: TradeSide = { tiles: [], cash: offer };
      const get: TradeSide = { tiles: [tile], cash: 0 };
      if (now - (mem.dealCooldown.get(dealSignature(give, get, target.id)) ?? -Infinity) < BOT_REJECTED_DEAL_COOLDOWN_MS) continue;
      return { type: "proposeTrade", toId: target.id, give, get };
    }
  }
  return null;
}

/** At most one action for the bot, or null when it has nothing to do right now. */
export function decide(inp: DecideInput): BotAction | null {
  const { snapshot, botId } = inp;
  const me = snapshot.players.find((p) => p.id === botId);
  if (!me || me.bankrupt || snapshot.phase === "gameOver") return null;

  if (snapshot.phase === "auction" && snapshot.auction) return decideAuction(inp, snapshot.auction);
  const mine = snapshot.currentPlayerId === botId;
  if (snapshot.phase === "raisingFunds") return mine && snapshot.pendingDebt ? decideDebt(inp) : null;

  // Trade answers can come at any time (even when it is not the bot's turn).
  const answer = decideTradeResponse(inp);
  if (answer) return answer;

  if (mine) {
    const P = PERSONALITIES[inp.personality];
    if (snapshot.phase === "awaitingDecision" && snapshot.pendingDecision) {
      const { tileIndex, price } = snapshot.pendingDecision;
      return { type: wantsToBuy(inp, tileIndex, price) ? "buy" : "skip" };
    }
    if (snapshot.phase === "awaitingJailChoice") {
      if (me.jailTurns >= RULES.maxJailTurns) return { type: "jailPay" };
      return { type: wantsToPayJail(inp) ? "jailPay" : "jailStay" };
    }
    if (snapshot.phase === "awaitingRoll") {
      if (snapshot.rules.mortgage) {
        const lifted = Object.entries(snapshot.properties)
          .filter(([, v]) => v.ownerId === botId && v.mortgaged)
          .map(([k]) => Number(k))
          .filter((i) => me.cash >= unmortgageCost(tileAt(i).price!) + P.reserve + 300)
          .sort((x, y) => tileValue(snapshot, y, botId) - tileValue(snapshot, x, botId) || x - y);
        if (lifted.length) return { type: "unmortgage", tileIndex: lifted[0]! };
      }
      const build = decideBuild(inp);
      if (build) return build;
      return { type: "roll" };
    }
    return null;
  }
  return findProposal(inp);
}

/** The safe default the watchdog plays when the brain fails or stalls: roll, skip, stay, withdraw, decline. */
export function safeDefault(snap: GameSnapshot, botId: string): BotAction | null {
  const me = snap.players.find((p) => p.id === botId);
  if (!me || me.bankrupt) return null;
  if (snap.phase === "auction" && snap.auction) {
    return snap.auction.withdrawnIds.includes(botId) || snap.auction.highestBidderId === botId ? null : { type: "withdraw" };
  }
  const pending = snap.trades.find((t) => t.status === "pending" && t.toId === botId);
  if (pending && snap.phase !== "raisingFunds") return { type: "rejectTrade", tradeId: pending.id };
  if (snap.currentPlayerId !== botId) return null;
  switch (snap.phase) {
    case "awaitingRoll":
      return { type: "roll" };
    case "awaitingDecision":
      return { type: "skip" };
    case "awaitingJailChoice":
      return { type: me.jailTurns >= RULES.maxJailTurns ? "jailPay" : "jailStay" };
    case "raisingFunds":
      return snap.pendingDebt && me.cash >= snap.pendingDebt.amount ? { type: "payDebt" } : { type: "declareBankruptcy" };
    default:
      return null;
  }
}
