import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  Forecaster,
  fitVariogram,
  forecastMse,
  forecastPoint,
  forecastRow,
  krigingWeights,
  persistenceWeights,
  variogramAt,
  type ForecastPoint,
} from "./forecast.js";
import type { WindowStat } from "./lens.js";
import { mulberry32 } from "./calibration.js";

const W = 60_000;

/** 0/1 windows of n events each, latent rate theta[t] (clamped to [0, 1]), on one grid from 0. */
function binaryWindows(theta: readonly number[], n: number, seed: number): WindowStat[] {
  const rng = mulberry32(seed);
  return theta.map((p, t) => {
    const q = Math.min(1, Math.max(0, p));
    let ones = 0;
    for (let k = 0; k < n; k++) if (rng() < q) ones++;
    return {
      windowStart: t * W, windowEnd: (t + 1) * W, count: n, mean: ones / n, sumSq: ones, valid: true,
      range: { min: ones < n ? 0 : 1, max: ones > 0 ? 1 : 0 },
    };
  });
}

/** AR(1) latent rate around `mu` with stationary sd `sd`. */
function ar1(length: number, rho: number, sd: number, mu: number, seed: number): number[] {
  const rng = mulberry32(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
  const out: number[] = [];
  let x = gauss() * sd;
  for (let t = 0; t < length; t++) {
    x = rho * x + Math.sqrt(1 - rho * rho) * sd * gauss();
    out.push(mu + x);
  }
  return out;
}

describe("F2: the forecast row (kriging on the variogram null's γ̂)", () => {
  it("recovers either family from an exact curve, and fits an all-zero γ̂ with zero", () => {
    const g = new Float64Array(101);
    for (let h = 1; h <= 100; h++) g[h] = 0.001 + 0.0005 * Math.pow(h, 0.6);
    const p = fitVariogram(g);
    assert.equal(p.family, "power");
    assert.ok(Math.abs(p.shape - 0.6) < 0.051, `shape ${p.shape}`);
    assert.ok(Math.abs(p.nugget - 0.001) < 1e-4 && Math.abs(p.scale - 0.0005) < 5e-5, JSON.stringify(p));
    for (let h = 1; h <= 100; h++) g[h] = 2e-4 + 3e-3 * (1 - Math.exp(-h / 30));
    const e = fitVariogram(g);
    assert.deepEqual([e.family, e.shape], ["exponential", 30]);
    assert.ok(Math.abs(variogramAt(e, 10) - g[10]) < 1e-9);
    const z = fitVariogram(new Float64Array(20));
    assert.equal(z.nugget + z.scale, 0);
    assert.equal(variogramAt(z, 0), 0);
  });

  it("kriging with no latent variation is the inverse-variance mean; with a steep γ it leans on the last window", () => {
    const pts: ForecastPoint[] = Array.from({ length: 5 }, (_, i) => ({ i, mean: 0.5, v: 0.01, n: 25 }));
    const flat = krigingWeights(pts, 5, () => 0)!;
    assert.ok(Array.from(flat.weights).every((x) => Math.abs(x - 0.2) < 1e-9));
    assert.ok(Math.abs(flat.latentVar - 0.01 / 5) < 1e-12);
    const steep = krigingWeights(pts, 5, (h) => (h === 0 ? 0 : 0.05 * Math.abs(h)))!;
    assert.ok(steep.weights[4] > 0.7, `last weight ${steep.weights[4]}`);
  });

  it("kriging's variance never exceeds persistence's on the same γ, and matches its own MSE formula", () => {
    const rng = mulberry32(7);
    const m = { family: "power" as const, nugget: 2e-4, scale: 3e-4, shape: 0.7 };
    const gamma = (h: number) => variogramAt(m, h);
    for (let rep = 0; rep < 20; rep++) {
      const pts: ForecastPoint[] = Array.from({ length: 30 }, (_, i) => ({ i, mean: 0.5, v: 1e-4 * (0.5 + rng()), n: 2000 }));
      for (const target of [30, 40, 59]) {
        const k = krigingWeights(pts, target, gamma)!;
        const p = forecastMse(pts, persistenceWeights(pts), target, gamma);
        assert.ok(k.latentVar <= p + 1e-12, `kriging ${k.latentVar} vs persistence ${p}`);
        assert.ok(Math.abs(forecastMse(pts, k.weights, target, gamma) - k.latentVar) < 1e-10);
      }
    }
  });

  it("on AR(1) latent streams both forecasts hold their intervals, and kriging's are narrower next window", () => {
    // Origins 30 windows apart are still correlated (ρ 0.97 per window), so the
    // check pools three independent streams rather than trusting one.
    const K = 60;
    const H = 24 * K;
    const stats = new Map<string, { n: number; ss: number; o2: number; sd: number; se: number }>();
    for (const seed of [11, 31, 51]) {
      const windows = binaryWindows(ar1(H + K + 4000, 0.97, 0.05, 0.5, seed), 300, seed + 1);
      for (let t = H + K; t + 30 <= windows.length; t += 30) {
        const recent = windows.slice(t - K, t);
        const history = windows.slice(t - K - H, t);
        for (const horizon of [1, 30]) {
          const target = windows[t - 1 + horizon];
          for (const method of ["kriging", "persistence"] as const) {
            const f = forecastRow(recent, history, { window_ms: W, horizon, method })!;
            assert.equal(f.virtual, true);
            assert.equal(f.targetStart, target.windowStart);
            const sd = Math.sqrt(f.latentVar + f.eventVar / target.count);
            const z = (target.mean - f.mean) / sd;
            const key = `${method}|${horizon}`;
            const s = stats.get(key) ?? { n: 0, ss: 0, o2: 0, sd: 0, se: 0 };
            s.n++;
            s.ss += z * z;
            if (Math.abs(z) >= 2) s.o2++;
            s.sd += sd;
            s.se += (target.mean - f.mean) ** 2;
            stats.set(key, s);
          }
        }
      }
    }
    for (const [key, s] of stats) {
      const v = s.ss / s.n;
      assert.ok(v > 0.7 && v < 1.35, `${key}: var z ${v.toFixed(3)} over ${s.n}`);
      assert.ok(s.o2 / s.n < 0.09, `${key}: |z|≥2 ${(s.o2 / s.n).toFixed(3)}`);
    }
    const k1 = stats.get("kriging|1")!;
    const p1 = stats.get("persistence|1")!;
    assert.ok(k1.sd / k1.n < 0.8 * (p1.sd / p1.n), `kriging sd ${k1.sd / k1.n} vs persistence ${p1.sd / p1.n}`);
    assert.ok(k1.se / k1.n < 0.8 * (p1.se / p1.n), `kriging mse ${k1.se / k1.n} vs persistence ${p1.se / p1.n}`);
  });

  it("reads nothing at or after its origin, and says when kriging fell back", () => {
    const windows = binaryWindows(ar1(400, 0.9, 0.05, 0.5, 3), 300, 4);
    const recent = windows.slice(300, 360);
    const poisoned = windows.slice(0, 380).map((w, t) => (t >= 360 ? { ...w, mean: 1, sumSq: w.count } : w));
    const clean = forecastRow(recent, windows.slice(0, 360), { window_ms: W, horizon: 1 })!;
    const withFuture = forecastRow(recent, poisoned, { window_ms: W, horizon: 1 })!;
    assert.deepEqual(withFuture, clean);
    assert.equal(clean.origin, 360 * W);
    assert.equal(forecastPoint(recent[0], 0).n, 300);
    assert.equal(forecastRow([], windows, { window_ms: W, horizon: 1 }), undefined);
  });
});

describe("Forecaster: production `$F` rows from window summaries", () => {
  const theta = ar1(600, 0.95, 0.05, 0.5, 9);
  const all = binaryWindows(theta, 200, 10);
  // A HistorySource over the synthetic windows that records what it was asked for.
  const asked: Array<[number, number]> = [];
  const source = {
    history: (_lens: unknown, fromTs: number, toTs: number) => {
      asked.push([fromTs, toTs]);
      return { window_ms: W, windows: all.filter((w) => w.windowStart >= fromTs && w.windowEnd <= toTs + 1) };
    },
  };
  const lens = { window_ms: W, align: "epoch" as const };
  const decl = { recent_windows: 30, horizons: [1, 5], history_ms: 300 * W };

  it("forecasts from the last whole windows before `now`, one row per horizon, all virtual", () => {
    const now = 450 * W + 12_345; // inside window 450: the origin is its start
    const rows = new Forecaster(source).forecast(lens, decl, now);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.virtual === true && r.origin === 450 * W && r.method === "kriging"));
    assert.deepEqual(rows.map((r) => [r.horizon, r.targetStart]), [[1, 450 * W], [5, 454 * W]]);
    assert.equal(asked.at(-1)![1], 450 * W - 1, "nothing at or after the origin is asked for");
    assert.ok(rows[0].basis.historyWindows > 250, `${rows[0].basis.historyWindows}`);
    assert.ok(rows[0].interval.lo < rows[0].mean && rows[0].mean < rows[0].interval.hi);
    assert.ok(rows[0].latentVar < rows[1].latentVar, "a farther window is less certain");
  });

  it("refuses a lens no summary can be kept for", () => {
    assert.throws(() => new Forecaster(source).forecast({ window_ms: W }, decl, 450 * W), /absolute grid/);
  });
});
