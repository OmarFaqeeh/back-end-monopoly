import { describe, expect, it } from "vitest";
import { BOARD, GROUPS, RULES, baseRent, harborRent, propertyRent, rentLevels, utilityRent } from "../../src/shared/rent.js";

describe("shared board and rules", () => {
  it("has the 40 tiles from the spec", () => {
    expect(BOARD).toHaveLength(40);
    BOARD.forEach((t, i) => expect(t.index).toBe(i));
    const kinds = (k: string) => BOARD.filter((t) => t.kind === k).map((t) => t.index);
    expect(kinds("harbor")).toEqual([5, 15, 25, 35]);
    expect(kinds("utility")).toEqual([12, 28]);
    expect(kinds("fortune")).toEqual([7, 22, 36]);
    expect(kinds("vault")).toEqual([2, 17, 33]);
    expect(kinds("tax")).toEqual([4, 38]);
    expect(BOARD[4]!.amount).toBe(200);
    expect(BOARD[38]!.amount).toBe(100);
    expect(GROUPS).toEqual({ 1: [1, 3], 2: [6, 8, 9], 3: [11, 13, 14], 4: [16, 18, 19], 5: [21, 23, 24], 6: [26, 27, 29], 7: [31, 32, 34], 8: [37, 39] });
    expect(BOARD[39]!.price).toBe(400);
    expect(RULES.houseCost).toBe(150);
    expect(RULES.hotelCost).toBe(300);
  });

  it("computes the rent examples from the spec", () => {
    expect(rentLevels(60)).toEqual([6, 30, 80, 220, 310, 410]);
    expect(rentLevels(400)).toEqual([40, 200, 560, 1440, 2080, 2720]);
    expect(baseRent(50)).toBe(6);
    expect(propertyRent(400, 5)).toBe(2720);
    expect(propertyRent(400, 0)).toBe(40);
  });

  it("computes harbor and utility rent", () => {
    expect([1, 2, 3, 4].map(harborRent)).toEqual([25, 50, 100, 200]);
    expect(utilityRent(7, 1)).toBe(28);
    expect(utilityRent(7, 2)).toBe(70);
  });
});
