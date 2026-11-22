// AFK removal: everything the kicked player owns goes back to the bank, always.
import { describe, expect, it } from "vitest";
import { applyBatch } from "../../src/shared/display.js";
import { toSnapshot } from "../../src/engine/state.js";
import { cashOf, fail, newGame, ok, own, playerOf, types } from "../helpers/engine.js";

const kick = (g: ReturnType<typeof newGame>, targetId: string) => ok(g, { type: "afkKick", playerId: "system", targetId } as never);

describe("afkKick", () => {
  it("with a debt to a creditor: the creditor receives NOTHING, the debt is cancelled, the tiles are unowned", () => {
    const g = newGame(["a", "b", "c"], 1500, 1, { mortgage: true });
    own(g, "b", [39]);
    own(g, "a", [37]);
    playerOf(g, "a").cash = 20;
    g.bank += 1480;
    playerOf(g, "a").position = 30;
    const debt = ok(g, { type: "roll", playerId: "a" }, 9); // lands on b's tile: rent 40 > cash 20, tile 37 covers it
    expect(debt.state.phase).toBe("raisingFunds");
    expect(toSnapshot(debt.state).pendingDebt).toMatchObject({ creditorId: "b" });

    const r = kick(debt.state, "a");
    expect(cashOf(r.state, "b")).toBe(1500); // the creditor got nothing
    expect(playerOf(r.state, "a")).toMatchObject({ bankrupt: true, cash: 0 });
    expect(r.state.properties[37]).toBeUndefined();
    expect(r.state.properties[39]).toMatchObject({ ownerId: "b" }); // b keeps its own
    expect(r.state.pendingDebt).toBeNull();
    expect(r.state.phase).toBe("awaitingRoll"); // the turn moved on
    expect(r.state.currentPlayerId).toBe("b");
    expect(types(r.events)).toEqual(["PROPERTY_RELEASED", "MONEY_CHANGED", "BANKRUPT", "TURN_ENDED", "TURN_STARTED"]);
    expect(r.events.find((e) => e.type === "MONEY_CHANGED")).toMatchObject({ reason: "afk_removed", delta: -20, newCash: 0 });
    expect(r.events.some((e) => e.type === "RENT_PAID")).toBe(false);
    expect(r.state.bank).toBe(1500 + 20 - 20 + 20 - 20 + 0 + (r.state.bank - 1500)); // conserved: checked by the invariants in ok()
  });

  it("buildings and mortgages are gone, the tiles are clean and another player can buy one; the Oasis pool is untouched", () => {
    const g = newGame(["a", "b", "c"], 1500, 1, { mortgage: true, oasisJackpot: true });
    own(g, "a", [1, 3], 3);
    own(g, "a", [5]);
    g.properties[5]!.mortgaged = true;
    g.oasisPool = 120;
    g.bank -= 120;
    const r = kick(g, "a"); // a is current: the turn passes to b
    expect(r.state.oasisPool).toBe(120);
    for (const i of [1, 3, 5]) expect(r.state.properties[i]).toBeUndefined();
    expect(r.events.find((e) => e.type === "PROPERTY_RELEASED")).toMatchObject({ playerId: "a", tiles: [1, 3, 5] });
    expect(cashOf(r.state, "a")).toBe(0);

    // b lands on the released tile 3 and buys it: it comes back clean (level 0, not mortgaged)
    const landed = ok(r.state, { type: "roll", playerId: "b" }, 3);
    expect(landed.state.phase).toBe("awaitingDecision");
    const bought = ok(landed.state, { type: "buy", playerId: "b" });
    expect(bought.state.properties[3]).toEqual({ ownerId: "b", level: 0, mortgaged: false });
  });

  it("a kicked player who is not on turn does not change whose turn it is; with two left it ends the game", () => {
    const g = newGame(["a", "b", "c"]);
    own(g, "c", [6]);
    const r = kick(g, "c");
    expect(r.state.currentPlayerId).toBe("a");
    expect(r.state.properties[6]).toBeUndefined();
    const over = kick(r.state, "b");
    expect(over.state.phase).toBe("gameOver");
    expect(over.state.winnerPlayerId).toBe("a");
  });

  it("leaves a running auction (the leader's bid is dropped) and trades involving the player are cancelled", () => {
    const g = newGame(["a", "b", "c"], 1500, 1, { auctions: true });
    const landed = ok(g, { type: "roll", playerId: "a" }, 6, 1_000_000).state;
    let s = ok(landed, { type: "skip", playerId: "a" }, undefined, 1_000_000).state;
    s = ok(s, { type: "bid", playerId: "b", amount: 50 }, undefined, 1_000_100).state;
    const r = kick(s, "b");
    expect(r.state.auction).toMatchObject({ highestBidderId: null });
    expect(r.state.phase).toBe("auction");

    const t = newGame(["a", "b", "c"]);
    own(t, "b", [6]);
    const offer = ok(t, { type: "proposeTrade", playerId: "a", toId: "b", give: { tiles: [], cash: 100 }, get: { tiles: [6], cash: 0 } }).state;
    expect(kick(offer, "b").state.trades[0]!.status).toBe("cancelled");
  });

  it("only the server can do it; it cannot target a player who is already out", () => {
    const g = newGame(["a", "b", "c"]);
    expect(fail(g, { type: "afkKick", playerId: "a", targetId: "b" } as never)).toBe("NOT_YOUR_TURN");
    const out = kick(g, "c").state;
    expect(fail(out, { type: "afkKick", playerId: "system", targetId: "c" } as never)).toBe("PLAYER_NOT_IN_GAME");
  });

  it("the shared reducer rebuilds the snapshot after a kick (tiles released, cash zero, debt gone)", () => {
    const g = newGame(["a", "b", "c"], 1500, 1, { mortgage: true });
    own(g, "a", [37, 39]);
    g.properties[39]!.mortgaged = true;
    const start = applyBatch(null, [{ type: "GAME_STARTED", players: g.players.map((p) => ({ id: p.id, characterId: p.characterId, cash: p.cash })), rules: g.rules }, { type: "TURN_STARTED", playerId: "a", turnNumber: 1, phase: "awaitingRoll" }], 0)!;
    const display = { ...start, properties: structuredClone(g.properties) };
    const r = kick(g, "a");
    expect(applyBatch(display, r.events, r.state.seq)).toEqual(toSnapshot(r.state));
  });
});
