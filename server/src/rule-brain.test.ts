/**
 * RuleBrain unit tests (Phase 1 Step 6).
 *
 * Verifies AR / CG / RC rule logic with synthetic snapshots.
 * No live generator or timers — snapshots are fed directly.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { RuleBrain } from "./rule-brain.js";
import { seededRng } from "./mock-stream-generator.js";
import type { STSnapshot, AgentStats, DomainStats } from "./testor-adapter.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeAgent(agentId: string, passRate: number, eventCount = 100): AgentStats {
  return { agentId, passRate, flakyRate: 0, eventCount };
}

function makeDomain(domain: string, gap: number): DomainStats {
  return { domain, coveredBits: 32 - gap, requiredBits: 32, gap };
}

function makeSnapshot(agents: AgentStats[], domains: DomainStats[] = []): STSnapshot {
  return { ts: Date.now(), agents, domains, touchedBitsThisTick: [] };
}

/** Feed N identical snapshots to the brain and return all decisions. */
function feedN(brain: RuleBrain, snap: STSnapshot, n: number) {
  const all = [];
  for (let i = 0; i < n; i++) {
    brain.observe(snap);
    all.push(...brain.decide());
  }
  return all;
}

/**
 * Establish a healthy per-agent baseline before a regression/dip scenario.
 * Per-agent thresholds (baseline − δ) require WARMUP_TICKS=10 healthy
 * observations before AR/RC fire; feed a margin over that.
 */
const WARMUP = 12;
function warmup(brain: RuleBrain, agents: AgentStats[], ticks = WARMUP) {
  feedN(brain, makeSnapshot(agents), ticks);
}

// ── AR rule ──────────────────────────────────────────────────────────────────

describe("RuleBrain — AR rule (per-agent baseline)", () => {
  test("rerouteSchema fires after REGRESSION_TICKS below the learned baseline", () => {
    const brain = new RuleBrain();
    // Establish baseline ~0.95 → threshold ~0.85
    warmup(brain, [makeAgent("agent-C", 0.95)]);
    const snap = makeSnapshot([makeAgent("agent-C", 0.70)]); // 0.70 < 0.85

    // 1 tick below threshold: not yet (REGRESSION_TICKS=2)
    feedN(brain, snap, 1);
    brain.observe(snap);
    // tick 2: should fire
    const decisions = brain.decide();
    const d = decisions.find((d) => d.type === "rerouteSchema");
    assert.ok(d, "rerouteSchema should fire on the 2nd sub-threshold tick (REGRESSION_TICKS=2)");
    assert.equal((d!.meta as { agentId: string }).agentId, "agent-C");
  });

  test("low-baseline agent does NOT fire just for being below the global 0.80", () => {
    // The core of the 静穏 fix: agent-B's 0.88 is its baseline, not a regression.
    // threshold ≈ 0.78, so steady 0.88 never fires.
    const brain = new RuleBrain();
    const snap = makeSnapshot([makeAgent("agent-B", 0.88)]);
    const decisions = feedN(brain, snap, 30);
    assert.equal(
      decisions.filter((d) => d.type === "rerouteSchema").length, 0,
      "a steady low-baseline agent must not be flagged as regressing",
    );
  });

  test("rerouteSchema does not fire while the agent stays at its baseline", () => {
    const brain = new RuleBrain();
    const snap = makeSnapshot([makeAgent("agent-A", 0.95)]);
    const decisions = feedN(brain, snap, 30);
    assert.equal(decisions.filter((d) => d.type === "rerouteSchema").length, 0);
  });

  test("rerouteSchema fires only once per regression (no spam)", () => {
    const brain = new RuleBrain();
    warmup(brain, [makeAgent("agent-C", 0.95)]);
    const decisions = feedN(brain, makeSnapshot([makeAgent("agent-C", 0.70)]), 10);
    const reroutes = decisions.filter((d) => d.type === "rerouteSchema");
    assert.equal(reroutes.length, 1, "should fire exactly once per regression session");
  });

  test("rerouteSchema re-arms after recovery", () => {
    const brain = new RuleBrain();
    const low = makeSnapshot([makeAgent("agent-C", 0.70)]);
    const high = makeSnapshot([makeAgent("agent-C", 0.95)]);
    warmup(brain, [makeAgent("agent-C", 0.95)]);
    // Trigger regression
    feedN(brain, low, 3);
    // Recovery (baseline updates resume, stays ~0.95)
    feedN(brain, high, 3);
    // Second regression: should fire again
    const decisions = feedN(brain, low, 3);
    assert.ok(decisions.some((d) => d.type === "rerouteSchema"), "should re-arm after recovery");
  });

  test("no AR firing during warmup (baseline not yet trusted)", () => {
    const brain = new RuleBrain();
    // Drop immediately, before WARMUP_TICKS=10 — threshold is null, nothing fires.
    const decisions = feedN(brain, makeSnapshot([makeAgent("agent-C", 0.30)]), 8);
    assert.equal(
      decisions.filter((d) => d.type === "rerouteSchema").length, 0,
      "regression must not fire before the agent's baseline is established",
    );
  });
});

// ── CG rule ──────────────────────────────────────────────────────────────────

describe("RuleBrain — CG rule", () => {
  test("schemaUpdate fires after GAP_TICKS above gap threshold", () => {
    const brain = new RuleBrain();
    const snap = makeSnapshot([], [makeDomain("auth", 8)]);  // gap=8 > GAP_THRESHOLD=4
    const decisions = feedN(brain, snap, 5);
    assert.ok(decisions.some((d) => d.type === "schemaUpdate"), "schemaUpdate should fire");
  });

  test("schemaUpdate does not fire for small gap", () => {
    const brain = new RuleBrain();
    const snap = makeSnapshot([], [makeDomain("auth", 2)]);  // gap=2 <= GAP_THRESHOLD=4
    const decisions = feedN(brain, snap, 10);
    assert.equal(decisions.filter((d) => d.type === "schemaUpdate").length, 0);
  });

  test("schemaUpdate fires for correct domain", () => {
    const brain = new RuleBrain();
    const snap = makeSnapshot([], [makeDomain("auth", 8), makeDomain("payment", 1)]);
    const decisions = feedN(brain, snap, 5);
    const d = decisions.find((d) => d.type === "schemaUpdate");
    assert.ok(d, "schemaUpdate should fire");
    assert.equal((d!.meta as { domain: string }).domain, "auth");
  });
});

// ── RC rule ──────────────────────────────────────────────────────────────────

describe("RuleBrain — RC rule (brief dip + recovery)", () => {
  test("replayRequest does NOT fire at healthy baseline", () => {
    const brain = new RuleBrain();
    const snap = makeSnapshot([
      makeAgent("agent-A", 0.95),
      makeAgent("agent-B", 0.88),
      makeAgent("agent-C", 0.95),
      makeAgent("agent-D", 0.90),
    ]);
    const decisions = feedN(brain, snap, 30);
    assert.equal(decisions.filter((d) => d.type === "replayRequest").length, 0,
      "each agent sits at its own baseline — no dip below its threshold, no RC");
  });

  test("replayRequest fires after agent dips below its threshold then recovers", () => {
    const brain = new RuleBrain();
    warmup(brain, [makeAgent("agent-C", 0.95)]); // threshold ~0.85
    const dip  = makeSnapshot([makeAgent("agent-C", 0.65)]); // in [0.40, 0.85)
    const high = makeSnapshot([makeAgent("agent-C", 0.92)]);

    // 3 ticks in dip zone
    feedN(brain, dip, 3);
    // recovery
    brain.observe(high);
    const decisions = brain.decide();
    const d = decisions.find((d) => d.type === "replayRequest");
    assert.ok(d, "replayRequest should fire on recovery from brief dip");
    assert.equal((d!.meta as { agentId: string }).agentId, "agent-C");
  });

  test("replayRequest does NOT fire for passRate below BRIEF_DIP_FLOOR (0.40) — too severe, AR handles", () => {
    const brain = new RuleBrain();
    warmup(brain, [makeAgent("agent-C", 0.95)]);
    const severe = makeSnapshot([makeAgent("agent-C", 0.20)]);
    const high   = makeSnapshot([makeAgent("agent-C", 0.92)]);

    feedN(brain, severe, 3);
    brain.observe(high);
    const decisions = brain.decide();
    assert.equal(decisions.filter((d) => d.type === "replayRequest").length, 0,
      "passRate 0.20 < BRIEF_DIP_FLOOR (0.40) — should not trigger RC replayRequest");
  });

  test("replayRequest fires only once per session", () => {
    const brain = new RuleBrain();
    warmup(brain, [makeAgent("agent-C", 0.95)]);
    const dip  = makeSnapshot([makeAgent("agent-C", 0.65)]);
    const high = makeSnapshot([makeAgent("agent-C", 0.92)]);

    // First dip + recovery
    feedN(brain, dip, 2);
    feedN(brain, high, 1);
    // Second dip + recovery (without reset)
    feedN(brain, dip, 2);
    feedN(brain, high, 1);

    const all: ReturnType<typeof brain.decide> = [];
    brain.observe(high);
    all.push(...brain.decide());

    // Already emitted — should not fire a second time without reset
    assert.equal(all.filter((d) => d.type === "replayRequest").length, 0,
      "already emitted — should not fire a second time without reset");
  });

  test("replayRequest re-arms after reset()", () => {
    const brain = new RuleBrain();
    const dip  = makeSnapshot([makeAgent("agent-C", 0.65)]);
    const high = makeSnapshot([makeAgent("agent-C", 0.92)]);

    warmup(brain, [makeAgent("agent-C", 0.95)]);
    feedN(brain, dip, 2);
    feedN(brain, high, 1);
    // First emission consumed; now reset (clears baseline too)
    brain.reset();
    // Re-establish baseline, then second dip + recovery should fire again
    warmup(brain, [makeAgent("agent-C", 0.95)]);
    feedN(brain, dip, 2);
    brain.observe(high);
    const decisions = brain.decide();
    assert.ok(decisions.some((d) => d.type === "replayRequest"),
      "replayRequest should re-arm after reset()");
  });

  test("replayRequest qProposal has window_ms", () => {
    const brain = new RuleBrain();
    warmup(brain, [makeAgent("agent-C", 0.95)]);
    const dip  = makeSnapshot([makeAgent("agent-C", 0.65)]);
    const high = makeSnapshot([makeAgent("agent-C", 0.92)]);

    feedN(brain, dip, 2);
    brain.observe(high);
    const decisions = brain.decide();
    const d = decisions.find((d) => d.type === "replayRequest");
    assert.ok(d?.qProposal, "replayRequest should carry qProposal");
    assert.ok(
      typeof (d!.qProposal!.params as { window_ms?: number }).window_ms === "number",
      "qProposal.params should have window_ms",
    );
  });
});

// ── RC calibration (異議 3 fixes) ─────────────────────────────────────────────
//
// DIP_REQUIRE_TICKS=2: single-tick statistical noise must not trigger RC.
// DIP_MAX_TICKS=4:     a dip that outlasts 4 ticks is AR territory — RC must not
//                      fire alongside rerouteSchema on recovery.

describe("RuleBrain — RC calibration (noise guard + AR overlap fix)", () => {
  test("single-tick dip does NOT trigger replayRequest (DIP_REQUIRE_TICKS guard)", () => {
    const brain = new RuleBrain();
    warmup(brain, [makeAgent("agent-C", 0.95)]);
    // 1 tick at 0.65 — below threshold but not enough to confirm brief dip
    brain.observe(makeSnapshot([makeAgent("agent-C", 0.65)]));
    brain.observe(makeSnapshot([makeAgent("agent-C", 0.92)]));
    const decisions = brain.decide();
    assert.equal(
      decisions.filter((d) => d.type === "replayRequest").length, 0,
      "single-tick dip should not trigger RC (requires DIP_REQUIRE_TICKS consecutive ticks)",
    );
  });

  test("two-tick dip DOES trigger replayRequest (minimum confirmed dip)", () => {
    const brain = new RuleBrain();
    warmup(brain, [makeAgent("agent-C", 0.95)]);
    feedN(brain, makeSnapshot([makeAgent("agent-C", 0.65)]), 2);
    brain.observe(makeSnapshot([makeAgent("agent-C", 0.92)]));
    const decisions = brain.decide();
    assert.ok(
      decisions.some((d) => d.type === "replayRequest"),
      "two-tick dip (== DIP_REQUIRE_TICKS) should trigger RC on recovery",
    );
  });

  test("prolonged dip (> DIP_MAX_TICKS) does NOT trigger replayRequest (AR territory)", () => {
    const brain = new RuleBrain();
    warmup(brain, [makeAgent("agent-C", 0.95)]);
    // 9 ticks exceeds DIP_MAX_TICKS=7 → RC tracking cancelled
    feedN(brain, makeSnapshot([makeAgent("agent-C", 0.65)]), 9);
    brain.observe(makeSnapshot([makeAgent("agent-C", 0.92)]));
    const decisions = brain.decide();
    assert.equal(
      decisions.filter((d) => d.type === "replayRequest").length, 0,
      "dip > DIP_MAX_TICKS should not trigger RC (AR territory, not brief dip)",
    );
  });

  test("AR scenario: rerouteSchema fires but replayRequest does NOT fire on recovery", () => {
    const brain = new RuleBrain();
    warmup(brain, [makeAgent("agent-C", 0.95)]); // threshold ~0.85
    // agent-C at 0.70 — below threshold (AR) AND in RC dip zone [0.40, 0.85).
    // 10 ticks → exceeds DIP_MAX_TICKS=7 (AR territory); rerouteSchema fires at the 2nd tick.
    const regression = makeSnapshot([makeAgent("agent-C", 0.70)]);
    const recovery   = makeSnapshot([makeAgent("agent-C", 0.92)]);
    const all = feedN(brain, regression, 10);
    brain.observe(recovery);
    all.push(...brain.decide());

    assert.ok(all.some((d) => d.type === "rerouteSchema"),
      "AR regression should still emit rerouteSchema");
    assert.equal(all.filter((d) => d.type === "replayRequest").length, 0,
      "prolonged AR regression should NOT also trigger replayRequest on recovery");
  });

  test("baseline quiet: production-noise binomial over 500 ticks fires nothing", () => {
    // Per-tick pass rates as binomial samples at PRODUCTION event counts.
    // 50 evt/s ÷ 4 agents × 5s window ≈ 62 events/agent → σ_rate ≈ 0.041 for
    // agent-B (p=0.88). A global 0.80 bar sat only ~1.9σ away (~2.6%/tick) and
    // fired spuriously; the per-agent threshold (baseline−0.10 ≈ 0.78) sits
    // >2σ below the agent's own mean, so quiet baseline stays quiet.
    // (Earlier this test used n=200 — 1.8× too lenient. 异议: test at prod counts.)
    const rng = seededRng(2025);
    const N_EVENTS = 62;
    const profiles = [
      { agentId: "agent-A", passRate: 0.95 },
      { agentId: "agent-B", passRate: 0.88 },
      { agentId: "agent-C", passRate: 0.95 },
      { agentId: "agent-D", passRate: 0.90 },
    ];

    function simRate(trueRate: number): number {
      let passes = 0;
      for (let i = 0; i < N_EVENTS; i++) if (rng() < trueRate) passes++;
      return passes / N_EVENTS;
    }

    const brain = new RuleBrain();
    const allDecisions: ReturnType<typeof brain.decide> = [];
    for (let tick = 0; tick < 500; tick++) {
      const agents = profiles.map((p) => makeAgent(p.agentId, simRate(p.passRate)));
      brain.observe(makeSnapshot(agents));
      allDecisions.push(...brain.decide());
    }
    // The actual 异议 finding was a spurious rerouteSchema on agent-B; assert BOTH.
    assert.equal(
      allDecisions.filter((d) => d.type === "rerouteSchema").length, 0,
      "production-noise baseline should not trigger rerouteSchema (agent-B 静穏 regression test)",
    );
    assert.equal(
      allDecisions.filter((d) => d.type === "replayRequest").length, 0,
      "production-noise baseline should not trigger replayRequest",
    );
  });
});
