// Runs the games of all rooms: owns the engine state per room code, validates who may act, broadcasts event batches,
// plays for players who are away (AFK) and tells the RoomManager when a game starts or ends.
// Single backend instance only (state and timers live in this process), like the RoomManager.
import { randomBytes } from "node:crypto";
import { DEFAULT_TIMINGS, type RoomTimings } from "../config/defaults.js";
import { BOT_THINK_MAX_MS, BOT_THINK_MIN_MS, BOT_TRADE_ANSWER_MAX_MS, BOT_TRADE_ANSWER_MIN_MS, BOT_WATCHDOG_MS, isPersonality, type PersonalityId } from "../config/botPersonalities.js";
import { SYSTEM_PLAYER, applyAction, mortgageableTiles } from "../engine/actions.js";
import { decide, dealSignature, evaluateTrade, newMemory, safeDefault, type BotAction, type BotMemory, type DecideInput } from "../engine/bots/botBrain.js";
import { Rng, seedToState } from "../engine/rng.js";
import { estimateAnimationMs } from "../shared/timing.js";
import { createGame, toSnapshot } from "../engine/state.js";
import type { Action, DiceSource, GameState } from "../engine/types.js";
import type { RoomManager } from "../rooms/roomManager.js";
import { rulesFromSettings } from "../shared/settings.js";
import type { GameErrorCode, GameEvent, GameEventsPayload, GameSnapshot, TradeSide } from "../shared/events.js";

export class GameError extends Error {
  constructor(readonly code: GameErrorCode | "PLAYERS_NOT_READY" | "NOT_IN_ROOM" | "VALIDATION_ERROR") {
    super(code);
  }
}

export interface GameEmitter {
  started(code: string, snapshot: GameSnapshot): void;
  events(code: string, payload: GameEventsPayload): void;
  over(code: string, winnerPlayerId: string): void;
}

/** What a client may ask for (the actionId makes retries idempotent). */
export type ClientAction =
  | { actionId: string; type: "roll" | "buy" | "skip" | "jailPay" | "jailStay" | "resign" }
  | { actionId: string; type: "build"; tileIndex: number; kind: "house" | "hotel" }
  | { actionId: string; type: "bid"; amount: number }
  | { actionId: string; type: "withdraw" | "payDebt" | "declareBankruptcy" }
  | { actionId: string; type: "mortgage" | "unmortgage"; tileIndex: number }
  | { actionId: string; type: "proposeTrade"; toId: string; give: TradeSide; get: TradeSide }
  | { actionId: string; type: "acceptTrade" | "rejectTrade" | "cancelTrade"; tradeId: string };

interface Runtime {
  state: GameState;
  /** Forced dice for tests (only ever filled when testMode is on). */
  forcedDice: [number, number][];
  /** When each currently disconnected player dropped (ms). */
  away: Map<string, number>;
  afkTimer: ReturnType<typeof setTimeout> | null;
  /** Fires when the running auction's time is up (cleared and re-armed after every change). */
  auctionTimer: ReturnType<typeof setTimeout> | null;
  /** Computer players: personality and memory. They act through the same actions as humans. */
  bots: Map<string, { personality: PersonalityId; mem: BotMemory }>;
  botTimer: ReturnType<typeof setTimeout> | null;
  botWatchdog: ReturnType<typeof setTimeout> | null;
  /** Re-checks every 10 s whether a bot has something to do (for example a trade proposal once the game is old enough). */
  botTick: ReturnType<typeof setInterval> | null;
  botRng: Rng;
  startedAt: number;
  autoCounter: number;
}

export interface GameManagerOptions {
  manager: RoomManager;
  timings?: RoomTimings;
  now?: () => number;
  /** Forced dice and cash tweaks are honored only when this is true (NODE_ENV=test). */
  testMode?: boolean;
  logger?: Pick<Console, "error">;
}

export class GameManager {
  emitter: GameEmitter = { started: () => {}, events: () => {}, over: () => {} };
  private readonly games = new Map<string, Runtime>();
  private readonly manager: RoomManager;
  private readonly timings: RoomTimings;
  private readonly now: () => number;
  readonly testMode: boolean;
  private readonly logger: Pick<Console, "error">;

  constructor(opts: GameManagerOptions) {
    this.manager = opts.manager;
    this.timings = opts.timings ?? DEFAULT_TIMINGS;
    this.now = opts.now ?? Date.now;
    this.testMode = opts.testMode ?? false;
    this.logger = opts.logger ?? console;
    this.manager.addHooks({
      playerDisconnected: (code, playerId) => this.onDisconnected(code, playerId),
      playerReconnected: (code, playerId) => this.onReconnected(code, playerId),
      playerRemoved: (code, playerId, reason) => this.onRemoved(code, playerId, reason),
      roomClosed: (code) => this.drop(code),
    });
  }

  /* ---------------------------------------------------------------- queries */

  isRunning(code: string): boolean {
    return this.games.has(code);
  }

  getSnapshot(code: string): GameSnapshot | null {
    const rt = this.games.get(code);
    return rt ? toSnapshot(rt.state) : null;
  }

  /* ---------------------------------------------------------------- starting */

  /** Host only. Seats must be at least 2 and all have a character. Freezes the room settings. */
  start(code: string, playerId: string): GameSnapshot {
    const room = this.manager.getSnapshot(code);
    if (!room) throw new GameError("NOT_IN_ROOM");
    const me = room.players.find((p) => p.playerId === playerId);
    if (!me) throw new GameError("NOT_IN_ROOM");
    if (!me.isHost) throw new GameError("NOT_HOST");
    if (this.games.has(code) || room.status === "playing") throw new GameError("GAME_ALREADY_STARTED");
    if (room.players.length < 2) throw new GameError("NEED_2_PLAYERS");
    if (room.players.some((p) => !p.characterId)) throw new GameError("PLAYERS_NOT_READY");

    const seed = randomBytes(16).toString("hex"); // never leaves the server
    const created = createGame({
      players: room.players.map((p) => ({ id: p.playerId, characterId: p.characterId })),
      rules: rulesFromSettings(room.settings),
      seed,
    });
    if (!created.ok) throw new GameError(created.error);

    const away = new Map<string, number>();
    for (const p of room.players) if (!p.connected) away.set(p.playerId, this.now());
    const bots = new Map<string, { personality: PersonalityId; mem: BotMemory }>();
    for (const b of this.manager.getBots(code)) bots.set(b.id, { personality: isPersonality(b.personality) ? b.personality : "balanced", mem: newMemory() });
    const rt: Runtime = { state: created.state, forcedDice: [], away, afkTimer: null, auctionTimer: null, autoCounter: 0, bots, botTimer: null, botWatchdog: null, botTick: null, botRng: new Rng(seedToState(seed + "-bots")), startedAt: this.now() };
    this.games.set(code, rt);
    if (bots.size > 0) {
      rt.botTick = setInterval(() => {
        if (!rt.botTimer && rt.state.phase !== "gameOver") this.scheduleBots(code, rt, 0);
      }, 10_000);
      rt.botTick.unref?.();
    }
    this.manager.markGameStarted(code);
    const snapshot = toSnapshot(created.state);
    this.emitter.started(code, snapshot);
    this.scheduleAfk(code);
    this.scheduleBots(code, rt, 0);
    return snapshot;
  }

  /* ---------------------------------------------------------------- actions */

  /** Applies a client action for a player. Throws GameError on any rejection. */
  act(code: string, playerId: string, action: ClientAction): void {
    const rt = this.games.get(code);
    if (!rt) throw new GameError("GAME_NOT_STARTED");
    if (!this.manager.getSnapshot(code)?.players.some((p) => p.playerId === playerId)) throw new GameError("NOT_IN_ROOM");
    const error = this.apply(code, rt, { ...action, playerId } as Action);
    if (error) throw new GameError(error);
  }

  /** Runs one action through the engine and broadcasts the result. Returns an error code or null. */
  private apply(code: string, rt: Runtime, action: Action): GameErrorCode | null {
    const dice: DiceSource | undefined = rt.forcedDice.length ? () => rt.forcedDice.shift()! : undefined;
    // The auction timeout may fire a few ms before endsAt (timer jitter): it is only ever sent after the deadline.
    const now = action.type === "auctionTimeout" ? Math.max(this.now(), rt.state.auction?.endsAt ?? 0) : this.now();
    const res = applyAction(rt.state, action, { ...(dice ? { dice } : {}), now });
    if (!res.ok) return res.error;
    rt.state = res.state;
    this.broadcast(code, rt, res.events);
    return null;
  }

  private broadcast(code: string, rt: Runtime, events: GameEvent[]): void {
    const snapshot = toSnapshot(rt.state);
    this.emitter.events(code, { events, snapshot, seq: snapshot.seq });
    if (rt.state.phase === "gameOver" && rt.state.winnerPlayerId) {
      this.manager.markGameFinished(code, rt.state.winnerPlayerId);
      this.emitter.over(code, rt.state.winnerPlayerId);
      this.clearTimers(rt);
      return;
    }
    this.syncAuction(code, rt);
    this.scheduleAfk(code);
    if (this.endIfOnlyBotsLeft(code, rt)) return;
    this.scheduleBots(code, rt, estimateAnimationMs(events));
  }

  /* ---------------------------------------------------------------- bots */

  /** Rejected bot actions (the target is exactly 0: a bot never plays an illegal move). */
  rejectedBotActions = 0;

  /** When every human is out of the game the game ends: the active bot with the highest net worth wins. */
  private endIfOnlyBotsLeft(code: string, rt: Runtime): boolean {
    if (rt.bots.size === 0 || rt.state.phase === "gameOver") return false;
    const humansLeft = rt.state.players.some((p) => !p.bankrupt && !rt.bots.has(p.id));
    if (humansLeft) return false;
    const error = this.apply(code, rt, { type: "endGame", playerId: SYSTEM_PLAYER, actionId: `end-${rt.state.seq}` });
    if (error) this.logger.error(`[game] could not end a bots-only game in ${code}: ${error}`);
    return true;
  }

  private botInput(rt: Runtime, botId: string): DecideInput {
    const bot = rt.bots.get(botId)!;
    return {
      snapshot: toSnapshot(rt.state),
      botId,
      personality: bot.personality,
      rng: () => rt.botRng.next(),
      now: this.now(),
      gameStartedAt: rt.startedAt,
      mem: bot.mem,
      humanIds: new Set(rt.state.players.filter((p) => !rt.bots.has(p.id)).map((p) => p.id)),
    };
  }

  /** The first bot that has something to do, with what it wants to do. A throwing brain falls back to the safe default. */
  private pickBotAction(rt: Runtime): { botId: string; action: BotAction } | null {
    const ids = [...rt.bots.keys()].filter((id) => rt.state.players.some((p) => p.id === id && !p.bankrupt));
    // A bot with an offer to answer first (answers never wait for other bots' turns), then whoever's turn it is, then the rest.
    const rank = (id: string) => (rt.state.trades.some((t: { status: string; toId: string }) => t.status === "pending" && t.toId === id) ? 0 : id === rt.state.currentPlayerId ? 1 : 2);
    ids.sort((a, b) => rank(a) - rank(b));
    for (const botId of ids) {
      let action: BotAction | null;
      try {
        action = decide(this.botInput(rt, botId));
      } catch (e) {
        this.logger.error(`[bot] brain failed for ${botId}: ${e instanceof Error ? e.message : String(e)}`);
        action = safeDefault(toSnapshot(rt.state), botId);
      }
      if (action) return { botId, action };
    }
    return null;
  }

  /** Plans the next bot move after `animationMs` (the client is still playing the last events) plus a human-like pause. */
  private scheduleBots(code: string, rt: Runtime, animationMs: number): void {
    if (rt.botTimer) clearTimeout(rt.botTimer);
    if (rt.botWatchdog) clearTimeout(rt.botWatchdog);
    rt.botTimer = null;
    rt.botWatchdog = null;
    if (rt.bots.size === 0 || rt.state.phase === "gameOver") return;
    const pick = this.pickBotAction(rt);
    if (!pick) return;
    const a = pick.action;
    const answering = a.type === "acceptTrade" || a.type === "rejectTrade";
    const [lo, hi] = answering ? [BOT_TRADE_ANSWER_MIN_MS, BOT_TRADE_ANSWER_MAX_MS] : rt.state.phase === "auction" ? [500, 1400] : [BOT_THINK_MIN_MS, BOT_THINK_MAX_MS];
    const delay = animationMs + lo + Math.floor(rt.botRng.next() * (hi - lo));
    rt.botTimer = setTimeout(() => this.runBot(code), delay);
    rt.botTimer.unref?.();
    // Watchdog: a bot that has not moved for 15 s (after the planned delay) plays a safe default.
    rt.botWatchdog = setTimeout(() => this.botWatchdogFired(code, pick.botId), delay + BOT_WATCHDOG_MS);
    rt.botWatchdog.unref?.();
  }

  private runBot(code: string): void {
    const rt = this.games.get(code);
    if (!rt) return;
    rt.botTimer = null;
    const pick = this.pickBotAction(rt); // the state may have changed while the bot was "thinking"
    if (!pick) return;
    this.playBot(code, rt, pick.botId, pick.action);
  }

  private botWatchdogFired(code: string, botId: string): void {
    const rt = this.games.get(code);
    if (!rt || rt.state.phase === "gameOver") return;
    this.logger.error(`[bot] watchdog: ${botId} did not act, playing the safe default`);
    const action = safeDefault(toSnapshot(rt.state), botId);
    if (action) this.playBot(code, rt, botId, action);
    else this.scheduleBots(code, rt, 0);
  }

  /** Plays a bot's action through the normal pipeline; remembers trades; counts (and replaces) a rejected action. */
  private playBot(code: string, rt: Runtime, botId: string, action: BotAction): void {
    const bot = rt.bots.get(botId)!;
    const input = this.botInput(rt, botId);
    // Remember what trade answers meant: a counter-offer is sent right after the decline.
    if (action.type === "rejectTrade") {
      const trade = rt.state.trades.find((t) => t.id === action.tradeId);
      if (trade) {
        const verdict = evaluateTrade(input, trade);
        if (verdict.verdict === "counter" && verdict.counter) {
          bot.mem.pendingCounter = { toId: trade.fromId, ...verdict.counter };
          bot.mem.counterRounds.set(trade.fromId, (bot.mem.counterRounds.get(trade.fromId) ?? 0) + 1);
        }
        bot.mem.dealCooldown.set(dealSignature(trade.give, trade.get, trade.fromId), this.now());
      }
    }
    if (action.type === "proposeTrade") {
      bot.mem.lastProposalAt = this.now();
      bot.mem.pendingCounter = null;
      bot.mem.dealCooldown.set(dealSignature(action.give, action.get, action.toId), this.now());
    }
    if (action.type === "acceptTrade") bot.mem.counterRounds.clear();
    const error = this.apply(code, rt, { ...action, playerId: botId, actionId: `bot-${botId}-${rt.state.seq}-${++rt.autoCounter}` } as Action);
    if (!error) return;
    this.rejectedBotActions++;
    this.logger.error(`[bot] ${botId} played an illegal ${action.type}: ${error}`);
    const fallback = safeDefault(toSnapshot(rt.state), botId);
    const again = fallback && fallback.type !== action.type ? this.apply(code, rt, { ...fallback, playerId: botId, actionId: `bot-${botId}-${rt.state.seq}-${++rt.autoCounter}` } as Action) : "NO_FALLBACK";
    if (again) this.scheduleBots(code, rt, 0);
  }

  /* ---------------------------------------------------------------- auction timer */

  /** Re-arms (or clears) the auction timer to match the state, and withdraws players who are not connected. */
  private syncAuction(code: string, rt: Runtime): void {
    if (rt.auctionTimer) clearTimeout(rt.auctionTimer);
    rt.auctionTimer = null;
    const a = rt.state.auction;
    if (!a || rt.state.phase !== "auction") return;
    rt.auctionTimer = setTimeout(() => this.auctionTimeout(code), Math.max(0, a.endsAt - this.now()));
    rt.auctionTimer.unref?.();
    queueMicrotask(() => this.withdrawAway(code));
  }

  private auctionTimeout(code: string): void {
    const rt = this.games.get(code);
    if (!rt || !rt.state.auction) return;
    const error = this.apply(code, rt, { type: "auctionTimeout", playerId: SYSTEM_PLAYER, actionId: `auction-timeout-${rt.state.seq}` });
    if (error) {
      this.logger.error(`[game] auction timeout refused in ${code}: ${error}`);
      this.syncAuction(code, rt);
    }
  }

  /** "A disconnected player is auto-withdrawn": one withdrawal at a time (each one re-syncs and may end the auction). */
  private withdrawAway(code: string): void {
    const rt = this.games.get(code);
    const a = rt?.state.auction;
    if (!rt || !a) return;
    const absent = rt.state.players.find((p) => !p.bankrupt && rt.away.has(p.id) && !a.withdrawnIds.includes(p.id) && p.id !== a.highestBidderId);
    if (!absent) return;
    const error = this.apply(code, rt, { type: "withdraw", playerId: absent.id, actionId: `auto-withdraw-${absent.id}-${rt.state.seq}` });
    if (error) this.logger.error(`[game] auto-withdraw failed for ${absent.id}: ${error}`);
  }

  /** A player pressed Leave (or their seat expired): treated as bankruptcy to the bank. */
  resign(code: string, playerId: string): void {
    const rt = this.games.get(code);
    if (!rt || rt.state.phase === "gameOver") return;
    const me = rt.state.players.find((p) => p.id === playerId);
    if (!me || me.bankrupt) return;
    const error = this.apply(code, rt, { type: "resign", playerId, actionId: `resign-${playerId}-${rt.state.seq}` });
    if (error) this.logger.error(`[game] resign failed for ${playerId}: ${error}`);
  }

  /* ---------------------------------------------------------------- presence and AFK */

  private onDisconnected(code: string, playerId: string): void {
    const rt = this.games.get(code);
    if (!rt) return;
    rt.away.set(playerId, this.now());
    this.scheduleAfk(code);
    this.withdrawAway(code);
  }

  private onReconnected(code: string, playerId: string): void {
    const rt = this.games.get(code);
    if (!rt) return;
    rt.away.delete(playerId);
    this.scheduleAfk(code);
  }

  private onRemoved(code: string, playerId: string, reason?: "left" | "inactive"): void {
    const rt = this.games.get(code);
    if (!rt) return;
    rt.away.delete(playerId);
    if (reason === "inactive") this.kickInactive(code, playerId);
    else this.resign(code, playerId);
  }

  /** Removes an inactive player: everything they own returns to the bank (see the engine's afkKick). */
  kickInactive(code: string, playerId: string): void {
    const rt = this.games.get(code);
    const me = rt?.state.players.find((p) => p.id === playerId);
    if (!rt || !me || me.bankrupt || rt.state.phase === "gameOver") return;
    const error = this.apply(code, rt, { type: "afkKick", playerId: SYSTEM_PLAYER, targetId: playerId, actionId: `afk-kick-${playerId}-${rt.state.seq}` });
    if (error) this.logger.error(`[game] could not remove ${playerId} for inactivity: ${error}`);
  }

  private clearAfk(rt: Runtime): void {
    if (rt.afkTimer) clearTimeout(rt.afkTimer);
    rt.afkTimer = null;
  }

  /** Every timer of a game (room closed, game over, shutdown). */
  private clearTimers(rt: Runtime): void {
    this.clearAfk(rt);
    if (rt.botTimer) clearTimeout(rt.botTimer);
    if (rt.botWatchdog) clearTimeout(rt.botWatchdog);
    rt.botTimer = null;
    rt.botWatchdog = null;
    if (rt.botTick) clearInterval(rt.botTick);
    rt.botTick = null;
    if (rt.auctionTimer) clearTimeout(rt.auctionTimer);
    rt.auctionTimer = null;
  }

  /** (Re)arms the AFK timer for the current player when they are disconnected and someone else is still here. */
  private scheduleAfk(code: string): void {
    const rt = this.games.get(code);
    if (!rt) return;
    this.clearAfk(rt);
    if (rt.state.phase === "gameOver") return;
    const current = rt.state.currentPlayerId;
    const since = current ? rt.away.get(current) : undefined;
    if (!current || since === undefined) return;
    const someoneHere = rt.state.players.some((p) => !p.bankrupt && !rt.away.has(p.id));
    if (!someoneHere) return;
    const wait = Math.max(this.timings.afkStepMs, since + this.timings.afkTimeoutMs - this.now());
    rt.afkTimer = setTimeout(() => this.autoPlay(code, current), wait);
    rt.afkTimer.unref?.();
  }

  /** Plays one step for an absent player: roll, decline a purchase, stay in detention (pay only when forced). */
  private autoPlay(code: string, playerId: string): void {
    const rt = this.games.get(code);
    if (!rt || rt.state.currentPlayerId !== playerId || !rt.away.has(playerId)) return;
    const me = rt.state.players.find((p) => p.id === playerId)!;
    const base = { playerId, actionId: `auto-${playerId}-${rt.state.seq}-${++rt.autoCounter}` };
    let action: Action;
    switch (rt.state.phase) {
      case "awaitingRoll":
        action = { ...base, type: "roll" };
        break;
      case "awaitingDecision":
        action = { ...base, type: "skip" };
        break;
      case "awaitingJailChoice":
        action = { ...base, type: me.jailTurns >= 3 ? "jailPay" : "jailStay" };
        break;
      case "raisingFunds": {
        // Pay the debt when possible; otherwise mortgage a tile; with nothing left to mortgage, declare bankruptcy.
        const debt = rt.state.pendingDebt;
        const tiles = mortgageableTiles(rt.state, playerId);
        if (debt && me.cash >= debt.amount) action = { ...base, type: "payDebt" };
        else if (tiles.length) action = { ...base, type: "mortgage", tileIndex: tiles[0]! };
        else action = { ...base, type: "declareBankruptcy" };
        break;
      }
      default:
        return;
    }
    const error = this.apply(code, rt, action);
    if (error) {
      this.logger.error(`[game] AFK action failed in ${code}: ${error}`);
      this.scheduleAfk(code);
    }
  }

  /* ---------------------------------------------------------------- test hooks (NODE_ENV=test only) */

  /** Queue forced dice for the next rolls. */
  setTestDice(code: string, sequence: [number, number][]): void {
    this.requireTestMode();
    const rt = this.games.get(code);
    if (!rt) throw new GameError("GAME_NOT_STARTED");
    rt.forcedDice.push(...sequence);
  }

  /** Sets a player's cash (the difference goes to or comes from the bank, so money stays conserved). */
  setTestCash(code: string, playerId: string, cash: number): void {
    this.requireTestMode();
    const rt = this.games.get(code);
    const p = rt?.state.players.find((x) => x.id === playerId);
    if (!rt || !p) throw new GameError("GAME_NOT_STARTED");
    rt.state.bank += p.cash - cash;
    p.cash = cash;
    rt.state.seq += 1;
    this.emitter.events(code, { events: [], snapshot: toSnapshot(rt.state), seq: rt.state.seq });
  }

  private requireTestMode(): void {
    if (!this.testMode) throw new GameError("NOT_ALLOWED_IN_GAME");
  }

  /* ---------------------------------------------------------------- lifecycle */

  private drop(code: string): void {
    const rt = this.games.get(code);
    if (!rt) return;
    this.clearTimers(rt);
    this.games.delete(code);
  }

  dispose(): void {
    for (const rt of this.games.values()) this.clearTimers(rt);
    this.games.clear();
  }
}
