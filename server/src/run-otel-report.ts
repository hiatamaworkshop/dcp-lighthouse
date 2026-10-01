/**
 * H4 report over the OTel Demo recording (ROADMAP_BRIEF.md 2026-09-27 (3)).
 *
 *   cd server && npm run build && node dist/run-otel-report.js --from 2026-10-01 --to 2026-10-01
 *
 * For p = 1 / 0.5 / 0.1 (the p = 1 recording thinned WHOLE TRACES at a time by
 * thinByTrace, weight 1/p — the sampling unit fixed 2026-09-30):
 *   - the alarm rate over flag-OFF time (ON spans and a settle tail excluded),
 *     against the design rate — H4's pre-registered comparison;
 *   - the detection of each ON span — at p = 1 this is the wiring check: a miss
 *     means ingest or value mapping is wrong, to be fixed before any statistics.
 *
 * Options: --flag (paymentFailure) --target (payment, the service the fault
 * should show in) --settle (30s) --window (10s) --span (60s) --seed (1).
 * Data and flags.jsonl come from OTEL_DATA_DIR (default <repo>/data/otel).
 * The holdout rule is the same as run-real-data-report's.
 */
import { join } from "node:path";
import { parseDuration } from "./otel-flag-schedule.js";
import {
  flagExclusion,
  h4Verdict,
  HOLDOUT_FROM_DAY,
  loadFlagTruth,
  loadOtelDir,
  runFlagDetection,
  runNullCalibration,
  thinByTrace,
} from "./real-data-harness.js";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const fromDay = arg("from");
const toDay = arg("to");
const holdout = process.argv.includes("--holdout");
if (fromDay === undefined || toDay === undefined) {
  console.error("usage: run-otel-report --from YYYY-MM-DD --to YYYY-MM-DD [--holdout] [--flag F] [--target SERVICE]");
  process.exit(2);
}
if (toDay >= HOLDOUT_FROM_DAY && !holdout) {
  console.error(
    `refusing: ${toDay} reaches the holdout (${HOLDOUT_FROM_DAY}…). ` +
      `Exploration must stop before it; --holdout is the single final look.`,
  );
  process.exit(2);
}

const flag = arg("flag", "paymentFailure") as string;
const target = arg("target", "payment") as string;
const settleMs = parseDuration(arg("settle", "30s") as string);
const spanMs = parseDuration(arg("span", "60s") as string);
const lens = { window_ms: parseDuration(arg("window", "10s") as string), group_by: ["service"] };
const seed = Number(arg("seed", "1"));

const dir = process.env.OTEL_DATA_DIR ?? join(process.cwd(), "..", "data", "otel");
const stream = await loadOtelDir(dir, { fromDay, toDay });
const lastTs = stream.events.length > 0 ? stream.events[stream.events.length - 1].ts : 0;
const spans = loadFlagTruth(dir, flag, lastTs).filter((s) => s.toTs > (stream.events[0]?.ts ?? 0) && s.fromTs < lastTs);
const exclude = flagExclusion(spans, settleMs);
const pct = (x: number) => `${(100 * x).toFixed(1)}%`;

console.log(
  `${stream.events.length} spans, ${stream.gaps.length} collection gaps, ${spans.length} ON spans of ${flag} ` +
    `(${spans.filter((s) => !s.confirmed).length} not confirmed against flagd) ` +
    `(${fromDay}…${toDay}${holdout ? ", HOLDOUT" : ""})`,
);
console.log(
  `lens window ${lens.window_ms / 1000}s group_by service, span ${spanMs / 1000}s, settle ${settleMs / 1000}s, ` +
    `sampled by trace (seed ${seed})`,
);

const offRate = new Map<number, number>();
let wiring = { detected: 0, trials: 0 };
let design = 0;
for (const p of [1, 0.5, 0.1]) {
  // One seed for every p: the p = 0.1 sample is then a subset of the p = 0.5 one.
  const thinned = { events: thinByTrace(stream.events, p, seed), gaps: stream.gaps };
  const nul = runNullCalibration(thinned, { lens, spanMs, shuffleReps: 0, exclude, seed });
  const det = runFlagDetection(thinned, spans, { lens, spanMs, settleMs, target: { key: "service", value: target } });
  offRate.set(p, nul.real.rate);
  if (p === 1) wiring = { detected: det.detected, trials: det.trials };
  design = nul.designTarget;
  console.log(
    `p=${p}: OFF alarm ${pct(nul.real.rate)} (${nul.real.flagged}/${nul.real.trials}) design ${pct(nul.designTarget)} | ` +
      `${nul.blindByGap} blind, ${nul.excluded} in ON/settle, ${nul.real.unusableReference} unusable ref || ` +
      `ON detected in ${target} ${det.detected}/${det.trials} (any group ${det.detectedAnyGroup}) | ` +
      `${det.tooShort} too short, ${det.refContaminated} ref contaminated, ${det.blindByGap} blind, ${det.unusableReference} unusable`,
  );
}

// The pre-registered rule, applied mechanically once the p = 1 wiring check passes
// (ROADMAP_BRIEF.md 2026-09-27 (3) H4, revision 2026-10-01 (2)).
const verdict = h4Verdict({
  offRateP1: offRate.get(1) ?? 0, offRateP01: offRate.get(0.1) ?? 0, design, wiring,
});
console.log(`\nH4 (pre-registered rule): ${verdict}`);
