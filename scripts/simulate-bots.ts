// Bots-only simulation: npm run sim:bots -- [games] [turnCap]
import { formatBotReport, simulateBots } from "../tests/helpers/botSim.js";

const games = Number(process.argv[2] ?? 2000);
const turnCap = Number(process.argv[3] ?? 500);
const started = Date.now();
const report = simulateBots({ games, turnCap });
console.log(formatBotReport(report));
console.log(`time: ${((Date.now() - started) / 1000).toFixed(1)} s`);
process.exit(report.violations.length || report.rejectedBotActions ? 1 : 0);
