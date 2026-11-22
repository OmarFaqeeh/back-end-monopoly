// Prints the simulation report: npm run sim -- [games] [turnCap]
import { formatReport, simulate } from "../tests/helpers/sim.js";

const games = Number(process.argv[2] ?? 1000);
const turnCap = Number(process.argv[3] ?? 500);
const started = Date.now();
const randomSettings = process.argv.includes("--settings");
const report = simulate({ games, turnCap, contract: true, randomSettings });
console.log(formatReport(report));
console.log(`time: ${((Date.now() - started) / 1000).toFixed(1)} s`);
process.exit(report.violations.length ? 1 : 0);
