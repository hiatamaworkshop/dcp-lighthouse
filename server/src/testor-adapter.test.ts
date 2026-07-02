/**
 * TestorAdapter unit tests (Phase 1 Step 4).
 *
 * Focus: the clock policy added in ROADMAP_BRIEF L1-1 (traders field finding
 * A3) — a snapshot must never include events dated after the adapter's own
 * clock, since a source's ts can run ahead of receive time (skew, replay).
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { TestorAdapter } from "./testor-adapter.js";
import type { TestEvent } from "./mock-stream-generator.js";

function makeEvent(ts: number, agentId = "agent-A", result: TestEvent["result"] = "pass"): TestEvent {
  return {
    $schema: "test_result:v1",
    ts,
    testId: `t-${ts}`,
    agentId,
    areas: [0],
    result,
    duration: 10,
    weight: 1,
    commitHash: "abc123",
  };
}

describe("TestorAdapter — clock policy (ROADMAP L1-1)", () => {
  test("excludes events with ts in the future relative to the adapter's clock", () => {
    let now = 10_000;
    const adapter = new TestorAdapter({ windowMs: 5000, clockFn: () => now });

    adapter.push(makeEvent(9_000)); // in-window, normal
    adapter.push(makeEvent(50_000)); // far in the future (e.g. clock skew)

    const snap = adapter.snapshot();
    const agent = snap.agents.find((a) => a.agentId === "agent-A");
    assert.ok(agent);
    assert.equal(agent!.eventCount, 1, "the future-dated event must not be counted in the snapshot");
  });

  test("includes an event exactly at ts===now", () => {
    let now = 10_000;
    const adapter = new TestorAdapter({ windowMs: 5000, clockFn: () => now });
    adapter.push(makeEvent(10_000));

    const snap = adapter.snapshot();
    const agent = snap.agents.find((a) => a.agentId === "agent-A");
    assert.ok(agent);
    assert.equal(agent!.eventCount, 1);
  });

  test("a future event stops excluding itself once the clock catches up", () => {
    let now = 10_000;
    const adapter = new TestorAdapter({ windowMs: 5000, clockFn: () => now });
    adapter.push(makeEvent(12_000)); // future relative to now=10_000

    let snap = adapter.snapshot();
    assert.equal(snap.agents.find((a) => a.agentId === "agent-A")?.eventCount ?? 0, 0);

    now = 12_000; // clock catches up
    snap = adapter.snapshot();
    assert.equal(snap.agents.find((a) => a.agentId === "agent-A")?.eventCount, 1);
  });
});
