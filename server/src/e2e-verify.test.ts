/**
 * E2E verification harness — PILOT_DATA.md §10 criteria.
 *
 * Three tests, one per scenario. AR and CG run a live stack (generator →
 * adapter → brain tick loop) with timingScale=0.2 to compress real-time
 * waits. RC bypasses the live stack and injects LensEvents at known
 * timestamps to verify that replay arithmetic matches injection truth.
 *
 * Criteria (§10):
 *   AR  — rerouteSchema for agent-C fires within 5s of regression start
 *   CG  — schemaUpdate for auth fires within 10s of gap start
 *   RC  — fine-window replay (1s) reveals burst that coarse (10s) averages away;
 *          burst window mean matches injection truth (≈0.10)
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { MockStreamGenerator, seededRng } from "./mock-stream-generator.js";
import { TestorAdapter, agentExtractor } from "./testor-adapter.js";
import { RetentionBuffer } from "./retention-buffer.js";
import { RuleBrain } from "./rule-brain.js";
import { SnapshotCurator } from "./snapshot-curator.js";
import type { BrainDecision } from "./brain-adapter.js";
import type { LensEvent } from "./lens.js";
import type { TestEvent } from "./mock-stream-generator.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Drive brain tick loop (observe → decide) every tickMs until the first
 * decision matching the predicate fires, or until maxMs elapses.
 */
async function waitForDecision(
  adapter: TestorAdapter,
  brain: RuleBrain,
  predicate: (d: BrainDecision) => boolean,
  maxMs: number,
  tickMs = 200,
): Promise<BrainDecision | null> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    brain.observe(adapter.snapshot());
    const found = brain.decide().find(predicate);
    if (found) return found;
    await sleep(tickMs);
  }
  return null;
}

// ── AR: agent regression ─────────────────────────────────────────────────────

describe("E2E AR — agent regression", { timeout: 15_000 }, () => {
  test("rerouteSchema fires within 5s of regression start", async () => {
    const gen = new MockStreamGenerator();
    // windowMs=3000: fills quickly enough but has lower passRate variance than 1s
    const adapter = new TestorAdapter({ windowMs: 3_000 });
    const brain = new RuleBrain();

    gen.onEvent((e) => adapter.push(e));
    // timingScale=0.2: AR baseline=2s, regression window=6s (total scenario 8s)
    gen.start({ rate: 50, timingScale: 0.2 });

    // Kick off scenario in background (don't await — baseline sleep is 2s)
    void gen.runScenario("AR");

    // Wait out the scaled baseline plus a small buffer, then start the clock.
    // The regression starts at 2s inside runAR; we wait 2.3s to be safely past it.
    await sleep(2_300);
    const regressionStartMs = Date.now();

    // Brain ticks every 200ms. With 3s window: passRate drops below 0.80 after
    // ~1.5s of regression events fill the window, then REGRESSION_TICKS=3 more
    // ticks = 600ms. Total from regressionStartMs ≈ 2.1s, well within 5s.
    // Filter specifically for agent-C to ignore other agents' natural variance.
    const decision = await waitForDecision(
      adapter,
      brain,
      (d) =>
        d.type === "rerouteSchema" &&
        (d.meta as { agentId?: string })?.agentId === "agent-C",
      5_000,
    );

    gen.stop();

    assert.ok(decision !== null, "AR: rerouteSchema should fire within 5s of regression start");
    const latencyMs = Date.now() - regressionStartMs;
    assert.ok(
      latencyMs <= 5_000,
      `AR decision latency ${latencyMs}ms exceeds 5 000ms (§10 criterion)`,
    );
  });
});

// ── CG: coverage gap ─────────────────────────────────────────────────────────

describe("E2E CG — coverage gap", { timeout: 15_000 }, () => {
  test("schemaUpdate for auth fires within 10s of gap start", async () => {
    const gen = new MockStreamGenerator();
    const adapter = new TestorAdapter({ windowMs: 3_000 });
    const brain = new RuleBrain();

    gen.onEvent((e) => adapter.push(e));
    // timingScale=0.2: CG gap lasts 6s — more than GAP_TICKS*tickMs=1s, so gap
    // persists long enough for the brain to accumulate 5 consecutive ticks.
    gen.start({ rate: 50, timingScale: 0.2 });

    // runCG sets cgExcludeBits synchronously before the first await, so the gap
    // is active from the moment the call returns.
    const gapStartMs = Date.now();
    void gen.runScenario("CG");

    // Brain ticks every 200ms. The 3s adapter window fills with CG events
    // (max 24 auth bits touched, gap=8 > GAP_THRESHOLD=4) within ~3s.
    // After 5 consecutive gap-ticks = 1s, decision fires. Total ≈ 4s < 10s.
    const decision = await waitForDecision(
      adapter,
      brain,
      (d) =>
        d.type === "schemaUpdate" &&
        (d.meta as { domain?: string })?.domain === "auth",
      10_000,
    );

    gen.stop();

    assert.ok(decision !== null, "CG: schemaUpdate should fire within 10s of gap start");
    const latencyMs = Date.now() - gapStartMs;
    assert.ok(
      latencyMs <= 10_000,
      `CG decision latency ${latencyMs}ms exceeds 10 000ms (§10 criterion)`,
    );
  });
});

// ── RC: Brain-initiated full chain ───────────────────────────────────────────
//
// Verifies the complete RC chain:
//   generator (seeded) → adapter → RuleBrain dip detection → replayRequest
//   → RetentionBuffer.replay → SnapshotCurator → dip tile at burst position
//
// Uses virtual clock (clockFn) to control event timestamps deterministically
// without real wall-clock waits. Uses agentExtractor("agent-C") so the
// replay focuses on agent-C's signal — fine window makes the 0.20 burst
// visible against the 0.95 baseline.
//
// Timeline (virtual ms):
//   t=[0, 19980)    — 1000 baseline events (20s, 50/s, all agents healthy)
//   t=[20000,21980) — 100 burst events (2s, agent-C passRate=0.20)
//   t=[22000,26980) — 250 recovery events (5s, all agents healthy again)
//   Brain ticks at t=20000,21000,...,28000 (1s interval)
//   Expected: replayRequest fires when adapter window clears the burst (~t=26000)

describe("E2E RC — Brain-initiated full chain (異議 2 fix)", () => {
  test("full chain: generator → adapter → Brain dip → replayRequest → curator dip tile", () => {
    let vt = 0;
    const clock = () => vt;

    const rng = seededRng(42);
    const gen  = new MockStreamGenerator({ rng, clockFn: clock });
    // Per-agent buffer for agent-C: fine-window replay shows 0.20 burst cleanly against 0.95 baseline
    const buf  = new RetentionBuffer<TestEvent>(agentExtractor("agent-C"), {
      retentionWindowMs: 120_000,
      now: clock,
    });
    const adap = new TestorAdapter({ windowMs: 5_000, clockFn: clock });
    const brain = new RuleBrain();
    const curator = new SnapshotCurator();

    gen.onEvent((e) => {
      adap.push(e);
      buf.observe(e, "test_result:v1");
    });

    // Phase 1: 1000 baseline events at 20ms intervals → 20 fine-window anchors
    for (let i = 0; i < 1_000; i++) {
      vt = i * 20;
      gen.singleTick();
    }

    // Phase 2: burst — agent-C fails at passRate=0.20 for 2s (100 events)
    const BURST_START = 20_000;
    const BURST_END   = 21_980;
    gen.setAgentProfile("agent-C", { passRate: 0.20, flakyRate: 0.01, areasPerTest: { min: 2, max: 6 } });
    for (let i = 0; i < 100; i++) {
      vt = BURST_START + i * 20;
      gen.singleTick();
    }

    // Phase 3: recovery — agent-C back to 0.95
    gen.setAgentProfile("agent-C", { passRate: 0.95, flakyRate: 0.01, areasPerTest: { min: 2, max: 6 } });
    for (let i = 0; i < 250; i++) {
      vt = 22_000 + i * 20;
      gen.singleTick();
    }

    // Brain tick loop: observe adapter snapshots at 1s virtual intervals.
    // Dip zone entry expected at vt≈22000 (window=[17000,22000] shows burst mix).
    // Recovery expected at vt≈26000 (burst events age out of 5s window).
    let replayDecision: BrainDecision | null = null;
    for (let t = 20_000; t <= 30_000; t += 1_000) {
      vt = t;
      brain.observe(adap.snapshot());
      const d = brain.decide().find((d) => d.type === "replayRequest");
      if (d) { replayDecision = d; break; }
    }

    assert.ok(
      replayDecision !== null,
      "Brain should fire replayRequest after detecting and recovering from agent-C dip",
    );

    // Execute replay as index.ts would: use qProposal.params.window_ms
    const fineMs = (replayDecision!.qProposal!.params as { window_ms: number }).window_ms;
    assert.equal(fineMs, 1_000, "replayRequest should propose fine window of 1s");

    // Replay full retained buffer at fine granularity (20 baseline + 2 burst + 5 recovery windows)
    const fineResult = buf.replay({ window_ms: fineMs });
    const pkg = curator.curate(fineResult);

    const dipTiles = pkg.tiles.filter((t) => t.shapeTag === "dip");
    assert.ok(
      dipTiles.length >= 1,
      `fine-window curator should produce ≥1 dip tile. Got tiles: [${pkg.tiles.map((t) => t.shapeTag).join(", ")}]`,
    );

    // Dip tile position must align with injection truth (burst region)
    const dip = dipTiles[0];
    assert.ok(
      dip.regionStart >= BURST_START && dip.regionStart < BURST_END + 1_000,
      `dip tile regionStart=${dip.regionStart} should align with burst region [${BURST_START}, ${BURST_END})`,
    );

    // Dip tile mean must reflect the injected passRate=0.20 (from the windows inside the tile)
    const dipMean = dip.windows[0].mean;
    assert.ok(
      dipMean < 0.60,
      `dip tile window mean=${dipMean.toFixed(3)} should be well below baseline (injection: agent-C passRate=0.20)`,
    );
  });
});

// ── RC: retroactive re-observation (arithmetic) ─────────────────────────────

describe("E2E RC — retroactive re-observation", () => {
  test("fine-window replay reveals injected burst; coarse averages it out", () => {
    // Direct injection bypasses the live generator. Events carry artificial
    // timestamps so we control the injection truth exactly.
    //
    // Injection truth:
    //   t=[T, T+8000)  — 800 baseline events, value=0.95 (pass-dominant)
    //   t=[T+8000, T+10000)  — 200 burst events, value=0.10 (fail-dominant)
    //
    // Coarse replay (window_ms=10000): one bucket, mean≈(800*0.95+200*0.10)/1000=0.78
    //   — burst is not a separable window, its shape is invisible
    // Fine replay (window_ms=1000): 10 buckets; burst buckets (t=8000–9999) have
    //   mean≈0.10, revealing the burst that coarse masked.

    const T = 2_000_000; // arbitrary base; far from real Date.now, avoids any eviction edge
    const buf = new RetentionBuffer<LensEvent>((raw) => raw, {
      retentionWindowMs: 120_000,
    });

    // Baseline: 800 events scattered over [T, T+8000)
    for (let i = 0; i < 800; i++) {
      buf.observe({ ts: T + Math.floor(Math.random() * 8000), value: 0.95 }, "test");
    }

    // Burst: 200 events scattered over [T+8000, T+10000)
    for (let i = 0; i < 200; i++) {
      buf.observe({ ts: T + 8000 + Math.floor(Math.random() * 2000), value: 0.10 }, "test");
    }

    // ── Coarse replay (10s window) ──────────────────────────────────────────
    const coarse = buf.replay({ window_ms: 10_000 });

    assert.equal(coarse.windows.length, 1, "coarse produces a single aggregated window");

    const coarseMean = coarse.windows[0].mean;
    // Expected ≈ 0.78. Range [0.70, 0.88] accounts for random scatter.
    assert.ok(
      coarseMean >= 0.70 && coarseMean <= 0.88,
      `coarse mean ${coarseMean.toFixed(3)} should be in [0.70, 0.88] — burst averaged away`,
    );

    // ── Fine replay (1s window) ─────────────────────────────────────────────
    const fine = buf.replay({ window_ms: 1_000 });

    assert.ok(fine.windows.length >= 9, `fine should produce ≥9 windows, got ${fine.windows.length}`);

    // Injection truth: burst is at [T+8000, T+10000). Fine windows aligned to T
    // (first event) produce a window starting at T+8000 (index 8) and T+9000 (index 9).
    // Both should have mean close to 0.10 (within noise from random scatter).
    const burstWindows = fine.windows.filter(
      (w) => w.windowStart >= T + 8000 && w.mean < 0.35,
    );
    assert.ok(
      burstWindows.length >= 1,
      `fine replay must have ≥1 burst window (mean < 0.35) at t≥T+8000 (injection truth: value=0.10 in [T+8000, T+10000))`,
    );

    // Sanity: the burst windows have substantially lower mean than coarse
    const burstMean = burstWindows[0].mean;
    assert.ok(
      burstMean < coarseMean * 0.6,
      `burst window mean ${burstMean.toFixed(3)} should be substantially below coarse mean ${coarseMean.toFixed(3)}`,
    );
  });
});
