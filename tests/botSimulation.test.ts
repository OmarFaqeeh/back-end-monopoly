import { describe, expect, it } from "vitest";
import { formatBotReport, simulateBots } from "./helpers/botSim.js";

describe("bots-only simulation", () => {
  it("300 seeded games (random personalities and settings): zero rejected bot actions, zero invariant violations, fast decisions", () => {
    const report = simulateBots({ games: 300, turnCap: 400 });
    console.log("\n" + formatBotReport(report));
    expect(report.rejectedBotActions).toBe(0);
    expect(report.violations).toEqual([]);
    expect(report.games).toBe(300);
    expect(report.finished + report.capped).toBe(300);
    expect(report.finished).toBeGreaterThan(50);
    expect(report.p99DecisionMs).toBeLessThan(10);
    for (const key of ["auctions", "mortgages", "debts", "builds", "jackpots"]) expect(report.coverage[key], key).toBeGreaterThan(0);
  }, 300_000);
});
