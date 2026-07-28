/**
 * §12 A/B experiment fixtures (L3 前段, PILOT_DATA.md §12 "Validation hook").
 *
 * PILOT_DATA.md §12 claims the LLM-facing snapshot package helps Brain decide
 * better than a bare number list. That claim needs a controlled comparison,
 * not intuition. These fixtures hold the underlying LensResults constant and
 * emit two presentations of the *same data* — a raw number-list form and a
 * curated SnapshotPackage — so presentation is the only variable an eval
 * harness varies. Ground truth (the injected anomaly) travels with the
 * fixture so decision accuracy can be scored.
 *
 * Information parity between arms is deliberate: the raw arm carries BOTH the
 * observation and the reference interval as number lists, because the curated
 * arm's tiles are scored against that reference. If the raw arm lacked the
 * reference, a curated win would be confounded — was it the tile presentation,
 * or just having baseline data the other arm didn't? The experiment §12
 * describes is about presentation, so both arms must see the same two lens
 * outputs (detection is a binary operation — ROADMAP_BRIEF.md 2026-07-25 —
 * and that holds for the number-list form too).
 *
 * This module builds fixtures only. Feeding them to an LLM and scoring
 * decisions is a separate, not-yet-built step (see ROADMAP_BRIEF.md L3).
 *
 * CG is deliberately not covered here: coverage gap is a hole in *which*
 * area bits get touched, not a mean-shift in a numeric stream, so it doesn't
 * fit the spike/dip/step tile vocabulary this module exercises. It would
 * need its own presentation design, not a fixture built from these same
 * primitives — left as a follow-up.
 */

import { RetentionBuffer } from "./retention-buffer.js";
import { SnapshotCurator, type SnapshotPackage } from "./snapshot-curator.js";
import type { LensEvent, LensResult } from "./lens.js";

// ── Fixture shape ───────────────────────────────────────────────────────────

/** One lens output rendered as bare numbers — the unit of the raw arm. */
export interface RawLensView {
  /** Window start timestamps, parallel to `means`. Needed so a positional answer ("the anomaly is at t≈X") can be scored against groundTruth. */
  windowStarts: number[];
  means: number[];
}

export interface ABFixture {
  scenario: string;
  /** The seed this fixture was built from, for trial auditability. */
  seed: number;
  /**
   * Machine-readable answer key: the injected anomaly's interval, or null for
   * a negative control (nothing injected). The harness scores verdicts against
   * this field; `groundTruth` carries the fuller human-readable detail.
   */
  injectedAnomaly: { startTs: number; endTs: number } | null;
  /** What was actually injected — the answer key for decision scoring. */
  groundTruth: Record<string, unknown>;
  /**
   * The "(a)" arm of §12's A/B test: the same observation/reference pair the
   * curator saw, presented as bare number lists with no curation applied.
   */
  raw: { window_ms: number; observation: RawLensView; reference: RawLensView };
  /** The "(b)" arm — curated tile package over the identical LensResult pair. */
  curated: SnapshotPackage;
}

// ── Deterministic injection ─────────────────────────────────────────────────

/**
 * mulberry32 — tiny seeded PRNG so a fixture is reproducible from its seed.
 * An A/B trial must be auditable ("seed 7 produced this data and this
 * decision"), and unseeded Math.random would make every build a new dataset.
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

/**
 * Inject `count` Bernoulli pass/fail events uniformly over [fromTs, toTs).
 * Bernoulli, not a constant value — a domain where every event carries a real
 * pass/fail has genuine within-window variance, unlike a constant-value
 * stream where variance is mechanically zero and the comparator's se
 * collapses to 0 (first-round fixture bug, ROADMAP_BRIEF.md 2026-07-28).
 */
function emit(
  buf: RetentionBuffer<LensEvent>,
  rng: () => number,
  fromTs: number,
  toTs: number,
  count: number,
  passRate: number,
): void {
  const span = toTs - fromTs;
  for (let i = 0; i < count; i++) {
    const ts = fromTs + Math.floor(rng() * span);
    const value = rng() < passRate ? 1 : 0;
    buf.observe({ ts, value }, "test");
  }
}

function toRawView(result: LensResult): RawLensView {
  return {
    windowStarts: result.windows.map((w) => w.windowStart),
    means: result.windows.map((w) => w.mean),
  };
}

const curator = new SnapshotCurator({ spikeZThreshold: 2.0, includeBaseline: true });

// ── RC ──────────────────────────────────────────────────────────────────────

/**
 * RC fixture: reuses the injection truth from e2e-verify.test.ts's
 * "E2E RC — retroactive re-observation" test (same burst position/magnitude),
 * extended with a pre-burst baseline interval so the fixture has a real
 * reference lens — mirroring index.ts's live "equal-length interval
 * immediately before" replay wiring rather than the isolated unit test's
 * self-reference.
 *
 * Injection truth:
 *   [T-10000, T)       — pre-burst baseline, P(pass)=0.95 (becomes the reference)
 *   [T, T+8000)        — baseline continues, P(pass)=0.95
 *   [T+8000, T+10000)  — burst, P(pass)=0.10
 */
export function buildRcFixture(seed = 1): ABFixture {
  const T = 2_000_000;
  const windowMs = 1_000;
  const rng = mulberry32(seed);
  const buf = new RetentionBuffer<LensEvent>((raw) => raw, { retentionWindowMs: 120_000 });

  emit(buf, rng, T - 10_000, T, 1_000, 0.95);
  emit(buf, rng, T, T + 8_000, 800, 0.95);
  emit(buf, rng, T + 8_000, T + 10_000, 200, 0.10);

  const fineResult = buf.replay({ window_ms: windowMs }, T, T + 10_000);
  const referenceResult = buf.replay({ window_ms: windowMs }, T - 10_000, T);
  const curated = curator.curate(fineResult, referenceResult);

  return {
    scenario: "RC",
    seed,
    injectedAnomaly: { startTs: T + 8_000, endTs: T + 10_000 },
    groundTruth: {
      burstStartTs: T + 8_000,
      burstEndTs: T + 10_000,
      burstPassRate: 0.10,
      baselinePassRate: 0.95,
    },
    raw: { window_ms: windowMs, observation: toRawView(fineResult), reference: toRawView(referenceResult) },
    curated,
  };
}

// ── AR ──────────────────────────────────────────────────────────────────────

/**
 * AR fixture: same regression truth as mock-stream-generator.ts's runAR
 * (P(pass) 0.95 → 0.70 for 30s — PILOT_DATA.md §6), direct-injected the same
 * way as RC rather than run through the live generator+adapter, so the
 * fixture is reproducible from its seed without sleepFn plumbing. The
 * reference interval is 15s (three 5s windows) rather than runAR's 10s
 * baseline — chosen for the lens, not the generator timeline.
 *
 * Unlike RC, AR's shift (0.95→0.70, ~26% relative) sits under the curator's
 * default 30% step-detection threshold, so this fixture is not expected to
 * produce a step_down tile — it relies on the per-window z-score detector
 * (item 1 of curate()), which has no relative-shift floor and fires on
 * count-driven significance instead. That is itself a fact worth the A/B
 * harness surfacing: a sustained-but-modest regression may read as a run of
 * "dip" tiles rather than one "step_down" tile under current defaults.
 */
export function buildArFixture(seed = 1): ABFixture {
  const T = 2_000_000;
  const windowMs = 5_000;
  const rng = mulberry32(seed);
  const buf = new RetentionBuffer<LensEvent>((raw) => raw, { retentionWindowMs: 120_000 });

  emit(buf, rng, T - 15_000, T, 1_500, 0.95);
  emit(buf, rng, T, T + 30_000, 3_000, 0.70);

  const observed = buf.replay({ window_ms: windowMs }, T, T + 30_000);
  const referenceResult = buf.replay({ window_ms: windowMs }, T - 15_000, T);
  const curated = curator.curate(observed, referenceResult);

  return {
    scenario: "AR",
    seed,
    injectedAnomaly: { startTs: T, endTs: T + 30_000 },
    groundTruth: {
      regressionStartTs: T,
      regressionEndTs: T + 30_000,
      regressedPassRate: 0.70,
      baselinePassRate: 0.95,
    },
    raw: { window_ms: windowMs, observation: toRawView(observed), reference: toRawView(referenceResult) },
    curated,
  };
}

// ── QUIET (negative control) ────────────────────────────────────────────────

/**
 * Negative control: same stream, same lens as RC, nothing injected. Without
 * it the experiment is unscoreable — a strategy that always answers "anomaly"
 * would score perfectly on RC/AR fixtures alone, so decision accuracy must be
 * measured against a mix that includes quiet intervals.
 *
 * Note the curated arm of a quiet fixture may still contain the occasional
 * ~2σ tile (the calibrated ~5% false-positive floor measured 2026-07-25) and
 * a baseline tile. That is realistic, not a bug: the experiment asks whether
 * the LLM reads such a package as "quiet" — tile presence is the detector's
 * output, verdict is the Brain's.
 */
export function buildQuietFixture(seed = 1): ABFixture {
  const T = 2_000_000;
  const windowMs = 1_000;
  const rng = mulberry32(seed);
  const buf = new RetentionBuffer<LensEvent>((raw) => raw, { retentionWindowMs: 120_000 });

  emit(buf, rng, T - 10_000, T, 1_000, 0.95);
  emit(buf, rng, T, T + 10_000, 1_000, 0.95);

  const observed = buf.replay({ window_ms: windowMs }, T, T + 10_000);
  const referenceResult = buf.replay({ window_ms: windowMs }, T - 10_000, T);
  const curated = curator.curate(observed, referenceResult);

  return {
    scenario: "QUIET",
    seed,
    injectedAnomaly: null,
    groundTruth: { baselinePassRate: 0.95 },
    raw: { window_ms: windowMs, observation: toRawView(observed), reference: toRawView(referenceResult) },
    curated,
  };
}
