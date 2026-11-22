// The bot brain and the valuation function: deterministic, per personality.
import { describe, expect, it } from "vitest";
import { BOT_REJECTED_DEAL_COOLDOWN_MS, BOT_TRADE_COOLDOWN_MS, BOT_TRADE_MIN_GAME_MS, type PersonalityId } from "../src/config/botPersonalities.js";
import { decide, dealSignature, evaluateTrade, findProposal, newMemory, safeDefault, type BotAction, type DecideInput } from "../src/engine/bots/botBrain.js";
import { netWorth, ownsFullSet, tileValue } from "../src/engine/bots/valuation.js";
import { toSnapshot } from "../src/engine/state.js";
import type { GameSnapshot, TradeOffer } from "../src/shared/events.js";
import { newGame, own, playerOf } from "./helpers/engine.js";

const T0 = 1_000_000;

/** A snapshot with 2 players ("bot" and "human") and the given tweaks. */
function snap(tweak: (g: ReturnType<typeof newGame>) => void = () => {}, rules = {}): GameSnapshot {
  const g = newGame(["bot", "human"], 1500, 1, rules);
  tweak(g);
  return toSnapshot(g);
}

function input(snapshot: GameSnapshot, personality: PersonalityId, over: Partial<DecideInput> = {}): DecideInput {
  return { snapshot, botId: "bot", personality, rng: () => 0.5, now: T0, gameStartedAt: T0 - 10 * 60_000, mem: newMemory(), humanIds: new Set(["human"]), ...over };
}
const act = (i: DecideInput) => decide(i);

describe("valuation", () => {
  it("a plain property is worth about its price plus the rent it will earn", () => {
    const s = snap();
    expect(tileValue(s, 6, "bot")).toBe(90 + Math.round(10 * 4)); // price 90, base rent 10
  });

  it("a tile that completes my set is worth much more; progress adds a little; blocking the opponent adds some", () => {
    const base = tileValue(snap(), 8, "bot");
    const progress = tileValue(snap((g) => own(g, "bot", [6])), 8, "bot"); // 1 of 2 others
    const completes = tileValue(snap((g) => own(g, "bot", [6, 9])), 8, "bot");
    const blocks = tileValue(snap((g) => own(g, "human", [6, 9])), 8, "bot");
    expect(progress).toBeGreaterThan(base);
    expect(completes).toBeGreaterThan(progress);
    expect(blocks).toBeGreaterThan(base);
    expect(tileValue(snap((g) => own(g, "bot", [6, 9]), { doubleRentSets: true }), 8, "bot")).toBeGreaterThan(completes); // sets pay double
  });

  it("harbors and utilities are worth more with every one already owned", () => {
    const one = tileValue(snap(), 5, "bot");
    const three = tileValue(snap((g) => own(g, "bot", [15, 25])), 5, "bot");
    expect(three).toBeGreaterThan(one);
    expect(tileValue(snap((g) => own(g, "bot", [12])), 28, "bot")).toBeGreaterThan(tileValue(snap(), 28, "bot"));
  });

  it("net worth is cash plus half the price of owned tiles; full sets are detected", () => {
    const s = snap((g) => own(g, "bot", [37, 39]));
    expect(netWorth(s, "bot")).toBe(1500 + 175 + 200);
    expect(ownsFullSet(s, "bot")).toBe(true);
    expect(ownsFullSet(s, "human")).toBe(false);
  });
});

/** The current player is the bot, deciding on tile 6 (price 90) with the given cash. */
function buying(personality: PersonalityId, cash: number, tweak: (g: ReturnType<typeof newGame>) => void = () => {}, tile = 6): BotAction | null {
  const g = newGame(["bot", "human"], 1500, 1, { auctions: true });
  tweak(g);
  playerOf(g, "bot").cash = cash;
  g.bank += 1500 - cash;
  g.phase = "awaitingDecision";
  g.pendingDecision = { kind: "buy", tileIndex: tile, price: tile === 39 ? 400 : 90 };
  return act(input(toSnapshot(g), personality));
}

describe("buy or skip", () => {
  it("never buys what it cannot afford", () => {
    for (const p of ["tycoon", "careful", "spender", "collector", "balanced"] as const) expect(buying(p, 50)).toEqual({ type: "skip" });
  });

  it("tycoon and spender buy every affordable tile, even when almost broke", () => {
    expect(buying("tycoon", 100)).toEqual({ type: "buy" });
    expect(buying("spender", 95)).toEqual({ type: "buy" }); // left with 5: no financial sense
  });

  it("careful needs a reserve, unless the tile extends or completes a set", () => {
    expect(buying("careful", 300)).toEqual({ type: "skip" }); // 210 left < 400
    expect(buying("careful", 600)).toEqual({ type: "buy" }); // 510 left
    expect(buying("careful", 300, (g) => own(g, "bot", [8]))).toEqual({ type: "buy" }); // extends its set
  });

  it("collector prefers its own countries; balanced follows the value score and reserve", () => {
    expect(buying("collector", 200)).toEqual({ type: "skip" }); // 110 left < 200, no set
    expect(buying("collector", 200, (g) => own(g, "bot", [8]))).toEqual({ type: "buy" }); // 110 left >= 50 and it extends
    expect(buying("balanced", 400, (g) => own(g, "bot", [6]), 8)).toEqual({ type: "buy" });
    expect(buying("balanced", 200)).toEqual({ type: "skip" }); // 110 left < 250
  });
});

describe("building and jail", () => {
  const withSet = (personality: PersonalityId, cash: number): BotAction | null => {
    const g = newGame(["bot", "human"], 5000, 1, { evenBuild: true });
    own(g, "bot", [1, 3]);
    playerOf(g, "bot").cash = cash;
    g.bank += 5000 - cash;
    return act(input(toSnapshot(g), personality));
  };

  it("builds on the lowest-level tile of a complete set and keeps its reserve", () => {
    expect(withSet("tycoon", 400)).toMatchObject({ type: "build", kind: "house" }); // 250 left >= 150
    expect(withSet("tycoon", 250)).toEqual({ type: "roll" }); // 100 left < 150
    expect(withSet("careful", 500)).toEqual({ type: "roll" }); // 350 left < 400
    expect(withSet("careful", 600)).toMatchObject({ type: "build" });
    expect(withSet("spender", 150)).toMatchObject({ type: "build" }); // builds always
  });

  it("never builds without a full set, and respects even build", () => {
    const g = newGame(["bot", "human"], 5000, 1, { evenBuild: true });
    own(g, "bot", [1]);
    expect(act(input(toSnapshot(g), "spender"))).toEqual({ type: "roll" });
    const h = newGame(["bot", "human"], 5000, 1, { evenBuild: true });
    own(h, "bot", [1, 3]);
    h.properties[1]!.level = 1;
    expect(act(input(toSnapshot(h), "spender"))).toMatchObject({ type: "build", tileIndex: 3 }); // not tile 1 again
  });

  const inJail = (personality: PersonalityId, cash: number, turn = 5, jailTurns = 0, tweak: (g: ReturnType<typeof newGame>) => void = () => {}) => {
    const g = newGame(["bot", "human"], 1500, 1);
    tweak(g);
    g.phase = "awaitingJailChoice";
    g.turnNumber = turn;
    Object.assign(playerOf(g, "bot"), { inJail: true, position: 10, jailTurns, cash });
    g.bank += 1500 - cash;
    return act(input(toSnapshot(g), personality));
  };

  it("jail choices follow the personality; after 3 stays only paying is offered; never pays without the money", () => {
    expect(inJail("tycoon", 800, 10)).toEqual({ type: "jailPay" }); // early game
    expect(inJail("tycoon", 800, 60)).toEqual({ type: "jailStay" }); // later
    expect(inJail("spender", 80)).toEqual({ type: "jailPay" });
    expect(inJail("balanced", 200)).toEqual({ type: "jailStay" });
    expect(inJail("balanced", 900)).toEqual({ type: "jailPay" });
    expect(inJail("collector", 900)).toEqual({ type: "jailStay" }); // no full set
    expect(inJail("collector", 900, 5, 0, (g) => own(g, "bot", [37, 39]))).toEqual({ type: "jailPay" });
    expect(inJail("careful", 900)).toEqual({ type: "jailPay" });
    expect(inJail("careful", 900, 5, 0, (g) => {
      own(g, "human", [1, 3, 6, 8]);
      Object.values(g.properties).forEach((p) => (p.level = 2));
    })).toEqual({ type: "jailStay" });
    expect(inJail("tycoon", 900, 10, 3)).toEqual({ type: "jailPay" }); // forced
    expect(inJail("tycoon", 30, 10)).toEqual({ type: "jailStay" }); // cannot pay
  });
});

describe("auction bidding", () => {
  const auction = (personality: PersonalityId, cash: number, over: Partial<NonNullable<GameSnapshot["auction"]>> = {}, tweak: (g: ReturnType<typeof newGame>) => void = () => {}) => {
    const g = newGame(["bot", "human"], 1500, 1, { auctions: true });
    tweak(g);
    playerOf(g, "bot").cash = cash;
    g.bank += 1500 - cash;
    g.phase = "auction";
    g.auction = { tileIndex: 6, currentBid: 0, highestBidderId: null, withdrawnIds: [], endsAt: T0 + 10_000, serverNow: T0, ...over };
    return act(input(toSnapshot(g), personality));
  };

  it("never bids above its cash or its personality ceiling; withdraws when outbid beyond it", () => {
    for (const p of ["tycoon", "careful", "spender", "collector", "balanced"] as const) {
      for (const bid of [0, 20, 60, 100, 140, 200]) {
        const a = auction(p, 130, { currentBid: bid, highestBidderId: bid ? "human" : null });
        if (a?.type === "bid") {
          expect(a.amount).toBeLessThanOrEqual(130);
          expect(a.amount).toBeGreaterThanOrEqual(Math.max(10, bid + 10));
          expect(a.amount % 10).toBe(0);
        } else expect(a).toEqual({ type: "withdraw" });
      }
    }
    expect(auction("careful", 1000, { currentBid: 80, highestBidderId: "human" })).toEqual({ type: "withdraw" }); // 0.9 x 90 = 81 < 90
    expect(auction("tycoon", 1000, { currentBid: 100, highestBidderId: "human" })).toMatchObject({ type: "bid" }); // 1.3 x 90 = 117
    expect(auction("tycoon", 1000, { currentBid: 117, highestBidderId: "human" })).toEqual({ type: "withdraw" });
    expect(auction("spender", 1000, { currentBid: 130, highestBidderId: "human" })).toMatchObject({ type: "bid" }); // 1.6 x 90 = 144
  });

  it("bids exactly its cash at most; does nothing while it leads or after withdrawing", () => {
    const a = auction("spender", 100, { currentBid: 80, highestBidderId: "human" });
    expect(a).toMatchObject({ type: "bid" }); // 100 cash, ceiling 144: it needs 90 and may go up to 100, never beyond its cash
    expect((a as { amount: number }).amount).toBeGreaterThanOrEqual(90);
    expect((a as { amount: number }).amount).toBeLessThanOrEqual(100);
    expect(auction("tycoon", 500, { currentBid: 40, highestBidderId: "bot" })).toBeNull();
    expect(auction("tycoon", 500, { withdrawnIds: ["bot"] })).toBeNull();
  });

  it("a collector pays up to 1.5x for a tile that completes its set", () => {
    const completing = (tweak = (g: ReturnType<typeof newGame>) => own(g, "bot", [8, 9])) => auction("collector", 1000, { currentBid: 120, highestBidderId: "human" }, tweak);
    expect(completing()).toMatchObject({ type: "bid" }); // 1.5 x 90 = 135
    expect(auction("collector", 1000, { currentBid: 120, highestBidderId: "human" })).toEqual({ type: "withdraw" }); // 1.2 x 90 = 108
  });
});

describe("raising funds", () => {
  it("pays when it can, otherwise mortgages the LEAST valuable tile first, then goes bankrupt only when nothing is left", () => {
    const g = newGame(["bot", "human"], 1500, 1, { mortgage: true });
    own(g, "bot", [1, 37, 5]); // 50, 350 and a harbor 200
    g.phase = "raisingFunds";
    g.pendingDebt = { amount: 300, creditorId: null, reason: "tax" };
    playerOf(g, "bot").cash = 50;
    g.bank += 1450;
    const first = act(input(toSnapshot(g), "balanced"));
    expect(first).toEqual({ type: "mortgage", tileIndex: 1 }); // the cheapest tile first
    playerOf(g, "bot").cash = 400;
    expect(act(input(toSnapshot(g), "balanced"))).toEqual({ type: "payDebt" });
    for (const i of [1, 37, 5]) g.properties[i]!.mortgaged = true;
    playerOf(g, "bot").cash = 50;
    expect(act(input(toSnapshot(g), "balanced"))).toEqual({ type: "declareBankruptcy" });
  });

  it("unmortgages a tile when it is rich", () => {
    const g = newGame(["bot", "human"], 5000, 1, { mortgage: true });
    own(g, "bot", [37]);
    g.properties[37]!.mortgaged = true;
    expect(act(input(toSnapshot(g), "balanced"))).toEqual({ type: "unmortgage", tileIndex: 37 });
    playerOf(g, "bot").cash = 300;
    expect(act(input(toSnapshot(g), "balanced"))).toEqual({ type: "roll" });
  });
});

describe("trade answers", () => {
  const offer = (give: { tiles: number[]; cash: number }, get: { tiles: number[]; cash: number }, id = "T1"): TradeOffer => ({ id, fromId: "human", toId: "bot", give, get, status: "pending" });
  const withOffer = (t: TradeOffer, personality: PersonalityId, tweak: (g: ReturnType<typeof newGame>) => void = () => {}, over: Partial<DecideInput> = {}) => {
    const g = newGame(["bot", "human"], 1500, 1);
    tweak(g);
    const s = toSnapshot(g);
    s.trades = [t];
    return input(s, personality, over);
  };

  it("accepts a good deal and a fair set-completing deal", () => {
    expect(act(withOffer(offer({ tiles: [], cash: 400 }, { tiles: [6], cash: 0 }), "balanced", (g) => own(g, "bot", [6])))).toEqual({ type: "acceptTrade", tradeId: "T1" });
    // human gives tile 8 (completes the bot's set 6, 8, 9) for fair money
    const fair = offer({ tiles: [8], cash: 0 }, { tiles: [], cash: 100 });
    expect(act(withOffer(fair, "collector", (g) => { own(g, "bot", [6, 9]); own(g, "human", [8]); }))).toEqual({ type: "acceptTrade", tradeId: "T1" });
  });

  it("refuses to give a human a complete set for a cheap price, but not when the human pays a lot", () => {
    const setup = (g: ReturnType<typeof newGame>) => { own(g, "human", [6, 8]); own(g, "bot", [9]); };
    const cheap = offer({ tiles: [], cash: 60 }, { tiles: [9], cash: 0 });
    expect(act(withOffer(cheap, "spender", setup))).toEqual({ type: "rejectTrade", tradeId: "T1" }); // even the clueless spender says no
    const generous = offer({ tiles: [], cash: 600 }, { tiles: [9], cash: 0 });
    expect(act(withOffer(generous, "balanced", setup))).toEqual({ type: "acceptTrade", tradeId: "T1" });
  });

  it("rejects clearly bad deals; margins differ by personality (careful wants a profit, spender accepts a loss)", () => {
    const meh = offer({ tiles: [], cash: 110 }, { tiles: [6], cash: 0 }); // tile 6 is worth 130 to the bot: this is about 15% under
    const own6 = (g: ReturnType<typeof newGame>) => own(g, "bot", [6]);
    expect(act(withOffer(offer({ tiles: [], cash: 10 }, { tiles: [6], cash: 0 }), "balanced", own6))).toEqual({ type: "rejectTrade", tradeId: "T1" });
    expect(act(withOffer(meh, "careful", own6))).toEqual({ type: "rejectTrade", tradeId: "T1" }); // needs +15%
    expect(act(withOffer(meh, "spender", own6))).toEqual({ type: "acceptTrade", tradeId: "T1" }); // takes -20%
  });

  it("makes at most 2 counter-offers per negotiation, then plainly declines", () => {
    const close = offer({ tiles: [], cash: 115 }, { tiles: [6], cash: 0 }); // 130 worth for 115: a little short for careful
    const run = (rounds: number) => {
      const i = withOffer(close, "careful", (g) => own(g, "bot", [6]));
      if (rounds) i.mem.counterRounds.set("human", rounds);
      return evaluateTrade(i, close);
    };
    const first = run(0);
    expect(first.verdict).toBe("counter");
    expect(first.counter).toMatchObject({ give: { tiles: [6] }, get: { tiles: [] } });
    expect(first.counter!.get.cash).toBeGreaterThan(115); // it asks for more money
    expect(run(1).verdict).toBe("counter");
    expect(run(2).verdict).toBe("reject"); // the limit
  });

  it("sends the pending counter-offer after the decline, and does not repeat a deal it already made", () => {
    const i = withOffer(offer({ tiles: [], cash: 1 }, { tiles: [], cash: 0 }), "careful");
    i.snapshot.trades = [];
    i.snapshot.currentPlayerId = "human"; // not the bot's turn: nothing else to do
    const counter = { toId: "human", give: { tiles: [6], cash: 0 }, get: { tiles: [], cash: 140 } };
    i.mem.pendingCounter = counter;
    expect(act(i)).toEqual({ type: "proposeTrade", ...counter });
    i.mem.dealCooldown.set(dealSignature(counter.give, counter.get, "human"), i.now - 1000);
    expect(act(i)).toBeNull();
  });
});

describe("trade proposals", () => {
  /** The bot owns 6 and 9; the human owns 8 (completing the bot's set). */
  const setup = (g: ReturnType<typeof newGame>) => {
    own(g, "bot", [6, 9]);
    own(g, "human", [8]);
  };
  const base = (over: Partial<DecideInput> = {}, tweak = setup) => {
    const g = newGame(["bot", "human"], 1500, 1);
    tweak(g);
    return input(toSnapshot(g), "collector", over);
  };

  it("proposes a fair, logical deal that completes a set (collector: most frequent)", () => {
    const a = findProposal(base());
    expect(a).toMatchObject({ type: "proposeTrade", toId: "human", get: { tiles: [8], cash: 0 }, give: { tiles: [] } });
    if (a?.type !== "proposeTrade") throw new Error("expected a proposal");
    expect(a.give.cash).toBeGreaterThan(0);
    expect(a.give.cash).toBeLessThanOrEqual(1500 - 200); // keeps its reserve
  });

  it("not before 3 minutes of game time, at most one per 90 s, 5-minute cooldown on the same deal", () => {
    expect(findProposal(base({ gameStartedAt: T0 - (BOT_TRADE_MIN_GAME_MS - 1000) }))).toBeNull();
    expect(findProposal(base({ gameStartedAt: T0 - BOT_TRADE_MIN_GAME_MS - 1 }))).not.toBeNull();
    const recent = base();
    recent.mem.lastProposalAt = T0 - (BOT_TRADE_COOLDOWN_MS - 1000);
    expect(findProposal(recent)).toBeNull();
    recent.mem.lastProposalAt = T0 - BOT_TRADE_COOLDOWN_MS - 1;
    const deal = findProposal(recent);
    expect(deal).not.toBeNull();
    if (deal?.type === "proposeTrade") recent.mem.dealCooldown.set(dealSignature(deal.give, deal.get, deal.toId), T0 - (BOT_REJECTED_DEAL_COOLDOWN_MS - 5000));
    expect(findProposal(recent)).toBeNull(); // same deal: not yet
    if (deal?.type === "proposeTrade") recent.mem.dealCooldown.set(dealSignature(deal.give, deal.get, deal.toId), T0 - BOT_REJECTED_DEAL_COOLDOWN_MS - 1);
    expect(findProposal(recent)).not.toBeNull(); // after 5 minutes it may try again
  });

  it("not while the target has a pending trade, during an auction or a debt, to bots, or when nothing completes a set", () => {
    const pending = base();
    pending.snapshot.trades = [{ id: "T9", fromId: "human", toId: "bot", give: { tiles: [], cash: 1 }, get: { tiles: [], cash: 0 }, status: "pending" }];
    expect(findProposal(pending)).toBeNull();
    const busy = base();
    busy.snapshot.phase = "auction";
    expect(findProposal(busy)).toBeNull();
    expect(findProposal(base({ humanIds: new Set() }))).toBeNull(); // bots never propose to bots
    expect(findProposal(base({}, (g) => own(g, "human", [8])))).toBeNull(); // nothing completes a set
    const built = base({}, (g) => { setup(g); g.properties[8]!.level = 1; });
    expect(findProposal(built)).toBeNull(); // never tiles with buildings
  });

  it("is part of decide() only when it is not the bot's turn", () => {
    const i = base();
    i.snapshot.currentPlayerId = "human";
    expect(act(i)).toMatchObject({ type: "proposeTrade" });
    const mine = base();
    mine.snapshot.currentPlayerId = "bot";
    expect(act(mine)).toEqual({ type: "roll" });
  });
});

describe("safe default", () => {
  it("rolls, skips, stays in jail, withdraws, declines trades and, in debt, pays or declares bankruptcy", () => {
    const g = newGame(["bot", "human"], 1500, 1);
    expect(safeDefault(toSnapshot(g), "bot")).toEqual({ type: "roll" });
    g.phase = "awaitingDecision";
    expect(safeDefault(toSnapshot(g), "bot")).toEqual({ type: "skip" });
    g.phase = "awaitingJailChoice";
    expect(safeDefault(toSnapshot(g), "bot")).toEqual({ type: "jailStay" });
    g.phase = "auction";
    g.auction = { tileIndex: 6, currentBid: 0, highestBidderId: null, withdrawnIds: [], endsAt: T0, serverNow: T0 };
    expect(safeDefault(toSnapshot(g), "bot")).toEqual({ type: "withdraw" });
    expect(safeDefault(toSnapshot(g), "human")).toEqual({ type: "withdraw" });
    const s = toSnapshot(newGame(["bot", "human"]));
    s.trades = [{ id: "T1", fromId: "human", toId: "bot", give: { tiles: [], cash: 5 }, get: { tiles: [], cash: 0 }, status: "pending" }];
    s.currentPlayerId = "human";
    expect(safeDefault(s, "bot")).toEqual({ type: "rejectTrade", tradeId: "T1" });
  });
});
