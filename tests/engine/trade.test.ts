import { describe, expect, it } from "vitest";
import { applyBatch } from "../../src/shared/display.js";
import { toSnapshot } from "../../src/engine/state.js";
import { cashOf, fail, newGame, ok, own, playerOf, types } from "../helpers/engine.js";

const side = (tiles: number[] = [], cash = 0) => ({ tiles, cash });
const propose = (state: ReturnType<typeof newGame>, from: string, to: string, give = side(), get = side()) =>
  ok(state, { type: "proposeTrade", playerId: from, toId: to, give, get });

describe("trading: proposing", () => {
  it("creates a pending offer visible in the snapshot; any player can propose at any time (not only on their turn)", () => {
    const g = newGame(["a", "b", "c"]);
    own(g, "a", [3]);
    own(g, "b", [6]);
    const r = propose(g, "b", "a", side([6], 20), side([3], 0)); // b is NOT the current player
    expect(types(r.events)).toEqual(["TRADE_PROPOSED"]);
    const snap = toSnapshot(r.state);
    expect(snap.trades).toEqual([{ id: "T1", fromId: "b", toId: "a", give: { tiles: [6], cash: 20 }, get: { tiles: [3], cash: 0 }, status: "pending" }]);
    expect(r.state.currentPlayerId).toBe("a"); // the turn is untouched
  });

  it("rejects bad offers: empty, to yourself, unknown, not your tile, their tile you do not hold, not buyable, buildings, funds", () => {
    const g = newGame(["a", "b"]);
    own(g, "a", [3, 1]);
    own(g, "b", [6]);
    g.properties[1]!.level = 2;
    const base = { type: "proposeTrade" as const, playerId: "a", toId: "b" };
    expect(fail(g, { ...base, give: side(), get: side() })).toBe("TRADE_INVALID");
    expect(fail(g, { ...base, toId: "a", give: side([3]), get: side() })).toBe("TRADE_INVALID");
    expect(fail(g, { ...base, toId: "zzz", give: side([3]), get: side() })).toBe("PLAYER_NOT_IN_GAME");
    expect(fail(g, { ...base, give: side([6]), get: side() })).toBe("NOT_OWNER"); // 6 is b's
    expect(fail(g, { ...base, give: side(), get: side([3]) })).toBe("NOT_OWNER"); // 3 is a's, not b's
    expect(fail(g, { ...base, give: side([4]), get: side() })).toBe("INVALID_TILE"); // tax tile
    expect(fail(g, { ...base, give: side([99]), get: side() })).toBe("INVALID_TILE");
    expect(fail(g, { ...base, give: side([1]), get: side() })).toBe("TRADE_HAS_BUILDINGS");
    expect(fail(g, { ...base, give: side([], 1501), get: side() })).toBe("INSUFFICIENT_FUNDS");
    expect(fail(g, { ...base, give: side([3, 3]), get: side() })).toBe("TRADE_INVALID"); // duplicate tile
    expect(fail(g, { ...base, give: side([], -5), get: side() })).toBe("TRADE_INVALID");
    expect(fail(g, { ...base, give: side([], 1.5), get: side() })).toBe("TRADE_INVALID");
  });

  it("allows at most 5 pending offers per player", () => {
    let g = newGame(["a", "b"]);
    for (let i = 0; i < 5; i++) g = propose(g, "a", "b", side([], 10 + i)).state;
    expect(fail(g, { type: "proposeTrade", playerId: "a", toId: "b", give: side([], 99), get: side() })).toBe("TOO_MANY_TRADES");
    expect(propose(g, "b", "a", side([], 5)).state.trades).toHaveLength(6); // the other player is not limited by a's offers
  });
});

describe("trading: answering", () => {
  const deal = () => {
    const g = newGame(["a", "b", "c"], 1500);
    own(g, "a", [1, 3]);
    own(g, "b", [6, 8, 9]);
    return propose(g, "a", "b", side([1, 3], 100), side([6, 8, 9], 40)).state;
  };

  it("accept swaps every tile, moves the net cash, conserves money, and marks the offer accepted", () => {
    const r = ok(deal(), { type: "acceptTrade", playerId: "b", tradeId: "T1" });
    const owner = (i: number) => r.state.properties[i]!.ownerId;
    expect([1, 3].map(owner)).toEqual(["b", "b"]);
    expect([6, 8, 9].map(owner)).toEqual(["a", "a", "a"]);
    expect(cashOf(r.state, "a")).toBe(1500 - 100 + 40);
    expect(cashOf(r.state, "b")).toBe(1500 + 100 - 40);
    expect(r.state.trades[0]!.status).toBe("accepted");
    expect(types(r.events)).toEqual([...Array(5).fill("PROPERTY_TRANSFERRED"), "MONEY_CHANGED", "MONEY_CHANGED", "TRADE_ACCEPTED"]);
  });

  it("only the recipient can accept or reject, only the proposer can cancel; the answer is final", () => {
    const g = deal();
    expect(fail(g, { type: "acceptTrade", playerId: "a", tradeId: "T1" })).toBe("NOT_TRADE_PARTY");
    expect(fail(g, { type: "acceptTrade", playerId: "c", tradeId: "T1" })).toBe("NOT_TRADE_PARTY");
    expect(fail(g, { type: "rejectTrade", playerId: "a", tradeId: "T1" })).toBe("NOT_TRADE_PARTY");
    expect(fail(g, { type: "cancelTrade", playerId: "b", tradeId: "T1" })).toBe("NOT_TRADE_PARTY");
    expect(fail(g, { type: "acceptTrade", playerId: "b", tradeId: "nope" })).toBe("TRADE_NOT_FOUND");

    const rejected = ok(g, { type: "rejectTrade", playerId: "b", tradeId: "T1" }).state;
    expect(rejected.trades[0]!.status).toBe("rejected");
    expect(fail(rejected, { type: "acceptTrade", playerId: "b", tradeId: "T1" })).toBe("TRADE_NOT_PENDING");
    const cancelled = ok(g, { type: "cancelTrade", playerId: "a", tradeId: "T1" }).state;
    expect(cancelled.trades[0]!.status).toBe("cancelled");
    expect(cashOf(cancelled, "a")).toBe(1500); // nothing moved
  });

  it("checks everything again at accept time: a tile that changed hands, a building, missing cash", () => {
    const g = deal();
    const moved = structuredClone(g);
    moved.properties[1]!.ownerId = "c"; // a no longer owns tile 1
    expect(fail(moved, { type: "acceptTrade", playerId: "b", tradeId: "T1" })).toBe("NOT_OWNER");
    const built = structuredClone(g);
    built.properties[6]!.level = 1;
    expect(fail(built, { type: "acceptTrade", playerId: "b", tradeId: "T1" })).toBe("TRADE_HAS_BUILDINGS");
    const poor = structuredClone(g);
    playerOf(poor, "b").cash = 30; // b must hand over 40 and has 30
    poor.bank += 1470;
    expect(fail(poor, { type: "acceptTrade", playerId: "b", tradeId: "T1" })).toBe("INSUFFICIENT_FUNDS");
    const broke = structuredClone(g);
    playerOf(broke, "a").cash = 50; // a must hand over 100
    broke.bank += 1450;
    expect(fail(broke, { type: "acceptTrade", playerId: "b", tradeId: "T1" })).toBe("INSUFFICIENT_FUNDS");
  });

  it("a cash-only offer works in both directions, and property for property needs no cash", () => {
    const g = newGame(["a", "b"]);
    own(g, "a", [3]);
    own(g, "b", [6]);
    const swap = ok(propose(g, "a", "b", side([3]), side([6])).state, { type: "acceptTrade", playerId: "b", tradeId: "T1" }).state;
    expect(swap.properties[3]!.ownerId).toBe("b");
    expect(swap.properties[6]!.ownerId).toBe("a");
    expect(cashOf(swap, "a")).toBe(1500);
    const pay = ok(propose(g, "b", "a", side([], 250), side()).state, { type: "acceptTrade", playerId: "a", tradeId: "T1" }).state;
    expect(cashOf(pay, "a")).toBe(1750);
    expect(cashOf(pay, "b")).toBe(1250);
  });

  it("a traded property keeps being the same tile for rent: the new owner collects", () => {
    const g = newGame(["a", "b"]);
    own(g, "a", [3]);
    const traded = ok(propose(g, "a", "b", side([3]), side()).state, { type: "acceptTrade", playerId: "b", tradeId: "T1" }).state;
    expect(traded.properties[3]!.ownerId).toBe("b");
  });
});

describe("trading and leaving the game", () => {
  it("pending offers of a player who resigns or goes bankrupt are cancelled", () => {
    let g = newGame(["a", "b", "c"]);
    own(g, "a", [3]);
    g = propose(g, "a", "b", side([3]), side()).state; // T1 a -> b
    g = propose(g, "c", "b", side([], 10), side()).state; // T2 c -> b
    const r = ok(g, { type: "resign", playerId: "a" });
    expect(r.state.trades.map((t) => [t.id, t.status])).toEqual([["T1", "cancelled"], ["T2", "pending"]]);
    expect(fail(r.state, { type: "acceptTrade", playerId: "b", tradeId: "T1" })).toBe("TRADE_NOT_PENDING");
  });

  it("cannot trade after the game is over or with a bankrupt player", () => {
    let g = newGame(["a", "b", "c"]);
    g = ok(g, { type: "resign", playerId: "b" }).state;
    expect(fail(g, { type: "proposeTrade", playerId: "a", toId: "b", give: side([], 5), get: side() })).toBe("TRADE_INVALID");
    const over = ok(g, { type: "resign", playerId: "c" }).state;
    expect(over.phase).toBe("gameOver");
    expect(fail(over, { type: "proposeTrade", playerId: "a", toId: "c", give: side([], 5), get: side() })).toBe("WRONG_PHASE");
  });
});

describe("trading: events rebuild the snapshot", () => {
  it("the display reducer reproduces the snapshot after propose, accept, reject and cancel", () => {
    const g = newGame(["a", "b", "c"]);
    own(g, "a", [1, 3]);
    own(g, "b", [6]);
    let state = g;
    let display = applyBatch(null, [{ type: "GAME_STARTED", players: state.players.map((p) => ({ id: p.id, characterId: p.characterId, cash: p.cash })), rules: state.rules }, { type: "TURN_STARTED", playerId: "a", turnNumber: 1, phase: "awaitingRoll" }], 0)!;
    display = { ...display, properties: structuredClone(state.properties) };
    const steps = [
      { type: "proposeTrade", playerId: "a", toId: "b", give: side([1], 30), get: side([6], 0) },
      { type: "proposeTrade", playerId: "c", toId: "a", give: side([], 10), get: side() },
      { type: "rejectTrade", playerId: "a", tradeId: "T2" },
      { type: "acceptTrade", playerId: "b", tradeId: "T1" },
      { type: "proposeTrade", playerId: "b", toId: "a", give: side([1]), get: side() },
      { type: "cancelTrade", playerId: "b", tradeId: "T3" },
      { type: "resign", playerId: "c" },
    ] as const;
    for (const step of steps) {
      const r = ok(state, step as never);
      state = r.state;
      display = applyBatch(display, r.events, state.seq)!;
      expect(display).toEqual(toSnapshot(state));
    }
  });
});
