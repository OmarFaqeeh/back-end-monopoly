import { describe, expect, it } from "vitest";
import { checkInvariants } from "../../src/engine/state.js";
import { newGame, own, playerOf } from "../helpers/engine.js";

describe("checkInvariants", () => {
  it("accepts a fresh game", () => {
    expect(checkInvariants(newGame(["a", "b", "c"]))).toEqual([]);
  });

  it("reports negative cash, lost money, bad owners and levels", () => {
    const g = newGame();
    playerOf(g, "a").cash = -5;
    expect(checkInvariants(g).join()).toMatch(/negative cash/);
    expect(checkInvariants(g).join()).toMatch(/money not conserved/);

    const h = newGame();
    own(h, "zzz", [3]);
    h.properties[3]!.level = 9;
    const found = checkInvariants(h).join();
    expect(found).toMatch(/bad level/);
    expect(found).toMatch(/owned by missing/);
  });
});
