/**
 * F2 — the forecast row, `$F` (ROADMAP_BRIEF.md 2026-10-08, 2026-10-14 (2) item 5,
 * 2026-10-22 (7)): the predicted mean of a window not yet observed, with the
 * variance that says how far the realized window may land from it.
 *
 * The comparison the curator already makes IS a forecast: every observation
 * window is judged against the reference mean, with a variance that grows with
 * the window's distance from the reference (the variogram null). That is the
 * persistence forecast — fixed weights nₖ/N on the reference windows. Kriging
 * keeps the same latent model (the semivariogram γ of window means, estimated
 * by the same estimator, semivariogramFromWindows) and the same sampling noise,
 * and only chooses the weights that minimise the forecast error. Its variance
 * can therefore never exceed persistence's for the same γ; whether the
 * narrower interval still holds the realized windows is measured, not assumed
 * (real-data-harness.ts: runForecastCalibration).
 *
 * Why γ̂ is smoothed by a fitted model before kriging: the raw Matheron curve
 * is noisy at long lags and not guaranteed conditionally negative definite, and
 * kriging weights chase its wiggles — over-confident forecasts (measured on an
 * AR(1) latent stream: z variance 1.09–1.43 with the raw curve, against about
 * 1.0 fitted). Two valid families are fitted and the closer one kept: a nugget
 * plus a power law, γ(h) = c₀ + b·h^α (0 < α < 2) — growth that does not level
 * off, the real 60 s curve's shape over an hour (2026-10-14 (4)) — and a nugget
 * plus an exponential, c₀ + b·(1 − e^(−h/r)) — a process with a sill, which the
 * power law overstates at small lags (and so forecasts too cautiously).
 *
 * A forecast is virtual: every row says so on its own axis (`virtual: true`),
 * the 2026-10-08 rule for anything that is not an observation.
 */
import { effectiveN, floorToWindow, weightTotal, type WindowStat } from "./lens.js";
import type { QForecastParams, QObserveParams } from "./q-registry.js";
import { summarizable, type HistorySource } from "./window-history.js";
import { isScorable, normalQuantile, semivariogramFromWindows, type SemivariogramEstimate } from "./snapshot-curator.js";

/**
 * A valid latent semivariogram, γ(0) = 0 and for h ≠ 0:
 *   "power":       nugget + scale·|h|^shape                 (0 < shape < 2)
 *   "exponential": nugget + scale·(1 − e^(−|h|/shape))       (shape = the range, in windows)
 */
export interface FittedVariogram {
  family: "power" | "exponential";
  nugget: number;
  scale: number;
  shape: number;
}

export function variogramAt(m: FittedVariogram, h: number): number {
  if (h === 0) return 0;
  const a = Math.abs(h);
  return m.nugget + m.scale * (m.family === "power" ? Math.pow(a, m.shape) : 1 - Math.exp(-a / m.shape));
}

const POWER_SHAPES = Array.from({ length: 39 }, (_, k) => (k + 1) / 20);
const EXPONENTIAL_RANGES = [0.5, 1, 1.5, 2, 3, 5, 7, 10, 15, 20, 30, 50, 70, 100, 150, 200, 300, 500, 1000, 3000];

/**
 * Least-squares fit to γ̂(1…maxLag), both families, the shape on a grid and
 * nugget, scale ≥ 0 in closed form for each shape; the smallest squared error
 * wins. An all-zero γ̂ (independent windows) fits nugget = scale = 0.
 */
export function fitVariogram(gamma: Float64Array, maxLag = gamma.length - 1): FittedVariogram {
  const L = Math.min(maxLag, gamma.length - 1);
  let best: FittedVariogram & { sse: number } = { family: "power", nugget: 0, scale: 0, shape: 1, sse: Infinity };
  if (L < 1) return { family: "power", nugget: 0, scale: 0, shape: 1 };
  const tryBasis = (family: FittedVariogram["family"], shape: number, basis: (h: number) => number) => {
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let h = 1; h <= L; h++) {
      const x = basis(h);
      sx += x;
      sy += gamma[h];
      sxx += x * x;
      sxy += x * gamma[h];
    }
    const det = L * sxx - sx * sx;
    const candidates: Array<[number, number]> = [];
    if (det > 0) candidates.push([(sxx * sy - sx * sxy) / det, (L * sxy - sx * sy) / det]);
    candidates.push([0, sxx > 0 ? Math.max(0, sxy / sxx) : 0], [Math.max(0, sy / L), 0]);
    for (const [c0, b] of candidates) {
      if (c0 < 0 || b < 0) continue;
      let sse = 0;
      for (let h = 1; h <= L; h++) sse += (gamma[h] - c0 - b * basis(h)) ** 2;
      if (sse < best.sse) best = { family, nugget: c0, scale: b, shape, sse };
    }
  };
  for (const a of POWER_SHAPES) tryBasis("power", a, (h) => Math.pow(h, a));
  for (const r of EXPONENTIAL_RANGES) tryBasis("exponential", r, (h) => 1 - Math.exp(-h / r));
  return { family: best.family, nugget: best.nugget, scale: best.scale, shape: best.shape };
}

/** One observed window as a forecast reads it: its position (window steps), mean, and the sampling variance of that mean. */
export interface ForecastPoint {
  i: number;
  mean: number;
  /** The window's own sampling variance of its mean (s²/n, Bessel — the estimator's vᵢ). */
  v: number;
  /** Effective event count (the weight persistence gives the window). */
  n: number;
}

export function forecastPoint(w: WindowStat, index: number): ForecastPoint {
  const n = effectiveN(w);
  return { i: index, mean: w.mean, v: n > 1 ? Math.max(0, w.sumSq / weightTotal(w) - w.mean * w.mean) / (n - 1) : 0, n };
}

/**
 * E[(Σλᵢmᵢ − θ₀)²] for weights summing to 1: 2Σλᵢgᵢ₀ − ΣΣλᵢλⱼGᵢⱼ, with the
 * semivariances of the NOISY window means Gᵢⱼ = γ(tᵢ − tⱼ) + (vᵢ + vⱼ)/2 (i ≠ j,
 * Gᵢᵢ = 0) and gᵢ₀ = γ(tᵢ − t₀) + vᵢ/2 to the latent target. For persistence
 * weights this is exactly the curator's variogram contrast plus σ²/N.
 */
export function forecastMse(points: readonly ForecastPoint[], weights: ArrayLike<number>, target: number, gamma: (h: number) => number): number {
  let cross = 0;
  let self = 0;
  for (let a = 0; a < points.length; a++) {
    cross += weights[a] * (gamma(points[a].i - target) + points[a].v / 2);
    for (let b = 0; b < points.length; b++) {
      if (a === b) continue;
      self += weights[a] * weights[b] * (gamma(points[a].i - points[b].i) + (points[a].v + points[b].v) / 2);
    }
  }
  return 2 * cross - self;
}

/** Persistence: the reference mean, weights nᵢ/N — what the curator compares every observation window with. */
export function persistenceWeights(points: readonly ForecastPoint[]): Float64Array {
  const N = points.reduce((s, p) => s + p.n, 0);
  return Float64Array.from(points, (p) => (N > 0 ? p.n / N : 1 / points.length));
}

/**
 * Ordinary kriging of the latent rate at `target` from noisy window means: the
 * weights summing to 1 that minimise forecastMse, from
 *   Σⱼ Gᵢⱼλⱼ + μ = gᵢ₀,  Σλⱼ = 1,
 * and its variance Σλᵢgᵢ₀ + μ. Undefined when the system cannot be solved or
 * gives a negative variance (the caller falls back to persistence).
 */
export function krigingWeights(
  points: readonly ForecastPoint[],
  target: number,
  gamma: (h: number) => number,
): { weights: Float64Array; latentVar: number } | undefined {
  const k = points.length;
  if (k === 0) return undefined;
  const n = k + 1;
  const A = Array.from({ length: n }, () => new Float64Array(n + 1));
  for (let a = 0; a < k; a++) {
    for (let b = 0; b < k; b++) {
      A[a][b] = a === b ? 0 : gamma(points[a].i - points[b].i) + (points[a].v + points[b].v) / 2;
    }
    A[a][k] = 1;
    A[a][n] = gamma(points[a].i - target) + points[a].v / 2;
  }
  for (let b = 0; b < k; b++) A[k][b] = 1;
  A[k][k] = 0;
  A[k][n] = 1;
  const g = Float64Array.from(points, (p) => gamma(p.i - target) + p.v / 2);
  // Gaussian elimination with partial pivoting on the augmented matrix.
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    if (!(Math.abs(A[piv][c]) > 1e-300)) return undefined;
    [A[c], A[piv]] = [A[piv], A[c]];
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / A[c][c];
      if (f === 0) continue;
      for (let j = c; j <= n; j++) A[r][j] -= f * A[c][j];
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = A[r][n];
    for (let j = r + 1; j < n; j++) s -= A[r][j] * x[j];
    x[r] = s / A[r][r];
  }
  if (!x.every(Number.isFinite)) return undefined;
  const weights = x.slice(0, k);
  let latentVar = x[k];
  for (let a = 0; a < k; a++) latentVar += weights[a] * g[a];
  if (!(latentVar >= 0)) return undefined;
  return { weights, latentVar };
}

/** The per-event variance pooled from the windows read: a window of n events then has sampling variance eventVar / n. */
export function pooledEventVariance(windows: readonly WindowStat[]): number {
  let num = 0;
  let den = 0;
  for (const w of windows) {
    const W = weightTotal(w);
    const n = effectiveN(w);
    if (!(W > 0) || !(n > 1)) continue;
    num += Math.max(0, w.sumSq / W - w.mean * w.mean) * n;
    den += n - 1;
  }
  return den > 0 ? num / den : 0;
}

/** A latent model ready to forecast from: γ̂ from the history, and the fitted valid γ kriging uses. */
export interface ForecastModel {
  estimate: SemivariogramEstimate;
  fitted: FittedVariogram;
  /** The lags the fit used (1…fitLag): estimated ones only, never the flat extrapolation. */
  fitLag: number;
}

/**
 * γ̂ from `history` windows ending by `origin` (nothing at or after the origin —
 * the forecast must not read what it predicts), up to `maxLag` window steps from
 * `gridOrigin`, and the nugget + power fit over the lags actually estimated.
 */
export function forecastModel(history: readonly WindowStat[], origin: number, window_ms: number, maxLag: number, gridOrigin: number): ForecastModel {
  const estimate = semivariogramFromWindows(history, origin, window_ms, maxLag, gridOrigin);
  const fitLag = Math.max(1, (estimate.extrapolatedFromLag ?? maxLag + 1) - 1);
  return { estimate, fitted: fitVariogram(estimate.gamma, fitLag), fitLag };
}

export interface ForecastRow {
  /** Always true: a forecast is a virtual value, never an observation (2026-10-08). Readers branch on this axis. */
  virtual: true;
  method: "kriging" | "persistence";
  /** LensGroup.label, when the view's lens is grouped (one row per group and horizon). */
  group?: string;
  /** End of the last window read: nothing at or after it went into the forecast. */
  origin: number;
  targetStart: number;
  targetEnd: number;
  /** Windows ahead of the origin; 1 = the next window. */
  horizon: number;
  /** Predicted latent rate of the target window. */
  mean: number;
  /** Variance of the latent forecast error. */
  latentVar: number;
  /** Per-event variance pooled from the windows read: the target window's own noise is this ÷ its event count. */
  eventVar: number;
  /** Median event count of the windows read — the count `interval` assumes for the target. */
  typicalCount: number;
  /** Central predictive interval (normal) for the target window's mean at `typicalCount` events. */
  interval: { level: number; lo: number; hi: number };
  basis: {
    /** Windows the forecast weighted. */
    windows: number;
    /**
     * Windows γ̂ rests on, and the first lag no pair of them reached (if any).
     * The fit saw only the lags before it; past it the variance is the fitted
     * family's extrapolation — an UNDERSTATEMENT while γ is still rising, as in a
     * young history just after start (a view that has had 8 windows forecasts
     * 30 ahead on a γ fitted to 7 lags).
     */
    historyWindows: number;
    extrapolatedFromLag?: number;
    variogram: FittedVariogram;
    /** Kriging could not be solved and the row fell back to persistence. */
    fellBack?: true;
  };
}

/**
 * The `$F` row for the window `horizon` steps after the last of `recent`:
 * `recent` are the windows the forecast weights (the last K before the origin,
 * on one grid), `history` the windows γ̂ is estimated from (ending at the
 * origin). Kriging by default; `method: "persistence"` gives the reference-mean
 * forecast the curator's comparison already makes, on the same fitted γ.
 */
export function forecastRow(
  recent: readonly WindowStat[],
  history: readonly WindowStat[],
  opts: {
    window_ms: number;
    horizon: number;
    method?: "kriging" | "persistence";
    level?: number;
    /** The forecast origin (a window boundary). Default: the end of the last of `recent` — give it when that window may be empty. */
    origin?: number;
    group?: string;
  },
): ForecastRow | undefined {
  const used = recent.filter(isScorable);
  if (used.length === 0) return undefined;
  const w = opts.window_ms;
  const gridOrigin = used[0].windowStart;
  const origin = opts.origin ?? Math.max(...recent.map((x) => x.windowEnd));
  const idx = (x: { windowStart: number }) => Math.round((x.windowStart - gridOrigin) / w);
  const targetStart = origin + (opts.horizon - 1) * w;
  const target = idx({ windowStart: targetStart });
  const model = forecastModel(history, origin, w, target, gridOrigin);
  const gamma = (h: number) => variogramAt(model.fitted, h);
  const points = used.map((x) => forecastPoint(x, idx(x)));
  const method = opts.method ?? "kriging";
  const kriged = method === "kriging" ? krigingWeights(points, target, gamma) : undefined;
  const weights = kriged?.weights ?? persistenceWeights(points);
  const latentVar = kriged?.latentVar ?? Math.max(0, forecastMse(points, weights, target, gamma));
  const mean = points.reduce((s, p, k) => s + weights[k] * p.mean, 0);
  const eventVar = pooledEventVariance(used);
  const counts = used.map((x) => x.count).sort((a, b) => a - b);
  const typicalCount = counts[counts.length >> 1];
  const level = opts.level ?? 0.95;
  const half = normalQuantile(0.5 + level / 2) * Math.sqrt(latentVar + (typicalCount > 0 ? eventVar / typicalCount : 0));
  return {
    virtual: true,
    method: kriged !== undefined || method === "persistence" ? method : "persistence",
    ...(opts.group !== undefined ? { group: opts.group } : {}),
    origin, targetStart, targetEnd: targetStart + w, horizon: opts.horizon,
    mean, latentVar, eventVar, typicalCount,
    interval: { level, lo: mean - half, hi: mean + half },
    basis: {
      windows: used.length,
      historyWindows: model.estimate.historyWindows,
      ...(model.estimate.extrapolatedFromLag !== undefined ? { extrapolatedFromLag: model.estimate.extrapolatedFromLag } : {}),
      variogram: model.fitted,
      ...(method === "kriging" && kriged === undefined ? { fellBack: true as const } : {}),
    },
  };
}

/**
 * A realized window judged against the forecast made for it — the comparison
 * whose reference is a forecast (ROADMAP_BRIEF.md 2026-10-14 (2) item 5), so the
 * package that carries it names `against: "forecast"` and the row it compared
 * with, the way SnapshotPackage.comparison names the reference and null it used.
 *
 * z = (realized mean − forecast) / √(latent forecast variance + event variance ÷
 * the REALIZED window's event count) — the formula runForecastCalibration
 * measured, so a score and the calibration table read the same quantity. That
 * calibration holds for a window of ordinary volume: `volumeRatio` (realized
 * count ÷ the count the forecast assumed) is carried so a reader can tell a
 * window the latent model claims to cover from a change in composition, where
 * every forecast misses (2026-10-22 (8): variance 1.4–2.1). It is not banded
 * here; the band is the reader's, as with the variogram's `volumeRatio`.
 *
 * Virtual: the forecast side is, and a reader branching on that axis must not
 * take a score for an observation (2026-10-08).
 */
export interface ForecastScore {
  virtual: true;
  against: "forecast";
  forecast: ForecastRow;
  realized: { windowStart: number; windowEnd: number; count: number; mean: number };
  /** realized mean − forecast mean. */
  error: number;
  /** √(latent variance + event variance ÷ realized count): the spread z is read in. */
  sd: number;
  z: number;
  /** Whether the realized mean lies in the central interval at the row's level, at the realized count (row.interval assumes the typical count). */
  insideInterval: boolean;
  volumeRatio: number;
}

/** Judge `realized` (the window the row was made for) against `row`. Undefined when the window cannot be scored (too few events — the same isScorable the calibration used). */
export function scoreForecast(row: ForecastRow, realized: WindowStat): ForecastScore | undefined {
  if (!isScorable(realized)) return undefined;
  const sd = Math.sqrt(row.latentVar + row.eventVar / effectiveN(realized));
  const error = realized.mean - row.mean;
  return {
    virtual: true,
    against: "forecast",
    forecast: row,
    realized: { windowStart: realized.windowStart, windowEnd: realized.windowEnd, count: realized.count, mean: realized.mean },
    error,
    sd,
    z: sd > 0 ? error / sd : 0,
    insideInterval: Math.abs(error) <= normalQuantile(0.5 + row.interval.level / 2) * sd,
    volumeRatio: row.typicalCount > 0 ? realized.count / row.typicalCount : NaN,
  };
}

/**
 * Production's `$F` rows (ROADMAP_BRIEF.md 2026-10-22 (8)): a view's lens and
 * its declared $Q[forecast], forecast from the standing window summaries
 * (window-history.ts) — the same windows the variogram null reads its history
 * from, so the forecast and the gate that later judges the realized window
 * rest on one γ̂ estimator.
 */
export class Forecaster {
  constructor(private readonly history: HistorySource) {}

  /**
   * The rows for every declared horizon (and every group, for a grouped lens),
   * made at `nowTs`. The origin is the last window boundary at or before it, so
   * every window read is whole and nothing at or after the origin is read.
   * Throws for a lens no window summary can be kept for (summarizable).
   */
  forecast(lens: QObserveParams, decl: QForecastParams, nowTs: number): ForecastRow[] {
    const normalized = summarizable(lens);
    const windowMs = (normalized.window_ms ?? 1_000) * (normalized.downsample_factor ?? 1);
    const origin = floorToWindow(nowTs, windowMs, normalized.origin ?? 0);
    const span = decl.recent_windows * windowMs;
    const read = this.history.history(lens, origin - span - decl.history_ms, origin - 1);
    const units = (lens.group_by?.length ?? 0) > 0
      ? (read.groups ?? []).map((g) => ({ group: g.label as string | undefined, windows: g.windows }))
      : [{ group: undefined as string | undefined, windows: read.windows }];
    const rows: ForecastRow[] = [];
    for (const u of units) {
      const recent = u.windows.filter((w) => w.windowStart >= origin - span && w.windowEnd <= origin);
      for (const horizon of decl.horizons) {
        const row = forecastRow(recent, u.windows, {
          window_ms: windowMs, horizon, origin,
          ...(decl.method !== undefined ? { method: decl.method } : {}),
          ...(decl.level !== undefined ? { level: decl.level } : {}),
          ...(u.group !== undefined ? { group: u.group } : {}),
        });
        if (row !== undefined) rows.push(row);
      }
    }
    return rows;
  }

  /**
   * The rows made at `at` (as forecast() would have made them then), each judged
   * against its target window if that window is whole by `nowTs`. The forecast
   * reads nothing at or after its origin; the realized windows are read in a
   * second request that starts there, so one request never holds both. A
   * window not yet whole, or too thin to score, yields no score — an absent
   * score is "not yet / not scorable", never a pass.
   */
  score(lens: QObserveParams, decl: QForecastParams, at: number, nowTs: number): ForecastScore[] {
    const rows = this.forecast(lens, decl, at).filter((r) => r.targetEnd <= nowTs);
    if (rows.length === 0) return [];
    const from = Math.min(...rows.map((r) => r.targetStart));
    const to = Math.max(...rows.map((r) => r.targetEnd));
    const read = this.history.history(lens, from, to - 1);
    const grouped = (lens.group_by?.length ?? 0) > 0;
    const byGroup = new Map<string | undefined, WindowStat[]>(
      grouped ? (read.groups ?? []).map((g) => [g.label as string | undefined, g.windows] as const) : [[undefined, read.windows]],
    );
    const scores: ForecastScore[] = [];
    for (const row of rows) {
      const realized = byGroup.get(row.group)?.find((w) => w.windowStart === row.targetStart);
      const s = realized !== undefined ? scoreForecast(row, realized) : undefined;
      if (s !== undefined) scores.push(s);
    }
    return scores;
  }
}
