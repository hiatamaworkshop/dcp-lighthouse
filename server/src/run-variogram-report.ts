/**
 * The variogram null on the collected Wikimedia stream, against the other two
 * (ROADMAP_BRIEF.md 2026-10-14 (2) item 1, (5)). Exploration only: every
 * collected day has been seen, so these figures are exploration whatever the
 * range, and the range must stay outside both holdouts (stage1RangeRefusal).
 *
 *   cd server && npm run build && node dist/run-variogram-report.js --from 2026-10-06 --to 2026-10-10
 *
 * Arms: the pre-registered "preceding equal-length span" comparisons — H1's
 * 1 s windows over 10 s and 10 s windows over 300 s, H3's 60 s windows over
 * 60 min. Every null reads the same windows (one grid, runPositionProfile);
 * the variogram null also gets `--history-spans` spans of history before each
 * reference (default 24: a day for H3's arm). Per arm and null: the package
 * alarm rate and the spike/dip rate per window by position in the observation
 * span — flat when the null is right about drift. H3's arm also gets the
 * diurnal correlation, for reading against the 2026-10-14 verdict.
 */
import { join } from "node:path";
import {
  curatorForNullModel,
  loadWikiDir,
  runDiurnalAlarms,
  runPositionProfile,
  stage1RangeRefusal,
} from "./real-data-harness.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const fromDay = arg("from");
const toDay = arg("to");
const historySpans = Number(arg("history-spans") ?? 24);
if (fromDay === undefined || toDay === undefined || !(historySpans >= 0)) {
  console.error("usage: run-variogram-report --from YYYY-MM-DD --to YYYY-MM-DD [--history-spans 24]");
  process.exit(2);
}
const refusal = stage1RangeRefusal(fromDay, toDay, process.argv.includes("--holdout"));
if (refusal !== undefined) {
  console.error(refusal);
  process.exit(2);
}

const dir = process.env.WIKI_DATA_DIR ?? join(process.cwd(), "..", "data", "wikimedia");
const stream = await loadWikiDir(dir, { fromDay, toDay });
const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
console.log(`${stream.events.length} events, ${stream.gaps.length} collection gaps (${fromDay}…${toDay}), history ${historySpans} spans`);

const ARMS = [
  { label: "H1 1 s windows, 10 s span", window: 1_000, span: 10_000, stride: 20_000 },
  { label: "H1 10 s windows, 300 s span", window: 10_000, span: 300_000, stride: 600_000 },
  { label: "H3 60 s windows, 60 min span", window: 60_000, span: 3_600_000, stride: 600_000 },
];
for (const a of ARMS) {
  console.log(`\n— ${a.label}`);
  console.log("null           trials  alarm   step    spike/dip per window, first → last sixth of the observation");
  for (const nullModel of ["independent", "overdispersed", "variogram"]) {
    const r = runPositionProfile(stream, {
      lens: { window_ms: a.window }, spanMs: a.span, strideMs: a.stride,
      curator: curatorForNullModel(nullModel, 2.0, { history: true }), historyMs: nullModel === "variogram" ? historySpans * a.span : 0,
    });
    console.log(
      `${nullModel.padEnd(14)} ${String(r.trials).padStart(6)}  ${pct(r.rate).padStart(6)}  ${pct(r.stepPackages / Math.max(1, r.trials)).padStart(5)}   ` +
        r.perWindowByPosition.map((x) => `${(1000 * x).toFixed(2)}‰`).join("  ") +
        (r.blindByGap > 0 ? `  (${r.blindByGap} blind by gap)` : ""),
    );
  }
}

// One grid anchored at the stream's first event, for every null: the figures
// compare the nulls with each other. They are NOT run-h3-report's numbers,
// which window each trial from its own first event (2026-10-14 (9) review).
console.log("\n— H3's diurnal correlation on these days (60 min arm, one grid anchored at the stream's first event; compare the nulls with each other — run-h3-report windows each trial separately, so its figures differ; exploration, not a verdict)");
for (const nullModel of ["overdispersed", "variogram"]) {
  const r = runDiurnalAlarms(stream, {
    spanMs: 3_600_000, lens: { window_ms: 60_000 }, curator: curatorForNullModel(nullModel, 2.0, { history: true }),
    historyMs: nullModel === "variogram" ? historySpans * 3_600_000 : 0,
  });
  const trials = r.bins.reduce((s, b) => s + b.trials, 0);
  const flagged = r.bins.reduce((s, b) => s + b.flagged, 0);
  console.log(`${nullModel.padEnd(14)} alarm ${pct(flagged / Math.max(1, trials))} (${flagged}/${trials}), r(rate, slope) ${r.correlation.toFixed(3)}`);
}
