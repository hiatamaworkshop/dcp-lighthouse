/**
 * Report over the collected Wikimedia stream (ROADMAP_BRIEF.md 2026-09-27 (3)).
 *
 *   cd server && npm run build && node dist/run-real-data-report.js --from 2026-09-29 --to 2026-10-02
 *
 * Prints H1's measurements (φ at 1 s / 10 s / 60 s, lag-1, R_real vs
 * FA_shuffle) and H2's power-vs-G curve. Data comes from WIKI_DATA_DIR
 * (default <repo>/data/wikimedia).
 *
 * The holdout is enforced here, not left to discipline: days on or after
 * HOLDOUT_FROM_DAY (days 5–7 of the collection) are refused unless
 * `--holdout` is passed, and passing it is the one final look the
 * pre-registration allows. Do not pass it to "just check" — nothing is
 * tuned on a holdout number, and a peek that changes a parameter afterwards
 * voids the period's conclusions.
 */
import { join } from "node:path";
import {
  dispersionProfile,
  HOLDOUT_FROM_DAY,
  loadWikiDir,
  restrictToKeyValues,
  runInjectionPower,
  runNullCalibration,
  topKeyValues,
} from "./real-data-harness.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const fromDay = arg("from");
const toDay = arg("to");
const holdout = process.argv.includes("--holdout");
if (fromDay === undefined || toDay === undefined) {
  console.error("usage: run-real-data-report --from YYYY-MM-DD --to YYYY-MM-DD [--holdout]");
  process.exit(2);
}
if (toDay >= HOLDOUT_FROM_DAY && !holdout) {
  console.error(
    `refusing: ${toDay} reaches the holdout (${HOLDOUT_FROM_DAY}…). ` +
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

console.log("\n— H1: dependence —");
for (const windowMs of [1_000, 10_000, 60_000]) {
  const d = dispersionProfile(stream, { windowMs });
  const k = dispersionProfile(stream, { windowMs, key: "wiki" });
  console.log(
    `window ${windowMs / 1000}s: φ mixed ${d.phi.toFixed(2)} | per-wiki ${k.phi.toFixed(2)} | ` +
      `lag1 ${d.lag1.toFixed(3)} (indep. ${d.lag1ExpectedUnderIndependence.toFixed(3)}) | ` +
      `${d.blocks} blocks, ${d.blindBlocks} blind`,
  );
}
for (const [label, lens] of [
  ["mixed 1s", { window_ms: 1_000 }],
  ["mixed 10s", { window_ms: 10_000 }],
] as const) {
  const spanMs = lens.window_ms === 10_000 ? 300_000 : 10_000;
  const r = runNullCalibration(stream, { lens, spanMs, shuffleReps: 3 });
  console.log(
    `${label} (span ${spanMs / 1000}s): R_real ${pct(r.real.rate)} (${r.real.flagged}/${r.real.trials}) ` +
      `FA_shuffle ${pct(r.shuffled.rate)} (${r.shuffled.flagged}/${r.shuffled.trials}) ` +
      `design ${pct(r.designTarget)} | ${r.blindByGap} blind by gap, ` +
      `${r.real.unusableReference}+${r.shuffled.unusableReference} unusable reference`,
  );
}

// The null control (fraction 0, same windows, same target) and the family the
// curator actually corrected for are printed beside each power: a power read
// alone hides how much of it the target window lights up with nothing planted,
// and whether growing G grew the family at all (thin keys are never scored).
console.log("\n— H2: power vs number of groups (target = busiest wiki, 80% of its window's events → 0) —");
const target = topKeyValues(stream.events, "wiki", 1)[0];
for (const g of [4, 16, 64, 256]) {
  const restricted = { ...stream, events: restrictToKeyValues(stream.events, "wiki", topKeyValues(stream.events, "wiki", g)) };
  const base = { lens: { window_ms: 1_000, group_by: ["wiki"] }, target: { key: "wiki", value: target } };
  const r = runInjectionPower(restricted, { ...base, fraction: 0.8 });
  const n = runInjectionPower(restricted, { ...base, fraction: 0 });
  console.log(
    `G=${g}: power ${pct(r.power)} (${r.detected}/${r.trials}), shift ${r.meanShiftTruth.toFixed(3)}, ` +
      `${r.targetThin} thin, ${r.blindByGap} blind, ${r.unusableReference} unusable | ` +
      `null control ${pct(n.power)} (${n.detected}/${n.trials}) | family ${r.meanFamilySize.toFixed(1)}`,
  );
}
