/**
 * Imports Kubernetes Prow test results by UTC day (ROADMAP C17).
 *
 *   node dist/run-prow-import.js --from 2026-11-01 --to 2026-11-14 [--jobs a,b,c] [--dir ../data/prow] [--force]
 *
 * A day already recorded in days.jsonl is skipped unless --force. Builds that
 * could not be read are recorded in the day's line (blind, not quiet).
 */

import { resolve } from "node:path";
import { DEFAULT_PROW_JOBS, ProwImporter, daysBetween } from "./prow-import.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const from = arg("--from");
  const to = arg("--to");
  if (from === undefined || to === undefined) {
    console.error("usage: run-prow-import --from YYYY-MM-DD --to YYYY-MM-DD [--jobs a,b,c] [--dir DIR] [--force]");
    process.exit(2);
  }
  const dir = resolve(arg("--dir") ?? "../data/prow");
  const jobs = (arg("--jobs") ?? DEFAULT_PROW_JOBS.join(",")).split(",").filter((j) => j !== "");
  const force = process.argv.includes("--force");
  const importer = new ProwImporter({ dir });
  let failed = 0;
  for (const job of jobs) {
    for (const day of daysBetween(from, to)) {
      try {
        const e = await importer.importDay(job, day, force);
        console.log(`[prow-import] ${job} ${day}: ${e.builds} builds, ${e.missing.length} missing${"skipped" in e ? " (already imported)" : ""}`);
      } catch (err) {
        failed++;
        console.error(`[prow-import] ${job} ${day}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  if (failed > 0) process.exit(1);
}

void main();
