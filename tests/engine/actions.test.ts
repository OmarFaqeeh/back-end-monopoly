import { describe, expect, it } from "vitest";
import { applyAction } from "../../src/engine/actions.js";
import { checkInvariants, createGame, toSnapshot } from "../../src/engine/state.js";
import { propertyRent } from "../../src/shared/rent.js";
import { cashOf, dice, fail, newGame, ok, own, playerOf, posOf, types } from "../helpers/engine.js";

const roll = (state: ReturnType<typeof newGame>, total: number, who = state.currentPlayerId!) => ok(state, { type: "roll", playerId: who }, total);

describe("createGame", () => {
  it("shuffles the turn order with the seed (deterministic) and needs 2 players", () => {
    const players = ["a", "b", "c", "d"].map((id) => ({ id, characterId: null }));
    const order = (seed: number) => {
      const r = createGame({ players, startingCash: 1500, seed });
      if (!r.ok) throw new Error(r.error);
      return r.state.players.map((p) => p.id).join("");
    };
    expect(order(7)).toBe(order(7));
    expect(new Set([1, 2, 3, 4, 5, 6, 7, 8].map(order)).size).toBeGreaterThan(1);
    expect(createGame({ players: [players[0]!], startingCash: 1500, seed: 1 })).toEqual({ ok: false, error: "NEED_2_PLAYERS" });
  });

  it("starts the first player on awaitingRoll and never leaks the seed or the decks", () => {
    const g = newGame(["a", "b", "c"]);
    const snap = toSnapshot(g);
    expect(snap.phase).toBe("awaitingRoll");
    expect(Object.keys(snap).sort()).toEqual(["auction", "currentPlayerId", "lastRoll", "oasisPool", "pendingDebt", "pendingDecision", "phase", "players", "properties", "rules", "seq", "trades", "turnNumber", "winnerPlayerId"]);
    expect(JSON.stringify(snap)).not.toMatch(/"rng"|"decks"|"bank"|"processed"/);
    expect(snap.players.every((p) => p.cash === 1500 && p.position === 0)).toBe(true);
  });
});

describe("movement and Start salary", () => {
  it("moves by the dice total and passes the turn when nothing happens", () => {
    const { state, events } = roll(newGame(), 5); // tile 5 = harbor, unowned -> buy decision
    expect(posOf(state, "a")).toBe(5);
    expect(types(events)).toEqual(["DICE_ROLLED", "MOVED", "LANDED"]);
    expect(state.phase).toBe("awaitingDecision");
    expect(state.pendingDecision).toEqual({ kind: "buy", tileIndex: 5, price: 200 });
  });

  it("wraps around the board and pays the salary when passing Start", () => {
    const g = newGame();
    playerOf(g, "a").position = 35;
    const { state, events } = roll(g, 7); // 35 + 7 = 42 -> tile 2 (vault)
    expect(posOf(state, "a")).toBe(2);
    expect(types(events)).toContain("PASSED_START");
    const moved = events.find((e) => e.type === "MOVED");
    expect(moved).toMatchObject({ from: 35, to: 2, path: [36, 37, 38, 39, 0, 1, 2] });
    expect(events.find((e) => e.type === "MONEY_CHANGED" && e.reason === "start")).toMatchObject({ delta: 200 });
  });

  it("pays the salary when landing exactly on Start", () => {
    const g = newGame();
    playerOf(g, "a").position = 28;
    const { state } = roll(g, 12);
    expect(posOf(state, "a")).toBe(0);
    expect(cashOf(state, "a")).toBe(1700);
  });

  it("does not pay the salary when sent to detention", () => {
    const g = newGame();
    playerOf(g, "a").position = 25;
    const { state, events } = roll(g, 5); // 30 = go to detention
    expect(posOf(state, "a")).toBe(10);
    expect(playerOf(state, "a").inJail).toBe(true);
    expect(cashOf(state, "a")).toBe(1500);
    expect(types(events)).toContain("SENT_TO_JAIL");
    expect(state.currentPlayerId).toBe("b");
  });
});

describe("buying", () => {
  it("buy takes the price, assigns the owner and passes the turn", () => {
    const { state } = ok(roll(newGame(), 3).state, { type: "buy", playerId: "a" });
    expect(cashOf(state, "a")).toBe(1450);
    expect(state.properties[3]).toEqual({ ownerId: "a", level: 0, mortgaged: false });
    expect(state.currentPlayerId).toBe("b");
    expect(state.phase).toBe("awaitingRoll");
  });

  it("rejects buy without enough cash but allows skip", () => {
    const g = roll(newGame(), 3).state;
    playerOf(g, "a").cash = 10;
    g.bank += 1490;
    expect(fail(g, { type: "buy", playerId: "a" })).toBe("INSUFFICIENT_FUNDS");
    const { state, events } = ok(g, { type: "skip", playerId: "a" });
    expect(types(events)).toContain("PROPERTY_SKIPPED");
    expect(state.properties[3]).toBeUndefined();
    expect(state.currentPlayerId).toBe("b");
  });

  it("does nothing on your own tile", () => {
    const g = newGame();
    own(g, "a", [3]);
    const { state, events } = roll(g, 3);
    expect(events.some((e) => e.type === "MONEY_CHANGED")).toBe(false);
    expect(state.currentPlayerId).toBe("b");
  });
});

describe("rent", () => {
  it("property rent follows the building level", () => {
    for (const level of [0, 1, 2, 3, 4, 5]) {
      const g = newGame();
      own(g, "b", [6], level);
      const { state } = roll(g, 6);
      const rent = propertyRent(90, level);
      expect(cashOf(state, "a")).toBe(1500 - rent);
      expect(cashOf(state, "b")).toBe(1500 + rent);
    }
  });

  it("harbor rent depends on harbors owned", () => {
    for (const [owned, rent] of [[[15], 25], [[15, 25], 50], [[15, 25, 35], 100], [[5, 15, 25, 35], 200]] as const) {
      const g = newGame();
      playerOf(g, "a").position = 9;
      own(g, "b", [...owned]);
      const { state } = roll(g, 6); // 9 + 6 = 15
      expect(cashOf(state, "a")).toBe(1500 - rent);
    }
  });

  it("utility rent is the dice total times 4 (one utility) or 10 (both)", () => {
    const one = newGame();
    own(one, "b", [12]);
    expect(cashOf(roll(one, 12).state, "a")).toBe(1500 - 12 * 4);
    const both = newGame();
    own(both, "b", [12, 28]);
    playerOf(both, "a").position = 5;
    expect(cashOf(roll(both, 7).state, "a")).toBe(1500 - 7 * 10);
  });

  it("emits one MONEY_CHANGED per cash change, then RENT_PAID", () => {
    const g = newGame();
    own(g, "b", [6]);
    const { events } = roll(g, 6);
    expect(types(events)).toEqual(["DICE_ROLLED", "MOVED", "LANDED", "MONEY_CHANGED", "MONEY_CHANGED", "RENT_PAID", "TURN_ENDED", "TURN_STARTED"]);
  });
});

describe("taxes and cards", () => {
  it("tax tiles take 200 and 100 for the bank", () => {
    expect(cashOf(roll(newGame(), 4).state, "a")).toBe(1300);
    const g = newGame();
    playerOf(g, "a").position = 30;
    expect(cashOf(roll(g, 8).state, "a")).toBe(1400);
  });

  it("cards are deterministic by seed and cycle when exhausted", () => {
    const draw = (seed: number) => {
      let g = newGame(["a", "b"], 100000, seed);
      const drawn: string[] = [];
      for (let i = 0; i < 14; i++) {
        playerOf(g, g.currentPlayerId!).position = 2;
        const r = roll(g, 5); // 2 + 5 = 7 fortune
        drawn.push((r.events.find((e) => e.type === "CARD_DRAWN") as { cardId: string }).cardId);
        g = r.state;
      }
      return drawn;
    };
    const first = draw(11);
    expect(draw(11)).toEqual(first);
    expect(draw(12)).not.toEqual(first);
    expect(new Set(first.slice(0, 12)).size).toBe(12); // every card once per cycle
    expect(first[12]).toBe(first[0]); // then the same order again
    expect(first[13]).toBe(first[1]);
  });

  it("a card applies its money amount (gain from the bank, loss to the bank)", () => {
    let g = newGame(["a", "b"], 100000, 5);
    for (let i = 0; i < 24; i++) {
      playerOf(g, g.currentPlayerId!).position = 2;
      const before = cashOf(g, g.currentPlayerId!);
      const r = roll(g, 5);
      const card = r.events.find((e) => e.type === "CARD_DRAWN") as { amount: number };
      expect(cashOf(r.state, g.currentPlayerId!) - before).toBe(card.amount);
      g = r.state;
    }
  });
});

describe("detention", () => {
  const jailed = () => {
    const g = newGame();
    playerOf(g, "a").position = 25;
    let s = roll(g, 5).state; // a goes to detention, b's turn
    s = ok(s, { type: "skip", playerId: "b" }, undefined).state ?? s;
    return s;
  };
  const toJailChoice = () => {
    const g = newGame();
    playerOf(g, "a").position = 25;
    let s = roll(g, 5).state;
    // b rolls onto a harmless tile (Oasis = 20 from 10? use 0 -> 8? keep simple: tile 20 is oasis)
    playerOf(s, "b").position = 8;
    s = roll(s, 12).state; // 8 + 12 = 20 oasis
    return s;
  };

  it("a jailed player starts the turn in awaitingJailChoice", () => {
    const s = toJailChoice();
    expect(s.currentPlayerId).toBe("a");
    expect(s.phase).toBe("awaitingJailChoice");
    expect(fail(s, { type: "roll", playerId: "a" }, 5)).toBe("WRONG_PHASE");
    void jailed;
  });

  it("jailPay costs 50, frees the player and the roll happens in the same turn", () => {
    const s = toJailChoice();
    const paid = ok(s, { type: "jailPay", playerId: "a" });
    expect(cashOf(paid.state, "a")).toBe(1450);
    expect(playerOf(paid.state, "a").inJail).toBe(false);
    expect(paid.state.phase).toBe("awaitingRoll");
    expect(paid.state.currentPlayerId).toBe("a");
    const moved = roll(paid.state, 3); // 10 + 3 = 13
    expect(posOf(moved.state, "a")).toBe(13);
  });

  it("jailStay counts up, ends the turn, and after 3 stays only paying is allowed", () => {
    let s = toJailChoice();
    for (let stay = 1; stay <= 3; stay++) {
      s = ok(s, { type: "jailStay", playerId: "a" }).state;
      expect(playerOf(s, "a").jailTurns).toBe(stay);
      expect(s.currentPlayerId).toBe("b");
      playerOf(s, "b").position = 8;
      s = roll(s, 12).state; // b loops harmlessly onto oasis
      playerOf(s, "b").position = 8;
    }
    expect(s.currentPlayerId).toBe("a");
    expect(fail(s, { type: "jailStay", playerId: "a" })).toBe("MUST_PAY_TO_LEAVE");
    expect(cashOf(ok(s, { type: "jailPay", playerId: "a" }).state, "a")).toBe(1450);
  });

  it("a voluntary fine without cash is refused; a forced one bankrupts to the bank", () => {
    const s = toJailChoice();
    playerOf(s, "a").cash = 20;
    s.bank += 1480;
    expect(fail(s, { type: "jailPay", playerId: "a" })).toBe("INSUFFICIENT_FUNDS");
    playerOf(s, "a").jailTurns = 3;
    const { state, events } = ok(s, { type: "jailPay", playerId: "a" });
    expect(types(events)).toContain("BANKRUPT");
    expect(playerOf(state, "a").bankrupt).toBe(true);
    expect(state.phase).toBe("gameOver"); // only b remains
    expect(state.winnerPlayerId).toBe("b");
  });
});

describe("building", () => {
  const setOwner = () => {
    const g = newGame(["a", "b"], 5000);
    own(g, "a", [1, 3]);
    return g;
  };

  it("needs the full country set, costs 150 per house and 300 for the hotel", () => {
    const partial = newGame(["a", "b"], 5000);
    own(partial, "a", [1]);
    expect(fail(partial, { type: "build", playerId: "a", tileIndex: 1, kind: "house" })).toBe("SET_INCOMPLETE");

    let g = setOwner();
    for (let level = 1; level <= 4; level++) {
      const r = ok(g, { type: "build", playerId: "a", tileIndex: 1, kind: "house" });
      expect(cashOf(r.state, "a")).toBe(cashOf(g, "a") - 150);
      expect(r.state.properties[1]!.level).toBe(level);
      g = r.state;
    }
    expect(fail(g, { type: "build", playerId: "a", tileIndex: 1, kind: "house" })).toBe("MAX_LEVEL");
    const hotel = ok(g, { type: "build", playerId: "a", tileIndex: 1, kind: "hotel" });
    expect(cashOf(hotel.state, "a")).toBe(cashOf(g, "a") - 300);
    expect(hotel.state.properties[1]!.level).toBe(5);
    expect(fail(hotel.state, { type: "build", playerId: "a", tileIndex: 1, kind: "hotel" })).toBe("MAX_LEVEL");
  });

  it("a hotel needs 4 houses, funds are checked, and only your own sets count", () => {
    const g = setOwner();
    expect(fail(g, { type: "build", playerId: "a", tileIndex: 1, kind: "hotel" })).toBe("HOTEL_NEEDS_4_HOUSES");
    playerOf(g, "a").cash = 100;
    g.bank += 4900;
    expect(fail(g, { type: "build", playerId: "a", tileIndex: 1, kind: "house" })).toBe("INSUFFICIENT_FUNDS");
    expect(fail(g, { type: "build", playerId: "a", tileIndex: 5, kind: "house" })).toBe("NOT_OWNER"); // harbor
    expect(fail(g, { type: "build", playerId: "a", tileIndex: 99, kind: "house" })).toBe("INVALID_TILE");
    const other = setOwner();
    expect(fail(other, { type: "build", playerId: "b", tileIndex: 1, kind: "house" })).toBe("NOT_YOUR_TURN");
    other.currentPlayerId = "b";
    expect(fail(other, { type: "build", playerId: "b", tileIndex: 1, kind: "house" })).toBe("NOT_OWNER");
  });

  it("building is allowed while waiting for a decision and there is no even-build rule", () => {
    const g = setOwner();
    const decided = roll(g, 6).state; // a lands on tile 6 (unowned) -> awaitingDecision
    expect(decided.phase).toBe("awaitingDecision");
    const built = ok(decided, { type: "build", playerId: "a", tileIndex: 1, kind: "house" });
    expect(ok(built.state, { type: "build", playerId: "a", tileIndex: 1, kind: "house" }).state.properties[1]!.level).toBe(2);
  });

  it("rent updates after building", () => {
    const g = setOwner();
    const built = ok(g, { type: "build", playerId: "a", tileIndex: 3, kind: "house" }).state;
    built.currentPlayerId = "b";
    const { state } = roll(built, 3);
    expect(cashOf(state, "b")).toBe(5000 - propertyRent(50, 1));
  });
});

describe("bankruptcy and the winner", () => {
  it("paying a player more than you have gives them everything and returns your properties to the bank", () => {
    const g = newGame(["a", "b", "c"], 1500);
    own(g, "b", [39], 5); // Dubai hotel: 2720 rent
    own(g, "a", [1, 3]);
    playerOf(g, "a").position = 30;
    const { state, events } = roll(g, 9); // 30 + 9 = 39
    expect(playerOf(state, "a").bankrupt).toBe(true);
    expect(cashOf(state, "a")).toBe(0);
    expect(cashOf(state, "b")).toBe(3000);
    expect(state.properties[1]).toBeUndefined();
    expect(state.properties[39]).toEqual({ ownerId: "b", level: 5, mortgaged: false });
    expect(events.filter((e) => e.type === "MONEY_CHANGED")).toHaveLength(2); // a pays everything it has, b receives it (30 + 9 does not wrap)
    expect(types(events)).toContain("BANKRUPT");
    expect(state.phase).toBe("awaitingRoll");
    expect(state.currentPlayerId).toBe("b"); // bankrupt players are skipped
  });

  it("a payment to the bank that you cannot afford bankrupts you to the bank", () => {
    const g = newGame(["a", "b", "c"]);
    playerOf(g, "a").cash = 120;
    g.bank += 1380;
    const { state } = roll(g, 4); // tax 200
    expect(playerOf(state, "a").bankrupt).toBe(true);
    expect(state.bank).toBe(1500); // 1380 set aside by the test + the 120 a still had
    expect(checkInvariants(state)).toEqual([]);
  });

  it("the last active player wins and nothing can be played afterwards", () => {
    const g = newGame(["a", "b"]);
    own(g, "b", [39], 5);
    playerOf(g, "a").position = 30;
    const { state, events } = roll(g, 9);
    expect(state.phase).toBe("gameOver");
    expect(state.winnerPlayerId).toBe("b");
    expect(types(events)).toContain("BANKRUPT");
    expect(types(events).at(-1)).toBe("GAME_OVER");
    expect(fail(state, { type: "roll", playerId: "b" }, 3)).toBe("WRONG_PHASE");
  });

  it("resign counts as bankruptcy to the bank, also for a player who is not on turn", () => {
    const g = newGame(["a", "b", "c"]);
    own(g, "b", [1, 3]);
    const r = ok(g, { type: "resign", playerId: "b" });
    expect(playerOf(r.state, "b").bankrupt).toBe(true);
    expect(r.state.properties[1]).toBeUndefined();
    expect(r.state.currentPlayerId).toBe("a");
    const mine = ok(r.state, { type: "resign", playerId: "a" });
    expect(mine.state.phase).toBe("gameOver");
    expect(mine.state.winnerPlayerId).toBe("c");
  });

  it("a current player who resigns hands the turn on", () => {
    const g = newGame(["a", "b", "c"]);
    const r = ok(g, { type: "resign", playerId: "a" });
    expect(r.state.currentPlayerId).toBe("b");
    expect(r.state.phase).toBe("awaitingRoll");
  });
});

describe("turn and phase guards, idempotency", () => {
  it("rejects actions out of turn and in the wrong phase", () => {
    const g = newGame();
    expect(fail(g, { type: "roll", playerId: "b" }, 4)).toBe("NOT_YOUR_TURN");
    expect(fail(g, { type: "buy", playerId: "a" })).toBe("WRONG_PHASE");
    expect(fail(g, { type: "skip", playerId: "a" })).toBe("WRONG_PHASE");
    expect(fail(g, { type: "jailPay", playerId: "a" })).toBe("WRONG_PHASE");
    expect(fail(g, { type: "jailStay", playerId: "a" })).toBe("WRONG_PHASE");
    expect(fail(g, { type: "roll", playerId: "zzz" }, 4)).toBe("PLAYER_NOT_IN_GAME");
    const d = roll(g, 3).state;
    expect(fail(d, { type: "roll", playerId: "a" }, 3)).toBe("WRONG_PHASE");
  });

  it("ignores a repeated actionId", () => {
    const g = newGame();
    const action = { actionId: "same", type: "roll", playerId: "a" } as const;
    const first = applyAction(g, action, { dice: () => dice(3) });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = applyAction(first.state, action, { dice: () => dice(3) });
    expect(second).toEqual({ ok: false, error: "DUPLICATE_ACTION" });
    expect(first.state.seq).toBe(1);
  });

  it("does not modify the input state", () => {
    const g = newGame();
    const copy = structuredClone(g);
    roll(g, 5);
    expect(g).toEqual(copy);
  });
});
