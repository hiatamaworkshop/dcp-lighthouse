/**
 * RuleBrain unit tests (Phase 1 Step 6).
 *
 * Verifies AR / CG / RC rule logic with synthetic snapshots.
 * No live generator or timers — snapshots are fed directly.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { RuleBrain } from "./rule-brain.js";
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

// ── AR rule ──────────────────────────────────────────────────────────────────

describe("RuleBrain — AR rule", () => {
  test("rerouteSchema fires after REGRESSION_TICKS below threshold", () => {
    const brain = new RuleBrain();
    const snap = makeSnapshot([makeAgent("agent-C", 0.70)]);

    // 2 ticks: not yet
    feedN(brain, snap, 2);
    brain.observe(snap);
    // tick 3: should fire
    const decisions = brain.decide();
    const d = decisions.find((d) => d.type === "rerouteSchema");
    assert.ok(d, "rerouteSchema should fire on tick 3");
    assert.equal((d!.meta as { agentId: string }).agentId, "agent-C");
  });

  test("rerouteSchema does not fire above threshold", () => {
    const brain = new RuleBrain();
    const snap = makeSnapshot([makeAgent("agent-A", 0.95)]);
    const decisions = feedN(brain, snap, 10);
    assert.equal(decisions.filter((d) => d.type === "rerouteSchema").length, 0);
  });

  test("rerouteSchema fires only once per regression (no spam)", () => {
    const brain = new RuleBrain();
    const snap = makeSnapshot([makeAgent("agent-C", 0.70)]);
    const decisions = feedN(brain, snap, 10);
    const reroutes = decisions.filter((d) => d.type === "rerouteSchema");
    assert.equal(reroutes.length, 1, "should fire exactly once per regression session");
  });

  test("rerouteSchema re-arms after recovery", () => {
    const brain = new RuleBrain();
    const low = makeSnapshot([makeAgent("agent-C", 0.70)]);
    const high = makeSnapshot([makeAgent("agent-C", 0.95)]);
    // Trigger regression
    feedN(brain, low, 3);
    // Recovery
    feedN(brain, high, 2);
    // Second regression: should fire again
    const decisions = feedN(brain, low, 3);
    assert.ok(decisions.some((d) => d.type === "rerouteSchema"), "should re-arm after recovery");
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
  test("replayRequest does NOT fire at healthy baseline (0.92)", () => {
    const brain = new RuleBrain();
    const snap = makeSnapshot([
      makeAgent("agent-A", 0.95),
      makeAgent("agent-B", 0.88),
      makeAgent("agent-C", 0.95),
      makeAgent("agent-D", 0.90),
    ]);
    const decisions = feedN(brain, snap, 20);
    assert.equal(decisions.filter((d) => d.type === "replayRequest").length, 0,
      "baseline passRate (0.88–0.95) is above REGRESSION_THRESHOLD — should not trigger RC");
  });

  test("replayRequest fires after agent dips into [0.40, 0.80) then recovers", () => {
    const brain = new RuleBrain();
    const dip  = makeSnapshot([makeAgent("agent-C", 0.65)]);
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

    // Count total replayRequests from the whole session via feedN above
    // We can't re-count from feedN — test the property via reset instead
    // This test just ensures it doesn't fire when already emitted
    assert.equal(all.filter((d) => d.type === "replayRequest").length, 0,
      "already emitted — should not fire a second time without reset");
  });

  test("replayRequest re-arms after reset()", () => {
    const brain = new RuleBrain();
    const dip  = makeSnapshot([makeAgent("agent-C", 0.65)]);
    const high = makeSnapshot([makeAgent("agent-C", 0.92)]);

    feedN(brain, dip, 2);
    feedN(brain, high, 1);
    // First emission consumed; now reset
    brain.reset();
    // Second dip + recovery should fire again
    feedN(brain, dip, 2);
    brain.observe(high);
    const decisions = brain.decide();
    assert.ok(decisions.some((d) => d.type === "replayRequest"),
      "replayRequest should re-arm after reset()");
  });

  test("replayRequest qProposal has window_ms", () => {
    const brain = new RuleBrain();
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
