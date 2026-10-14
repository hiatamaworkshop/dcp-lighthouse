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
 *
 * Stage 3's single look (ROADMAP_BRIEF.md 2026-10-14 (12)) is the one exception
 * to "exploration only":
 *
 *   node dist/run-variogram-report.js --from 2026-10-19 --to 2026-10-21 --holdout
 *
 * reads exactly the holdout days once they are complete (stage3HoldoutRefusal),
 * plus the two days before them for references and history, scores only trials
 * observing inside the holdout, and prints stage3Verdict on the variogram null's
 * arms V-a and V-b with the pre-registered settings (`--history-spans` refused).
 */
import { join } from "node:path";
import {
  curatorForNullModel,
  loadWikiDir,
  runDiurnalAlarms,
  runPositionProfile,
  stage1RangeRefusal,
  stage3HoldoutRefusal,
  stage3Verdict,
  STAGE3_HOLDOUT_FROM_DAY,
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
const holdout = process.argv.includes("--holdout");
const refusal = holdout
  ? stage3HoldoutRefusal(fromDay, toDay, Date.now()) ??
    (arg("history-spans") !== undefined ? "refusing: stage 3's holdout reads the pre-registered 24 history spans" : undefined)
  : stage1RangeRefusal(fromDay, toDay, false);
if (refusal !== undefined) {
  console.error(refusal);
  process.exit(2);
}

const dir = process.env.WIKI_DATA_DIR ?? join(process.cwd(), "..", "data", "wikimedia");

const ARMS = [
  { label: "H1 1 s windows, 10 s span", window: 1_000, span: 10_000, stride: 20_000 },
  { label: "H1 10 s windows, 300 s span", window: 10_000, span: 300_000, stride: 600_000 },
  { label: "H3 60 s windows, 60 min span", window: 60_000, span: 3_600_000, stride: 600_000 },
];

if (holdout) {
  // V-a's first trial observes from the holdout's first instant: its reference is
  // the hour before and its history the 24 h before that, so two days before the
  // holdout are loaded. Only trials observing inside the holdout are planned.
  const DAY = 86_400_000;
  const obsFromTs = Date.parse(`${STAGE3_HOLDOUT_FROM_DAY}T00:00:00Z`);
  const loadFrom = new Date(obsFromTs - 2 * DAY).toISOString().slice(0, 10);
  const s = await loadWikiDir(dir, { fromDay: loadFrom, toDay });
  console.log(`STAGE 3 HOLDOUT ${fromDay}…${toDay} (loaded from ${loadFrom} for references and history): ${s.events.length} events, ${s.gaps.length} collection gaps`);
  const arm = (window: number, span: number, stride: number) =>
    runPositionProfile(s, {
      lens: { window_ms: window }, spanMs: span, strideMs: stride, obsFromTs,
      curator: curatorForNullModel("variogram", 2.0, { history: true }), historyMs: 24 * span,
    });
  const a = arm(60_000, 3_600_000, 600_000);
  const b = arm(1_000, 10_000, 20_000);
  for (const [name, p] of [["V-a (60 s windows, 60 min)", a], ["V-b (1 s windows, 10 s)", b]] as const) {
    console.log(
      `${name}: trials ${p.trials}, alarm ${(100 * p.rate).toFixed(2)}%, step ${(100 * p.stepPackages / Math.max(1, p.trials)).toFixed(1)}%, ` +
        `blind by gap ${p.blindByGap}, unusable reference ${p.unusableReference}; by position ` +
        p.perWindowByPosition.map((x) => `${(1000 * x).toFixed(2)}‰`).join("  "),
    );
  }
  console.log(`VERDICT: ${stage3Verdict(a, b)}`);

  // Report-only rows, pre-registered as not part of the verdict.
  console.log("\nreport only (not the verdict):");
  for (const x of ARMS) {
    for (const nullModel of ["independent", "overdispersed", "variogram"]) {
      const r = runPositionProfile(s, {
        lens: { window_ms: x.window }, spanMs: x.span, strideMs: x.stride, obsFromTs,
        curator: curatorForNullModel(nullModel, 2.0, { history: true }), historyMs: nullModel === "variogram" ? 24 * x.span : 0,
      });
      console.log(`  ${x.label}, ${nullModel}: alarm ${(100 * r.rate).toFixed(2)}% of ${r.trials}; by position ` +
        r.perWindowByPosition.map((y) => `${(1000 * y).toFixed(2)}‰`).join("  "));
    }
  }
  const d = runDiurnalAlarms(s, {
    spanMs: 3_600_000, lens: { window_ms: 60_000 }, obsFromTs,
    curator: curatorForNullModel("variogram", 2.0, { history: true }), historyMs: 24 * 3_600_000,
  });
  console.log(`  H3's arm, variogram: r(rate, slope) ${d.correlation.toFixed(3)} (hourly curve from the loaded days)`);
  process.exit(0);
}
const stream = await loadWikiDir(dir, { fromDay, toDay });
const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
console.log(`${stream.events.length} events, ${stream.gaps.length} collection gaps (${fromDay}…${toDay}), history ${historySpans} spans`);

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
