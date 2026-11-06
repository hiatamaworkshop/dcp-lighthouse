/**
 * Retention of the collector's daily gz files (ROADMAP C6). Dry run unless `--apply`.
 *
 *   cd server && npm run build && node dist/run-wiki-retention.js            # what it would delete
 *   cd server && node dist/run-wiki-retention.js --apply                     # delete, record in pruned.jsonl
 *
 * Deletes nothing while free space is at least 100 GB; under it, deletes the oldest day files
 * until 120 GB are free, sparing the last 14 days and every holdout week (wiki-retention.ts).
 * Reads names and sizes only, never a file's content. Not wired to the collector or a schedule:
 * the collector stays a pure recorder, and the rule is run when the disk is checked.
 */
import { readdirSync, statSync, statfsSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HOLDOUTS } from "./real-data-harness.js";
import { planRetention, recordPruned, retentionDayOf } from "./wiki-retention.js";

const dir = process.env.WIKI_DATA_DIR ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../data/wikimedia");
const apply = process.argv.includes("--apply");
const GIB = 1024 ** 3;

const fs = statfsSync(dir);
const freeBytes = Number(fs.bavail) * Number(fs.bsize);
const files = readdirSync(dir)
  .filter((f) => retentionDayOf(f) !== undefined)
  .map((name) => ({ name, bytes: statSync(join(dir, name)).size }));
const now = Date.now();
const plan = planRetention({ files, freeBytes, todayDay: new Date(now).toISOString().slice(0, 10), holdouts: HOLDOUTS });

console.log(`retention ${apply ? "APPLY" : "dry run"}: ${dir}`);
console.log(`free ${(freeBytes / GIB).toFixed(1)} GiB · ${files.length} day files (${(files.reduce((s, f) => s + f.bytes, 0) / GIB).toFixed(1)} GiB) · ${plan.protectedCount} protected`);
if (plan.action === "none") {
  console.log("nothing to delete: free space is at or above the low line (100 GiB)");
} else {
  for (const v of plan.victims) console.log(`  ${apply ? "delete" : "would delete"} ${v.name} (${(v.bytes / 1e6).toFixed(0)} MB)`);
  console.log(`${plan.action === "short" ? "SHORT: all that may go is not enough — " : ""}free after ≈ ${(plan.freeAfterBytes / GIB).toFixed(1)} GiB (target 120 GiB)`);
  if (apply && plan.victims.length > 0) {
    // Record first: a crash between the two leaves a file that is listed but still there (harmless), never a deleted day that reads as quiet.
    recordPruned(dir, plan.victims.map((v) => retentionDayOf(v.name)!), now);
    for (const v of plan.victims) unlinkSync(join(dir, v.name));
    console.log(`deleted ${plan.victims.length} files; recorded in pruned.jsonl`);
  }
}
