// Engine types. GameState is the full server-side state; the client only ever sees toSnapshot(state).
import type { DeckName, GameErrorCode, GameEvent, GameSnapshot, BuildKind, TradeSide } from "../shared/events.js";

export type { GameErrorCode, GameEvent, GameSnapshot } from "../shared/events.js";

export interface GameState extends GameSnapshot {
  /** Internal only (never sent): RNG state, card decks and their positions, the bank's net balance. */
  rng: number;
  decks: Record<DeckName, string[]>;
  deckPos: Record<DeckName, number>;
  /** Net cash held by the bank (taxes, purchases, fines in; salary and card gains out). cash + bank is conserved. */
  bank: number;
  /** What happens after a debt is paid (internal; the snapshot only carries pendingDebt). */
  debtThen: DebtThen | null;
  /** Counter for trade ids (T1, T2, ...). */
  tradeSeq: number;
  /** Recent action ids, for idempotency. */
  processed: string[];
}

/** Returns the two dice values (1..6). Tests and E2E inject fixed sequences (server honors it only in NODE_ENV=test). */
export type DiceSource = () => [number, number];

/** Continuation of a turn that was interrupted by a debt: finish the turn, or free the player from detention. */
export interface DebtThen {
  after: "endTurn" | "jailFreed";
  /** The event to emit once the debt is paid (RENT_PAID, TAX_PAID, JAIL_PAID). */
  event?: GameEvent;
}

export interface EngineContext {
  dice?: DiceSource;
  /** Clock for the auction timers (ms). Defaults to Date.now(). */
  now?: number;
}

interface Base {
  actionId: string;
  playerId: string;
}

export type Action =
  | (Base & { type: "roll" })
  | (Base & { type: "buy" })
  | (Base & { type: "skip" })
  | (Base & { type: "jailPay" })
  | (Base & { type: "jailStay" })
  | (Base & { type: "build"; tileIndex: number; kind: BuildKind })
  | (Base & { type: "resign" })
  | (Base & { type: "bid"; amount: number })
  | (Base & { type: "withdraw" })
  | (Base & { type: "auctionTimeout" })
  | (Base & { type: "endGame" })
  | (Base & { type: "afkKick"; targetId: string })
  | (Base & { type: "mortgage"; tileIndex: number })
  | (Base & { type: "unmortgage"; tileIndex: number })
  | (Base & { type: "payDebt" })
  | (Base & { type: "declareBankruptcy" })
  | (Base & { type: "proposeTrade"; toId: string; give: TradeSide; get: TradeSide })
  | (Base & { type: "acceptTrade"; tradeId: string })
  | (Base & { type: "rejectTrade"; tradeId: string })
  | (Base & { type: "cancelTrade"; tradeId: string });

export type ActionResult = { ok: true; state: GameState; events: GameEvent[] } | { ok: false; error: GameErrorCode };
