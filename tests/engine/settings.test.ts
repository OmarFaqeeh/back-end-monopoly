// Every room setting, ON and OFF, with boundaries. Games here start with the legacy-off defaults of the test helper
// (auctions and even build OFF) so each test switches on exactly the rule it is about.
import { describe, expect, it } from "vitest";
import { createGame, toSnapshot } from "../../src/engine/state.js";
import { propertyRent } from "../../src/shared/rent.js";
import { cashOf, dice, fail, newGame, ok, own, playerOf, posOf, types } from "../helpers/engine.js";

const T0 = 1_000_000;
const roll = (g: ReturnType<typeof newGame>, total: number, who = g.currentPlayerId!, now?: number) => ok(g, { type: "roll", playerId: who }, total, now);
const poolOf = (g: ReturnType<typeof newGame>) => toSnapshot(g).oasisPool;

describe("startingCash", () => {
  it("every player starts with the chosen amount (1000 and 5000)", () => {
    for (const startingCash of [1000, 5000]) {
      const r = createGame({ players: ["a", "b", "c"].map((id) => ({ id, characterId: null })), rules: { startingCash }, seed: 1 });
      if (!r.ok) throw new Error(r.error);
      expect(r.state.players.map((p) => p.cash)).toEqual([startingCash, startingCash, startingCash]);
      expect(r.state.rules.startingCash).toBe(startingCash);
      expect(r.events[0]).toMatchObject({ type: "GAME_STARTED", rules: { startingCash } });
    }
  });
});

describe("doubleRentSets", () => {
  const rentPaid = (rules: { doubleRentSets: boolean }, setup: (g: ReturnType<typeof newGame>) => void, total = 6) => {
    const g = newGame(["a", "b"], 1500, 1, rules);
    setup(g);
    return 1500 - cashOf(roll(g, total).state, "a");
  };
  const base = propertyRent(90, 0);

  it("ON: an unbuilt property of a complete set pays double; OFF: normal rent", () => {
    const full = (g: ReturnType<typeof newGame>) => own(g, "b", [6, 8, 9]);
    expect(rentPaid({ doubleRentSets: true }, full)).toBe(base * 2);
    expect(rentPaid({ doubleRentSets: false }, full)).toBe(base);
  });

  it("ON: not doubled for an incomplete set, with buildings, on a mortgaged tile, or on harbors and utilities", () => {
    expect(rentPaid({ doubleRentSets: true }, (g) => own(g, "b", [6, 8]))).toBe(base);
    expect(rentPaid({ doubleRentSets: true }, (g) => { own(g, "b", [6, 8, 9]); g.properties[6]!.level = 1; })).toBe(propertyRent(90, 1));
    expect(rentPaid({ doubleRentSets: true }, (g) => own(g, "b", [5, 15, 25, 35]), 5)).toBe(200); // harbors: 4 owned, never doubled
    expect(rentPaid({ doubleRentSets: true }, (g) => own(g, "b", [12, 28]), 12)).toBe(12 * 10); // utilities
  });
});

describe("oasisJackpot", () => {
  const withPool = (on: boolean) => newGame(["a", "b"], 1500, 1, { oasisJackpot: on });

  it("ON: taxes, negative cards and the jail fine feed the pool (the bank gets nothing); OFF: they go to the bank", () => {
    const g = withPool(true);
    const afterTax = roll(g, 4).state; // tax 200
    expect(poolOf(afterTax)).toBe(200);
    expect(afterTax.bank).toBe(0);

    const card = withPool(true);
    card.decks.fortune = ["F01"]; // -50
    playerOf(card, "a").position = 2;
    expect(poolOf(roll(card, 5).state)).toBe(50);

    const jail = withPool(true);
    jail.phase = "awaitingJailChoice";
    playerOf(jail, "a").inJail = true;
    playerOf(jail, "a").position = 10;
    expect(poolOf(ok(jail, { type: "jailPay", playerId: "a" }).state)).toBe(50);

    const off = withPool(false);
    const offTax = roll(off, 4).state;
    expect(poolOf(offTax)).toBe(0);
    expect(offTax.bank).toBe(200);
  });

  it("does not receive purchases, building costs or bankruptcy leftovers", () => {
    const g = withPool(true);
    const bought = ok(roll(g, 3).state, { type: "buy", playerId: "a" }).state; // tile 3 costs 50
    expect(poolOf(bought)).toBe(0);
    const built = withPool(true);
    own(built, "a", [1, 3]);
    expect(poolOf(ok(built, { type: "build", playerId: "a", tileIndex: 1, kind: "house" }).state)).toBe(0);
    const broke = withPool(true);
    playerOf(broke, "a").cash = 120;
    broke.bank += 1380;
    const out = roll(broke, 4).state; // tax 200 with 120 cash: bankrupt, leftovers go to the bank
    expect(playerOf(out, "a").bankrupt).toBe(true);
    expect(poolOf(out)).toBe(0);
  });

  it("landing on the Oasis pays the whole pool and empties it; an empty pool pays nothing; passing is not landing", () => {
    const g = withPool(true);
    g.oasisPool = 340;
    g.bank -= 340; // keep the ledger balanced for the hand-made pool
    playerOf(g, "a").position = 18;
    const passing = roll(g, 4); // 18 -> 22: passes the Oasis
    expect(poolOf(passing.state)).toBe(340);

    playerOf(g, "a").position = 14;
    const landed = roll(g, 6); // 14 -> 20
    expect(cashOf(landed.state, "a")).toBe(1500 + 340);
    expect(poolOf(landed.state)).toBe(0);
    expect(types(landed.events)).toContain("OASIS_COLLECTED");
    expect(landed.events.find((e) => e.type === "MONEY_CHANGED")).toMatchObject({ reason: "oasis", delta: 340 });

    const empty = withPool(true);
    playerOf(empty, "a").position = 14;
    expect(roll(empty, 6).events.some((e) => e.type === "MONEY_CHANGED" || e.type === "OASIS_COLLECTED")).toBe(false);
    const off = withPool(false);
    off.oasisPool = 0;
    playerOf(off, "a").position = 14;
    expect(types(roll(off, 6).events)).not.toContain("OASIS_COLLECTED");
  });
});

describe("auctions", () => {
  const atDecision = (rules: { auctions: boolean }, cash = 1500) => {
    const g = newGame(["a", "b", "c"], cash, 1, rules);
    return roll(g, 6, "a", T0).state; // a lands on tile 6 (unowned): awaitingDecision
  };

  it("OFF: skip just ends the turn. ON: skip starts an auction for everybody, including the one who skipped", () => {
    const off = ok(atDecision({ auctions: false }), { type: "skip", playerId: "a" });
    expect(off.state.phase).toBe("awaitingRoll");
    expect(off.state.currentPlayerId).toBe("b");

    const on = ok(atDecision({ auctions: true }), { type: "skip", playerId: "a" }, undefined, T0);
    expect(on.state.phase).toBe("auction");
    expect(on.state.currentPlayerId).toBe("a");
    expect(on.state.auction).toMatchObject({ tileIndex: 6, currentBid: 0, highestBidderId: null, withdrawnIds: [], endsAt: T0 + 12000, serverNow: T0 });
  });

  it("bids: minimum 10, steps of 10 on top of the current bid, at most your cash (equal is fine), the timer resets to 10 s", () => {
    let g = ok(atDecision({ auctions: true }), { type: "skip", playerId: "a" }, undefined, T0).state;
    expect(fail(g, { type: "bid", playerId: "b", amount: 9 }, undefined, T0)).toBe("AUCTION_INVALID_BID");
    expect(fail(g, { type: "bid", playerId: "b", amount: 1501 }, undefined, T0)).toBe("INSUFFICIENT_FUNDS");
    expect(fail(g, { type: "bid", playerId: "b", amount: 15.5 }, undefined, T0)).toBe("AUCTION_INVALID_BID");
    g = ok(g, { type: "bid", playerId: "b", amount: 10 }, undefined, T0 + 3000).state;
    expect(g.auction).toMatchObject({ currentBid: 10, highestBidderId: "b", endsAt: T0 + 13000 });
    expect(fail(g, { type: "bid", playerId: "c", amount: 19 }, undefined, T0 + 3100)).toBe("AUCTION_INVALID_BID"); // needs 20
    expect(fail(g, { type: "bid", playerId: "b", amount: 30 }, undefined, T0 + 3100)).toBe("AUCTION_INVALID_BID"); // you lead already
    g = ok(g, { type: "bid", playerId: "c", amount: 20 }, undefined, T0 + 4000).state;
    g = ok(g, { type: "bid", playerId: "a", amount: 1500 }, undefined, T0 + 5000).state; // bid equal to cash: nobody can outbid, so it ends at once
    expect(g.auction).toBeNull();
    expect(g.properties[6]).toEqual({ ownerId: "a", level: 0, mortgaged: false });
    expect(cashOf(g, "a")).toBe(0);
  });

  it("withdraw: a withdrawn player cannot bid again; the leader cannot withdraw; only a withdraw by others", () => {
    let g = ok(atDecision({ auctions: true }), { type: "skip", playerId: "a" }, undefined, T0).state;
    g = ok(g, { type: "bid", playerId: "b", amount: 10 }, undefined, T0).state;
    expect(fail(g, { type: "withdraw", playerId: "b" }, undefined, T0)).toBe("AUCTION_INVALID_BID");
    g = ok(g, { type: "withdraw", playerId: "c" }, undefined, T0).state;
    expect(fail(g, { type: "bid", playerId: "c", amount: 40 }, undefined, T0)).toBe("AUCTION_WITHDRAWN");
    expect(fail(g, { type: "withdraw", playerId: "c" }, undefined, T0)).toBe("AUCTION_WITHDRAWN");
  });

  it("the highest bidder buys at the bid when the timer runs out; the turn passes on; nothing early", () => {
    let g = ok(atDecision({ auctions: true }), { type: "skip", playerId: "a" }, undefined, T0).state;
    g = ok(g, { type: "bid", playerId: "b", amount: 70 }, undefined, T0 + 1000).state;
    g = ok(g, { type: "bid", playerId: "c", amount: 80 }, undefined, T0 + 2000).state;
    expect(fail(g, { type: "auctionTimeout", playerId: "system" }, undefined, T0 + 5000)).toBe("WRONG_PHASE"); // too early
    expect(fail(g, { type: "auctionTimeout", playerId: "b" }, undefined, T0 + 99_000)).toBe("NOT_YOUR_TURN"); // only the server
    const r = ok(g, { type: "auctionTimeout", playerId: "system" }, undefined, T0 + 12_001);
    expect(r.state.properties[6]).toEqual({ ownerId: "c", level: 0, mortgaged: false });
    expect(cashOf(r.state, "c")).toBe(1420);
    expect(r.events.find((e) => e.type === "MONEY_CHANGED")).toMatchObject({ reason: "auction", delta: -80 });
    expect(r.state.phase).toBe("awaitingRoll");
    expect(r.state.currentPlayerId).toBe("b"); // next after a
  });

  it("no bids: the tile stays unowned. Players under 10 cash are out from the start. It ends early when nobody else can outbid", () => {
    const none = ok(ok(atDecision({ auctions: true }), { type: "skip", playerId: "a" }, undefined, T0).state, { type: "auctionTimeout", playerId: "system" }, undefined, T0 + 12_001);
    expect(none.state.properties[6]).toBeUndefined();
    expect(none.events.find((e) => e.type === "AUCTION_ENDED")).toMatchObject({ winnerId: null });

    const g = atDecision({ auctions: true });
    for (const id of ["b", "c"]) playerOf(g, id).cash = 5;
    g.bank += 2990;
    const started = ok(g, { type: "skip", playerId: "a" }, undefined, T0).state;
    expect(started.auction!.withdrawnIds.sort()).toEqual(["b", "c"]);
    const a1 = ok(started, { type: "bid", playerId: "a", amount: 10 }, undefined, T0 + 10); // everybody else is out: it ends at once
    expect(a1.state.phase).toBe("awaitingRoll");
    expect(a1.state.properties[6]!.ownerId).toBe("a");
  });

  it("trades are paused and resigning keeps the auction going", () => {
    let g = ok(atDecision({ auctions: true }), { type: "skip", playerId: "a" }, undefined, T0).state;
    expect(fail(g, { type: "proposeTrade", playerId: "b", toId: "c", give: { tiles: [], cash: 5 }, get: { tiles: [], cash: 0 } }, undefined, T0)).toBe("WRONG_PHASE");
    g = ok(g, { type: "bid", playerId: "b", amount: 30 }, undefined, T0).state;
    const r = ok(g, { type: "resign", playerId: "b" }, undefined, T0 + 5); // the leader resigns: the lead is cleared
    expect(r.state.auction).toMatchObject({ highestBidderId: null, currentBid: 30 });
    expect(r.state.phase).toBe("auction");
  });
});

describe("noRentInDetention", () => {
  it("ON: no rent while the owner is in detention (RENT_WAIVED); OFF: rent is paid", () => {
    for (const on of [true, false]) {
      const g = newGame(["a", "b"], 1500, 1, { noRentInDetention: on });
      own(g, "b", [6]);
      playerOf(g, "b").inJail = true;
      playerOf(g, "b").position = 10;
      const r = roll(g, 6);
      expect(cashOf(r.state, "a")).toBe(on ? 1500 : 1500 - propertyRent(90, 0));
      expect(types(r.events).includes("RENT_WAIVED")).toBe(on);
      if (on) expect(r.events.find((e) => e.type === "RENT_WAIVED")).toMatchObject({ reason: "owner_in_detention" });
    }
  });
});

describe("mortgage", () => {
  const mg = (on = true) => newGame(["a", "b"], 1500, 1, { mortgage: on });

  it("OFF: no mortgage actions exist", () => {
    const g = mg(false);
    own(g, "a", [37]);
    expect(fail(g, { type: "mortgage", playerId: "a", tileIndex: 37 })).toBe("MORTGAGE_DISABLED");
  });

  it("ON: mortgage pays floor(price/2), unmortgage costs ceil(price/2 x 1.1); only on your own turn", () => {
    const g = mg();
    own(g, "a", [37, 5]); // 350 and a harbor (200)
    const m = ok(g, { type: "mortgage", playerId: "a", tileIndex: 37 });
    expect(cashOf(m.state, "a")).toBe(1500 + 175);
    expect(m.state.properties[37]!.mortgaged).toBe(true);
    expect(fail(m.state, { type: "mortgage", playerId: "a", tileIndex: 37 })).toBe("NOT_MORTGAGEABLE");
    expect(cashOf(ok(m.state, { type: "mortgage", playerId: "a", tileIndex: 5 }).state, "a")).toBe(1500 + 175 + 100);
    const u = ok(m.state, { type: "unmortgage", playerId: "a", tileIndex: 37 });
    expect(cashOf(u.state, "a")).toBe(1675 - Math.ceil((350 * 11) / 20)); // 193
    expect(fail(u.state, { type: "unmortgage", playerId: "a", tileIndex: 37 })).toBe("NOT_MORTGAGED");
    expect(fail(g, { type: "mortgage", playerId: "b", tileIndex: 37 })).toBe("NOT_YOUR_TURN");
    const odd = mg();
    own(odd, "a", [1]); // 50 -> 25; unmortgage ceil(27.5) = 28
    const m2 = ok(odd, { type: "mortgage", playerId: "a", tileIndex: 1 }).state;
    expect(cashOf(ok(m2, { type: "unmortgage", playerId: "a", tileIndex: 1 }).state, "a")).toBe(1525 - 28);
    const poor = structuredClone(m2);
    playerOf(poor, "a").cash = 27;
    poor.bank += 1498;
    expect(fail(poor, { type: "unmortgage", playerId: "a", tileIndex: 1 })).toBe("INSUFFICIENT_FUNDS");
  });

  it("a tile or a group with buildings cannot be mortgaged", () => {
    const g = mg();
    own(g, "a", [1, 3]);
    g.properties[1]!.level = 1;
    expect(fail(g, { type: "mortgage", playerId: "a", tileIndex: 1 })).toBe("NOT_MORTGAGEABLE");
    expect(fail(g, { type: "mortgage", playerId: "a", tileIndex: 3 })).toBe("NOT_MORTGAGEABLE"); // a building elsewhere in its group
  });

  it("a mortgaged tile collects no rent, blocks building on its whole group, and still counts for harbors", () => {
    const g = mg();
    own(g, "b", [6]);
    g.properties[6]!.mortgaged = true;
    const r = roll(g, 6);
    expect(cashOf(r.state, "a")).toBe(1500);
    expect(r.events.find((e) => e.type === "RENT_WAIVED")).toMatchObject({ reason: "mortgaged" });

    const build = mg();
    own(build, "a", [1, 3]);
    build.properties[3]!.mortgaged = true;
    expect(fail(build, { type: "build", playerId: "a", tileIndex: 1, kind: "house" })).toBe("GROUP_MORTGAGED");

    const harbors = mg();
    own(harbors, "b", [5, 15, 25]);
    harbors.properties[15]!.mortgaged = true;
    playerOf(harbors, "a").position = 0;
    expect(1500 - cashOf(roll(harbors, 5).state, "a")).toBe(100); // 3 harbors owned (one mortgaged) still means rent 100 from tile 5
  });

  it("raising funds: a payment that cash cannot cover but mortgages can becomes a debt; pay it, the turn goes on", () => {
    const g = mg();
    own(g, "a", [37, 39]); // 175 + 200 available
    playerOf(g, "a").cash = 100;
    g.bank += 1400;
    const debt = roll(g, 4); // tax 200 with 100 cash: shortfall 100
    expect(debt.state.phase).toBe("raisingFunds");
    expect(toSnapshot(debt.state).pendingDebt).toEqual({ amount: 200, creditorId: null, reason: "tax" });
    expect(types(debt.events)).toContain("DEBT_STARTED");
    expect(fail(debt.state, { type: "payDebt", playerId: "a" })).toBe("INSUFFICIENT_FUNDS");
    expect(fail(debt.state, { type: "roll", playerId: "a" }, 5)).toBe("WRONG_PHASE");
    expect(fail(debt.state, { type: "proposeTrade", playerId: "b", toId: "a", give: { tiles: [], cash: 1 }, get: { tiles: [], cash: 0 } })).toBe("WRONG_PHASE");
    const m = ok(debt.state, { type: "mortgage", playerId: "a", tileIndex: 39 }).state; // +200
    const paid = ok(m, { type: "payDebt", playerId: "a" });
    expect(cashOf(paid.state, "a")).toBe(100);
    expect(paid.state.pendingDebt).toBeNull();
    expect(paid.state.currentPlayerId).toBe("b");
    expect(types(paid.events)).toEqual(["MONEY_CHANGED", "DEBT_PAID", "TAX_PAID", "TURN_ENDED", "TURN_STARTED"]);
  });

  it("raising funds: rent debt goes to the owner; declaring bankruptcy hands over what is left; the Oasis jackpot gets a paid tax", () => {
    const g = mg();
    own(g, "b", [39]);
    g.properties[39]!.level = 0;
    own(g, "a", [37]);
    playerOf(g, "a").cash = 20;
    g.bank += 1480;
    playerOf(g, "a").position = 30;
    const debt = roll(g, 9); // lands on b's tile 39: rent 40, a has 20, tile 37 is worth 175
    expect(toSnapshot(debt.state).pendingDebt).toEqual({ amount: 40, creditorId: "b", reason: "rent" });
    const gone = ok(debt.state, { type: "declareBankruptcy", playerId: "a" });
    expect(playerOf(gone.state, "a").bankrupt).toBe(true);
    expect(cashOf(gone.state, "b")).toBe(1520);
    expect(gone.state.phase).toBe("gameOver");

    const pool = newGame(["a", "b"], 1500, 1, { mortgage: true, oasisJackpot: true });
    own(pool, "a", [37, 39]);
    playerOf(pool, "a").cash = 100;
    pool.bank += 1400;
    const d = roll(pool, 4).state;
    const after = ok(ok(d, { type: "mortgage", playerId: "a", tileIndex: 39 }).state, { type: "payDebt", playerId: "a" }).state;
    expect(poolOf(after)).toBe(200);
  });

  it("raising funds is skipped when mortgages cannot cover the shortfall, or the rule is off: immediate bankruptcy", () => {
    const short = mg();
    own(short, "a", [1]); // worth 25 only
    playerOf(short, "a").cash = 100;
    short.bank += 1400;
    expect(playerOf(roll(short, 4).state, "a").bankrupt).toBe(true);
    const off = mg(false);
    own(off, "a", [37, 39]);
    playerOf(off, "a").cash = 100;
    off.bank += 1400;
    expect(playerOf(roll(off, 4).state, "a").bankrupt).toBe(true);
  });

  it("a forced detention fine becomes a debt too, then the player is free and rolls", () => {
    const g = mg();
    own(g, "a", [37]);
    g.phase = "awaitingJailChoice";
    Object.assign(playerOf(g, "a"), { inJail: true, position: 10, jailTurns: 3, cash: 20 });
    g.bank += 1480;
    const pay = ok(g, { type: "jailPay", playerId: "a" });
    expect(pay.state.phase).toBe("raisingFunds");
    const done = ok(ok(pay.state, { type: "mortgage", playerId: "a", tileIndex: 37 }).state, { type: "payDebt", playerId: "a" });
    expect(done.state.phase).toBe("awaitingRoll");
    expect(playerOf(done.state, "a").inJail).toBe(false);
    expect(posOf(done.state, "a")).toBe(10);
  });
});

describe("evenBuild", () => {
  const set = (on: boolean) => {
    const g = newGame(["a", "b"], 5000, 1, { evenBuild: on });
    own(g, "a", [6, 8, 9]);
    return g;
  };

  it("ON: a house only on a lowest-level tile; a hotel only when every tile has 4 houses", () => {
    let g = set(true);
    g = ok(g, { type: "build", playerId: "a", tileIndex: 6, kind: "house" }).state;
    expect(fail(g, { type: "build", playerId: "a", tileIndex: 6, kind: "house" })).toBe("UNEVEN_BUILD"); // 6 is ahead of 8 and 9
    g = ok(g, { type: "build", playerId: "a", tileIndex: 8, kind: "house" }).state;
    g = ok(g, { type: "build", playerId: "a", tileIndex: 9, kind: "house" }).state;
    g = ok(g, { type: "build", playerId: "a", tileIndex: 6, kind: "house" }).state; // now level 1 each, 6 may go to 2
    const uneven = set(true);
    for (const t of [6, 8, 9]) uneven.properties[t]!.level = 4;
    uneven.properties[9]!.level = 3;
    expect(fail(uneven, { type: "build", playerId: "a", tileIndex: 6, kind: "hotel" })).toBe("UNEVEN_BUILD"); // 9 is below 4
    uneven.properties[9]!.level = 4;
    expect(ok(uneven, { type: "build", playerId: "a", tileIndex: 6, kind: "hotel" }).state.properties[6]!.level).toBe(5);
    void g;
  });

  it("OFF: any tile of the set in any order; the hotel only needs its own 4 houses", () => {
    let g = set(false);
    for (let i = 0; i < 4; i++) g = ok(g, { type: "build", playerId: "a", tileIndex: 6, kind: "house" }).state;
    expect(g.properties[6]!.level).toBe(4);
    expect(ok(g, { type: "build", playerId: "a", tileIndex: 6, kind: "hotel" }).state.properties[6]!.level).toBe(5);
  });
});

describe("settings keep their invariants", () => {
  it("the rules are frozen in the snapshot and unchanged after many actions", () => {
    const g = newGame(["a", "b"], 1500, 1, { oasisJackpot: true, mortgage: true });
    const after = roll(g, 4).state;
    expect(toSnapshot(after).rules).toEqual(toSnapshot(g).rules);
    expect(toSnapshot(after).rules).toMatchObject({ oasisJackpot: true, mortgage: true, auctions: false });
    void dice;
  });
});
