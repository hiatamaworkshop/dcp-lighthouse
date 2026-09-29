/**
 * Long-running entry point for the real-data calibration period's Wikimedia
 * collector (ROADMAP_BRIEF.md 2026-09-27 (3), stage 0).
 *
 *   cd server && npm run build && node dist/run-wikimedia-collector.js
 *
 * Data goes to WIKI_DATA_DIR (default: <repo>/data/wikimedia, gitignored).
 * Ctrl-C / SIGTERM stops it cleanly; restarting resumes via `since` and
 * de-duplicates the overlap, and any downtime shows up in gaps.jsonl.
 */
import { join } from "node:path";
import { WikimediaCollector } from "./wikimedia-collector.js";

const dir = process.env.WIKI_DATA_DIR ?? join(process.cwd(), "..", "data", "wikimedia");
const collector = new WikimediaCollector({ dir });
const abort = new AbortController();

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`[wiki-collector] ${sig} — stopping`);
    abort.abort();
  });
}

const report = setInterval(() => {
  console.log(`[wiki-collector] ${JSON.stringify(collector.stats)}`);
}, 60_000);

console.log(`[wiki-collector] writing to ${dir}`);
await collector.run(abort.signal);
clearInterval(report);
console.log(`[wiki-collector] stopped ${JSON.stringify(collector.stats)}`);
