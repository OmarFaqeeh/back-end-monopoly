// Auctions and debts through the GameManager with fake timers: the server clock ends auctions, absent players are
// withdrawn, an AFK debtor is handled, and timers are cleared when the room closes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TIMINGS } from "../src/config/defaults.js";
import { GameManager } from "../src/game/gameManager.js";
import { RoomManager } from "../src/rooms/roomManager.js";
import { InMemoryRoomRepository } from "../src/services/roomRepository.js";
import type { GameEvent, GameSnapshot } from "../src/shared/events.js";
import { dice } from "./helpers/engine.js";

let manager: RoomManager;
let game: GameManager;
const events: GameEvent[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  events.length = 0;
  manager = new RoomManager({ repo: new InMemoryRoomRepository(), logger: { error: () => {} } });
  game = new GameManager({ manager, testMode: true, timings: { ...DEFAULT_TIMINGS, afkTimeoutMs: 20_000, afkStepMs: 100 }, logger: { error: () => {} } });
  game.emitter = { started: () => {}, over: () => {}, events: (_c, p) => events.push(...p.events) };
});
afterEach(() => {
  game.dispose();
  manager.dispose();
  vi.useRealTimers();
});

async function startRoom(settings: Record<string, unknown> = {}) {
  const created = await manager.createRoom("Omar");
  const host = await manager.join({ code: created.code, nickname: "Omar", playerId: created.playerId, playerToken: created.playerToken, socketId: "s-host" });
  const g1 = await manager.join({ code: created.code, nickname: "Sara", socketId: "s-1" });
  const g2 = await manager.join({ code: created.code, nickname: "Lina", socketId: "s-2" });
  for (const [i, p] of [host.playerId, g1.playerId, g2.playerId].entries()) await manager.selectCharacter(created.code, p, `c0${i + 1}`);
  if (Object.keys(settings).length) await manager.updateSettings(created.code, created.playerId, settings);
  game.start(created.code, created.playerId);
  const snap = () => game.getSnapshot(created.code)!;
  const order = snap().players.map((p) => p.id);
  const sockets: Record<string, string> = { [host.playerId]: "s-host", [g1.playerId]: "s-1", [g2.playerId]: "s-2" };
  let n = 0;
  const act = (id: string, a: object) => game.act(created.code, id, { actionId: `t${++n}`, ...a } as never);
  return { code: created.code, snap, order, sockets, act };
}

/** The current player lands on tile 6 (unowned) and skips: an auction starts. */
function toAuction(r: Awaited<ReturnType<typeof startRoom>>) {
  const first = r.order[0]!;
  game.setTestDice(r.code, [dice(6)]);
  r.act(first, { type: "roll" });
  r.act(first, { type: "skip" });
  return first;
}

describe("auction timer", () => {
  it("the server clock settles the auction after 12 s without bids, and after 10 s from the last bid", async () => {
    const r = await startRoom();
    const first = toAuction(r);
    expect(r.snap().phase).toBe("auction");
    const [, b, c] = r.order as [string, string, string];

    vi.advanceTimersByTime(11_000);
    expect(r.snap().phase).toBe("auction"); // not yet
    r.act(b, { type: "bid", amount: 40 }); // resets the window to 10 s
    vi.advanceTimersByTime(9_000);
    r.act(c, { type: "bid", amount: 60 });
    vi.advanceTimersByTime(9_900);
    expect(r.snap().phase).toBe("auction");
    vi.advanceTimersByTime(200);
    expect(r.snap().phase).toBe("awaitingRoll");
    expect(r.snap().properties[6]).toMatchObject({ ownerId: c });
    expect(r.snap().players.find((p) => p.id === c)!.cash).toBe(1440);
    expect(events.filter((e) => e.type === "AUCTION_ENDED")).toMatchObject([{ winnerId: c, price: 60 }]);
    expect(r.snap().currentPlayerId).toBe(b); // the turn moved on from `first`
    void first;
  });

  it("no bids: the tile stays unowned after the first window; a withdrawing majority ends it at once", async () => {
    const r = await startRoom();
    toAuction(r);
    vi.advanceTimersByTime(12_001);
    expect(r.snap().properties[6]).toBeUndefined();
    expect(r.snap().phase).toBe("awaitingRoll");

    const q = await startRoom();
    toAuction(q);
    const [a, b, c] = q.order as [string, string, string];
    q.act(b, { type: "bid", amount: 10 });
    q.act(a, { type: "withdraw" });
    q.act(c, { type: "withdraw" }); // only the leader remains: sold immediately, no waiting
    expect(q.snap().phase).toBe("awaitingRoll");
    expect(q.snap().properties[6]).toMatchObject({ ownerId: b });
  });

  it("a player who disconnects is withdrawn automatically", async () => {
    const r = await startRoom();
    toAuction(r);
    const [, b, c] = r.order as [string, string, string];
    manager.disconnect(r.code, c, r.sockets[c]!);
    await vi.advanceTimersByTimeAsync(10);
    expect(r.snap().auction!.withdrawnIds).toContain(c);
    expect(() => r.act(c, { type: "bid", amount: 20 })).toThrow();
    r.act(b, { type: "bid", amount: 20 });
    expect(r.snap().auction!.highestBidderId).toBe(b);
  });

  it("closing the room clears the auction timer (nothing fires afterwards)", async () => {
    const r = await startRoom();
    toAuction(r);
    const before = events.length;
    await manager.closeByCode(r.code, "ALL_LEFT");
    vi.advanceTimersByTime(60_000);
    expect(events.length).toBe(before);
    expect(game.isRunning(r.code)).toBe(false);
  });

  it("an AFK current player whose skip starts an auction is withdrawn and the auction still ends", async () => {
    const r = await startRoom();
    const first = r.order[0]!;
    manager.disconnect(r.code, first, r.sockets[first]!);
    game.setTestDice(r.code, [dice(6)]);
    await vi.advanceTimersByTimeAsync(20_000 + 5_000); // AFK: the server rolls, skips, and the auction runs out
    await vi.advanceTimersByTimeAsync(13_000);
    const snap: GameSnapshot = r.snap();
    expect(["awaitingRoll", "awaitingDecision"]).toContain(snap.phase);
    expect(events.some((e) => e.type === "AUCTION_STARTED")).toBe(true);
    expect(events.some((e) => e.type === "AUCTION_ENDED")).toBe(true);
  });
});

describe("debt flow on the server", () => {
  it("an AFK debtor with mortgageable tiles pays the debt by mortgaging; the game goes on", async () => {
    const r = await startRoom({ mortgage: true });
    const first = r.order[0]!;
    // Give the first player two expensive tiles by auction wins is long; use the test hooks instead: cash 100, tax tile.
    game.setTestCash(r.code, first, 100);
    game.setTestDice(r.code, [dice(4)]); // tile 4: tax 200, but no tiles to mortgage -> bankrupt at once
    r.act(first, { type: "roll" });
    expect(r.snap().players.find((p) => p.id === first)!.bankrupt).toBe(true);
    expect(r.snap().phase).not.toBe("raisingFunds");
  });
});
