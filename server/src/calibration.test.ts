/**
 * Standing calibration check for the curator's detector.
 *
 * The reason this file exists is in ROADMAP_BRIEF.md 2026-07-28: the curator
 * shipped with a 29% package-level false-alarm rate and nothing caught it,
 * because the rate had never been measured as part of the suite. 対策A fixed
 * the rate and verified it with a throwaway script, which would have left the
 * next change in the same blind spot.
 *
 * These bands are deliberately wide. Their job is to catch a detector that has
 * gone grossly wrong in either direction — firing constantly, or silenced by an
 * over-correction — not to police sampling noise. The seeds are fixed, so a
 * failure here is a real change in behaviour and never a coin flip.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  measureDetectionRate,
  measureFalseAlarmRate,
  formatCalibration,
} from "./calibration.js";
import { familyWiseAlpha } from "./snapshot-curator.js";

const SEEDS = 500;

describe("curator calibration — false alarms on a null stream", () => {
  const design = familyWiseAlpha(2.0);

  it("sits on the design target on the pilot's own data shape", () => {
    // The pilot streams pass/fail at a ~0.95 pass rate with ~100 events per
    // window, so this is the shape the shipped detector actually meets. It read
    // 6.85% here until the continuity correction of 2026-08-17; 29% before 対策A.
    const r = measureFalseAlarmRate({ seeds: SEEDS });
    const summary = formatCalibration("shipped shape", r);

    assert.ok(r.trials > SEEDS * 0.9, `most trials must be scorable — ${summary}`);
    assert.ok(
      Math.abs(r.rate - design) < 0.015,
      `shipped shape should sit near the ${(100 * design).toFixed(2)}% design target — ${summary}`,
    );
    // A detector that never fires would satisfy any upper bound, so the lower
    // side is asserted separately rather than folded into the band above.
    assert.ok(r.rate > 0.02, `false-alarm rate suspiciously low, detector may be silenced — ${summary}`);
  });

  it("errs conservative on SYMMETRIC data — the cost of the correction, pinned", () => {
    // MEASURED, NOT DESIRED. The continuity correction is derived from the
    // lattice, not from the skew, so it applies to symmetric pass/fail data too
    // — where the normal approximation needed no help. The rate lands under
    // design instead of on it (2.9% vs 4.55%). That is the price paid for the
    // skewed case, and it is asserted so a future refinement that removes it
    // shows up here rather than passing unnoticed.
    const r = measureFalseAlarmRate({ seeds: SEEDS, shape: { passRate: 0.5 } });
    const summary = formatCalibration("symmetric", r);
    assert.ok(r.rate <= design, `symmetric data should not exceed design — ${summary}`);
    assert.ok(r.rate > 0.01, `conservative is not the same as silent — ${summary}`);
  });

  it("documents where the correction still does NOT close the gap", () => {
    // MEASURED, NOT DESIRED (ROADMAP_BRIEF.md 2026-08-17). Half a lattice step
    // is the right first-order term, not the whole error. Two regimes still
    // overshoot, both because the sampling distribution is further from normal
    // than one step accounts for:
    //
    //   extreme skew  p=0.99, ~100 events/window : 14.6% -> 8.1%
    //   thin windows  p=0.95, ~20 events/window  : 13.5% -> 6.9%
    //
    // Halved in each case, still above design. Asserting the residual keeps the
    // claim in the devlog honest: this fixed the shipped operating point, it did
    // not make the detector calibrated everywhere.
    const skewed = measureFalseAlarmRate({ seeds: SEEDS, shape: { passRate: 0.99 } });
    const thin = measureFalseAlarmRate({ seeds: SEEDS, shape: { eventsPerSpan: 200 } });
    assert.ok(skewed.rate > design, `extreme skew should still overshoot — ${formatCalibration("p=0.99", skewed)}`);
    assert.ok(thin.rate > design, `thin windows should still overshoot — ${formatCalibration("n~20", thin)}`);
    // ...but not by as much as before the correction, which is the other half
    // of the claim.
    assert.ok(skewed.rate < 0.12, `extreme skew regressed past its corrected level — ${formatCalibration("p=0.99", skewed)}`);
    assert.ok(thin.rate < 0.11, `thin windows regressed past their corrected level — ${formatCalibration("n~20", thin)}`);
  });
});

describe("curator calibration — under a weighting lens", () => {
  // The reason calibration takes a lens at all. `decay: exp(τ)` replaces every
  // raw count in the comparator with an effective sample size, so its
  // false-alarm rate is a different measurement, not an inherited one.
  //
  // It was measured wrong first, which is why these are here: refusing to
  // apply the continuity correction to weighted windows — on the reasoning
  // that a weighted sum is not confined to a lattice — took the rate straight
  // back to 7.1%, the pre-correction figure. Switching the correction off was
  // the only thing the weighting was doing to the gate.
  const design = familyWiseAlpha(2.0);
  const lens = { window_ms: 1_000, decay: "exp(tau=30s)" };

  it("stays on the design target when τ is long relative to the span", () => {
    const r = measureFalseAlarmRate({ seeds: SEEDS, lens });
    const summary = formatCalibration("exp(tau=30s)", r);
    assert.ok(Math.abs(r.rate - design) < 0.015, `weighted lens should sit near design — ${summary}`);
    assert.ok(r.rate > 0.02, `weighted lens suspiciously quiet — ${summary}`);
  });

  it("keeps its power — the weighting must not buy calibration by going blind", () => {
    const weak = measureDetectionRate(0.9, { seeds: SEEDS, lens });
    const unweighted = measureDetectionRate(0.9, { seeds: SEEDS });
    assert.ok(
      Math.abs(weak.rate - unweighted.rate) < 0.05,
      `a τ three times the span should barely move power — ${formatCalibration("exp", weak)} vs ${formatCalibration("plain", unweighted)}`,
    );
    assert.ok(measureDetectionRate(0.6, { seeds: SEEDS, lens }).rate > 0.95, "a strong burst must still fire");
  });

  it("overshoots as τ approaches the span, and it is the thin-sample regime doing it", () => {
    // MEASURED, NOT DESIRED. τ=2s over a 10s span leaves the reference all
    // 1000 of its events but only ~387 effective ones, and the rate reads
    // 6.6%. Quadrupling the event density takes it to 4.0% — the same move the
    // UNWEIGHTED lens makes at that density (4.4% → 3.4%), which is what says
    // this is the already-documented thin-effective-sample residual rather
    // than something weighting introduced.
    const short = measureFalseAlarmRate({ seeds: SEEDS, lens: { window_ms: 1_000, decay: "exp(tau=2s)" } });
    assert.ok(short.rate > design, `short τ should still overshoot — ${formatCalibration("exp(tau=2s)", short)}`);
    const dense = measureFalseAlarmRate({
      seeds: SEEDS,
      lens: { window_ms: 1_000, decay: "exp(tau=2s)" },
      shape: { eventsPerSpan: 4_000 },
    });
    assert.ok(dense.rate < short.rate, `density must relieve it — ${formatCalibration("dense", dense)}`);
  });
});

describe("curator calibration — power", () => {
  it("still detects a strong burst", () => {
    // The cheapest way to pass a false-alarm bound is to stop detecting
    // anything, so the bound above is only meaningful next to this.
    const r = measureDetectionRate(0.6, { seeds: SEEDS });
    assert.ok(r.rate > 0.95, `a 0.95→0.60 burst must be detected — ${formatCalibration("burst 0.60", r)}`);
  });

  it("degrades gracefully rather than cliff-edging as the effect shrinks", () => {
    // 対策D's finding, kept as a standing shape check: Šidák preserves
    // family-wise alpha, not power, and the cost lands near the noise floor.
    // The continuity correction charges here too — a 0.95→0.90 drop was detected
    // in 52.2% of trials before it and 44.5% after. That trade is why the exact
    // conditional (Fisher) alternative was measured and rejected: it never
    // exceeds design, but takes the same figure to 27.4% (ROADMAP_BRIEF.md
    // 2026-08-17).
    const strong = measureDetectionRate(0.6, { seeds: SEEDS });
    const weak = measureDetectionRate(0.9, { seeds: SEEDS });
    assert.ok(strong.rate > weak.rate, "a larger effect must be detected at least as often");
    assert.ok(weak.rate > 0.1, `a 5pp regression should not be invisible — ${formatCalibration("burst 0.90", weak)}`);
  });
});
