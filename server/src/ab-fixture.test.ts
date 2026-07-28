import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildRcFixture, buildArFixture, buildQuietFixture, type ABFixture } from "./ab-fixture.js";

/**
 * Cross-arm consistency: every dip/spike tile in the curated arm must point
 * at a window that appears verbatim (same start, same mean) in the raw arm's
 * observation view. This is the fixture's core contract — two presentations
 * of the same data — so it is asserted, not assumed.
 */
function assertArmsConsistent(fx: ABFixture): void {
  for (const tile of fx.curated.tiles) {
    if (tile.shapeTag !== "dip" && tile.shapeTag !== "spike") continue;
    const idx = fx.raw.observation.windowStarts.indexOf(tile.regionStart);
    assert.ok(idx >= 0, `tile at t=${tile.regionStart} has no matching raw window`);
    assert.equal(
      fx.raw.observation.means[idx],
      tile.windows[0].mean,
      `raw mean and tile mean diverge at t=${tile.regionStart}`,
    );
  }
}

describe("ab-fixture — RC", () => {
  test("raw and curated presentations describe the same underlying data", () => {
    const fx = buildRcFixture();

    assert.equal(fx.scenario, "RC");
    assert.ok(fx.curated.referenceUsable, "pre-burst baseline must make the reference usable");

    assert.ok(fx.raw.observation.means.length >= 9, `expected >=9 fine windows, got ${fx.raw.observation.means.length}`);
    assert.ok(fx.raw.reference.means.length >= 9, "raw arm must carry the reference interval too (information parity)");
    assert.ok(fx.curated.spanMs, "curated package must have a span");

    // Ground truth: burst windows in the raw array should read low.
    const rawBurstMeans = fx.raw.observation.means.filter((m) => m < 0.35);
    assert.ok(rawBurstMeans.length >= 1, "raw means must contain at least one burst-range value");

    // Curated side must surface a dip tile inside the injected burst window.
    const dipTiles = fx.curated.tiles.filter((t) => t.shapeTag === "dip");
    assert.ok(dipTiles.length >= 1, "curated package must contain a dip tile");
    const truth = fx.groundTruth as { burstStartTs: number; burstEndTs: number };
    assert.ok(
      // -1000: windows align to the segment's first event, not to fromTs, so
      // the burst boundary can fall up to one window inside the previous one.
      dipTiles.some((t) => t.regionStart >= truth.burstStartTs - 1000 && t.regionStart < truth.burstEndTs),
      "dip tile must land within the injected burst region",
    );

    assertArmsConsistent(fx);
  });
});

describe("ab-fixture — AR", () => {
  test("raw and curated presentations describe the same underlying data", () => {
    const fx = buildArFixture();

    assert.equal(fx.scenario, "AR");
    assert.ok(fx.curated.referenceUsable, "pre-regression baseline must make the reference usable");
    assert.ok(fx.raw.observation.means.length >= 5, `expected >=5 windows over the 30s regression, got ${fx.raw.observation.means.length}`);
    assert.ok(fx.raw.reference.means.length >= 2, "raw arm must carry the reference interval too (information parity)");

    // Ground truth: every regression-window mean should read well below baseline.
    assert.ok(
      fx.raw.observation.means.every((m) => m < 0.85),
      `all regression windows should read below 0.85 (baseline 0.95, regressed 0.70), got [${fx.raw.observation.means.join(", ")}]`,
    );

    // A sustained-but-modest shift (~26%) sits under the curator's default
    // step threshold (30%) — see ab-fixture.ts's buildArFixture doc. Expect
    // per-window dip tiles, not step_down, and don't overclaim step
    // detection this fixture isn't calibrated to trigger.
    const dipTiles = fx.curated.tiles.filter((t) => t.shapeTag === "dip");
    assert.ok(dipTiles.length >= 1, "curated package must contain at least one dip tile in the regression window");
    const truth = fx.groundTruth as { regressionStartTs: number; regressionEndTs: number };
    assert.ok(
      dipTiles.every((t) => t.regionStart >= truth.regressionStartTs && t.regionStart < truth.regressionEndTs),
      "every dip tile must land inside the injected regression region",
    );

    assertArmsConsistent(fx);
  });
});

describe("ab-fixture — QUIET (negative control)", () => {
  test("nothing injected, but structurally identical to RC", () => {
    const fx = buildQuietFixture();

    assert.equal(fx.scenario, "QUIET");
    assert.equal(fx.injectedAnomaly, null);
    assert.ok(fx.curated.referenceUsable, "quiet fixture must still have a usable reference");
    assert.ok(fx.raw.observation.means.length >= 9);
    assert.ok(
      fx.raw.observation.means.every((m) => m > 0.85),
      `quiet observation should stay near baseline, got [${fx.raw.observation.means.join(", ")}]`,
    );
    // No assertion on tile count: the ~5% two-sided false-positive floor at
    // 2σ means an occasional spurious tile is expected and realistic. What
    // must NOT appear is a large-magnitude tile.
    const bigTiles = fx.curated.tiles.filter((t) => (t.magnitude ?? 0) > 4);
    assert.equal(bigTiles.length, 0, `quiet fixture must not contain >4σ tiles, got ${JSON.stringify(bigTiles.map((t) => t.label))}`);

    assertArmsConsistent(fx);
  });
});

describe("ab-fixture — determinism", () => {
  test("same seed reproduces the same fixture; different seeds differ", () => {
    const a = buildRcFixture(7);
    const b = buildRcFixture(7);
    assert.deepEqual(a.raw, b.raw, "same seed must reproduce identical raw data");
    assert.deepEqual(
      a.curated.tiles.map((t) => [t.shapeTag, t.regionStart, t.magnitude]),
      b.curated.tiles.map((t) => [t.shapeTag, t.regionStart, t.magnitude]),
      "same seed must reproduce identical tiles",
    );

    const c = buildRcFixture(8);
    assert.notDeepEqual(a.raw.observation.means, c.raw.observation.means, "different seeds must produce different data");
  });
});
