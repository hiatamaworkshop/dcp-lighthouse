/**
 * SnapshotCurator tests (Phase 0 Step 3b).
 *
 * Tests verify the $U "present" step: mechanical detection of spikes, gaps,
 * step changes, divergence, and baseline selection. No LLM is involved;
 * $U works on LensResult data produced by applyLens.
 *
 * Ground-truth check: the same injected-truth harness pattern used in
 * retention-buffer.test.ts is reused here so the curator's spike detection
 * is validated against a known anomaly, not just statistical noise.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyLens, type LensEvent } from "./lens.js";
import { SnapshotCurator, type SnapshotPackage } from "./snapshot-curator.js";

const ev = (ts: number, value: number): LensEvent => ({ ts, value });

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Build a flat LensResult directly from windows (avoids needing applyLens). */
function buildResult(windows: { windowStart: number; mean: number; count?: number }[], window_ms = 1000) {
  return {
    window_ms,
    windows: windows.map((w) => ({
      windowStart: w.windowStart,
      windowEnd: w.windowStart + window_ms,
      mean: w.mean,
      count: w.count ?? 10,
    })),
  };
}

// ── globalStats ─────────────────────────────────────────────────────────────

describe("SnapshotCurator — globalStats", () => {
  it("returns zeros for an empty result", () => {
    const curator = new SnapshotCurator();
    const pkg = curator.curate({ window_ms: 1000, windows: [] });
    assert.deepEqual(pkg.globalStats, { mean: 0, stdDev: 0, windowCount: 0 });
    assert.equal(pkg.tiles.length, 0);
    assert.equal(pkg.spanMs, undefined);
  });

  it("computes mean and stdDev over window means", () => {
    const result = buildResult([
      { windowStart: 0, mean: 1 },
      { windowStart: 1000, mean: 3 },
    ]);
    const curator = new SnapshotCurator({ includeBaseline: false });
    const pkg = curator.curate(result);
    assert.equal(pkg.globalStats.mean, 2);
    assert.ok(Math.abs(pkg.globalStats.stdDev - 1) < 1e-9);
    assert.equal(pkg.globalStats.windowCount, 2);
  });
});

// ── Spike detection ─────────────────────────────────────────────────────────

describe("SnapshotCurator — spike detection", () => {
  it("detects a spike via z-score against known injected truth", () => {
    // Injected truth: baseline 0.5, burst 3.5 for one 1s window at t=10000
    const truth = {
      baselineValue: 0.5,
      burstValue: 3.5,
      burstStart: 10_000,
      burstDurMs: 1000,
      stepMs: 100,
      durationMs: 30_000,
    };
    const events: LensEvent[] = [];
    for (let ts = 0; ts < truth.durationMs; ts += truth.stepMs) {
      const inBurst = ts >= truth.burstStart && ts < truth.burstStart + truth.burstDurMs;
      events.push(ev(ts, inBurst ? truth.burstValue : truth.baselineValue));
    }
    const result = applyLens(events, { window_ms: 1000 });
    const curator = new SnapshotCurator({ spikeZThreshold: 2.0 });
    const pkg = curator.curate(result);

    const spikeTiles = pkg.tiles.filter((t) => t.shapeTag === "spike");
    assert.ok(spikeTiles.length >= 1, "should find at least one spike tile");

    const burstTile = spikeTiles.find((t) => t.regionStart === truth.burstStart);
    assert.ok(burstTile, `spike tile at t=${truth.burstStart} should be present`);
    assert.ok(Math.abs(burstTile!.windows[0].mean - truth.burstValue) < 1e-9,
      `spike tile mean should equal injected burstValue ${truth.burstValue}`);
    assert.ok(burstTile!.magnitude !== undefined && burstTile!.magnitude > 2,
      `z-score should be > 2 (got ${burstTile!.magnitude})`);
  });

  it("emits no spike tiles when stream is flat", () => {
    const result = buildResult(
      Array.from({ length: 10 }, (_, i) => ({ windowStart: i * 1000, mean: 1.0 })),
    );
    const curator = new SnapshotCurator({ includeBaseline: false });
    const pkg = curator.curate(result);
    assert.equal(pkg.tiles.filter((t) => t.shapeTag === "spike").length, 0);
  });
});

// ── Gap detection ───────────────────────────────────────────────────────────

describe("SnapshotCurator — gap detection (CG signal)", () => {
  it("detects a gap between consecutive windows", () => {
    const result = buildResult([
      { windowStart: 0, mean: 1 },
      { windowStart: 10_000, mean: 1 }, // 9s gap with window_ms=1000 → > 2×window_ms
    ]);
    const curator = new SnapshotCurator({ includeBaseline: false });
    const pkg = curator.curate(result);
    const gapTiles = pkg.tiles.filter((t) => t.shapeTag === "gap");
    assert.equal(gapTiles.length, 1);
    assert.equal(gapTiles[0].regionStart, 1000); // end of first window
    assert.equal(gapTiles[0].regionEnd, 10_000); // start of second window
  });

  it("does not emit a gap smaller than minGapMs", () => {
    const result = buildResult([
      { windowStart: 0, mean: 1 },
      { windowStart: 1000, mean: 1 }, // contiguous — no gap
    ]);
    const curator = new SnapshotCurator({ includeBaseline: false, minGapMs: 500 });
    const pkg = curator.curate(result);
    assert.equal(pkg.tiles.filter((t) => t.shapeTag === "gap").length, 0);
  });
});

// ── Step detection ──────────────────────────────────────────────────────────

describe("SnapshotCurator — step change detection (AR signal)", () => {
  it("detects a sustained step_down as an agent regression signal", () => {
    // Baseline: 10 windows at mean 1.0, then 5 windows at mean 0.6 (40% drop)
    const ws = [
      ...Array.from({ length: 10 }, (_, i) => ({ windowStart: i * 1000, mean: 1.0 })),
      ...Array.from({ length: 5 }, (_, i) => ({ windowStart: (i + 10) * 1000, mean: 0.6 })),
    ];
    const result = buildResult(ws);
    const curator = new SnapshotCurator({
      stepThreshold: 0.25,
      stepWindowCount: 3,
      includeBaseline: false,
    });
    const pkg = curator.curate(result);
    const stepTiles = pkg.tiles.filter((t) => t.shapeTag === "step_down");
    assert.ok(stepTiles.length >= 1, "should detect a step_down");
    // The step region should be in the regression range
    const regTile = stepTiles[0];
    assert.ok(regTile.regionStart >= 10_000, `step should start at or after t=10000 (got ${regTile.regionStart})`);
  });

  it("detects a step_up when mean elevates sustainedly", () => {
    const ws = [
      ...Array.from({ length: 10 }, (_, i) => ({ windowStart: i * 1000, mean: 1.0 })),
      ...Array.from({ length: 4 }, (_, i) => ({ windowStart: (i + 10) * 1000, mean: 1.5 })),
    ];
    const result = buildResult(ws);
    const curator = new SnapshotCurator({ stepThreshold: 0.2, stepWindowCount: 3, includeBaseline: false });
    const pkg = curator.curate(result);
    assert.ok(pkg.tiles.some((t) => t.shapeTag === "step_up"), "should detect step_up");
  });
});

// ── Divergence detection (parallel overlays) ────────────────────────────────

describe("SnapshotCurator — divergence across parallel lenses", () => {
  it("detects a window where fine and coarse lenses disagree", () => {
    // Lens A has a spike at t=2000; lens B averages it away
    const lensA = buildResult([
      { windowStart: 0, mean: 0.5 },
      { windowStart: 1000, mean: 0.5 },
      { windowStart: 2000, mean: 5.0 }, // spike
      { windowStart: 3000, mean: 0.5 },
    ]);
    const lensB = buildResult([
      { windowStart: 0, mean: 0.5 },
      { windowStart: 1000, mean: 0.5 },
      { windowStart: 2000, mean: 0.55 }, // averaged away
      { windowStart: 3000, mean: 0.5 },
    ]);
    const curator = new SnapshotCurator({
      compareLens: lensB,
      spikeZThreshold: 100, // suppress spike tiles so only divergence fires
      includeBaseline: false,
    });
    const pkg = curator.curate(lensA);
    const divTiles = pkg.tiles.filter((t) => t.shapeTag === "divergence");
    assert.ok(divTiles.length >= 1, "should detect divergence at the spike window");
    assert.ok(divTiles.some((t) => t.regionStart === 2000), "divergence should be at t=2000");
  });
});

// ── Baseline tile ────────────────────────────────────────────────────────────

describe("SnapshotCurator — baseline tile", () => {
  it("includes a baseline tile for the most-normal window", () => {
    const result = buildResult([
      { windowStart: 0, mean: 1.0 },
      { windowStart: 1000, mean: 1.05 }, // closest to mean
      { windowStart: 2000, mean: 5.0 },  // spike (excluded from baseline pick)
    ]);
    const curator = new SnapshotCurator({ includeBaseline: true, spikeZThreshold: 100 });
    const pkg = curator.curate(result);
    const baseTile = pkg.tiles.find((t) => t.shapeTag === "baseline");
    assert.ok(baseTile, "baseline tile should be present");
  });

  it("always includes baseline when no anomalies found", () => {
    const result = buildResult(
      Array.from({ length: 5 }, (_, i) => ({ windowStart: i * 1000, mean: 1.0 })),
    );
    const curator = new SnapshotCurator({ includeBaseline: true });
    const pkg = curator.curate(result);
    assert.ok(pkg.tiles.some((t) => t.shapeTag === "baseline"));
  });
});

// ── maxTiles cap ────────────────────────────────────────────────────────────

describe("SnapshotCurator — maxTiles cap", () => {
  it("caps the tile count at maxTiles", () => {
    // Many spikes
    const ws = Array.from({ length: 20 }, (_, i) => ({
      windowStart: i * 1000,
      mean: i % 2 === 0 ? 1.0 : 10.0,
    }));
    const result = buildResult(ws);
    const curator = new SnapshotCurator({ maxTiles: 5, spikeZThreshold: 1.0 });
    const pkg = curator.curate(result);
    assert.ok(pkg.tiles.length <= 5, `expected ≤5 tiles, got ${pkg.tiles.length}`);
  });
});

// ── spanMs + metadata ───────────────────────────────────────────────────────

describe("SnapshotCurator — package metadata", () => {
  it("records spanMs and window_ms correctly", () => {
    const result = buildResult([
      { windowStart: 5000, mean: 1 },
      { windowStart: 10_000, mean: 1 },
    ]);
    const curator = new SnapshotCurator({ includeBaseline: false });
    const pkg = curator.curate(result);
    assert.ok(pkg.spanMs);
    assert.equal(pkg.spanMs!.start, 5000);
    assert.equal(pkg.spanMs!.end, 11_000); // last windowEnd
    assert.equal(pkg.window_ms, 1000);
    assert.ok(typeof pkg.generatedAt === "number" && pkg.generatedAt > 0);
  });

  it("tiles are sorted chronologically in the final package", () => {
    const result = buildResult([
      { windowStart: 0, mean: 0.5 },
      { windowStart: 1000, mean: 0.5 },
      { windowStart: 2000, mean: 5.0 },
      { windowStart: 3000, mean: 0.5 },
      { windowStart: 10_000, mean: 0.5 }, // creates a gap at t=4000–10000
    ]);
    const curator = new SnapshotCurator({ spikeZThreshold: 1.5, includeBaseline: false });
    const pkg = curator.curate(result);
    for (let i = 1; i < pkg.tiles.length; i++) {
      assert.ok(
        pkg.tiles[i].regionStart >= pkg.tiles[i - 1].regionStart,
        `tiles should be chronological: tile ${i - 1} at ${pkg.tiles[i - 1].regionStart}, tile ${i} at ${pkg.tiles[i].regionStart}`,
      );
    }
  });
});
