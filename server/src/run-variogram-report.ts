/**
 * The variogram null on the collected Wikimedia stream, against the other two
 * (ROADMAP_BRIEF.md 2026-10-14 (2) item 1, (5)). Exploration only: every
 * collected day has been seen, so these figures are exploration whatever the
 * range. Spent holdout days may be read and are labelled in the output; an
 * unspent holdout is refused (stage1RangeRefusal).
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
 * `--full-history` loads the two days before `--from` as well and scores only
 * trials observing from `--from` 00:00Z on, so every trial has its whole
 * reference and history — the way stage 3's single look read its holdout
 * (2026-10-22, commit f0b338c). That look is spent: `--holdout` is refused.
 */
import { join } from "node:path";
import {
  curatorForNullModel,
  loadWikiDir,
  runDiurnalAlarms,
  runPositionProfile,
  spentHoldoutNote,
  stage1RangeRefusal,
  stage3HoldoutRefusal,
} from "./real-data-harness.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const fromDay = arg("from");
const toDay = arg("to");
const historySpans = Number(arg("history-spans") ?? 24);
if (fromDay === undefined || toDay === undefined || !(historySpans >= 0)) {
  console.error("usage: run-variogram-report --from YYYY-MM-DD --to YYYY-MM-DD [--history-spans 24] [--full-history]");
  process.exit(2);
}
const fullHistory = process.argv.includes("--full-history");
const DAY = 86_400_000;
const obsFromTs = fullHistory ? Date.parse(`${fromDay}T00:00:00Z`) : undefined;
const loadFrom = obsFromTs !== undefined ? new Date(obsFromTs - 2 * DAY).toISOString().slice(0, 10) : fromDay;
const refusal = process.argv.includes("--holdout")
  ? stage3HoldoutRefusal(fromDay, toDay, Date.now())
  : stage1RangeRefusal(loadFrom, toDay, false);
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

const stream = await loadWikiDir(dir, { fromDay: loadFrom, toDay });
const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
console.log(
  `${stream.events.length} events, ${stream.gaps.length} collection gaps (${fromDay}…${toDay}` +
    (fullHistory ? `, loaded from ${loadFrom} for references and history` : "") + `), history ${historySpans} spans`,
);
const spentNote = spentHoldoutNote(loadFrom, toDay);
if (spentNote !== undefined) console.log(spentNote);

for (const a of ARMS) {
  console.log(`\n— ${a.label}`);
  console.log("null           trials  alarm   step    spike/dip per window, first → last sixth of the observation");
  for (const nullModel of ["independent", "overdispersed", "variogram"]) {
    const r = runPositionProfile(stream, {
      lens: { window_ms: a.window }, spanMs: a.span, strideMs: a.stride, obsFromTs,
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
    spanMs: 3_600_000, lens: { window_ms: 60_000 }, obsFromTs, curator: curatorForNullModel(nullModel, 2.0, { history: true }),
    historyMs: nullModel === "variogram" ? historySpans * 3_600_000 : 0,
  });
  const trials = r.bins.reduce((s, b) => s + b.trials, 0);
  const flagged = r.bins.reduce((s, b) => s + b.flagged, 0);
  console.log(`${nullModel.padEnd(14)} alarm ${pct(flagged / Math.max(1, trials))} (${flagged}/${trials}), r(rate, slope) ${r.correlation.toFixed(3)}`);
}
