/**
 * Stage 3's question asked again with a control (ROADMAP_BRIEF.md 2026-10-22 (4)(5)):
 * the package alarm rate on unlabelled real data counts the stream's make-up
 * changing (a bot batch starting or stopping) as if it were the null's error.
 * This report splits the two, and measures the half stage 3 never asked:
 *
 *   1. calibration where the null's assumptions hold — the gate's z over EVERY
 *      window at ordinary volume (ORDINARY_VOLUME) against N(0, 1), and the
 *      ordinary-volume package rate against what the gate promises;
 *   2. the alarms the make-up produces — episodes whose fired windows all moved
 *      in volume, per day (a description, not a verdict);
 *   3. detection at steady volume — a planted shift of the bot share
 *      (runShiftInjection) against its unplanted control.
 *
 *   cd server && npm run build && node dist/run-volume-report.js --from 2026-10-01 --to 2026-10-21
 *
 * Every trial has its whole reference and history: the two days before each
 * chunk of up to three observation days are loaded with it. Exploration only;
 * spent holdout days are labelled, an unspent holdout is refused. Options:
 * `--nulls` (independent,overdispersed,variogram), `--no-inject`.
 *
 * The day is the resampling unit for spread (alarms and window scores cluster
 * within a day): section 3 bootstraps whole days to give the sampling spread a
 * 7-day period's figures would have — what a holdout's tolerance is set from.
 *
 * Stage 4's single look (ROADMAP_BRIEF.md 2026-10-22 (6)), once its week is over:
 *
 *   node dist/run-volume-report.js --from 2026-10-26 --to 2026-11-01 --holdout
 *
 * reads exactly the holdout week (stage4HoldoutRefusal) with the two days before
 * it for references and history, runs every section with the default nulls, and
 * prints stage4Verdict on V-a and the 10 s arm at the end.
 */
import { join } from "node:path";
import { mulberry32 } from "./calibration.js";
import {
  ORDINARY_VOLUME,
  addGateZSums,
  bandFigures,
  emptyGateZSums,
  loadWikiDir,
  runShiftInjection,
  runVolumeCalibration,
  scoringCurator,
  spentHoldoutNote,
  stage1RangeRefusal,
  stage4HoldoutRefusal,
  stage4Verdict,
  type GateZSums,
  type VolumeCalibrationDay,
} from "./real-data-harness.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const DAY = 86_400_000;
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const fromDay = arg("from");
const toDay = arg("to");
const nulls = (arg("nulls") ?? "independent,overdispersed,variogram").split(",") as Array<"independent" | "overdispersed" | "variogram">;
const inject = !process.argv.includes("--no-inject");
if (fromDay === undefined || toDay === undefined || nulls.some((n) => !["independent", "overdispersed", "variogram"].includes(n))) {
  console.error("usage: run-volume-report --from YYYY-MM-DD --to YYYY-MM-DD [--nulls independent,overdispersed,variogram] [--no-inject]");
  process.exit(2);
}
const holdout = process.argv.includes("--holdout");
const loadFirst = dayOf(Date.parse(`${fromDay}T00:00:00Z`) - 2 * DAY);
const refusal = holdout
  ? stage4HoldoutRefusal(fromDay, toDay, Date.now()) ??
    (arg("nulls") !== undefined || !inject ? "refusing: stage 4's holdout runs the pre-registered nulls and sections" : undefined)
  : stage1RangeRefusal(loadFirst, toDay, false);
if (refusal !== undefined) {
  console.error(refusal);
  process.exit(2);
}
const dir = process.env.WIKI_DATA_DIR ?? join(process.cwd(), "..", "data", "wikimedia");

interface Arm {
  key: string;
  label: string;
  window: number;
  span: number;
  stride: number;
  shifts: number[];
  runs: number[];
  every: number;
}
const ARMS: Arm[] = [
  { key: "V-b", label: "1 s windows, 10 s span (V-b, H1)", window: 1_000, span: 10_000, stride: 20_000, shifts: [-0.1, -0.2, -0.4], runs: [1, 5], every: 20 },
  { key: "H1-10s", label: "10 s windows, 300 s span (H1)", window: 10_000, span: 300_000, stride: 600_000, shifts: [-0.02, -0.05, -0.1, -0.2], runs: [1, 6, 30], every: 1 },
  { key: "V-a", label: "60 s windows, 60 min span (V-a, H3)", window: 60_000, span: 3_600_000, stride: 600_000, shifts: [-0.02, -0.05, -0.1, -0.2], runs: [1, 10, 30], every: 2 },
];

interface Totals {
  trials: number;
  blindByGap: number;
  flagged: number;
  flaggedOrdinary: number;
  expectedOrdinary: number;
  episodes: number;
  compositionEpisodes: number;
  typical: number[];
  bands: Map<string, GateZSums>;
  days: VolumeCalibrationDay[];
}
const totals = new Map<string, Totals>();
const injections = new Map<string, { trials: number; detected: number; control: number; truth: number; skipped: number }>();
const fresh = (): Totals => ({
  trials: 0, blindByGap: 0, flagged: 0, flaggedOrdinary: 0, expectedOrdinary: 0, episodes: 0, compositionEpisodes: 0, typical: [], bands: new Map(), days: [],
});

if (holdout) console.log(`STAGE 4 HOLDOUT ${fromDay}…${toDay} — the single look (ROADMAP_BRIEF.md 2026-10-22 (6))`);
console.log(`volume-split calibration and steady-volume detection, observation days ${fromDay}…${toDay} (loaded from ${loadFirst}); ` +
  `ordinary volume = ${ORDINARY_VOLUME[0]}…${ORDINARY_VOLUME[1]}× the reference's median window; history 24 spans; nulls ${nulls.join(", ")}`);
const spentNote = spentHoldoutNote(loadFirst, toDay);
if (spentNote !== undefined) console.log(spentNote);

for (let c = Date.parse(`${fromDay}T00:00:00Z`); c <= Date.parse(`${toDay}T00:00:00Z`); c += 3 * DAY) {
  const chunkTo = dayOf(Math.min(c + 2 * DAY, Date.parse(`${toDay}T00:00:00Z`)));
  const stream = await loadWikiDir(dir, { fromDay: dayOf(c - 2 * DAY), toDay: chunkTo });
  console.error(`[volume-report] ${dayOf(c)}…${chunkTo}: ${stream.events.length} events, ${stream.gaps.length} gaps`);
  for (const arm of ARMS) {
    const base = { lens: { window_ms: arm.window }, spanMs: arm.span, strideMs: arm.stride, obsFromTs: c };
    for (const nm of nulls) {
      const historyMs = nm === "variogram" ? 24 * arm.span : 0;
      const r = runVolumeCalibration(stream, { ...base, curator: scoringCurator(nm), historyMs });
      const key = `${arm.key}|${nm}`;
      const t = totals.get(key) ?? fresh();
      t.trials += r.trials;
      t.blindByGap += r.blindByGap;
      t.flagged += r.flagged;
      t.flaggedOrdinary += r.flaggedOrdinary;
      t.expectedOrdinary += r.expectedOrdinaryRate * r.trials;
      t.episodes += r.episodes;
      t.compositionEpisodes += r.compositionEpisodes;
      t.typical.push(r.typicalWindowCount);
      for (const b of r.bands) {
        const a = t.bands.get(b.band) ?? emptyGateZSums();
        addGateZSums(a, b.sums);
        t.bands.set(b.band, a);
      }
      t.days.push(...r.byDay);
      totals.set(key, t);
      if (!inject) continue;
      for (const shift of arm.shifts) {
        for (const runs of arm.runs) {
          const x = runShiftInjection(stream, { ...base, curator: scoringCurator(nm), historyMs, shift, windows: runs, every: arm.every });
          const ik = `${arm.key}|${nm}|${shift}|${runs}`;
          const acc = injections.get(ik) ?? { trials: 0, detected: 0, control: 0, truth: 0, skipped: 0 };
          acc.trials += x.trials;
          acc.detected += x.detected;
          acc.control += x.controlDetected;
          acc.truth += x.meanShiftTruth * x.trials;
          acc.skipped += x.skipped;
          injections.set(ik, acc);
        }
      }
    }
  }
}

const pct = (x: number, d = 1) => `${(100 * x).toFixed(d)}%`;
const permil = (x: number) => `${(1000 * x).toFixed(2)}‰`;
const weekday = (d: string) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(`${d}T00:00:00Z`).getUTCDay()];

console.log("\n1. Calibration where the null's assumptions hold (ordinary volume) — gate z over every (trial, window) pair");
for (const arm of ARMS) {
  const typical = totals.get(`${arm.key}|${nulls[0]}`)?.typical ?? [];
  const median = typical.length > 0 ? typical.slice().sort((a, b) => a - b)[typical.length >> 1] : 0;
  const widthSd = median > 0 ? (ORDINARY_VOLUME[1] - 1) * Math.sqrt(median) : 0;
  console.log(`\n— ${arm.label}: typical window ${median.toFixed(0)} events, so the band's upper edge is ${widthSd.toFixed(1)} Poisson SDs out` +
    (widthSd < 3 ? " (too narrow to separate make-up changes from counting noise: read the bands together)" : ""));
  console.log("null           band      windows   var z   |z|≥1   |z|≥2   |z|≥3   ≥gate (nominal)");
  for (const nm of nulls) {
    const t = totals.get(`${arm.key}|${nm}`)!;
    for (const band of ["ordinary", "low", "high"] as const) {
      const a = t.bands.get(band);
      if (a === undefined || a.n === 0) continue;
      const f = bandFigures(band, a);
      console.log(
        `${nm.padEnd(14)} ${band.padEnd(8)} ${String(f.windows).padStart(9)}  ${f.varGateZ.toFixed(3).padStart(6)}  ${pct(f.over1).padStart(6)}  ${pct(f.over2, 2).padStart(6)}  ` +
          `${pct(f.over3, 2).padStart(6)}  ${permil(f.overGate)} (${permil(f.nominalOverGate)})`,
      );
    }
  }
  console.log("               N(0, 1):              1.000   31.7%   4.55%   0.27%");
}

console.log("\n2. Package alarms: all, ordinary-volume only (vs what the gate promises for that many windows), and episodes");
console.log("arm      null           trials   alarm   ordinary-only (expected)   episodes  composition-only");
for (const arm of ARMS) {
  for (const nm of nulls) {
    const t = totals.get(`${arm.key}|${nm}`)!;
    console.log(
      `${arm.key.padEnd(8)} ${nm.padEnd(14)} ${String(t.trials).padStart(6)}  ${pct(t.flagged / Math.max(1, t.trials), 2).padStart(6)}   ` +
        `${pct(t.flaggedOrdinary / Math.max(1, t.trials), 2).padStart(6)} (${pct(t.expectedOrdinary / Math.max(1, t.trials), 2)})          ` +
        `${String(t.episodes).padStart(5)}  ${String(t.compositionEpisodes).padStart(6)}`,
    );
  }
}

if (nulls.includes("variogram")) {
  for (const armKey of ["V-a", "H1-10s", "V-b"]) {
    const days = totals.get(`${armKey}|variogram`)!.days;
    console.log(`\n3. Per observation day (${armKey}, variogram): package alarms, episodes (composition-only), and the gate z at ordinary volume`);
    console.log("day         wd    trials  alarm   ordinary  episodes   ord. windows  var z   |z|≥2   |z|≥3   ≥gate (nominal)");
    for (const d of days) {
      const f = bandFigures("ordinary", d.ordinary);
      console.log(
        `${d.day}  ${weekday(d.day)}  ${String(d.trials).padStart(6)}  ${pct(d.flagged / Math.max(1, d.trials)).padStart(6)}  ` +
          `${pct(d.flaggedOrdinary / Math.max(1, d.trials)).padStart(7)}   ${`${d.episodes} (${d.compositionEpisodes})`.padEnd(9)}  ` +
          `${String(f.windows).padStart(9)}  ${f.varGateZ.toFixed(3).padStart(6)}  ${pct(f.over2, 2).padStart(6)}  ${pct(f.over3, 2).padStart(6)}  ` +
          `${permil(f.overGate)} (${permil(f.nominalOverGate)})`,
      );
    }
    // Whole days resampled: the spread a 7-day period's pooled figures would have.
    const rng = mulberry32(20261022);
    const reps = 4000;
    const stats: Array<{ v: number; o2: number; o3: number; og: number; alarm: number; ordAlarm: number }> = [];
    for (let r = 0; r < reps; r++) {
      const pool = emptyGateZSums();
      let trials = 0;
      let flagged = 0;
      let ordinary = 0;
      for (let k = 0; k < 7; k++) {
        const d = days[Math.floor(rng() * days.length)];
        addGateZSums(pool, d.ordinary);
        trials += d.trials;
        flagged += d.flagged;
        ordinary += d.flaggedOrdinary;
      }
      const f = bandFigures("ordinary", pool);
      stats.push({ v: f.varGateZ, o2: f.over2, o3: f.over3, og: f.overGate / Math.max(1e-12, f.nominalOverGate), alarm: flagged / trials, ordAlarm: ordinary / trials });
    }
    const q = (xs: number[], p: number) => xs.slice().sort((a, b) => a - b)[Math.floor(p * (xs.length - 1))];
    const show = (name: string, xs: number[], fmt: (x: number) => string) =>
      console.log(`   7-day bootstrap ${name.padEnd(28)} median ${fmt(q(xs, 0.5))}, 95% ${fmt(q(xs, 0.025))} … ${fmt(q(xs, 0.975))}`);
    show("var z (ordinary)", stats.map((s) => s.v), (x) => x.toFixed(3));
    show("|z|≥2 (ordinary)", stats.map((s) => s.o2), (x) => pct(x, 2));
    show("|z|≥3 (ordinary)", stats.map((s) => s.o3), (x) => pct(x, 2));
    show("≥gate ÷ nominal (ordinary)", stats.map((s) => s.og), (x) => `${x.toFixed(2)}×`);
    show("package alarm (all)", stats.map((s) => s.alarm), (x) => pct(x, 1));
    show("package alarm (ordinary-only)", stats.map((s) => s.ordAlarm), (x) => pct(x, 1));
  }
}

if (inject) {
  console.log("\n4. Detection at steady volume: the bot share planted down by |shift| over the first `runs` windows of the observation");
  console.log("   (power = a dip/step_down tile on those windows; control = the same trials unplanted)");
  for (const arm of ARMS) {
    console.log(`\n— ${arm.label}`);
    console.log(`null           runs  ${arm.shifts.map((s) => `shift ${s}`.padStart(16)).join("")}`);
    for (const nm of nulls) {
      for (const runs of arm.runs) {
        const cells = arm.shifts.map((s) => {
          const a = injections.get(`${arm.key}|${nm}|${s}|${runs}`)!;
          return `${pct(a.detected / Math.max(1, a.trials), 0)} (c ${pct(a.control / Math.max(1, a.trials), 0)})`.padStart(16);
        });
        console.log(`${nm.padEnd(14)} ${String(runs).padStart(4)}  ${cells.join("")}`);
      }
    }
    const any = injections.get(`${arm.key}|${nulls[0]}|${arm.shifts[0]}|${arm.runs[0]}`)!;
    console.log(`   trials per cell ≈ ${any.trials} (every ${arm.every}th), skipped ≈ ${any.skipped}`);
  }
}

if (holdout) {
  const armOf = (key: string, name: string) => {
    const t = totals.get(`${key}|variogram`)!;
    return { name, ordinary: t.bands.get("ordinary") ?? emptyGateZSums(), trials: t.trials, blindByGap: t.blindByGap };
  };
  console.log(`\nSTAGE 4 VERDICT (claim C, ordinary volume, variogram null): ${stage4Verdict([armOf("V-a", "V-a"), armOf("H1-10s", "10 s arm")])}`);
}
