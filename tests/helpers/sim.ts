// Seeded game simulation with bot-like policies. Used by the simulation gate and the display-contract test.
// Games can use random combinations of ALL rule settings (auctions, mortgage, even build, double rent, Oasis, ...).
import { applyAction, mortgageableTiles } from "../../src/engine/actions.js";
import { Rng, seedToState } from "../../src/engine/rng.js";
import { checkInvariants, createGame, toSnapshot } from "../../src/engine/state.js";
import type { Action, GameEvent, GameState } from "../../src/engine/types.js";
import { applyBatch } from "../../src/shared/display.js";
import { BOARD, RULES } from "../../src/shared/rent.js";
import { STARTING_CASH_OPTIONS, type GameRules } from "../../src/shared/settings.js";

export type Policy = "random" | "smart";

type Draft = Omit<Action, "actionId" | "playerId">;

/** Candidate actions in priority order; the simulator plays the first one the engine accepts. */
function candidates(state: GameState, playerId: string, policy: Policy, rng: Rng): Draft[] {
  const me = state.players.find((p) => p.id === playerId)!;
  const owned = Object.entries(state.properties).filter(([, v]) => v.ownerId === playerId).map(([k]) => Number(k));
  const mine = owned.filter((i) => BOARD[i]!.kind === "property");
  const builds: Draft[] = mine.flatMap((tileIndex) => [
    { type: "build" as const, tileIndex, kind: "house" as const },
    { type: "build" as const, tileIndex, kind: "hotel" as const },
  ]);
  const mortgageTile = (): Draft[] => {
    if (!state.rules.mortgage || !owned.length) return [];
    const t = owned[rng.int(owned.length)]!;
    return [state.properties[t]!.mortgaged ? { type: "unmortgage", tileIndex: t } : { type: "mortgage", tileIndex: t }];
  };

  if (state.phase === "raisingFunds") {
    const tiles = mortgageableTiles(state, playerId);
    return [{ type: "payDebt" }, ...tiles.map((tileIndex): Draft => ({ type: "mortgage", tileIndex })), { type: "declareBankruptcy" }];
  }
  if (state.phase === "awaitingDecision") {
    if (policy === "smart") return [{ type: "buy" }, { type: "skip" }];
    return rng.int(2) === 0 ? [{ type: "buy" }, { type: "skip" }] : [{ type: "skip" }];
  }
  if (state.phase === "awaitingJailChoice") {
    const pre = rng.int(6) === 0 ? mortgageTile() : [];
    if (policy === "smart") return [...pre, { type: "jailPay" }, { type: "jailStay" }];
    return rng.int(2) === 0 ? [...pre, { type: "jailPay" }, { type: "jailStay" }] : [...pre, { type: "jailStay" }, { type: "jailPay" }];
  }
  // awaitingRoll
  if (policy === "smart") return [...(rng.int(8) === 0 ? mortgageTile() : []), ...builds, { type: "roll" }];
  const out: Draft[] = [];
  if (builds.length && rng.int(4) === 0) out.push(builds[rng.int(builds.length)]!);
  if (rng.int(5) === 0) out.push(...mortgageTile());
  if (me.cash > 0 && rng.int(600) === 0) out.push({ type: "resign" });
  out.push({ type: "roll" });
  return out;
}

/** Extra, out-of-turn actions: trade offers between random players, answered at random. */
function tradeStep(state: GameState, rng: Rng): Action | null {
  const active = state.players.filter((p) => !p.bankrupt);
  if (active.length < 2) return null;
  const pending = state.trades.filter((t) => t.status === "pending");
  const roll = rng.int(10);
  if (pending.length && roll < 5) {
    const t = pending[rng.int(pending.length)]!;
    const kind = rng.int(5);
    if (kind < 3) return { type: "acceptTrade", tradeId: t.id, playerId: t.toId } as Action;
    if (kind === 3) return { type: "rejectTrade", tradeId: t.id, playerId: t.toId } as Action;
    return { type: "cancelTrade", tradeId: t.id, playerId: t.fromId } as Action;
  }
  const from = active[rng.int(active.length)]!;
  const others = active.filter((p) => p.id !== from.id);
  const to = others[rng.int(others.length)]!;
  const owned = (id: string) => Object.entries(state.properties).filter(([, v]) => v.ownerId === id && v.level === 0 && !v.mortgaged).map(([k]) => Number(k));
  const pick = (list: number[]) => (list.length && rng.int(2) === 0 ? [list[rng.int(list.length)]!] : []);
  return {
    type: "proposeTrade",
    playerId: from.id,
    toId: to.id,
    give: { tiles: pick(owned(from.id)), cash: rng.int(3) === 0 ? rng.int(Math.max(1, from.cash)) : 0 },
    get: { tiles: pick(owned(to.id)), cash: rng.int(3) === 0 ? rng.int(Math.max(1, to.cash)) : 0 },
    actionId: "",
  } as unknown as Action;
}

/** An auction step: a random bidder bids a little more, withdraws, or the clock runs out. */
function auctionStep(state: GameState, rng: Rng, stuck: number): { action: Draft & { playerId: string }; advanceTo?: number } {
  const a = state.auction!;
  const open = state.players.filter((p) => !p.bankrupt && !a.withdrawnIds.includes(p.id));
  const p = open[rng.int(open.length)];
  if (!p || stuck > 25 || p.id === a.highestBidderId) return { action: { type: "auctionTimeout", playerId: "system" }, advanceTo: a.endsAt + 1 };
  const min = Math.max(RULES.auctionMinBid, a.currentBid + RULES.auctionBidStep);
  if (p.cash >= min && rng.int(100) < 62) {
    const amount = Math.min(p.cash, min + RULES.auctionBidStep * rng.int(6));
    return { action: { type: "bid", amount, playerId: p.id } };
  }
  return { action: { type: "withdraw", playerId: p.id } };
}

export function randomRules(rng: Rng): GameRules {
  return {
    startingCash: STARTING_CASH_OPTIONS[rng.int(STARTING_CASH_OPTIONS.length)]!,
    doubleRentSets: rng.int(2) === 0,
    oasisJackpot: rng.int(2) === 0,
    auctions: rng.int(2) === 0,
    noRentInDetention: rng.int(2) === 0,
    mortgage: rng.int(2) === 0,
    evenBuild: rng.int(2) === 0,
  };
}

export interface SimOptions {
  games: number;
  turnCap?: number;
  /** Also feed every batch to the shared display reducer and compare with the snapshot. */
  contract?: boolean;
  firstSeed?: number;
  /** Every game uses a random combination of the rule settings. */
  randomSettings?: boolean;
}

export interface SimReport {
  games: number;
  finished: number;
  capped: number;
  totalTurns: number;
  bankruptcies: number;
  actions: number;
  violations: { seed: number; message: string }[];
  /** Trade offers proposed, accepted, and refused by the engine (the engine may refuse random offers). */
  trades: { proposed: number; accepted: number; refused: number };
  /** How often each rule actually did something in the simulated games. */
  coverage: Record<string, number>;
}

export function simulate(opts: SimOptions): SimReport {
  const report: SimReport = {
    games: 0,
    finished: 0,
    capped: 0,
    totalTurns: 0,
    bankruptcies: 0,
    actions: 0,
    violations: [],
    trades: { proposed: 0, accepted: 0, refused: 0 },
    coverage: { auctionsStarted: 0, auctionsSold: 0, auctionsUnsold: 0, mortgages: 0, unmortgages: 0, debts: 0, debtsPaid: 0, debtBankruptcies: 0, oasisCollected: 0, rentDoubled: 0, rentWaived: 0, uneven: 0, afkKicks: 0 },
  };
  const cap = opts.turnCap ?? 500;
  const first = opts.firstSeed ?? 1;

  for (let n = 0; n < opts.games; n++) {
    const seed = first + n;
    const count = 2 + (n % 5);
    const policies: Record<string, Policy> = {};
    const ids = Array.from({ length: count }, (_, i) => `p${i + 1}`);
    ids.forEach((id, i) => (policies[id] = n % 3 === 0 ? "random" : n % 3 === 1 ? "smart" : i % 2 === 0 ? "smart" : "random"));
    const policyRng = new Rng(seedToState(`policy-${seed}`));
    const rules = opts.randomSettings ? randomRules(policyRng) : undefined;

    const created = createGame({ players: ids.map((id) => ({ id, characterId: null })), startingCash: rules ? undefined : 1500, ...(rules ? { rules } : {}), seed });
    if (!created.ok) throw new Error(created.error);
    let state = created.state;
    let display = applyBatch(null, created.events, 0);
    const violate = (message: string) => report.violations.push({ seed, message });
    report.games++;
    let counter = 0;
    let clock = 1_000_000;
    let stuck = 0;

    const apply = (draft: Draft & { playerId: string }, label: string): boolean => {
      const action = { ...draft, actionId: `s${seed}-${++counter}` } as Action;
      clock += 40;
      const res = applyAction(state, action, { now: action.type === "auctionTimeout" ? Math.max(clock, state.auction?.endsAt ?? 0) : clock });
      if (!res.ok) return false;
      state = res.state;
      report.actions++;
      for (const e of res.events as GameEvent[]) {
        if (e.type === "BANKRUPT") report.bankruptcies++;
        if (e.type === "AUCTION_STARTED") report.coverage.auctionsStarted!++;
        if (e.type === "AUCTION_ENDED") report.coverage[e.winnerId ? "auctionsSold" : "auctionsUnsold"]!++;
        if (e.type === "PROPERTY_MORTGAGED") report.coverage.mortgages!++;
        if (e.type === "PROPERTY_UNMORTGAGED") report.coverage.unmortgages!++;
        if (e.type === "DEBT_STARTED") report.coverage.debts!++;
        if (e.type === "DEBT_PAID") report.coverage.debtsPaid!++;
        if (e.type === "OASIS_COLLECTED") report.coverage.oasisCollected!++;
        if (e.type === "RENT_WAIVED") report.coverage.rentWaived!++;
      }
      if (action.type === "declareBankruptcy") report.coverage.debtBankruptcies!++;
      const problems = checkInvariants(state);
      if (problems.length) violate(`${label}: ${problems.join("; ")}`);
      if (opts.contract) {
        display = applyBatch(display, res.events, state.seq);
        if (JSON.stringify(display) !== JSON.stringify(toSnapshot(state))) violate(`display differs from snapshot after ${label}`);
      }
      return true;
    };

    while (state.phase !== "gameOver" && state.turnNumber < cap) {
      if (state.phase === "auction") {
        const step = auctionStep(state, policyRng, stuck++);
        if (step.advanceTo) clock = Math.max(clock, step.advanceTo);
        if (!apply(step.action, `auction ${step.action.type}`)) {
          // an illegal pick (for example the leader tried to withdraw): let the clock run out instead
          if (!apply({ type: "auctionTimeout", playerId: "system" }, "auction timeout")) {
            violate("auction cannot be settled");
            break;
          }
        }
        if (report.violations.length > 20) break;
        continue;
      }
      stuck = 0;
      const playerId = state.currentPlayerId!;
      let applied = false;
      for (const draft of candidates(state, playerId, policies[playerId]!, policyRng)) {
        if (apply({ ...draft, playerId } as Draft & { playerId: string }, draft.type)) {
          applied = true;
          break;
        }
      }
      if (!applied) {
        violate(`no legal action for ${playerId} in phase ${state.phase}`);
        break;
      }
      // an out-of-turn trade action now and then
      if (state.phase !== "gameOver" && policyRng.int(8) === 0) {
        const extra = tradeStep(state, policyRng);
        if (extra) {
          const before = state.seq;
          const ok = apply(extra as Draft & { playerId: string }, extra.type);
          if (!ok) report.trades.refused++;
          else if (state.seq > before) {
            if (extra.type === "proposeTrade") report.trades.proposed++;
            if (extra.type === "acceptTrade") report.trades.accepted++;
          }
        }
      }
      // now and then a player is removed for inactivity: everything they own returns to the bank
      if (state.phase !== "gameOver" && policyRng.int(400) === 0) {
        const active = state.players.filter((p) => !p.bankrupt);
        if (active.length > 2) {
          const target = active[policyRng.int(active.length)]!;
          if (apply({ type: "afkKick", playerId: "system", targetId: target.id } as unknown as Draft & { playerId: string }, "afkKick")) report.coverage.afkKicks!++;
        }
      }
      if (report.violations.length > 20) break;
    }
    report.totalTurns += state.turnNumber;
    if (state.phase === "gameOver") report.finished++;
    else report.capped++;
  }
  return report;
}

export function formatReport(r: SimReport): string {
  return [
    `games run:            ${r.games}`,
    `finished with winner: ${r.finished}`,
    `hit the turn cap:     ${r.capped}`,
    `average turns:        ${(r.totalTurns / Math.max(1, r.games)).toFixed(1)}`,
    `actions applied:      ${r.actions}`,
    `bankruptcies:         ${r.bankruptcies}`,
    `trades:               ${r.trades.proposed} proposed, ${r.trades.accepted} accepted`,
    `rule coverage:        ${Object.entries(r.coverage).map(([k, v]) => `${k}=${v}`).join(", ")}`,
    `invariant violations: ${r.violations.length}`,
    ...r.violations.slice(0, 5).map((v) => `  FAIL seed ${v.seed}: ${v.message}`),
  ].join("\n");
}
