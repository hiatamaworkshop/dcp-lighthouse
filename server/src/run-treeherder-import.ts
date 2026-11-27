/**
 * Imports Mozilla Treeherder `autoland` pushes (tier-1 jobs) by UTC day (ROADMAP C29).
 *
 *   node dist/run-treeherder-import.js --from 2026-11-07 --to 2026-11-22 [--dir ../data/treeherder] [--force]
 *
 * A day already recorded in days.jsonl is skipped unless --force. A day is
 * refused until 3 days after it ends (classifications must settle). Pushes
 * whose jobs could not be read are recorded in the day's line (blind, not quiet).
 */

import { resolve } from "node:path";
import { daysBetween } from "./prow-import.js";
import { TreeherderImporter } from "./treeherder-import.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const from = arg("--from");
  const to = arg("--to");
  if (from === undefined || to === undefined) {
    console.error("usage: run-treeherder-import --from YYYY-MM-DD --to YYYY-MM-DD [--dir DIR] [--force]");
    process.exit(2);
  }
  const dir = resolve(arg("--dir") ?? "../data/treeherder");
  const importer = new TreeherderImporter({ dir });
  let failed = 0;
  for (const day of daysBetween(from, to)) {
    try {
      const e = await importer.importDay(day, process.argv.includes("--force"));
      console.log(`[treeherder-import] ${day}: ${e.pushes} pushes, ${e.jobs} tier-1 jobs, ${e.missing.length} missing${"skipped" in e ? " (already imported)" : ""}`);
    } catch (err) {
      failed++;
      console.error(`[treeherder-import] ${day}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (failed > 0) process.exit(1);
}

void main();
