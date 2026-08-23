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
import { applyLens, MIN_VALID_COUNT, type LensEvent, type LensResult } from "./lens.js";
import { SnapshotCurator, type SnapshotPackage } from "./snapshot-curator.js";

const ev = (ts: number, value: number): LensEvent => ({ ts, value });

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a flat LensResult directly from windows (avoids needing applyLens).
 * sumSq is synthesized as count*mean^2 — i.e. every event in the window is
 * assumed to equal the window's mean exactly (zero within-window spread).
 * This is the honest choice for a fixture that only specifies a mean: it
 * means the pooled reference variance (see poolStats in snapshot-curator.ts)
 * reduces to a count-weighted spread of window means, since there is no real
 * per-event distribution to draw from.
 */
function buildResult(
  windows: { windowStart: number; mean: number; count?: number; range?: { min: number; max: number } }[],
  window_ms = 1000,
): LensResult {
  return {
    window_ms,
    windows: windows.map((w) => {
      const count = w.count ?? 10;
      return {
        windowStart: w.windowStart,
        windowEnd: w.windowStart + window_ms,
        mean: w.mean,
        count,
        sumSq: count * w.mean * w.mean,
        valid: count >= MIN_VALID_COUNT,
        ...(w.range ? { range: w.range } : {}),
      };
    }),
  };
}

// ── unreachable tails (blindness applied to a direction) ────────────────────

/** Seeded PRNG so these fixtures are reproducible. */
function rng32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A real Bernoulli stream through the real lens, rather than a hand-built
 * LensResult. buildResult synthesizes sumSq as count*mean², i.e. zero
 * within-window spread, which makes the pooled σ an order of magnitude smaller
 * than a genuine pass/fail stream's and puts every tail comfortably in reach —
 * so the property under test here can only be exercised on real aggregation.
 */
function bernoulliResult(seed: number, passRate: number, fromTs: number, spanMs: number) {
  const rand = rng32(seed);
  const events: LensEvent[] = [];
  for (let i = 0; i < 1000; i++) {
    events.push({ ts: fromTs + Math.floor(rand() * spanMs), value: rand() < passRate ? 1 : 0 });
  }
  return applyLens(events, { window_ms: 1000, align: "epoch" });
}

describe("SnapshotCurator — a tail that cannot fire is blindness, not quiet", () => {
  it("declares the spike tail unreachable when the data's ceiling sits under the gate", () => {
    // A window mean cannot exceed the largest value the stream produces. On the
    // pilot's 0.95-pass shape that ceiling is 1.0, only a couple of σ above
    // baseline, so the Šidák-corrected gate sits above anything the data could
    // ever produce. "No spikes" then reports a question that was never askable
    // — measured as 136 dips to 1 spike over 2000 null trials
    // (ROADMAP_BRIEF.md 2026-08-17).
    const observation = bernoulliResult(1, 0.95, 0, 10_000);
    const reference = bernoulliResult(2, 0.95, -10_000, 10_000);
    const pkg = new SnapshotCurator({ spikeZThreshold: 2.0 }).curate(observation, reference);

    const spike = pkg.unreachableTails.find((t) => t.direction === "spike");
    assert.ok(
      spike,
      `expected the spike tail to be declared unreachable, got ${JSON.stringify(pkg.unreachableTails)}`,
    );
    assert.ok(
      spike.attainableZ < spike.requiredZ,
      `attainable ${spike.attainableZ} must fall short of the gate ${spike.requiredZ}`,
    );
    // The dip side is reachable at this shape, so only one direction is named.
    assert.equal(pkg.unreachableTails.filter((t) => t.direction === "dip").length, 0);
  });

  it("says nothing when the distribution puts both tails in reach", () => {
    // Same machinery at a 0.5 pass rate: the mean sits far from either bound,
    // so both directions can clear the gate and reporting one would be noise.
    // This is also the shape whose measured false-alarm rate matches design.
    const observation = bernoulliResult(1, 0.5, 0, 10_000);
    const reference = bernoulliResult(2, 0.5, -10_000, 10_000);
    const pkg = new SnapshotCurator({ spikeZThreshold: 2.0 }).curate(observation, reference);
    assert.deepEqual(pkg.unreachableTails, []);
  });

  it("stays silent when windows carry no observed range to reason from", () => {
    // Hand-built fixtures and any caller predating `range`: absence of evidence
    // about reachability must not be reported as evidence of unreachability.
    const reference = buildResult([
      { windowStart: -2000, mean: 0.90, count: 100 },
      { windowStart: -1000, mean: 0.99, count: 100 },
    ]);
    const observation = buildResult([{ windowStart: 0, mean: 0.95, count: 100 }]);
    const pkg = new SnapshotCurator({ spikeZThreshold: 2.0 }).curate(observation, reference);
    assert.deepEqual(pkg.unreachableTails, []);
  });
});

// ── reference usability (blindness vs quiet) ────────────────────────────────

describe("SnapshotCurator — a degenerate reference is blindness, not quiet", () => {
  it("declares referenceUsable=false when every reference event is identical", () => {
    // The bug this pins (2026-08-17): Number.isFinite(0) is true, so a
    // zero-variance reference passed the usability check while comparisonSE
    // returned 0 for every window and the scoring loop skipped them all. The
    // package then said "usable yardstick, no anomalies" — the exact
    // silence-read-as-quiet failure the flag exists to prevent.
    const reference = buildResult([
      { windowStart: -2000, mean: 1.0, count: 50 },
      { windowStart: -1000, mean: 1.0, count: 50 },
    ]);
    const observation = buildResult([{ windowStart: 0, mean: 0.4, count: 50 }]);
    const pkg = new SnapshotCurator({ includeBaseline: false }).curate(observation, reference);

    assert.equal(pkg.globalStats.eventCount, 100, "the reference did have events");
    assert.equal(pkg.referenceUsable, false, "but no variance, so nothing could be scored");
    assert.equal(
      pkg.tiles.filter((t) => t.shapeTag === "dip" || t.shapeTag === "spike").length,
      0,
      "and the flag must agree with the scoring loop, which already emitted nothing",
    );
  });

  it("still reports a usable reference when there is real variance", () => {
    const reference = buildResult([
      { windowStart: -2000, mean: 0.90, count: 50 },
      { windowStart: -1000, mean: 0.98, count: 50 },
    ]);
    const observation = buildResult([{ windowStart: 0, mean: 0.94, count: 50 }]);
    const pkg = new SnapshotCurator({ includeBaseline: false }).curate(observation, reference);
    assert.equal(pkg.referenceUsable, true);
    assert.ok(pkg.globalStats.stdDev > 0);
  });

  it("no longer calls effectiveN==2 usable — the floor is MIN_VALID_COUNT, not the Bessel minimum", () => {
    // Two reference events with real spread (mean 1.0 and 0.0): enough for
    // Bessel's correction to produce a variance (0.5, not NaN or 0), but
    // n_eff=2 carries essentially no degrees of freedom, so that variance
    // does not mean anything yet. Before the floor was raised from
    // effectiveN>=2 to effectiveN>=MIN_VALID_COUNT, this reference reported
    // referenceUsable=true (ROADMAP_BRIEF.md 2026-08-18 (5) §B: "a bare
    // floor of 2, not a practical one" — the precondition L5 needed tightened
    // before thinning could reuse it).
    const reference = buildResult([
      { windowStart: -2000, mean: 1.0, count: 1 },
      { windowStart: -1000, mean: 0.0, count: 1 },
    ]);
    const observation = buildResult([{ windowStart: 0, mean: 0.5, count: 50 }]);
    const pkg = new SnapshotCurator({ includeBaseline: false }).curate(observation, reference);
    assert.equal(pkg.referenceUsable, false);
  });

  it("reports the reference's event weight, which windowCount cannot convey", () => {
    // Three windows can hold three events or three thousand, and the
    // comparator divides by the event total, not the window total.
    const thin = buildResult([
      { windowStart: -2000, mean: 0.9, count: 3 },
      { windowStart: -1000, mean: 1.0, count: 3 },
    ]);
    const fat = buildResult([
      { windowStart: -2000, mean: 0.9, count: 500 },
      { windowStart: -1000, mean: 1.0, count: 500 },
    ]);
    const observation = buildResult([{ windowStart: 0, mean: 0.94, count: 50 }]);
    const curator = new SnapshotCurator({ includeBaseline: false });

    const thinPkg = curator.curate(observation, thin);
    const fatPkg = curator.curate(observation, fat);
    assert.equal(thinPkg.globalStats.eventCount, 6);
    assert.equal(fatPkg.globalStats.eventCount, 1000);
    // Same window count, three orders of magnitude apart in weight.
    assert.equal(thinPkg.globalStats.windowCount, fatPkg.globalStats.windowCount);
  });
});

// ── selection context ───────────────────────────────────────────────────────

describe("SnapshotCurator — selection context (multiple-comparisons metadata)", () => {
  it("reports the family size it actually corrected over, not the reference window count", () => {
    // The two counts differ and conflating them would misstate the family:
    // globalStats.windowCount counts REFERENCE windows, scoredWindowCount
    // counts the OBSERVATION windows eligible for scoring.
    const observation = buildResult([
      { windowStart: 0, mean: 0.95 },
      { windowStart: 1000, mean: 0.95 },
      { windowStart: 2000, mean: 0.95 },
    ]);
    const reference = buildResult([
      { windowStart: -2000, mean: 0.95 },
      { windowStart: -1000, mean: 0.95 },
    ]);
    const pkg = new SnapshotCurator().curate(observation, reference);
    assert.equal(pkg.selection.scoredWindowCount, 3);
    assert.equal(pkg.globalStats.windowCount, 2);
  });

  it("excludes windows below MIN_VALID_COUNT from the family", () => {
    // An unscorable window is not a comparison, so counting it would inflate
    // the correction and silently desensitize the whole package.
    const observation = buildResult([
      { windowStart: 0, mean: 0.95, count: 10 },
      { windowStart: 1000, mean: 0.95, count: MIN_VALID_COUNT - 1 },
    ]);
    const reference = buildResult([{ windowStart: -1000, mean: 0.95, count: 10 }]);
    const pkg = new SnapshotCurator().curate(observation, reference);
    assert.equal(pkg.selection.scoredWindowCount, 1);
  });

  it("carries the declared base threshold and a Šidák-corrected effective one", () => {
    const observation = buildResult(
      Array.from({ length: 10 }, (_, i) => ({ windowStart: i * 1000, mean: 0.95 })),
    );
    const reference = buildResult([
      { windowStart: -2000, mean: 0.95 },
      { windowStart: -1000, mean: 0.96 },
    ]);
    const pkg = new SnapshotCurator({ spikeZThreshold: 2.0 }).curate(observation, reference);

    assert.equal(pkg.selection.baseZThreshold, 2.0);
    assert.equal(pkg.selection.scoredWindowCount, 10);
    // Correcting for a family of 10 must raise the bar, never lower it.
    assert.ok(
      pkg.selection.effectiveZThreshold > pkg.selection.baseZThreshold,
      `effective ${pkg.selection.effectiveZThreshold} must exceed base ${pkg.selection.baseZThreshold}`,
    );
    // 対策A's documented figure for N=10 at a 2.0σ family budget is ~2.8σ.
    assert.ok(
      Math.abs(pkg.selection.effectiveZThreshold - 2.8) < 0.1,
      `expected ~2.8σ for N=10, got ${pkg.selection.effectiveZThreshold}`,
    );
  });

  it("is present even on an empty package, so a reader never has to guess", () => {
    const pkg = new SnapshotCurator().curate({ window_ms: 1000, windows: [] });
    assert.equal(pkg.selection.scoredWindowCount, 0);
    assert.equal(pkg.selection.baseZThreshold, 2.0);
  });
});

// ── globalStats ─────────────────────────────────────────────────────────────

describe("SnapshotCurator — globalStats", () => {
  it("returns zeros for an empty result", () => {
    const curator = new SnapshotCurator();
    const pkg = curator.curate({ window_ms: 1000, windows: [] });
    assert.deepEqual(pkg.globalStats, { mean: 0, stdDev: 0, windowCount: 0, eventCount: 0 });
    assert.equal(pkg.tiles.length, 0);
    assert.equal(pkg.spanMs, undefined);
  });

  it("computes mean and stdDev pooled by event count, not spread of window means (2026-07-25 reference-lens design)", () => {
    const result = buildResult([
      { windowStart: 0, mean: 1 },
      { windowStart: 1000, mean: 3 },
    ]);
    const curator = new SnapshotCurator({ includeBaseline: false });
    const pkg = curator.curate(result);
    assert.equal(pkg.globalStats.mean, 2);
    // Bessel-corrected pooled variance over 20 events (10 at value 1, 10 at
    // value 3): (10*1^2 + 10*3^2 - 20*2^2) / (20-1) = 20/19.
    const expectedStdDev = Math.sqrt(20 / 19);
    assert.ok(Math.abs(pkg.globalStats.stdDev - expectedStdDev) < 1e-9);
    assert.equal(pkg.globalStats.windowCount, 2);
  });
});

// ── Window validity gating (ROADMAP L1-2) ──────────────────────────────────

describe("SnapshotCurator — low-count window validity", () => {
  it("pools a low-count outlier window into stats but its own SE is unresolvable so it never fires (2026-07-25 reference-lens design)", () => {
    // 10 flat windows plus one count=1 window whose mean is wildly off. The
    // old design excluded it via a valid/MIN_VALID_COUNT gate. The new design
    // has no such gate: the window IS pooled (event-count-weighted) into the
    // reference stats, but its own sample variance needs >=2 events to exist
    // at all — at count=1 it's NaN, so its standard error is NaN and it can
    // never cross a z threshold. The exception dissolves into the arithmetic
    // instead of being a separate branch.
    const result = buildResult([
      ...Array.from({ length: 10 }, (_, i) => ({ windowStart: i * 1000, mean: 1.0 })),
      { windowStart: 10_000, mean: 50.0, count: 1 },
    ]);
    const curator = new SnapshotCurator({ spikeZThreshold: 2.0, includeBaseline: false });
    const pkg = curator.curate(result);

    // Pooled over 101 events (100 at value 1.0, 1 at value 50.0).
    assert.ok(Math.abs(pkg.globalStats.mean - 150 / 101) < 1e-9,
      "the count=1 window should be pooled into the mean, not excluded");
    assert.ok(pkg.globalStats.stdDev > 0,
      "pooled stdDev should reflect the outlier's contribution");

    const anomalyTiles = pkg.tiles.filter((t) => t.shapeTag === "spike" || t.shapeTag === "dip");
    assert.equal(anomalyTiles.length, 0,
      "no window should fire: the outlier's own SE is unresolvable (count=1), and the flat " +
      "windows sit only 1σ from the (outlier-shifted) mean — below the 2.0 threshold");
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
      spikeZThreshold: 100, // suppress spike tiles so only divergence fires
      includeBaseline: false,
    });
    const pkg = curator.curate(lensA, lensB);
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

// ── Dip detection (RC signal) ────────────────────────────────────────────────

describe("SnapshotCurator — dip detection (RC fine-window signal)", () => {
  it("detects a dip via negative z-score against known injected truth", () => {
    // Mirrors the RC E2E injection: 8 baseline windows at 0.95, 2 burst windows at 0.10
    const ws = [
      ...Array.from({ length: 8 }, (_, i) => ({ windowStart: i * 1000, mean: 0.95 })),
      { windowStart: 8000, mean: 0.10 },
      { windowStart: 9000, mean: 0.10 },
    ];
    const result = buildResult(ws);
    const curator = new SnapshotCurator({ spikeZThreshold: 2.0, includeBaseline: false });
    const pkg = curator.curate(result);
    const dipTiles = pkg.tiles.filter((t) => t.shapeTag === "dip");
    assert.ok(dipTiles.length >= 1, "should find at least one dip tile");
    assert.ok(dipTiles.some((t) => t.regionStart >= 8000), "dip should be in the burst region");
  });

  it("dip tile carries a positive magnitude (absolute z-score)", () => {
    const ws = [
      ...Array.from({ length: 8 }, (_, i) => ({ windowStart: i * 1000, mean: 0.95 })),
      { windowStart: 8000, mean: 0.10 },
    ];
    const result = buildResult(ws);
    const curator = new SnapshotCurator({ spikeZThreshold: 2.0, includeBaseline: false });
    const pkg = curator.curate(result);
    const dipTile = pkg.tiles.find((t) => t.shapeTag === "dip");
    assert.ok(dipTile?.magnitude !== undefined && dipTile.magnitude > 0,
      "dip magnitude should be a positive number (|z|)");
  });

  it("emits no dip tiles when stream is flat", () => {
    const result = buildResult(
      Array.from({ length: 10 }, (_, i) => ({ windowStart: i * 1000, mean: 0.95 })),
    );
    const curator = new SnapshotCurator({ spikeZThreshold: 2.0, includeBaseline: false });
    const pkg = curator.curate(result);
    assert.equal(pkg.tiles.filter((t) => t.shapeTag === "dip").length, 0);
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

// ── Explicit reference lens (ROADMAP_BRIEF.md 2026-07-25 — 参照レンズ設計) ──

describe("SnapshotCurator — explicit reference lens", () => {
  it("scores against a fixed external reference so magnitude does not drift as later windows accumulate", () => {
    // Reference has a little real spread (window means alternate slightly)
    // so the standard error is non-zero and z-scores are finite.
    const reference = buildResult(
      Array.from({ length: 20 }, (_, i) => ({ windowStart: i * 1000, mean: i % 2 === 0 ? 0.94 : 0.96 })),
    );
    const burstWindow = { windowStart: 20_000, mean: 0.60, count: 10 };

    const curator = new SnapshotCurator({ includeBaseline: false });

    const shortPkg = curator.curate(buildResult([burstWindow]), reference);
    const shortDip = shortPkg.tiles.find((t) => t.shapeTag === "dip");
    assert.ok(shortDip, "burst window should be flagged as a dip against the fixed reference");

    // Append 30 quiet windows AFTER the burst and re-score against the SAME
    // reference object. Under the old self-referential design (computeGlobalStats
    // over the observation's own accumulating windows), growing the observation
    // set would shrink the population stdDev over time and change the burst
    // window's z-score even though nothing about the burst itself changed —
    // this is the "late-firing coarse dip" finding. With an explicit external
    // reference, the burst window's z-score is bit-for-bit identical.
    const longPkg = curator.curate(
      buildResult([
        burstWindow,
        ...Array.from({ length: 30 }, (_, i) => ({ windowStart: 21_000 + i * 1000, mean: 0.95 })),
      ]),
      reference,
    );
    const longDip = longPkg.tiles.find((t) => t.regionStart === burstWindow.windowStart);

    assert.ok(longDip, "burst window should still be flagged after more windows accumulate");
    assert.equal(
      longDip!.magnitude,
      shortDip!.magnitude,
      "z-score must not drift when the reference is fixed externally",
    );
  });

  it("self-reference (the default) is equivalent to passing the same LensResult explicitly", () => {
    const result = buildResult([
      { windowStart: 0, mean: 1.0 },
      { windowStart: 1000, mean: 5.0 },
    ]);
    const curator = new SnapshotCurator({ includeBaseline: false });
    const implicit = curator.curate(result);
    const explicit = curator.curate(result, result);
    assert.deepEqual({ ...implicit, generatedAt: 0 }, { ...explicit, generatedAt: 0 });
  });
});

// ── Comparator soundness (2026-07-25 self-review regressions) ───────────────

// ── Continuity correction (2026-08-17) ──────────────────────────────────────

describe("SnapshotCurator — the gate corrects for lattice-valued data, and only then", () => {
  // Background in ROADMAP_BRIEF.md 2026-08-17: on pass/fail data a window of n
  // events can only produce n+1 distinct means, and treating that staircase as
  // continuous put the package false-alarm rate at 6.85% against a 4.55%
  // design. Half a lattice step comes off the deviation before the gate sees it.
  //
  // The property that makes this honest rather than a fudge factor is that the
  // lattice is DETECTED from sufficient statistics, so the correction switches
  // itself off on data it does not apply to. Both cases below are the same
  // stream to three decimal places; the only thing that differs is whether the
  // values are two-valued.
  const REF = applyLens(
    Array.from({ length: 300 }, (_, i) => ev(i * 10, i % 25 === 0 ? 0 : 1)), // 0.96
    { window_ms: 1000 },
  );
  // 91/100 against a 0.96 baseline: 2.21σ raw, 1.99σ once the staircase is
  // accounted for — deliberately between the two, which is the only place the
  // correction is observable at all.
  const window = (perturbFirstZeroTo: number | null): LensEvent[] => {
    const out: LensEvent[] = [];
    for (let i = 0; i < 100; i++) {
      const pass = i < 91 ? 1 : 0;
      out.push(ev(100_000 + i, pass === 0 && i === 91 && perturbFirstZeroTo !== null ? perturbFirstZeroTo : pass));
    }
    return out;
  };
  const curator = new SnapshotCurator({ includeBaseline: false });
  const dips = (evts: LensEvent[]): number =>
    curator.curate(applyLens(evts, { window_ms: 1000 }), REF).tiles.filter((t) => t.shapeTag === "dip").length;

  it("does not fire on a two-valued window whose raw z clears the bar only by the lattice's own coarseness", () => {
    assert.equal(dips(window(null)), 0);
  });

  it("fires on the same window once one event lands off the lattice — even though that makes the dip shallower", () => {
    // Moving a single 0 up to 0.001 raises the window mean, so this observation
    // is strictly LESS anomalous than the one above. It fires because sumSq no
    // longer matches what two-valued data forces it to be, so the correction
    // correctly declines to apply. Nothing but the lattice test differs.
    assert.equal(dips(window(0.001)), 1);
  });

  it("reports the uncorrected z as magnitude, so the effect size Brain reads is untouched", () => {
    const tile = curator
      .curate(applyLens(window(0.001), { window_ms: 1000 }), REF)
      .tiles.find((t) => t.shapeTag === "dip");
    assert.ok(tile!.magnitude! > 2.15, `magnitude ${tile!.magnitude} should be the raw z, above the gate it passed`);
  });

  it("does not let a window with no effective evidence inflate the Šidák family", () => {
    // Found reviewing the exp(τ) commit. Past ~414τ of age every weight
    // underflows its own square, so ΣW² is exactly 0 while ΣW is not, and the
    // window's effective n collapses to 0 — an infinite standard error, so it
    // can never fire. It still passed the count-based scorability test, so it
    // counted toward the family and raised the bar for the window that COULD
    // fire: measured at 2.27σ instead of 2.00σ for a family of one.
    //
    // τ=1s and a segment seven minutes deep is enough to reach this, and
    // replaying historical spans is what the model is for.
    const stale: LensEvent[] = [];
    for (let i = 0; i < 100; i++) stale.push(ev(i, i % 20 === 0 ? 0 : 1));
    for (let i = 0; i < 3; i++) stale.push(ev(415_000 + i, 1));
    const obs = applyLens(stale, { window_ms: 1000, decay: "exp(tau=1s)", align: "epoch" });

    const dead = obs.windows.find((w) => w.windowStart === 0)!;
    assert.equal(dead.count, 100, "the window is not empty — it passes every count-based test");
    assert.equal(dead.weights!.sumW2, 0, "but its second weight moment has underflowed");
    assert.ok(dead.weights!.sumW > 0, "while its total weight has not");

    const pkg = new SnapshotCurator({ includeBaseline: false }).curate(obs, REF);
    assert.equal(pkg.selection.scoredWindowCount, 1, "only the live window is testable");
    // Family of one ⇒ the base threshold, uncorrected.
    assert.equal(pkg.selection.effectiveZThreshold, pkg.selection.baseZThreshold);
  });

  it("survives a WEIGHTING lens — the correction is about the values, not about the counts", () => {
    // Regression for the first attempt at `decay: exp(τ)`, which had
    // detectLattice refuse to answer whenever a window carried weights. That
    // reads plausibly (a weighted sum is not confined to a lattice) and is
    // measurably wrong: it put the false-alarm rate under the weighted lens
    // back at 7.1%, i.e. exactly the pre-correction figure. The two-valuedness
    // identity holds for any weights with total weight in place of count.
    //
    // τ is far longer than the segment so the arithmetic is untouched to six
    // decimals and only the SHAPE of the statistics differs — which is the one
    // thing under test.
    const lens = { window_ms: 1000, decay: "exp(tau=1000000s)" };
    const weightedRef = applyLens(
      Array.from({ length: 300 }, (_, i) => ev(i * 10, i % 25 === 0 ? 0 : 1)),
      lens,
    );
    const weightedDips = (evts: LensEvent[]): number =>
      curator.curate(applyLens(evts, lens), weightedRef).tiles.filter((t) => t.shapeTag === "dip").length;

    assert.ok(
      weightedRef.windows.every((w) => w.weights !== undefined),
      "the lens must actually be producing weighted windows, or this test proves nothing",
    );
    assert.equal(weightedDips(window(null)), 0, "the lattice correction must still apply");
    assert.equal(weightedDips(window(0.001)), 1, "and must still switch off when the lattice is broken");
  });
});

describe("SnapshotCurator — comparator scores against the reference's spread, not the window's own", () => {
  // Regression for a bug found by self-review: scoring with a Welch-style SE
  // that used each window's OWN variance made a perfectly uniform window look
  // maximally anomalous, because for bounded data an extreme mean forces a
  // near-zero within-window variance — collapsing the denominator exactly when
  // the numerator is largest. Measured on a healthy 0.95-pass stream, an
  // all-pass window scored a constant 6.57σ "spike" at every window size.
  const events = (n: number, value: number, t0: number): LensEvent[] =>
    Array.from({ length: n }, (_, i) => ev(t0 + i, value));

  /** Reference: 0.95-pass-like stream — mostly 1.0 with a scattering of 0.0. */
  const reference = applyLens(
    Array.from({ length: 600 }, (_, i) => ev(i * 10, i % 20 === 0 ? 0 : 1)),
    { window_ms: 1000 },
  );

  it("does not flag a perfectly uniform all-pass window as a spike", () => {
    // Every event equals the best possible value. Its own variance is exactly
    // zero. This must read as unremarkable, not as the strongest signal present.
    const observation = applyLens(events(50, 1.0, 100_000), { window_ms: 1000 });
    const curator = new SnapshotCurator({ includeBaseline: false });
    const pkg = curator.curate(observation, reference);
    assert.deepEqual(
      pkg.tiles.filter((t) => t.shapeTag === "spike"),
      [],
      "a uniformly healthy window must not be flagged as an anomaly",
    );
  });

  it("magnitude grows with window size for the same effect (a zero-variance window must not score a size-independent constant)", () => {
    // The bug's signature was that z did not depend on n at all. With the
    // reference supplying the yardstick, more events = more evidence = higher z.
    const curator = new SnapshotCurator({ includeBaseline: false, spikeZThreshold: 0.5 });
    const zAt = (n: number): number => {
      const pkg = curator.curate(applyLens(events(n, 0.0, 100_000), { window_ms: 1000 }), reference);
      return pkg.tiles.find((t) => t.shapeTag === "dip")!.magnitude!;
    };
    const [z10, z40] = [zAt(10), zAt(40)];
    assert.ok(z40 > z10 * 1.5,
      `z should scale with evidence: n=10 gave ${z10.toFixed(2)}, n=40 gave ${z40.toFixed(2)}`);
  });

  it("still detects a genuine drop", () => {
    const observation = applyLens(events(50, 0.2, 100_000), { window_ms: 1000 });
    const curator = new SnapshotCurator({ includeBaseline: false });
    const pkg = curator.curate(observation, reference);
    assert.ok(pkg.tiles.some((t) => t.shapeTag === "dip"), "a real drop must still fire");
  });
});

describe("SnapshotCurator — unusable reference is blindness, not quiet", () => {
  // Regression for a bug found by self-review: when the reference segment fell
  // outside retention the pooled variance was NaN, every comparison silently
  // evaluated false, and curate() returned an empty tile list indistinguishable
  // from a healthy stream. That is the silence-vs-blindness confusion this
  // project explicitly tracks, so the state is now reported.
  const observation = buildResult([
    { windowStart: 0, mean: 1.0 },
    { windowStart: 1000, mean: 0.1 },
  ]);

  it("reports referenceUsable=false for an empty reference", () => {
    const pkg = new SnapshotCurator().curate(observation, { window_ms: 1000, windows: [] });
    assert.equal(pkg.referenceUsable, false);
    assert.deepEqual(pkg.tiles.filter((t) => t.shapeTag === "dip"), [],
      "no comparison is possible, so no reference-derived tiles");
  });

  it("reports referenceUsable=false when the reference holds too few events for a variance", () => {
    const pkg = new SnapshotCurator().curate(observation, buildResult([{ windowStart: 0, mean: 1.0, count: 1 }]));
    assert.equal(pkg.referenceUsable, false);
  });

  it("reports referenceUsable=true for a normal reference", () => {
    const pkg = new SnapshotCurator().curate(observation);
    assert.equal(pkg.referenceUsable, true);
  });

  it("does not fabricate a step tile with magnitude:0 when the reference can't ground one", () => {
    // 3 sustained windows well past stepThreshold (default 0.3) — enough to
    // trigger detectSteps' run-length gate (default minRun=3) purely from the
    // mean-shift check, which only needs ref.mean and does not itself require
    // variance. Before the fix this fabricated a step_up/step_down tile with
    // magnitude:0, misreporting "measured, no shift" instead of "no yardstick".
    const sustained = buildResult([
      { windowStart: 0, mean: 1.0 },
      { windowStart: 1000, mean: 1.0 },
      { windowStart: 2000, mean: 1.0 },
    ]);
    const pkg = new SnapshotCurator().curate(sustained, buildResult([{ windowStart: 0, mean: 0.5, count: 1 }]));
    assert.equal(pkg.referenceUsable, false);
    assert.deepEqual(
      pkg.tiles.filter((t) => t.shapeTag === "step_up" || t.shapeTag === "step_down"),
      [],
      "no reference means no scored step, not a step with magnitude:0",
    );
  });
});

// ── Šidák correction (2026-07-28 "対策A") ──────────────────────────────────

describe("SnapshotCurator — Šidák-corrected spike/dip threshold scales with window count", () => {
  // Reference: 100 windows alternating mean=0/mean=2 (count=100 each) pools to
  // mean=1.0, variance~=1.0 — a fixed, reusable yardstick so every case below
  // scores the same target window against an identical population.
  const refWindows = Array.from({ length: 100 }, (_, i) => ({
    windowStart: i * 1000,
    mean: i % 2 === 0 ? 0 : 2,
    count: 100,
  }));
  const reference = buildResult(refWindows);

  // A quiet filler window sits exactly at the reference mean (z=0, never
  // fires) but still counts toward N — it is what a real second, third, ...
  // scored window in the same package would look like.
  function withFillers(targetMean: number, fillerCount: number) {
    const windows = [{ windowStart: 500_000, mean: targetMean, count: 100 }];
    for (let i = 0; i < fillerCount; i++) {
      windows.push({ windowStart: 600_000 + i * 1000, mean: 1.0, count: 100 });
    }
    const observation = buildResult(windows);
    const curator = new SnapshotCurator({ spikeZThreshold: 2.0, includeBaseline: false });
    const pkg = curator.curate(observation, reference);
    return pkg.tiles.find((t) => t.regionStart === 500_000);
  }

  it("a ~2.2σ window fires alone (N=1, threshold is a no-op there)", () => {
    const tile = withFillers(1.221, 0);
    assert.ok(tile, "N=1 must behave exactly like the uncorrected 2.0σ threshold");
    assert.ok(Math.abs(tile!.magnitude! - 2.199) < 0.01);
  });

  it("the SAME ~2.2σ window is suppressed once enough other windows share the package (N=15)", () => {
    const tile = withFillers(1.221, 14);
    assert.equal(tile, undefined,
      "package-wide Šidák correction must raise the effective threshold above 2.2σ at N=15");
  });

  it("suppression already applies at a modest N=5, not just large packages", () => {
    const tile = withFillers(1.221, 4);
    assert.equal(tile, undefined);
  });

  it("a genuine large effect (~10σ) still fires even in a large package (N=30)", () => {
    const tile = withFillers(2.0, 29);
    assert.ok(tile, "correction must not suppress real anomalies, only inflate the noise floor");
    assert.ok(tile!.magnitude! > 9);
  });

  it("threshold correction is exactly a no-op at N=1: 2.05σ fires, 1.95σ does not", () => {
    const se = Math.sqrt(1 * (1 / 100 + 1 / 10_000));
    assert.ok(withFillers(1 + 2.05 * se, 0), "just above 2.0σ must still fire at N=1");
    assert.equal(withFillers(1 + 1.95 * se, 0), undefined, "just below 2.0σ must not fire at N=1");
  });
});

// ── Grouped curation (ROADMAP L4 group_by) ──────────────────────────────────

/**
 * A four-agent stream at a fixed per-agent rate, built from real events so the
 * dilution below is arithmetic rather than a hand-written fixture number.
 *
 * Every (agent, window) cell emits RATE_PER_AGENT events of which `passCount`
 * are 1 and the rest 0 — deterministic, so every z-score in these tests is
 * reproducible rather than seed-dependent.
 */
const RATE_PER_AGENT = 25;
const AGENTS = ["agent-a", "agent-b", "agent-c", "agent-d"];
const HEALTHY_PASSES = 24; // 24/25 = 0.96

function cell(windowStart: number, agentId: string, passCount: number): LensEvent[] {
  return Array.from({ length: RATE_PER_AGENT }, (_, i) => ({
    ts: windowStart + i * (1000 / RATE_PER_AGENT),
    value: i < passCount ? 1 : 0,
    keys: { agentId },
  }));
}

/** `sick` overrides one (window, agent) cell's pass count. */
function span(
  windowStarts: number[],
  sick?: { windowStart: number; agentId: string; passCount: number },
): LensEvent[] {
  const out: LensEvent[] = [];
  for (const ws of windowStarts) {
    for (const agentId of AGENTS) {
      const passes =
        sick && sick.windowStart === ws && sick.agentId === agentId
          ? sick.passCount
          : HEALTHY_PASSES;
      out.push(...cell(ws, agentId, passes));
    }
  }
  return out;
}

const REF_WINDOWS = [0, 1000, 2000];
const OBS_WINDOWS = [3000, 4000, 5000];
const GROUPED = { window_ms: 1000, align: "epoch" as const, group_by: ["agentId"] };
const FLAT = { window_ms: 1000, align: "epoch" as const };

describe("SnapshotCurator — group_by: the mixture hides what the group shows", () => {
  // agent-c spends part of the middle window failing: 20/25 = 0.80 against its
  // own 0.96 baseline. In the four-agent mixture that same window reads
  // (24+24+20+24)/100 = 0.92 — the dip diluted to roughly a quarter of its
  // depth, which is the recorded L4 motivation (ROADMAP_BRIEF.md 2026-07-25).
  const SICK = { windowStart: 4000, agentId: "agent-c", passCount: 20 };
  const obsEvents = span(OBS_WINDOWS, SICK);
  const refEvents = span(REF_WINDOWS);
  const curator = new SnapshotCurator({ spikeZThreshold: 2.0, includeBaseline: true });

  const flatPkg = curator.curate(applyLens(obsEvents, FLAT), applyLens(refEvents, FLAT));
  const groupedPkg = curator.curate(applyLens(obsEvents, GROUPED), applyLens(refEvents, GROUPED));

  it("the mixed lens does not report the dip at all", () => {
    // Not a threshold-tuning artefact: the mixed window sits ~1.8σ from
    // baseline, under even the uncorrected 2.0σ bar.
    assert.equal(flatPkg.tiles.filter((t) => t.shapeTag === "dip").length, 0);
  });

  it("the grouped lens reports it, attributed to the responsible agent", () => {
    const dips = groupedPkg.tiles.filter((t) => t.shapeTag === "dip");
    assert.equal(dips.length, 1, `expected exactly one dip, got ${dips.map((d) => d.label)}`);
    assert.equal(dips[0].group, "agent-c");
    assert.equal(dips[0].regionStart, 4000);
    assert.ok(dips[0].label.includes("agent-c"), "the label must name the group");
  });

  it("the same dip is nearly twice the effect size once it is not averaged across agents", () => {
    // The mixed window scores too low to be reported at all, so it is re-read
    // through a deliberately loose threshold purely to obtain its z. magnitude
    // is the uncorrected z in both packages, so the two are comparable.
    //
    // 0.5 and not 1.0: the extraction device has to stay clear of the gate, and
    // at 1.0 the N=3 bar (1.553σ) sat within a hundredth of this window's
    // continuity-corrected 1.55σ. That is the device interfering with the
    // measurement, not a property of grouping.
    const loose = new SnapshotCurator({ spikeZThreshold: 0.5, includeBaseline: false });
    const mixedZ = loose
      .curate(applyLens(obsEvents, FLAT), applyLens(refEvents, FLAT))
      .tiles.find((t) => t.regionStart === 4000 && t.shapeTag === "dip")!.magnitude!;
    const groupedZ = groupedPkg.tiles.find((t) => t.shapeTag === "dip")!.magnitude!;

    assert.ok(mixedZ < 2.0, `mixed z ${mixedZ} must sit under the shipped 2.0σ bar`);
    assert.ok(groupedZ > 3.4, `grouped z ${groupedZ}`);
    assert.ok(
      groupedZ / mixedZ > 1.9,
      `grouping deepened the effect only ${(groupedZ / mixedZ).toFixed(2)}×`,
    );
  });

  it("scores the groups, not the mixture — no untagged anomaly tiles", () => {
    const anomalies = groupedPkg.tiles.filter((t) => t.shapeTag === "dip" || t.shapeTag === "spike");
    assert.ok(anomalies.every((t) => t.group !== undefined));
  });

  it("leaves the healthy agents silent", () => {
    const flagged = new Set(
      groupedPkg.tiles
        .filter((t) => t.shapeTag === "dip" || t.shapeTag === "spike")
        .map((t) => t.group),
    );
    assert.deepEqual([...flagged], ["agent-c"]);
  });

  it("pairs each group with its own reference, not the pooled one", () => {
    // Make the OTHER agents unhealthy in the reference span, moving the pooled
    // mean a long way while agent-c's own baseline stays put. Scored against
    // the pooled reference, agent-c's magnitude would move; against its own it
    // must not.
    const skewedRef = [
      ...span(REF_WINDOWS).filter((e) => e.keys!.agentId === "agent-c"),
      ...REF_WINDOWS.flatMap((ws) =>
        AGENTS.filter((a) => a !== "agent-c").flatMap((a) => cell(ws, a, 5)),
      ),
    ];
    //
    // maxTiles is lifted for this comparison: the skew makes the other three
    // agents scream (0.96 observed against a 0.20 reference), and at the
    // default cap of 12 those louder tiles evict agent-c's — the maxTiles
    // eviction already recorded as a known sharp edge. The question here is
    // which reference agent-c was scored against, not which tiles survived.
    const uncapped = new SnapshotCurator({
      spikeZThreshold: 2.0,
      includeBaseline: true,
      maxTiles: 100,
    });
    const plain = uncapped.curate(applyLens(obsEvents, GROUPED), applyLens(refEvents, GROUPED));
    const skewed = uncapped.curate(applyLens(obsEvents, GROUPED), applyLens(skewedRef, GROUPED));

    const pick = (p: SnapshotPackage): number =>
      p.tiles.find((t) => t.group === "agent-c" && t.shapeTag === "dip")!.magnitude!;
    assert.ok(
      Math.abs(pick(plain) - pick(skewed)) < 1e-9,
      `agent-c magnitude moved ${pick(plain)} → ${pick(skewed)} when OTHER agents' reference changed`,
    );
  });
});

describe("SnapshotCurator — group_by: blindness is per group", () => {
  const curator = new SnapshotCurator({ spikeZThreshold: 2.0 });

  it("names groups it could not score instead of silently omitting them", () => {
    // agent-d appears only in the observation — a newly-started agent. There is
    // no same-group history to compare it against, and falling back to the
    // pooled reference would compare one agent to the mixture, which is the
    // dilution group_by exists to remove.
    const refEvents = span(REF_WINDOWS).filter((e) => e.keys!.agentId !== "agent-d");
    const obsEvents = span(OBS_WINDOWS, { windowStart: 4000, agentId: "agent-d", passCount: 2 });
    const pkg = curator.curate(applyLens(obsEvents, GROUPED), applyLens(refEvents, GROUPED));

    assert.deepEqual(pkg.unscoredGroups, ["agent-d"]);
    assert.equal(
      pkg.tiles.some((t) => t.group === "agent-d"),
      false,
      "an unscorable group must not produce anomaly tiles",
    );
  });

  it("omits the field entirely when every observed group was scorable", () => {
    const pkg = curator.curate(
      applyLens(span(OBS_WINDOWS), GROUPED),
      applyLens(span(REF_WINDOWS), GROUPED),
    );
    assert.equal(pkg.unscoredGroups, undefined);
  });

  it("also names a group whose OWN reference pool is degenerate, not just an absent one", () => {
    // agent-c's reference is a uniform 100% pass rate across all three
    // windows — real events, effectiveN well above 2, but zero within-agent
    // spread, so its pooled reference variance is exactly 0. Before
    // isReferenceUsable unified the package-level flag with buildScoringUnits
    // (this fix), the group path only checked effectiveN>=2, not variance>0,
    // so this group silently entered scoring: comparisonSE returned 0, so it
    // never fired a tile, but it was reported as SCORED-AND-QUIET rather than
    // UNSCORABLE — indistinguishable from a genuinely healthy, well-grounded
    // group. Mirrors the whole-package bug pinned above ("a degenerate
    // reference is blindness, not quiet"), reached here through group_by.
    const refEvents = [
      ...span(REF_WINDOWS).filter((e) => e.keys!.agentId !== "agent-c"),
      ...REF_WINDOWS.flatMap((ws) => cell(ws, "agent-c", RATE_PER_AGENT)), // 100% pass, zero spread
    ];
    const obsEvents = span(OBS_WINDOWS, { windowStart: 4000, agentId: "agent-c", passCount: 5 });
    const pkg = curator.curate(applyLens(obsEvents, GROUPED), applyLens(refEvents, GROUPED));

    assert.ok(
      pkg.unscoredGroups?.includes("agent-c"),
      `expected agent-c in unscoredGroups, got ${JSON.stringify(pkg.unscoredGroups)}`,
    );
    assert.equal(
      pkg.tiles.some((t) => t.group === "agent-c"),
      false,
      "an unscorable group must not produce tiles, scored-quiet or otherwise",
    );
  });
});

describe("SnapshotCurator — group_by: the Šidák family is the package, not the group", () => {
  // Grouping turns N windows into N×G comparisons. If each group carried its
  // own fresh budget the package-level false-alarm rate would climb with the
  // number of groups — exactly the inflation 対策A removed for window count.
  // The cost is real and is pinned here: the same anomaly at the same depth
  // fires when it is the only group and does not when it is one of four.
  const curator = new SnapshotCurator({ spikeZThreshold: 2.0, includeBaseline: false });

  // This pair needs an effect BETWEEN two bars 0.47σ apart, and the 25-event
  // cells the rest of this file uses cannot express one: on that lattice the
  // neighbouring depths score 2.19σ and 3.07σ (continuity-corrected), which
  // straddle both bars together. That is the discreteness finding of
  // 2026-08-17 showing up as a test-authoring constraint, so the fixture is
  // made finer here rather than the assertion loosened. At 200 events per cell
  // the correction costs 0.16σ instead of 0.44σ and a borderline exists again.
  const DENSE_RATE = 200;
  const DENSE_HEALTHY = 192; // 192/200 = 0.96, the same rate as the shared fixture
  const BORDERLINE = 183; // 0.915 vs 0.96 = 2.81σ raw, 2.65σ gated — above N=3 (2.42σ), below N=12 (2.89σ)

  function denseCell(windowStart: number, agentId: string, passCount: number): LensEvent[] {
    return Array.from({ length: DENSE_RATE }, (_, i) => ({
      ts: windowStart + i * (1000 / DENSE_RATE),
      value: i < passCount ? 1 : 0,
      keys: { agentId },
    }));
  }
  function denseSpan(windowStarts: number[], sickWindow?: number): LensEvent[] {
    const out: LensEvent[] = [];
    for (const ws of windowStarts) {
      for (const agentId of AGENTS) {
        const passes =
          ws === sickWindow && agentId === "agent-c" ? BORDERLINE : DENSE_HEALTHY;
        out.push(...denseCell(ws, agentId, passes));
      }
    }
    return out;
  }
  const onlyC = (evts: LensEvent[]): LensEvent[] =>
    evts.filter((e) => e.keys!.agentId === "agent-c");

  it("fires at family size 3 (one group × three windows)", () => {
    const pkg = curator.curate(
      applyLens(onlyC(denseSpan(OBS_WINDOWS, 4000)), GROUPED),
      applyLens(onlyC(denseSpan(REF_WINDOWS)), GROUPED),
    );
    const dip = pkg.tiles.find((t) => t.shapeTag === "dip");
    assert.ok(dip, "a 2.81σ dip must clear the N=3 bar (2.42σ)");
    assert.ok(dip!.magnitude! > 2.6 && dip!.magnitude! < 3.0, `magnitude ${dip!.magnitude}`);
  });

  it("does not fire at family size 12 (four groups × three windows)", () => {
    const pkg = curator.curate(
      applyLens(denseSpan(OBS_WINDOWS, 4000), GROUPED),
      applyLens(denseSpan(REF_WINDOWS), GROUPED),
    );
    assert.equal(
      pkg.tiles.filter((t) => t.shapeTag === "dip").length,
      0,
      "the same depth must not clear the N=12 bar (2.89σ) — grouping costs sensitivity",
    );
  });
});

describe("SnapshotCurator — group_by: a single group falling silent is a gap", () => {
  it("detects a gap inside one group that the mixed stream never shows", () => {
    // agent-d stops reporting for three windows while the others carry on, so
    // the mixture has no hole at all — the CG case that motivates per-group
    // gap detection.
    const windows = [3000, 4000, 5000, 6000, 7000];
    const events = windows.flatMap((ws) =>
      AGENTS.filter((a) => a !== "agent-d" || ws === 3000 || ws === 7000).flatMap((a) =>
        cell(ws, a, HEALTHY_PASSES),
      ),
    );
    const curator = new SnapshotCurator({ spikeZThreshold: 2.0, includeBaseline: false });
    const pkg = curator.curate(applyLens(events, GROUPED), applyLens(span(REF_WINDOWS), GROUPED));

    const gaps = pkg.tiles.filter((t) => t.shapeTag === "gap");
    assert.equal(gaps.length, 1, `expected one gap, got ${gaps.map((g) => g.label)}`);
    assert.equal(gaps[0].group, "agent-d");
    assert.equal(gaps[0].regionStart, 4000);
    assert.equal(gaps[0].regionEnd, 7000);

    // The mixed lens over the same events reports nothing missing.
    const flatPkg = curator.curate(applyLens(events, FLAT), applyLens(span(REF_WINDOWS), FLAT));
    assert.equal(flatPkg.tiles.filter((t) => t.shapeTag === "gap").length, 0);
  });
});

// ── agg_func: median — curator refuses to score it (ROADMAP_BRIEF.md 2026-08-18 (5) §C / 2026-08-23) ──

describe("SnapshotCurator — agg_func: median is unscorable, not silently scored", () => {
  const medEvents = (n: number, fromTs: number): LensEvent[] =>
    Array.from({ length: n }, (_, i) => ({ ts: fromTs + i * 10, value: i % 5 }));

  it("sets aggFuncUnscored and never produces a tile, even for an obviously anomalous median observation", () => {
    const curator = new SnapshotCurator({ spikeZThreshold: 2.0, includeBaseline: true });
    const observation = applyLens(medEvents(50, 0), { window_ms: 1000, agg_func: "median" });
    const reference = applyLens(medEvents(50, 0), { window_ms: 1000, agg_func: "median" });
    const pkg = curator.curate(observation, reference);

    assert.equal(pkg.aggFuncUnscored, true);
    assert.deepEqual(pkg.tiles, []);
    assert.equal(pkg.referenceUsable, false, "median means no z-test model, not merely no yardstick");
  });

  it("also refuses when only the REFERENCE lens is median (a mean observation scored against it would be meaningless)", () => {
    const curator = new SnapshotCurator({ spikeZThreshold: 2.0, includeBaseline: true });
    const observation = applyLens(medEvents(50, 0), { window_ms: 1000 }); // plain mean
    const reference = applyLens(medEvents(50, 0), { window_ms: 1000, agg_func: "median" });
    const pkg = curator.curate(observation, reference);

    assert.equal(pkg.aggFuncUnscored, true);
    assert.deepEqual(pkg.tiles, []);
  });

  it("a plain mean lens is entirely unaffected: no aggFuncUnscored field at all", () => {
    const curator = new SnapshotCurator({ spikeZThreshold: 2.0, includeBaseline: true });
    const observation = applyLens(medEvents(50, 0), { window_ms: 1000 });
    const pkg = curator.curate(observation);
    assert.equal(pkg.aggFuncUnscored, undefined);
  });

  it("group_by: a median lens is refused even though groups carry their own real medians in `mean`", () => {
    const curator = new SnapshotCurator({ spikeZThreshold: 2.0, includeBaseline: true });
    const events: LensEvent[] = [
      { ts: 0, value: 1, keys: { agentId: "A" } },
      { ts: 10, value: 5, keys: { agentId: "A" } },
      { ts: 20, value: 9, keys: { agentId: "A" } },
    ];
    const observation = applyLens(events, { window_ms: 1000, group_by: ["agentId"], agg_func: "median" });
    // The raw LensResult still carries the real median — the curator declines to JUDGE it, not to compute it.
    assert.equal(observation.groups![0].windows[0].mean, 5);

    const pkg = curator.curate(observation);
    assert.equal(pkg.aggFuncUnscored, true);
    assert.deepEqual(pkg.tiles, []);
    assert.equal(pkg.unscoredGroups, undefined, "the whole-package flag replaces the group-level one here, not alongside it");
  });
});
