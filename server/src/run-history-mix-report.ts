/**
 * Step 1b (ROADMAP_BRIEF.md 2026-11-02 (2)): is the variogram null's
 * conservatism at ordinary volume (stage 4: V-a var z 0.533) the history's
 * make-up changes inflating γ̂? (hypothesis H-mix)
 *
 * Diagnostic only — the curator is not changed. Each "preceding span" trial is
 * scored twice under the variogram null: with its history as recorded, and
 * with the history's windows off ordinary volume removed
 * (runHistoryMixCalibration). Read:
 *
 *   1. the ordinary-volume gate z, full vs cleaned (var z, |z|≥2, |z|≥3);
 *   2. the same by how much of each trial's history was off ordinary volume
 *      (H-mix predicts: the more contaminated, the narrower the full z, and
 *      cleaning widens it toward N(0, 1));
 *   3. per observation day (one day's make-up change vs a week's);
 *   4. what cleaning buys and costs: a steady-volume −0.1 shift over one window,
 *      caught with either history, and the unplanted control.
 *
 * Synthetic check (real-data-harness.test.ts): batches in the history take the
 * ordinary var z from 0.96 to 0.32 and the −0.1 detection from 40 to 10 of 118;
 * cleaning by the reference's volume brings them back to 0.94 and 43.
 *
 *   cd server && npm run build && node dist/run-history-mix-report.js --from 2026-10-26 --to 2026-11-01
 *
 * Arms V-a (60 s / 60 min) and the 10 s arm (10 s / 300 s). V-b (1 s) is left
 * out: its volume band is 1.4 Poisson SDs wide and cannot tell make-up from
 * counting noise (2026-10-22 (5)). `--clean reference|trailing|both` (default
 * both): how "off ordinary volume" is read for a history window — against the
 * trial's reference median (default reading) or against the windows just
 * before it. Exploration only.
 */
import { join } from "node:path";
import {
  addGateZSums,
  bandFigures,
  emptyGateZSums,
  historyMixReading,
  loadWikiDir,
  runHistoryMixCalibration,
  spentHoldoutNote,
  stage1RangeRefusal,
  stage5HoldoutRefusal,
  stage5Verdict,
  type GateZSums,
  type VolumeBandStats,
} from "./real-data-harness.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const DAY = 86_400_000;
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const fromDay = arg("from");
const toDay = arg("to");
// Stage 5's single look (ROADMAP C8): the sealed week 2026-11-09…11-15, the pre-registered rule only.
// --rehearse: the same rule, options and verdict on EXPLORATION days (a range that touches the sealed week is
// refused as always) — to run the look's code path before the look.
const holdout = process.argv.includes("--holdout");
const rehearse = process.argv.includes("--rehearse");
if (holdout && rehearse) {
  console.error("refusing: --rehearse is for exploration days, not the holdout");
  process.exit(2);
}
const preregistered = holdout || rehearse;
const cleanArg = preregistered ? "history" : arg("clean") ?? "both";
const maxRemoved = preregistered ? "0.5" : arg("max-removed");
const CLEANS = ["reference", "trailing", "history", "centered"] as const;
type Clean = (typeof CLEANS)[number];
const cleans = (cleanArg === "both" ? ["reference", "trailing"] : cleanArg.split(",")) as Clean[];
if (fromDay === undefined || toDay === undefined || cleans.some((c) => !CLEANS.includes(c))) {
  console.error("usage: run-history-mix-report --from YYYY-MM-DD --to YYYY-MM-DD [--clean reference|trailing|history|centered|both (comma list ok)]");
  process.exit(2);
}
const loadFirst = dayOf(Date.parse(`${fromDay}T00:00:00Z`) - 2 * DAY);
const refusal = holdout
  ? stage5HoldoutRefusal(fromDay, toDay, Date.now()) ??
    (arg("clean") !== undefined || arg("max-removed") !== undefined || process.argv.includes("--fine-bins")
      ? "refusing: stage 5's holdout runs the pre-registered rule (clean history, max removed 0.5) with no other options"
      : undefined)
  : rehearse && (arg("clean") !== undefined || arg("max-removed") !== undefined || process.argv.includes("--fine-bins"))
    ? "refusing: --rehearse runs the pre-registered rule (clean history, max removed 0.5) with no other options"
    : stage1RangeRefusal(loadFirst, toDay, false);
if (refusal !== undefined) {
  console.error(refusal);
  process.exit(2);
}
const dir = process.env.WIKI_DATA_DIR ?? join(process.cwd(), "..", "data", "wikimedia");

const ARMS = [
  { key: "V-a", label: "60 s windows, 60 min span", window: 60_000, span: 3_600_000, stride: 600_000, injectEvery: 2 },
  { key: "H1-10s", label: "10 s windows, 300 s span", window: 10_000, span: 300_000, stride: 600_000, injectEvery: 1 },
] as const;
const SHIFT = -0.1;

interface Acc {
  trials: number;
  contamination: number;
  historyWindows: number;
  removed: number;
  bands: Map<VolumeBandStats["band"], { full: GateZSums; cleaned: GateZSums }>;
  bins: Map<string, { trials: number; full: GateZSums; cleaned: GateZSums }>;
  blindByGap: number;
  days: Array<{ day: string; trials: number; meanContamination: number; full: VolumeBandStats; cleaned: VolumeBandStats }>;
  inj: { trials: number; detectedFull: number; detectedCleaned: number; controlFull: number; controlCleaned: number };
}
const acc = new Map<string, Acc>();

if (holdout) console.log(`STAGE 5 HOLDOUT ${fromDay}…${toDay} — the single look (ROADMAP_BRIEF.md 2026-11-02 (11))`);
console.log(`step 1b (H-mix): ordinary-volume gate z under the variogram null with the history as recorded vs cleaned of ` +
  `off-ordinary-volume windows, observation days ${fromDay}…${toDay} (loaded from ${loadFirst}); history 24 spans; clean ${cleans.join(", ")}`);
const spentNote = spentHoldoutNote(loadFirst, toDay);
if (spentNote !== undefined) console.log(spentNote);

for (let c = Date.parse(`${fromDay}T00:00:00Z`); c <= Date.parse(`${toDay}T00:00:00Z`); c += 3 * DAY) {
  const chunkTo = dayOf(Math.min(c + 2 * DAY, Date.parse(`${toDay}T00:00:00Z`)));
  const stream = await loadWikiDir(dir, { fromDay: dayOf(c - 2 * DAY), toDay: chunkTo });
  console.error(`[history-mix-report] ${dayOf(c)}…${chunkTo}: ${stream.events.length} events, ${stream.gaps.length} gaps`);
  for (const arm of ARMS) {
    for (const clean of cleans) {
      const r = runHistoryMixCalibration(stream, {
        lens: { window_ms: arm.window }, spanMs: arm.span, strideMs: arm.stride, obsFromTs: c, historyMs: 24 * arm.span, clean,
        ...(maxRemoved !== undefined ? { maxRemovedShare: Number(maxRemoved) } : {}),
        ...(process.argv.includes("--fine-bins") ? { contaminationBins: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, Infinity] } : {}),
        inject: { shift: SHIFT, windows: 1, every: arm.injectEvery },
      });
      const key = `${arm.key}|${clean}`;
      const a: Acc = acc.get(key) ?? {
        trials: 0, contamination: 0, historyWindows: 0, removed: 0, bands: new Map(), bins: new Map(), blindByGap: 0, days: [],
        inj: { trials: 0, detectedFull: 0, detectedCleaned: 0, controlFull: 0, controlCleaned: 0 },
      };
      a.trials += r.trials;
      a.blindByGap += r.blindByGap;
      a.contamination += r.meanContamination * r.trials;
      a.historyWindows += r.historyWindows;
      a.removed += r.removedHistoryWindows;
      for (const b of r.bands) {
        const x = a.bands.get(b.band) ?? { full: emptyGateZSums(), cleaned: emptyGateZSums() };
        addGateZSums(x.full, b.full.sums);
        addGateZSums(x.cleaned, b.cleaned.sums);
        a.bands.set(b.band, x);
      }
      for (const b of r.bins) {
        const k = `${b.from}…${b.to === Infinity ? "1" : b.to}`;
        const x = a.bins.get(k) ?? { trials: 0, full: emptyGateZSums(), cleaned: emptyGateZSums() };
        x.trials += b.trials;
        addGateZSums(x.full, b.full.sums);
        addGateZSums(x.cleaned, b.cleaned.sums);
        a.bins.set(k, x);
      }
      a.days.push(...r.byDay);
      if (r.injection !== undefined) {
        a.inj.trials += r.injection.trials;
        a.inj.detectedFull += r.injection.detectedFull;
        a.inj.detectedCleaned += r.injection.detectedCleaned;
        a.inj.controlFull += r.injection.controlFull;
        a.inj.controlCleaned += r.injection.controlCleaned;
      }
      acc.set(key, a);
    }
  }
}

const pct = (x: number, d = 2) => `${(100 * x).toFixed(d)}%`;
const fig = (f: VolumeBandStats) => `${String(f.windows).padStart(7)}  ${f.varGateZ.toFixed(3).padStart(6)}  ${pct(f.over2).padStart(6)}  ${pct(f.over3).padStart(6)}`;
const weekday = (d: string) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(`${d}T00:00:00Z`).getUTCDay()];

for (const arm of ARMS) {
  for (const clean of cleans) {
    const a = acc.get(`${arm.key}|${clean}`)!;
    console.log(`\n=== ${arm.key} (${arm.label}), clean = ${clean}: ${a.trials} trials, history windows removed ` +
      `${a.removed}/${a.historyWindows} (${pct(a.removed / Math.max(1, a.historyWindows), 1)}), mean contamination ${pct(a.contamination / Math.max(1, a.trials), 1)}`);
    console.log("1. by the observation window's volume band          [history as recorded]           [history cleaned]");
    console.log("   band        windows   var z   |z|≥2   |z|≥3   |   var z   |z|≥2   |z|≥3");
    for (const band of ["ordinary", "low", "high"] as const) {
      const x = a.bands.get(band);
      if (x === undefined || x.full.n === 0) continue;
      const f = bandFigures(band, x.full);
      const g = bandFigures(band, x.cleaned);
      console.log(`   ${band.padEnd(9)} ${fig(f)}   | ${g.varGateZ.toFixed(3).padStart(6)}  ${pct(g.over2).padStart(6)}  ${pct(g.over3).padStart(6)}`);
    }
    console.log("   N(0, 1)                1.000   4.55%   0.27%");
    console.log("2. ordinary volume, by the share of the trial's history off ordinary volume");
    console.log("   contamination  trials   windows   var z   |z|≥2   |z|≥3   |   var z   |z|≥2   |z|≥3");
    for (const [k, x] of a.bins) {
      if (x.trials === 0) continue;
      const f = bandFigures("ordinary", x.full);
      const g = bandFigures("ordinary", x.cleaned);
      console.log(`   ${k.padEnd(13)} ${String(x.trials).padStart(7)} ${fig(f)}   | ${g.varGateZ.toFixed(3).padStart(6)}  ${pct(g.over2).padStart(6)}  ${pct(g.over3).padStart(6)}`);
    }
    console.log("3. ordinary volume, per observation day");
    console.log("   day         wd   trials  contam.   windows   var z   |z|≥2   |z|≥3   |   var z   |z|≥2   |z|≥3");
    for (const d of a.days) {
      console.log(`   ${d.day}  ${weekday(d.day)}  ${String(d.trials).padStart(6)}  ${pct(d.meanContamination, 1).padStart(6)} ${fig(d.full)}   | ` +
        `${d.cleaned.varGateZ.toFixed(3).padStart(6)}  ${pct(d.cleaned.over2).padStart(6)}  ${pct(d.cleaned.over3).padStart(6)}`);
    }
    const i = a.inj;
    console.log(`4. a steady-volume shift of ${SHIFT} over one window: caught ${i.detectedFull}/${i.trials} (${pct(i.detectedFull / Math.max(1, i.trials), 1)}) ` +
      `with the history as recorded, ${i.detectedCleaned}/${i.trials} (${pct(i.detectedCleaned / Math.max(1, i.trials), 1)}) cleaned; ` +
      `unplanted control ${pct(i.controlFull / Math.max(1, i.trials), 1)} / ${pct(i.controlCleaned / Math.max(1, i.trials), 1)}`);
  }
}
console.log("\nReading, fixed before any recorded day was run (2026-11-02 (2), historyMixReading on the reference cleaning): supported = the " +
  "ordinary var z widens by ≥ 0.15 when cleaned AND the most contaminated bin (≥ 0.1) is narrower than the least; not supported = widens by < 0.05; " +
  "overshoot = the cleaned null went liberal (var > 1.25 or |z|≥3 > 0.8%)");
for (const arm of ARMS) {
  const a = acc.get(`${arm.key}|reference`);
  if (a === undefined) continue;
  const bands = [...a.bands.entries()].map(([band, x]) => ({ band, full: bandFigures(band, x.full), cleaned: bandFigures(band, x.cleaned) }));
  const bins = [...a.bins.entries()]
    .map(([k, x]) => ({ from: Number(k.split("…")[0]), full: bandFigures("ordinary", x.full) }))
    .sort((p, q) => p.from - q.from);
  const r = historyMixReading({ bands, bins: bins.map((b) => ({ ...b, to: 0, trials: 0, cleaned: b.full })) });
  console.log(`   ${arm.key}: ${r.verdict} (widening ${r.widening >= 0 ? "+" : ""}${r.widening.toFixed(3)}, gradient ${r.gradient ? "yes" : "no"}` +
    `${r.overshoot ? ", cleaned null overshoots" : ""})`);
}

if (preregistered) {
  const armOf = (key: string, name: string) => {
    const a = acc.get(`${key}|history`)!;
    const o = a.bands.get("ordinary");
    return { name, full: o?.full ?? emptyGateZSums(), cleaned: o?.cleaned ?? emptyGateZSums(), trials: a.trials, blindByGap: a.blindByGap, injection: a.inj };
  };
  console.log(`\nSTAGE 5 VERDICT${rehearse ? " — REHEARSAL on exploration days, not the look" : ""} (claim H-clean, ordinary volume, variogram null with history_clean median): ${stage5Verdict([armOf("V-a", "V-a"), armOf("H1-10s", "10 s arm")])}`);
}
