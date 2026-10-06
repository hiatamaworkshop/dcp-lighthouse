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
 * H3 has its own holdout (H3_HOLDOUT_FROM_DAY…H3_HOLDOUT_TO_DAY): days in it are
 * refused without `--holdout`, and `--holdout` must cover exactly those days —
 * it is the single final look, as for stage 1.
 */
import { join } from "node:path";
import {
  H3_HOLDOUT_FROM_DAY,
  H3_HOLDOUT_TO_DAY,
  h3Verdict,
  loadWikiDir,
  runDiurnalAlarms,
} from "./real-data-harness.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const fromDay = arg("from");
const toDay = arg("to");
const holdout = process.argv.includes("--holdout");
if (fromDay === undefined || toDay === undefined) {
  console.error("usage: run-h3-report --from YYYY-MM-DD --to YYYY-MM-DD [--holdout]");
  process.exit(2);
}
if (holdout && (fromDay !== H3_HOLDOUT_FROM_DAY || toDay !== H3_HOLDOUT_TO_DAY)) {
  console.error(`refusing: --holdout reads exactly ${H3_HOLDOUT_FROM_DAY}…${H3_HOLDOUT_TO_DAY}, H3's judgment days.`);
  process.exit(2);
}
// The single look spent on a half-collected holdout cannot be taken back.
if (holdout && Date.now() < Date.parse(`${H3_HOLDOUT_TO_DAY}T00:00:00Z`) + 86_400_000) {
  console.error(`refusing: H3's holdout runs until the end of ${H3_HOLDOUT_TO_DAY} (UTC); it is not complete yet.`);
  process.exit(2);
}
if (!holdout && toDay >= H3_HOLDOUT_FROM_DAY) {
  console.error(
    `refusing: ${toDay} reaches H3's holdout (${H3_HOLDOUT_FROM_DAY}…). ` +
      `Exploration must stop before it; --holdout is the single final look.`,
  );
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
    `(${fromDay}…${toDay}${holdout ? ", HOLDOUT" : ""})`,
);

let verdict = "";
for (const [label, spanMs, windowMs] of [["60 min", 3_600_000, 60_000], ["1 min", 60_000, 1_000]] as const) {
  const r = runDiurnalAlarms(stream, { spanMs, lens: { window_ms: windowMs } });
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
console.log(`\nH3 (pre-registered rule, 60-minute arm): ${verdict}`);
