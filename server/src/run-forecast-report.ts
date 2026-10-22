/**
 * F2 on the collected Wikimedia stream (ROADMAP_BRIEF.md 2026-10-22 (7)(8)): does
 * the kriging forecast hold its predictive intervals where the latent model
 * claims to hold (ordinary volume), and are they narrower than the persistence
 * forecast the curator's comparison already makes?
 *
 *   cd server && npm run build && node dist/run-forecast-report.js --from 2026-10-01 --to 2026-10-21
 *
 * Arms: 60 s windows forecast from the last 60 (horizons 1…60 windows) and 10 s
 * windows from the last 30 (horizons 1…30), γ̂ from 24 spans of history ending
 * at the origin, one origin every 10 minutes. Every origin has its whole history:
 * the two days before each chunk of up to three observation days are loaded
 * with it. Exploration only; an unspent holdout is refused (stage 4's week).
 */
import { join } from "node:path";
import {
  FORECAST_METHODS,
  addForecastCell,
  emptyForecastCell,
  loadWikiDir,
  runForecastCalibration,
  spentHoldoutNote,
  stage1RangeRefusal,
  type ForecastCell,
} from "./real-data-harness.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const DAY = 86_400_000;
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const fromDay = arg("from");
const toDay = arg("to");
if (fromDay === undefined || toDay === undefined) {
  console.error("usage: run-forecast-report --from YYYY-MM-DD --to YYYY-MM-DD");
  process.exit(2);
}
const loadFirst = dayOf(Date.parse(`${fromDay}T00:00:00Z`) - 2 * DAY);
const refusal = stage1RangeRefusal(loadFirst, toDay, false);
if (refusal !== undefined) {
  console.error(refusal);
  process.exit(2);
}
const dir = process.env.WIKI_DATA_DIR ?? join(process.cwd(), "..", "data", "wikimedia");

const ARMS = [
  { key: "60 s", window: 60_000, K: 60, horizons: [1, 5, 15, 30, 60] },
  { key: "10 s", window: 10_000, K: 30, horizons: [1, 6, 30] },
];
const totals = new Map<string, Map<string, ForecastCell>>();
const days = new Map<string, Map<string, ForecastCell>>();
const meta = new Map<string, { origins: number; blind: number; fellBack: number }>();

console.log(`F2 forecast calibration, origins ${fromDay}…${toDay} (loaded from ${loadFirst}); history 24 spans; one origin every 10 min`);
const spentNote = spentHoldoutNote(loadFirst, toDay);
if (spentNote !== undefined) console.log(spentNote);

for (let c = Date.parse(`${fromDay}T00:00:00Z`); c <= Date.parse(`${toDay}T00:00:00Z`); c += 3 * DAY) {
  const chunkTo = dayOf(Math.min(c + 2 * DAY, Date.parse(`${toDay}T00:00:00Z`)));
  const stream = await loadWikiDir(dir, { fromDay: dayOf(c - 2 * DAY), toDay: chunkTo });
  console.error(`[forecast-report] ${dayOf(c)}…${chunkTo}: ${stream.events.length} events`);
  for (const arm of ARMS) {
    const r = runForecastCalibration(stream, {
      lens: { window_ms: arm.window }, recentWindows: arm.K, horizons: arm.horizons,
      historyMs: 24 * arm.K * arm.window, strideMs: 600_000, obsFromTs: c,
    });
    const t = totals.get(arm.key) ?? new Map<string, ForecastCell>();
    for (const [k, v] of r.cells) {
      const a = t.get(k) ?? emptyForecastCell();
      addForecastCell(a, v);
      t.set(k, a);
    }
    totals.set(arm.key, t);
    const d = days.get(arm.key) ?? new Map<string, ForecastCell>();
    for (const [k, v] of r.byDay) d.set(k, v);
    days.set(arm.key, d);
    const m = meta.get(arm.key) ?? { origins: 0, blind: 0, fellBack: 0 };
    m.origins += r.origins;
    m.blind += r.blindByGap;
    m.fellBack += r.krigingFellBack;
    meta.set(arm.key, m);
  }
}

const pct = (x: number, d = 2) => `${(100 * x).toFixed(d)}%`;
const fig = (c: ForecastCell) => {
  const mean = c.n > 0 ? c.s / c.n : 0;
  return {
    v: c.n > 1 ? (c.ss - c.n * mean * mean) / (c.n - 1) : 0, o2: c.n > 0 ? c.o2 / c.n : 0, o3: c.n > 0 ? c.o3 / c.n : 0,
    sd: c.n > 0 ? c.sd / c.n : 0, rmse: c.n > 0 ? Math.sqrt(c.se / c.n) : 0,
  };
};
for (const arm of ARMS) {
  const t = totals.get(arm.key)!;
  const m = meta.get(arm.key)!;
  console.log(`\n— ${arm.key} windows, forecast from the last ${arm.K}: ${m.origins} origins, ${m.blind} blind by gap, kriging fell back ${m.fellBack}×`);
  for (const band of ["ordinary", "off"]) {
    console.log(`  ${band === "ordinary" ? "ordinary volume (where the model claims to hold)" : "volume off ordinary (make-up changing)"}:`);
    console.log("  horizon  method            n        var z   |z|≥2    |z|≥3    mean SD   RMSE      SD vs persistence");
    for (const h of arm.horizons) {
      const base = fig(t.get(`persistence|${h}|${band}`) ?? emptyForecastCell());
      for (const method of FORECAST_METHODS) {
        const c = t.get(`${method}|${h}|${band}`);
        if (c === undefined || c.n === 0) continue;
        const f = fig(c);
        console.log(
          `  ${String(h).padStart(7)}  ${method.padEnd(16)} ${String(c.n).padStart(6)}  ${f.v.toFixed(3).padStart(6)}  ${pct(f.o2).padStart(6)}  ${pct(f.o3).padStart(6)}  ` +
            `${(1000 * f.sd).toFixed(2).padStart(6)}e-3 ${(1000 * f.rmse).toFixed(2).padStart(6)}e-3  ${base.sd > 0 ? `${(100 * (f.sd / base.sd - 1)).toFixed(1)}%` : "—"}`,
        );
      }
    }
  }
  console.log(`  N(0, 1): var 1.000, |z|≥2 4.55%, |z|≥3 0.27%`);
  console.log(`  per day (kriging, horizon ${arm.horizons[0]}, ordinary volume): day  n  var z  |z|≥2`);
  for (const [day, c] of [...days.get(arm.key)!.entries()].sort()) {
    const f = fig(c);
    console.log(`    ${day}  ${String(c.n).padStart(4)}  ${f.v.toFixed(3)}  ${pct(f.o2, 1)}`);
  }
}
