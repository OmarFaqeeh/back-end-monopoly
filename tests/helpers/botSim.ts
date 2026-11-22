// Bots-only games: every player is a bot with a random personality, with random combinations of the rule settings.
// Bots decide with the same brain the server uses and act through applyAction, exactly like humans. Counts rejected bot
// actions (must be exactly 0), invariant violations, decision times, and the win rate per personality.
import { applyAction } from "../../src/engine/actions.js";
import { newMemory, decide, safeDefault, type BotAction, type BotMemory } from "../../src/engine/bots/botBrain.js";
import { Rng, seedToState } from "../../src/engine/rng.js";
import { checkInvariants, createGame, toSnapshot } from "../../src/engine/state.js";
import type { Action, GameState } from "../../src/engine/types.js";
import { PERSONALITY_IDS, type PersonalityId } from "../../src/config/botPersonalities.js";
import { randomRules } from "./sim.js";

export interface BotSimReport {
  games: number;
  finished: number;
  capped: number;
  totalTurns: number;
  actions: number;
  rejectedBotActions: number;
  violations: { seed: number; message: string }[];
  decisionMs: number[];
  p99DecisionMs: number;
  wins: Record<PersonalityId, number>;
  played: Record<PersonalityId, number>;
  coverage: Record<string, number>;
}

export function simulateBots(opts: { games: number; turnCap?: number; firstSeed?: number }): BotSimReport {
  const cap = opts.turnCap ?? 500;
  const first = opts.firstSeed ?? 1;
  const zero = () => Object.fromEntries(PERSONALITY_IDS.map((p) => [p, 0])) as Record<PersonalityId, number>;
  const report: BotSimReport = {
    games: 0, finished: 0, capped: 0, totalTurns: 0, actions: 0, rejectedBotActions: 0, violations: [], decisionMs: [], p99DecisionMs: 0,
    wins: zero(), played: zero(), coverage: { auctions: 0, mortgages: 0, unmortgages: 0, debts: 0, builds: 0, jackpots: 0, bankruptcies: 0 },
  };

  for (let n = 0; n < opts.games; n++) {
    const seed = first + n;
    const rng = new Rng(seedToState(`botsim-${seed}`));
    const count = 2 + (n % 5);
    const ids = Array.from({ length: count }, (_, i) => `b${i + 1}`);
    const personality: Record<string, PersonalityId> = Object.fromEntries(ids.map((id) => [id, PERSONALITY_IDS[rng.int(PERSONALITY_IDS.length)]!]));
    const mem: Record<string, BotMemory> = Object.fromEntries(ids.map((id) => [id, newMemory()]));
    const rules = randomRules(rng);
    const created = createGame({ players: ids.map((id) => ({ id, characterId: null })), rules, seed });
    if (!created.ok) throw new Error(created.error);
    let state: GameState = created.state;
    report.games++;
    for (const id of ids) report.played[personality[id]!]++;
    const violate = (message: string) => report.violations.push({ seed, message });
    const startedAt = 1_000_000;
    let clock = startedAt;
    let counter = 0;
    let idle = 0;

    const play = (playerId: string, action: BotAction | { type: "auctionTimeout" }, label: string): boolean => {
      const full = { ...action, playerId, actionId: `b${seed}-${++counter}` } as Action;
      clock += 1500;
      const res = applyAction(state, full, { now: full.type === "auctionTimeout" ? Math.max(clock, state.auction?.endsAt ?? 0) : clock });
      if (!res.ok) {
        if (full.type !== "auctionTimeout") report.rejectedBotActions++;
        violate(`rejected ${label} by ${playerId} in phase ${state.phase}: ${res.error}`);
        return false;
      }
      state = res.state;
      report.actions++;
      for (const e of res.events) {
        if (e.type === "AUCTION_STARTED") report.coverage.auctions!++;
        if (e.type === "PROPERTY_MORTGAGED") report.coverage.mortgages!++;
        if (e.type === "PROPERTY_UNMORTGAGED") report.coverage.unmortgages!++;
        if (e.type === "DEBT_STARTED") report.coverage.debts!++;
        if (e.type === "BUILT") report.coverage.builds!++;
        if (e.type === "OASIS_COLLECTED") report.coverage.jackpots!++;
        if (e.type === "BANKRUPT") report.coverage.bankruptcies!++;
      }
      const problems = checkInvariants(state);
      if (problems.length) violate(`${label}: ${problems.join("; ")}`);
      return true;
    };

    const think = (botId: string): BotAction | null => {
      const t0 = performance.now();
      let action: BotAction | null;
      try {
        action = decide({ snapshot: toSnapshot(state), botId, personality: personality[botId]!, rng: () => rng.next(), now: clock, gameStartedAt: startedAt, mem: mem[botId]!, humanIds: new Set() });
      } catch (e) {
        violate(`brain threw for ${botId}: ${(e as Error).message}`);
        action = safeDefault(toSnapshot(state), botId);
      }
      report.decisionMs.push(performance.now() - t0);
      return action;
    };

    while (state.phase !== "gameOver" && state.turnNumber < cap && report.violations.length < 10) {
      let acted = false;
      if (state.phase === "auction") {
        const open = state.players.filter((p) => !p.bankrupt && !state.auction!.withdrawnIds.includes(p.id));
        const order = rng.shuffle(open);
        for (const p of order) {
          const a = think(p.id);
          if (a) {
            acted = play(p.id, a, a.type);
            break;
          }
        }
        if (!acted) acted = play("system", { type: "auctionTimeout" }, "auction timeout");
      } else {
        const botId = state.currentPlayerId!;
        const a = think(botId);
        if (a) acted = play(botId, a, a.type);
        else violate(`bot ${botId} has nothing to do in phase ${state.phase}`);
      }
      if (!acted) {
        if (++idle > 3) break;
      } else idle = 0;
    }
    report.totalTurns += state.turnNumber;
    if (state.phase === "gameOver") {
      report.finished++;
      report.wins[personality[state.winnerPlayerId!]!]++;
    } else report.capped++;
  }
  const sorted = Float64Array.from(report.decisionMs).sort();
  report.p99DecisionMs = sorted[Math.floor(sorted.length * 0.99)] ?? 0;
  return report;
}

export function formatBotReport(r: BotSimReport): string {
  const rows = PERSONALITY_IDS.map((p) => `  ${p.padEnd(10)} played ${String(r.played[p]).padStart(5)}  won ${String(r.wins[p]).padStart(5)}  win rate ${((100 * r.wins[p]) / Math.max(1, r.played[p])).toFixed(1)}%`);
  return [
    `bot games run:        ${r.games}`,
    `finished with winner: ${r.finished}`,
    `hit the turn cap:     ${r.capped}`,
    `average turns:        ${(r.totalTurns / Math.max(1, r.games)).toFixed(1)}`,
    `actions applied:      ${r.actions}`,
    `rejected bot actions: ${r.rejectedBotActions}`,
    `invariant violations: ${r.violations.length}`,
    `decision time p99:    ${r.p99DecisionMs.toFixed(3)} ms (max ${r.decisionMs.reduce((m, v) => (v > m ? v : m), 0).toFixed(3)} ms)`,
    `coverage:             ${Object.entries(r.coverage).map(([k, v]) => `${k}=${v}`).join(", ")}`,
    `win rate per personality (wins / games played by that personality):`,
    ...rows,
    ...r.violations.slice(0, 5).map((v) => `  FAIL seed ${v.seed}: ${v.message}`),
  ].join("\n");
}
