// 1 human + 3 bots through the GameManager with a fake clock: the bots answer and propose trades, bid in auctions,
// mortgage to pay debts, and never play an illegal move. State is arranged through the runtime (test-only access).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TIMINGS } from "../src/config/defaults.js";
import { GameManager } from "../src/game/gameManager.js";
import { BotManager } from "../src/rooms/botManager.js";
import { RoomManager } from "../src/rooms/roomManager.js";
import { InMemoryRoomRepository } from "../src/services/roomRepository.js";
import type { GameEvent } from "../src/shared/events.js";
import { dice } from "./helpers/engine.js";

let manager: RoomManager;
let bots: BotManager;
let game: GameManager;
const events: GameEvent[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  events.length = 0;
  manager = new RoomManager({ repo: new InMemoryRoomRepository(), logger: { error: () => {} } });
  bots = new BotManager(manager);
  game = new GameManager({ manager, testMode: true, timings: { ...DEFAULT_TIMINGS, afkTimeoutMs: 600_000, turnIdleKickMs: 3_600_000 }, logger: { error: () => {} } });
  game.emitter = { started: () => {}, over: () => {}, events: (_c, p) => events.push(...p.events) };
});
afterEach(() => {
  bots.dispose();
  game.dispose();
  manager.dispose();
  vi.useRealTimers();
});

/* eslint-disable @typescript-eslint/no-explicit-any */
const runtime = (code: string) => (game as any).games.get(code) as { state: any; bots: Map<string, { personality: string; mem: any }> };

async function start(settings: Record<string, unknown> = {}) {
  const created = await manager.createRoom("Omar");
  await manager.join({ code: created.code, nickname: "Omar", playerId: created.playerId, playerToken: created.playerToken, socketId: "s-host" });
  await manager.selectCharacter(created.code, created.playerId, "c01");
  await manager.updateSettings(created.code, created.playerId, { allowBots: true, ...settings });
  await vi.advanceTimersByTimeAsync(0);
  game.start(created.code, created.playerId);
  const human = created.playerId;
  const code = created.code;
  const botIds = manager.getBots(code).map((b) => b.id);
  let n = 0;
  const act = (a: object) => game.act(code, human, { actionId: `h${++n}`, ...a } as never);
  const snap = () => game.getSnapshot(code)!;
  /** Lets the clock run until it is the human's turn in the given phase. */
  const untilHuman = async (phase = "awaitingRoll") => {
    for (let i = 0; i < 400 && !(snap().currentPlayerId === human && snap().phase === phase); i++) await vi.advanceTimersByTimeAsync(1_000);
    expect(snap().currentPlayerId).toBe(human);
  };
  return { code, human, botIds, act, snap, untilHuman };
}

describe("1 human + 3 bots", () => {
  it("starts with three bots; they play, and no bot action is ever rejected", async () => {
    const g = await start();
    expect(g.botIds).toHaveLength(3);
    expect(g.snap().players).toHaveLength(4);
    // The human skips their roll-ups by being "AFK-free": roll when it is their turn, and let the bots play in between.
    for (let turn = 0; turn < 6; turn++) {
      await g.untilHuman();
      g.act({ type: "roll" });
      await vi.advanceTimersByTimeAsync(6_000);
      if (g.snap().phase === "awaitingDecision" && g.snap().currentPlayerId === g.human) g.act({ type: "skip" });
      if (g.snap().phase === "auction") await vi.advanceTimersByTimeAsync(20_000);
    }
    expect(game.rejectedBotActions).toBe(0);
    expect(events.some((e) => e.type === "DICE_ROLLED" && g.botIds.includes(e.playerId))).toBe(true);
  }, 60_000);

  it("a bot takes part in an auction (the human skips a tile and the bots bid within their limits)", async () => {
    const g = await start({ auctions: true });
    await g.untilHuman();
    game.setTestDice(g.code, [dice(6)]); // tile 6 (Patagonia, 90)
    g.act({ type: "roll" });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(g.snap().phase).toBe("awaitingDecision");
    g.act({ type: "skip" });
    expect(g.snap().phase).toBe("auction");
    await vi.advanceTimersByTimeAsync(40_000); // bots think, bid, the timer runs out
    const bids = events.filter((e) => e.type === "AUCTION_BID") as { playerId: string; amount: number }[];
    expect(events.some((e) => e.type === "AUCTION_ENDED")).toBe(true);
    for (const b of bids) {
      expect(g.botIds).toContain(b.playerId);
      expect(b.amount).toBeLessThanOrEqual(Math.floor(1.6 * 90) + 10); // the highest personality ceiling is 1.6x
    }
    expect(game.rejectedBotActions).toBe(0);
  }, 60_000);

  it("a bot that cannot pay raises funds by mortgaging, then pays the debt", async () => {
    const g = await start({ mortgage: true, auctions: false });
    const rt = runtime(g.code);
    const botId = g.botIds[0]!;
    // Give the bot two expensive tiles and almost no cash, then make it land on the tax tile.
    const s = rt.state;
    s.properties[37] = { ownerId: botId, level: 0, mortgaged: false };
    s.properties[39] = { ownerId: botId, level: 0, mortgaged: false };
    const bot = s.players.find((p: any) => p.id === botId);
    s.bank += bot.cash - 100;
    bot.cash = 100;
    bot.position = 0;
    s.currentPlayerId = botId;
    s.phase = "awaitingRoll";
    game.setTestDice(g.code, [dice(4)]); // tile 4: tax 200
    await vi.advanceTimersByTimeAsync(40_000);
    const types = events.map((e) => e.type);
    expect(types).toContain("DEBT_STARTED");
    expect(types).toContain("PROPERTY_MORTGAGED");
    expect(types).toContain("DEBT_PAID");
    expect(game.rejectedBotActions).toBe(0);
  }, 60_000);
});

describe("trades with a bot", () => {
  /** The human owns tile 8; the bot owns 6 and 9 (so tile 8 completes the bot's set). */
  async function setup() {
    const g = await start({ auctions: false });
    const rt = runtime(g.code);
    const botId = g.botIds[0]!;
    rt.bots.get(botId)!.personality = "balanced";
    rt.state.properties[8] = { ownerId: g.human, level: 0, mortgaged: false };
    rt.state.properties[6] = { ownerId: botId, level: 0, mortgaged: false };
    rt.state.properties[9] = { ownerId: botId, level: 0, mortgaged: false };
    return { ...g, botId, rt };
  }
  const status = (g: { snap: () => { trades: { id: string; status: string }[] } }, id: string) => g.snap().trades.find((t) => t.id === id)?.status;

  it("answers within 3 to 7 s (plus pacing): a lowball is rejected, an improved offer is accepted, a fair one too", async () => {
    const g = await setup();
    // The human asks for the bot's tile 6 and offers almost nothing: rejected.
    g.act({ type: "proposeTrade", toId: g.botId, give: { tiles: [], cash: 10 }, get: { tiles: [6], cash: 0 } });
    expect(status(g, "T1")).toBe("pending");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(status(g, "T1")).toBe("pending"); // it takes its time
    await vi.advanceTimersByTimeAsync(20_000);
    expect(status(g, "T1")).toBe("rejected");
    // The human improves the offer; the bot judges it by the same rules and accepts.
    g.act({ type: "proposeTrade", toId: g.botId, give: { tiles: [], cash: 400 }, get: { tiles: [6], cash: 0 } });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(status(g, "T2")).toBe("accepted");
    expect(g.snap().properties[6]!.ownerId).toBe(g.human);
    expect(game.rejectedBotActions).toBe(0);
  }, 60_000);

  it("never hands the human a complete set cheaply", async () => {
    const g = await setup();
    g.rt.state.properties[6] = { ownerId: g.human, level: 0, mortgaged: false }; // the human has 6 and 8; the bot owns 9
    g.act({ type: "proposeTrade", toId: g.botId, give: { tiles: [], cash: 60 }, get: { tiles: [9], cash: 0 } });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(status(g, "T1")).toBe("rejected");
    expect(g.snap().properties[9]!.ownerId).toBe(g.botId);
  }, 60_000);

  it("proposes a fair set-completing deal once the game is 3 minutes old, and not before", async () => {
    const g = await setup();
    g.rt.bots.get(g.botId)!.personality = "collector"; // proposes most often
    await vi.advanceTimersByTimeAsync(150_000);
    expect(events.some((e) => e.type === "TRADE_PROPOSED")).toBe(false); // too early
    for (let i = 0; i < 30 && !events.some((e) => e.type === "TRADE_PROPOSED"); i++) await vi.advanceTimersByTimeAsync(10_000);
    const proposed = events.find((e) => e.type === "TRADE_PROPOSED") as { trade: { fromId: string; toId: string; get: { tiles: number[] } } } | undefined;
    expect(proposed).toBeTruthy();
    expect(proposed!.trade.fromId).toBe(g.botId);
    expect(proposed!.trade.toId).toBe(g.human);
    expect(proposed!.trade.get.tiles).toEqual([8]);
    // At most one proposal per 90 s from this bot.
    const count = () => events.filter((e) => e.type === "TRADE_PROPOSED").length;
    const first = count();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(count()).toBe(first);
    expect(game.rejectedBotActions).toBe(0);
  }, 120_000);
});
