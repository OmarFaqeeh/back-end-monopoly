import { describe, expect, it } from "vitest";
import { simulate } from "./helpers/sim.js";

describe("display contract", () => {
  it("replaying every event batch through the shared applyEvent reproduces the snapshot after every batch", () => {
    // simulate({ contract: true }) feeds each batch to applyBatch and compares it with toSnapshot after EVERY action.
    const report = simulate({ games: 150, turnCap: 300, contract: true, firstSeed: 50_000 });
    expect(report.violations).toEqual([]);
    expect(report.actions).toBeGreaterThan(10_000);
    expect(report.bankruptcies).toBeGreaterThan(0);
  }, 120_000);
});
