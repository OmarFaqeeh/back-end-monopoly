// Bot personalities. Every number is a tunable constant; the bot brain reads only this table.
// "Different minds": some bots have no financial sense at all (spender), some are careful.
export type PersonalityId = "tycoon" | "careful" | "spender" | "collector" | "balanced";

export interface Personality {
  id: PersonalityId;
  /** Cash a bot tries to keep after spending. */
  reserve: number;
  /** Cash it keeps after building. */
  buildReserve: number;
  /** Auction ceiling as a multiple of the list price (and for a tile that completes one of its sets). */
  auctionFactor: number;
  auctionSetFactor: number;
  /** Required margin on a trade, as a share of what it gives (negative = accepts slightly unfavorable deals). */
  tradeMargin: number;
  /** The margin when the trade completes one of its sets. */
  tradeSetMargin: number;
  /** Odds (0..1) that it looks for a trade to propose when it is allowed to. */
  proposalChance: number;
}

export const PERSONALITIES: Record<PersonalityId, Personality> = {
  tycoon: { id: "tycoon", reserve: 100, buildReserve: 150, auctionFactor: 1.3, auctionSetFactor: 1.3, tradeMargin: -0.05, tradeSetMargin: -0.05, proposalChance: 0.5 },
  careful: { id: "careful", reserve: 400, buildReserve: 400, auctionFactor: 0.9, auctionSetFactor: 0.9, tradeMargin: 0.15, tradeSetMargin: 0.15, proposalChance: 0.1 },
  spender: { id: "spender", reserve: 0, buildReserve: 0, auctionFactor: 1.6, auctionSetFactor: 1.6, tradeMargin: -0.2, tradeSetMargin: -0.2, proposalChance: 0.4 },
  collector: { id: "collector", reserve: 200, buildReserve: 200, auctionFactor: 1.2, auctionSetFactor: 1.5, tradeMargin: 0.05, tradeSetMargin: -0.15, proposalChance: 0.9 },
  balanced: { id: "balanced", reserve: 250, buildReserve: 250, auctionFactor: 1.1, auctionSetFactor: 1.1, tradeMargin: 0.08, tradeSetMargin: 0.08, proposalChance: 0.5 },
};

export const PERSONALITY_IDS = Object.keys(PERSONALITIES) as PersonalityId[];
export const isPersonality = (v: unknown): v is PersonalityId => typeof v === "string" && v in PERSONALITIES;

/** Timing constants of bots (ms). */
export const BOT_TRADE_MIN_GAME_MS = 180_000;
export const BOT_TRADE_COOLDOWN_MS = 90_000;
export const BOT_REJECTED_DEAL_COOLDOWN_MS = 300_000;
export const BOT_REFILL_AFTER_REMOVE_MS = 10_000;
export const BOT_REFILL_INTERVAL_MS = 5_000;
export const BOT_WATCHDOG_MS = 15_000;
export const BOT_THINK_MIN_MS = 800;
export const BOT_THINK_MAX_MS = 2_200;
export const BOT_TRADE_ANSWER_MIN_MS = 3_000;
export const BOT_TRADE_ANSWER_MAX_MS = 7_000;
export const BOT_MAX_COUNTER_ROUNDS = 2;
