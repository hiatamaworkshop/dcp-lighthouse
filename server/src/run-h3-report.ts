/**
 * H3 report over the collected Wikimedia stream (ROADMAP_BRIEF.md 2026-09-27 (3),
 * H3's period fixed in revision 2026-10-06).
 *
 *   cd server && npm run build && node dist/run-h3-report.js --from 2026-10-07 --to 2026-10-10
 *
 * Two arms, each "preceding equal-length span as reference": 60 min (60 s
 * windows) and 1 min (1 s windows) — 60 windows per span in both, mixed stream.
 * Per UTC hour: alarm rate, and the bot-share curve's slope at that hour. The
 * pre-registered rule reads the 60-minute arm's correlation (h3Verdict).
 *
 * H3's holdout (H3_HOLDOUT_FROM_DAY…H3_HOLDOUT_TO_DAY) had its single look on
 * 2026-10-14 under H3_NULL_MODEL ("overdispersed", revision 2026-10-07 (2)),
 * with the code at commit 9d90c16 (output: data/logs/h3-holdout-report-20261014.txt).
 * Like stage 1's reports, this one refuses `--holdout` (h3RangeRefusal) and,
 * since 2026-10-22, reads spent holdout days as exploration, saying so in the
 * output. The default null model is still H3_NULL_MODEL; `--null-model
 * independent` is for comparison. Its verdict line is a mechanical reading of
 * the rule on exploration data, never H3's verdict (that was 2026-10-14's).
 */
import { join } from "node:path";
import {
  H3_NULL_MODEL,
  h3RangeRefusal,
  h3Verdict,
  curatorForNullModel,
  loadWikiDir,
  runDiurnalAlarms,
  spentHoldoutNote,
} from "./real-data-harness.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const fromDay = arg("from");
const toDay = arg("to");
const holdout = process.argv.includes("--holdout");
const nullModel = arg("null-model") ?? H3_NULL_MODEL;
const curator = curatorForNullModel(nullModel);
if (fromDay === undefined || toDay === undefined) {
  console.error("usage: run-h3-report --from YYYY-MM-DD --to YYYY-MM-DD [--null-model independent|overdispersed]");
  process.exit(2);
}
const refusal = h3RangeRefusal(fromDay, toDay, holdout);
if (refusal !== undefined) {
  console.error(refusal);
  process.exit(2);
}

const dir = process.env.WIKI_DATA_DIR ?? join(process.cwd(), "..", "data", "wikimedia");
const stream = await loadWikiDir(dir, { fromDay, toDay });
const hours = stream.events.length > 0
  ? (stream.events[stream.events.length - 1].ts - stream.events[0].ts) / 3_600_000
  : 0;
const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
console.log(
  `${stream.events.length} events over ${hours.toFixed(1)} h, ${stream.gaps.length} collection gaps ` +
    `(${fromDay}…${toDay}, null model: ${nullModel})`,
);
const spentNote = spentHoldoutNote(fromDay, toDay);
if (spentNote !== undefined) console.log(spentNote);

let verdict = "";
for (const [label, spanMs, windowMs] of [["60 min", 3_600_000, 60_000], ["1 min", 60_000, 1_000]] as const) {
  const r = runDiurnalAlarms(stream, { spanMs, lens: { window_ms: windowMs }, curator });
  const trials = r.bins.reduce((a, b) => a + b.trials, 0);
  const flagged = r.bins.reduce((a, b) => a + b.flagged, 0);
  console.log(
    `\n— ${label} span (${windowMs / 1000}s windows): alarm ${pct(trials > 0 ? flagged / trials : 0)} (${flagged}/${trials}) ` +
      `design ${pct(r.designTarget)} | r(rate, slope) ${r.correlation.toFixed(3)} | ` +
      `${r.blindByGap} blind by gap, ${r.unusableReference} unusable reference`,
  );
  console.log("hour  trials  rate    bot-share  slope");
  for (const b of r.bins) {
    console.log(
      `${String(b.hour).padStart(2, "0")}Z  ${String(b.trials).padStart(6)}  ${pct(b.rate).padStart(6)}  ` +
        `${Number.isFinite(b.level) ? b.level.toFixed(3) : "  —  "}      ${Number.isFinite(b.slope) ? b.slope.toFixed(4) : "—"}`,
    );
  }
  if (spanMs === 3_600_000) verdict = h3Verdict(r);
}
console.log(`\nthe pre-registered H3 rule applied to this exploration (NOT H3's verdict; 60-minute arm, ${nullModel} null): ${verdict}`);
