/**
 * Calibration measurement for the curator's detector.
 *
 * This exists because of how 対策A was found: the shipped curator carried a 29%
 * package-level false-alarm rate, and nothing noticed until an unrelated A/B
 * experiment happened to surface it (ROADMAP_BRIEF.md 2026-07-28). The rate had
 * never been wrong-in-a-way-a-test-could-see; it had simply never been measured
 * as a standing check. The correction was then verified with a throwaway script,
 * which leaves the next change in exactly the same position.
 *
 * So calibration is measured here, in committed code, against the design target
 * derived from `spikeZThreshold` itself (`familyWiseAlpha`) rather than against
 * a number someone once observed.
 *
 * The measurement takes a LENS, which is the whole point of its shape. A
 * detector is only calibrated with respect to how the data was aggregated, so
 * "is the curator still calibrated?" cannot be answered once and for all — it
 * has to be re-asked for each lens that changes the statistics. `decay:
 * exp(τ)` is the next such change: weighting alters effective sample size,
 * which moves the effective threshold, so its calibration must be measured, not
 * assumed. Passing a lens in makes that a one-line question.
 *
 * Both directions are measured on purpose. A detector that never fires has a
 * perfect false-alarm rate, so bounding only the false-alarm side would bless
 * exactly the over-correction 対策A's trade-off risks (対策D measured that
 * cost: Šidák preserves family-wise alpha, it does not preserve power).
 */

import { RetentionBuffer, type RetentionBufferOptions } from "./retention-buffer.js";
import { SnapshotCurator, familyWiseAlpha } from "./snapshot-curator.js";
import type { LensEvent } from "./lens.js";
import type { QObserveParams } from "./q-registry.js";

/** Anchor for generated streams; arbitrary but fixed so runs are reproducible. */
const T0 = 2_000_000;

/**
 * mulberry32 — the same tiny seeded PRNG the fixtures use. Reproducibility is
 * the property that lets a calibration figure be compared across commits at
 * all: an unseeded stream would make every run a different experiment.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface StreamShape {
  /** Length of the reference span and of the observation span, in ms. */
  spanMs?: number;
  /** Events emitted into each span. */
  eventsPerSpan?: number;
  /** Baseline pass probability. */
  passRate?: number;
}

const DEFAULT_SHAPE: Required<StreamShape> = {
  spanMs: 10_000,
  eventsPerSpan: 1_000,
  passRate: 0.95,
};

function emit(
  buf: RetentionBuffer<LensEvent>,
  rng: () => number,
  fromTs: number,
  toTs: number,
  count: number,
  passRate: number,
): void {
  // Generate then push in ts order, not draw order. RetentionBuffer.evict()
  // assumes the front of its internal array is the oldest event (it walks
  // forward from index 0), which holds only if events arrive push-order ≈
  // ts-order — true of a real stream, false of "count random draws in an
  // interval" pushed in draw order. It was harmless while every trial's
  // retentionWindowMs was far wider than spanMs (nothing ever got evicted
  // mid-span to expose it); L5's thinning calibration deliberately shrinks
  // retentionWindowMs below spanMs so the reference zone is exercised, which
  // makes mid-span eviction — and this ordering requirement — real for the
  // first time. segment()'s own sort makes the final read-out order-blind
  // regardless, so this is a no-op for every pre-L5 trial (retentionWindowMs
  // = spanMs*10 there, so nothing evicts and every event lands in `events`
  // either way) and only changes behaviour where eviction actually runs.
  const events = Array.from({ length: count }, () => ({
    ts: fromTs + Math.floor(rng() * (toTs - fromTs)),
    value: rng() < passRate ? 1 : 0,
  })).sort((a, b) => a.ts - b.ts);
  for (const e of events) buf.observe(e, "calibration");
}

/**
 * One null trial: a reference span and an observation span drawn from the SAME
 * distribution, so every anomaly tile the curator raises is by construction a
 * false alarm.
 *
 * `injected` is the deliberate exception — the same generator with a burst in
 * the last fifth of the observation span, used for the power measurement, so
 * both directions are measured on identical machinery rather than on two
 * fixtures that might differ in some way nobody tracked.
 */
function buildTrial(
  seed: number,
  shape: Required<StreamShape>,
  injected: { passRate: number } | null,
  retention?: Partial<RetentionBufferOptions>,
): { observation: RetentionBuffer<LensEvent>; obsFrom: number; obsTo: number; refFrom: number; refTo: number } {
  const rng = mulberry32(seed);
  const buf = new RetentionBuffer<LensEvent>((raw) => raw, {
    // A retentionWindowMs this wide keeps the whole trial in the freshness
    // zone by default, so the reference zone (ROADMAP L5) is inert unless a
    // caller shrinks it explicitly — this is what makes buildTrial's default
    // behaviour, and every pre-L5 calibration figure measured against it,
    // unaffected by the reference zone's existence.
    retentionWindowMs: shape.spanMs * 10,
    ...retention,
  });
  const refFrom = T0 - shape.spanMs;
  const obsTo = T0 + shape.spanMs;

  emit(buf, rng, refFrom, T0, shape.eventsPerSpan, shape.passRate);
  if (injected === null) {
    emit(buf, rng, T0, obsTo, shape.eventsPerSpan, shape.passRate);
  } else {
    const burstStart = obsTo - shape.spanMs / 5;
    const quietEvents = Math.round(shape.eventsPerSpan * 0.8);
    emit(buf, rng, T0, burstStart, quietEvents, shape.passRate);
    emit(buf, rng, burstStart, obsTo, shape.eventsPerSpan - quietEvents, injected.passRate);
  }
  return { observation: buf, obsFrom: T0, obsTo, refFrom, refTo: T0 };
}

/** Does a package claim an anomaly? Baseline tiles are not claims. */
function hasAnomalyTile(tiles: ReadonlyArray<{ shapeTag: string }>): boolean {
  return tiles.some((t) => t.shapeTag !== "baseline");
}

export interface CalibrationOptions {
  /** The lens under which to measure. Calibration is a property of the lens, not of the curator alone. */
  lens?: QObserveParams;
  /** Number of seeded trials. More seeds tighten the estimate; the run is cheap. */
  seeds?: number;
  /** First seed, so disjoint seed ranges can be compared. */
  startSeed?: number;
  shape?: StreamShape;
  /** Defaults to the shipped configuration (2.0σ family budget, baseline tiles on). */
  curator?: SnapshotCurator;
  /** The base threshold the curator was built with, used to report the design target. */
  baseZThreshold?: number;
  /**
   * Overrides for the trial's RetentionBuffer (ROADMAP L5). Calibration is a
   * property of how the reference span was STORED, not just how it is
   * aggregated — shrinking retentionWindowMs below spanMs and setting
   * referenceWindowMs/thinningRatio is what makes the reference span actually
   * come from the thinned zone instead of the freshness zone. Omitted entirely
   * by every pre-L5 test, so their figures are unaffected by this field existing.
   */
  retention?: Partial<RetentionBufferOptions>;
}

export interface CalibrationResult {
  trials: number;
  /** Packages containing at least one non-baseline tile. */
  flagged: number;
  /** flagged / trials. */
  rate: number;
  /**
   * The rate the configuration is designed for. For the false-alarm
   * measurement this is `familyWiseAlpha(baseZ)`; nothing else is a legitimate
   * comparison point.
   */
  designTarget: number;
  /** Trials whose reference could not ground a comparison — blind, not quiet. */
  unusableReference: number;
}

/**
 * Package-level FALSE ALARM rate: of `seeds` null streams, how many produced a
 * package claiming an anomaly.
 *
 * Deterministic given the seed range, so a test asserting a band on this is a
 * real regression check rather than a coin flip that fails now and then.
 *
 * Trials whose reference is unusable are counted separately and excluded from
 * the rate. A blind trial did not decline to fire — it could not fire — and
 * folding it into the denominator would flatter the rate for the same reason
 * silence must not be read as quiet.
 */
export function measureFalseAlarmRate(opts: CalibrationOptions = {}): CalibrationResult {
  return measure(opts, null);
}

/**
 * DETECTION rate for an injected burst of `burstPassRate`: the power side.
 *
 * Needed alongside the false-alarm figure because the cheapest way to pass a
 * false-alarm bound is to stop detecting anything.
 */
export function measureDetectionRate(
  burstPassRate: number,
  opts: CalibrationOptions = {},
): CalibrationResult {
  return measure(opts, { passRate: burstPassRate });
}

function measure(
  opts: CalibrationOptions,
  injected: { passRate: number } | null,
): CalibrationResult {
  const shape = { ...DEFAULT_SHAPE, ...opts.shape };
  const seeds = opts.seeds ?? 200;
  const startSeed = opts.startSeed ?? 1;
  const baseZ = opts.baseZThreshold ?? 2.0;
  const curator =
    opts.curator ?? new SnapshotCurator({ spikeZThreshold: baseZ, includeBaseline: true });
  const lens: QObserveParams = opts.lens ?? { window_ms: 1_000 };

  let flagged = 0;
  let unusableReference = 0;
  let scored = 0;

  for (let i = 0; i < seeds; i++) {
    const trial = buildTrial(startSeed + i, shape, injected, opts.retention);
    const observation = trial.observation.replay(lens, trial.obsFrom, trial.obsTo);
    const reference = trial.observation.replay(lens, trial.refFrom, trial.refTo);
    const pkg = curator.curate(observation, reference);
    if (!pkg.referenceUsable) {
      unusableReference++;
      continue;
    }
    scored++;
    if (hasAnomalyTile(pkg.tiles)) flagged++;
  }

  return {
    trials: scored,
    flagged,
    rate: scored > 0 ? flagged / scored : 0,
    designTarget: familyWiseAlpha(baseZ),
    unusableReference,
  };
}

/** One-line summary for a console or a devlog table. */
export function formatCalibration(label: string, r: CalibrationResult): string {
  return (
    `${label}: ${r.flagged}/${r.trials} = ${(100 * r.rate).toFixed(1)}% ` +
    `(design ${(100 * r.designTarget).toFixed(2)}%)` +
    (r.unusableReference > 0 ? `, ${r.unusableReference} blind` : "")
  );
}
