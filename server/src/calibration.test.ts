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
  it("stays far below the pre-対策A rate and well above silence, on the pilot's own data shape", () => {
    // The pilot streams pass/fail at a ~0.95 pass rate, so this is the shape
    // the shipped detector actually meets.
    const r = measureFalseAlarmRate({ seeds: SEEDS });
    const summary = formatCalibration("shipped shape", r);

    assert.ok(r.trials > SEEDS * 0.9, `most trials must be scorable — ${summary}`);
    // 29% was the defect 対策A corrected; anything approaching it is a regression.
    assert.ok(r.rate < 0.10, `false-alarm rate too high — ${summary}`);
    // A detector that never fires would sail past the bound above. The design
    // target is ~4.55%, so a rate near zero means something stopped working.
    assert.ok(r.rate > 0.02, `false-alarm rate suspiciously low, detector may be silenced — ${summary}`);
  });

  it("matches the design target on SYMMETRIC data — the model itself is calibrated", () => {
    // Separating this from the case above is the point. On symmetric values the
    // measured rate sits on the design target, which says the Šidák budget and
    // the standard error are right. The gap that remains on the pilot's skewed
    // shape is therefore a normal-approximation problem, not a broken
    // comparator — see the skew test below.
    const design = familyWiseAlpha(2.0);
    const r = measureFalseAlarmRate({
      seeds: SEEDS,
      shape: { passRate: 0.5 },
    });
    const summary = formatCalibration("symmetric", r);
    assert.ok(
      Math.abs(r.rate - design) < 0.03,
      `symmetric-data rate should sit near the ${(100 * design).toFixed(2)}% design target — ${summary}`,
    );
  });

  it("documents the open skew gap rather than pretending it is not there", () => {
    // MEASURED, NOT DESIRED (ROADMAP_BRIEF.md 2026-08-17): at a 0.95 pass rate
    // the window mean's sampling distribution is left-skewed, so the normal
    // approximation understates the lower tail and dips fire more often than
    // the nominal alpha. Measured at n=2000: 6.85% overall, split 136 dip to 1
    // spike. This asserts the imbalance still exists so that a future fix
    // (skewness correction via a pooled third moment) shows up here as a
    // failure demanding the numbers be re-read, rather than passing silently.
    const skewed = measureFalseAlarmRate({ seeds: SEEDS, shape: { passRate: 0.95 } });
    const symmetric = measureFalseAlarmRate({ seeds: SEEDS, shape: { passRate: 0.5 } });
    assert.ok(
      skewed.rate > symmetric.rate,
      `the known skew excess should still be visible — ` +
        `${formatCalibration("skewed", skewed)} vs ${formatCalibration("symmetric", symmetric)}`,
    );
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
    const strong = measureDetectionRate(0.6, { seeds: SEEDS });
    const weak = measureDetectionRate(0.9, { seeds: SEEDS });
    assert.ok(strong.rate > weak.rate, "a larger effect must be detected at least as often");
    assert.ok(weak.rate > 0.1, `a 5pp regression should not be invisible — ${formatCalibration("burst 0.90", weak)}`);
  });
});
