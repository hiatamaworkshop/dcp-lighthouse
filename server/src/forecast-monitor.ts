/**
 * Calibration monitoring for `$F` (ROADMAP C5, ROADMAP_BRIEF.md 2026-11-02 (2) item C).
 *
 * A forecast is made, scored (`ForecastScore`) and drawn, and nothing reads whether
 * the intervals it states keep their promise. A forecast whose calibration drifts
 * — the stream changes character, the history thins, γ̂ goes stale — looks exactly
 * like a healthy one on the dashboard. This is the first reader of `$F`: it keeps the
 * scores of forecasts as their target windows become whole, and says per view,
 * horizon and span (1 h, 24 h) whether the realized windows land where the
 * intervals said, or that it cannot say yet.
 *
 * Why it must accumulate rather than recompute: window summaries are kept for an
 * hour (HISTORY_WINDOW_MS), so the forecast made a day ago cannot be rebuilt. The
 * monitor scores a forecast as soon as its last target is whole and remembers only
 * the numbers it needs. State lives in memory: a restart makes every span blind
 * again, which is the honest reading of an empty record.
 *
 * What it judges: z = (realized − forecast) / sd, whose variance is 1 where the
 * latent model holds (measured 0.85 on real 60 s windows of ordinary volume,
 * 2026-10-22 (8)). The state is read on windows of ORDINARY volume only
 * (ORDINARY_VOLUME_BAND): outside it the stream's make-up changed and every
 * forecast misses (variance 1.4–2.1), which is the volume channel's finding, not
 * a failing yardstick. The all-windows figures are reported beside it.
 *
 *   blind          fewer than MONITOR_MIN_TARGETS ordinary windows — not "healthy"
 *   overconfident  var z − 2 SE > 1: intervals too narrow, the forecast over-claims
 *   conservative   var z + 2 SE < 0.7: intervals too wide (the recorded baseline is 0.85)
 *   healthy        otherwise
 *
 * SE = √(2 / (n − 1)), the sampling error of a variance from n draws. The origins
 * are one per MONITOR_ORIGIN_EVERY_MS, so a horizon's targets are distinct windows,
 * but neighbouring windows are correlated (that is what the latent model is
 * about), so the SE is if anything narrow: "overconfident" is the more trustworthy
 * verdict of the two.
 */
import { floorToWindow } from "./lens.js";
import type { QForecastParams, QObserveParams } from "./q-registry.js";
import { ORDINARY_VOLUME_BAND, viewWindowMs, type ForecastScore } from "./forecast.js";

/** One forecast origin is scored per this many ms (rounded up to a whole window). */
export const MONITOR_ORIGIN_EVERY_MS = 60_000;
/** The spans a reading covers, by the target window's end. */
export const MONITOR_SPANS_MS: readonly number[] = [3_600_000, 86_400_000];
/** Fewest ordinary-volume target windows a state is read from. */
export const MONITOR_MIN_TARGETS = 30;
export const MONITOR_OVERCONFIDENT_ABOVE = 1.0;
export const MONITOR_CONSERVATIVE_BELOW = 0.7;
/** At most this many origins are scored in one catch-up (a first update, or after a long stall). */
const MAX_CATCHUP_ORIGINS = 60;

export type CalibrationState = "healthy" | "overconfident" | "conservative" | "blind";

/** What the monitor keeps of one scored forecast. */
export interface MonitorRecord {
  origin: number;
  targetEnd: number;
  horizon: number;
  group?: string;
  z: number;
  inside: boolean;
  volumeRatio: number;
  level: number;
}

export interface CalibrationReading {
  horizon: number;
  /** Ordinary-volume target windows the state is read from. */
  targets: number;
  meanZ: number;
  varZ: number;
  /** Share with |z| ≥ 2 and ≥ 3 (N(0, 1): 4.55%, 0.27%). */
  over2: number;
  over3: number;
  /** Share inside the stated interval, and the level it was stated at. */
  coverage: number;
  level: number;
  state: CalibrationState;
  /** The same figures over every scored window, whatever its volume. */
  all: { targets: number; varZ: number; coverage: number };
}

export interface CalibrationSpan {
  span_ms: number;
  /** The worst state among the horizons (overconfident > conservative > healthy); blind only if every horizon is. */
  state: CalibrationState;
  readings: CalibrationReading[];
}

export interface CalibrationReport {
  /** A reading of virtual values; readers branch on this axis (2026-10-08). */
  virtual: true;
  view: string;
  asOf: number;
  /** The last origin scored, or null before the first. */
  scoredThrough: number | null;
  spans: CalibrationSpan[];
}

/** The state for `targets` ordinary windows with variance `varZ`. */
export function calibrationState(varZ: number, targets: number): CalibrationState {
  if (!(targets >= MONITOR_MIN_TARGETS) || !Number.isFinite(varZ)) return "blind";
  const se = Math.sqrt(2 / (targets - 1));
  if (varZ - 2 * se > MONITOR_OVERCONFIDENT_ABOVE) return "overconfident";
  if (varZ + 2 * se < MONITOR_CONSERVATIVE_BELOW) return "conservative";
  return "healthy";
}

function figures(rs: readonly MonitorRecord[]): { n: number; mean: number; variance: number; over2: number; over3: number; coverage: number } {
  const n = rs.length;
  if (n === 0) return { n, mean: 0, variance: NaN, over2: 0, over3: 0, coverage: 0 };
  let s = 0;
  let ss = 0;
  let o2 = 0;
  let o3 = 0;
  let inside = 0;
  for (const r of rs) {
    s += r.z;
    ss += r.z * r.z;
    if (Math.abs(r.z) >= 2) o2++;
    if (Math.abs(r.z) >= 3) o3++;
    if (r.inside) inside++;
  }
  const mean = s / n;
  return { n, mean, variance: n > 1 ? (ss - n * mean * mean) / (n - 1) : NaN, over2: o2 / n, over3: o3 / n, coverage: inside / n };
}

const SEVERITY: Record<CalibrationState, number> = { blind: 0, healthy: 1, conservative: 2, overconfident: 3 };

/** The readings over `spans` ending at `nowTs`, from scored forecasts (pure — what the monitor serves). */
export function readCalibration(records: readonly MonitorRecord[], spans: readonly number[], nowTs: number): CalibrationSpan[] {
  const [lo, hi] = ORDINARY_VOLUME_BAND;
  return spans.map((span_ms) => {
    const inSpan = records.filter((r) => r.targetEnd > nowTs - span_ms && r.targetEnd <= nowTs);
    const horizons = [...new Set(inSpan.map((r) => r.horizon))].sort((a, b) => a - b);
    const readings: CalibrationReading[] = horizons.map((horizon) => {
      const all = inSpan.filter((r) => r.horizon === horizon);
      const ordinary = all.filter((r) => r.volumeRatio >= lo && r.volumeRatio <= hi);
      const f = figures(ordinary);
      const a = figures(all);
      return {
        horizon, targets: f.n, meanZ: f.mean, varZ: f.variance, over2: f.over2, over3: f.over3, coverage: f.coverage,
        level: all[0].level, state: calibrationState(f.variance, f.n),
        all: { targets: a.n, varZ: a.variance, coverage: a.coverage },
      };
    });
    let state: CalibrationState = "blind";
    for (const r of readings) if (SEVERITY[r.state] > SEVERITY[state]) state = r.state;
    return { span_ms, state, readings };
  });
}

/** The part of Forecaster the monitor needs (a stub in the tests). */
export interface ForecastScorer {
  score(lens: QObserveParams, decl: QForecastParams, at: number, nowTs: number): ForecastScore[];
}

export interface MonitoredView {
  view: string;
  lens: QObserveParams;
  decl: QForecastParams;
}

interface ViewState {
  /** The lens and declaration the records were made under: a change starts the record over. */
  key: string;
  records: MonitorRecord[];
  /** The next origin to score. */
  next: number | undefined;
  scoredThrough: number | null;
}

export class ForecastMonitor {
  private readonly views = new Map<string, ViewState>();

  constructor(
    private readonly scorer: ForecastScorer,
    private readonly spans: readonly number[] = MONITOR_SPANS_MS,
  ) {}

  /**
   * Score every origin whose forecasts are now all whole (the horizon furthest
   * ahead has ended). Origins sit on a grid of MONITOR_ORIGIN_EVERY_MS, so the
   * cost is one forecast-and-score a minute per view however fine its windows.
   * Throws what the scorer throws (a lens no summary can be kept for).
   */
  update(nowTs: number, views: readonly MonitoredView[]): void {
    for (const v of views) {
      const key = JSON.stringify([v.lens, v.decl]);
      let st = this.views.get(v.view);
      if (st === undefined || st.key !== key) {
        st = { key, records: [], next: undefined, scoredThrough: null };
        this.views.set(v.view, st);
      }
      const windowMs = viewWindowMs(v.lens);
      const stride = Math.ceil(MONITOR_ORIGIN_EVERY_MS / windowMs) * windowMs;
      const ahead = Math.max(...v.decl.horizons) * windowMs;
      const newest = floorToWindow(nowTs - ahead, stride, 0);
      const reach = (MAX_CATCHUP_ORIGINS - 1) * stride;
      let at = Math.max(st.next ?? newest - reach, newest - reach);
      for (; at <= newest; at += stride) {
        for (const s of this.scorer.score(v.lens, v.decl, at, nowTs)) {
          st.records.push({
            origin: s.forecast.origin, targetEnd: s.realized.windowEnd, horizon: s.forecast.horizon,
            ...(s.forecast.group !== undefined ? { group: s.forecast.group } : {}),
            z: s.z, inside: s.insideInterval, volumeRatio: s.volumeRatio, level: s.forecast.interval.level,
          });
        }
        st.scoredThrough = at;
        st.next = at + stride;
      }
      const keep = nowTs - Math.max(...this.spans);
      if (st.records.length > 0 && st.records[0].targetEnd <= keep) st.records = st.records.filter((r) => r.targetEnd > keep);
    }
  }

  /** The view's calibration over each span, as of `nowTs`. Blind (no readings) for a view never updated. */
  report(view: string, nowTs: number): CalibrationReport {
    const st = this.views.get(view);
    return {
      virtual: true, view, asOf: nowTs, scoredThrough: st?.scoredThrough ?? null,
      spans: readCalibration(st?.records ?? [], this.spans, nowTs),
    };
  }
}
