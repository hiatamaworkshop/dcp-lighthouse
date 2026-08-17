import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { findQuietFalsePositiveSeeds } from "./ab-strategy-b.js";
import { buildQuietFixture } from "./ab-fixture.js";

describe("ab-strategy-b — false-positive seed sweep (対策B fixture selection)", () => {
  test("returns exactly `count` QUIET fixtures, each with a non-baseline tile and no injected anomaly", () => {
    const fixtures = findQuietFalsePositiveSeeds(9);
    assert.equal(fixtures.length, 9);
    for (const fx of fixtures) {
      assert.equal(fx.scenario, "QUIET");
      assert.equal(fx.injectedAnomaly, null, `seed ${fx.seed} must be a true negative control`);
      // The bug this pins (found 2026-08-17): baseline tiles are near-unconditional
      // on a QUIET fixture and are not anomaly claims, so they must not satisfy
      // the sweep on their own — only spike/dip/gap/step_*/divergence do.
      assert.ok(
        fx.curated.tiles.some((t) => t.shapeTag !== "baseline"),
        `seed ${fx.seed} must carry a real false-positive anomaly tile, not just baseline`,
      );
    }
  });

  test("a baseline-only tile set does not satisfy the sweep", () => {
    // Regression pin: seed 1 is baseline-only pre-fix (verified against the
    // live curator during the 2026-08-17 bug investigation), so it must NOT
    // be the first hit once the filter excludes baseline.
    const fixtures = findQuietFalsePositiveSeeds(1);
    assert.notEqual(fixtures[0].seed, 1, "seed 1 is baseline-only and must not count as a false positive");
  });

  test("seeds are unique and reproducible — rerunning the sweep finds the same set", () => {
    const a = findQuietFalsePositiveSeeds(9).map((fx) => fx.seed);
    const b = findQuietFalsePositiveSeeds(9).map((fx) => fx.seed);
    assert.deepEqual(a, b);
    assert.equal(new Set(a).size, a.length, "no seed should repeat");
  });

  test("startSeed shifts which sweep window is searched", () => {
    const fromOne = findQuietFalsePositiveSeeds(1)[0].seed;
    const shifted = findQuietFalsePositiveSeeds(1, { startSeed: fromOne + 1 })[0].seed;
    assert.ok(shifted > fromOne, "sweeping from after the first hit must not return it again");
  });

  test("throws rather than silently under-delivering when the budget is too small", () => {
    assert.throws(
      () => findQuietFalsePositiveSeeds(9, { maxSeeds: 1 }),
      /only found/,
    );
  });

  test("sanity: buildQuietFixture itself is deterministic per seed (precondition for the sweep)", () => {
    // curated.generatedAt is a wall-clock stamp, not seed-derived — excluded
    // from the comparison on purpose, not an oversight.
    const a = buildQuietFixture(123);
    const b = buildQuietFixture(123);
    assert.deepEqual(a.raw, b.raw);
    assert.deepEqual(a.groundTruth, b.groundTruth);
    assert.deepEqual(
      { ...a.curated, generatedAt: 0 },
      { ...b.curated, generatedAt: 0 },
    );
  });
});
