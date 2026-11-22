import { describe, expect, it } from "vitest";
import { formatReport, simulate } from "./helpers/sim.js";

describe("simulation gate", () => {
  it("1000 seeded games (2 to 6 bots, random and smart policies) never break an invariant", () => {
    const report = simulate({ games: 1000, turnCap: 500, contract: true });
    console.log("\n" + formatReport(report));
    expect(report.violations).toEqual([]);
    expect(report.games).toBe(1000);
    expect(report.finished + report.capped).toBe(1000);
    expect(report.finished).toBeGreaterThan(300); // games really end with a winner
    expect(report.bankruptcies).toBeGreaterThan(0);
    expect(report.trades.accepted).toBeGreaterThan(0); // trades really happen in the simulated games
  }, 300_000);
});
