/**
 * TestorAdapter unit tests (Phase 1 Step 4).
 *
 * Focus: the clock policy added in ROADMAP_BRIEF L1-1 (field finding
 * A3) — a snapshot must never include events dated after the adapter's own
 * clock, since a source's ts can run ahead of receive time (skew, replay).
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { TestorAdapter, testEventExtractor } from "./testor-adapter.js";
import { RetentionBuffer } from "./retention-buffer.js";
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

describe("testEventExtractor — group keys (ROADMAP L4)", () => {
  test("attaches the axes a group_by lens can name", () => {
    const ev = testEventExtractor(makeEvent(1000, "agent-C", "fail"), "test_result:v1");
    assert.equal(ev?.value, 0);
    assert.equal(ev?.keys?.agentId, "agent-C");
    // areas [0] is in the auth range (bits 0–31).
    assert.equal(ev?.keys?.domain, "auth");
  });

  test("files an event by the domain holding most of its area bits", () => {
    // bits 64+ are ui; the single auth bit must not win a 1-vs-3 majority.
    const raw = { ...makeEvent(1000), areas: [0, 64, 65, 66] };
    assert.equal(testEventExtractor(raw, "test_result:v1")?.keys?.domain, "ui");
  });

  test("is the path a grouped replay actually reads keys through", () => {
    // End-to-end for the wiring rather than the extractor alone: the same
    // events index.ts feeds the retention buffer must come back out split by
    // agent when $Q asks for it. A key dropped anywhere in this path would
    // collapse every event into the unkeyed group and read as "one agent".
    const buffer = new RetentionBuffer<TestEvent>(testEventExtractor, { retentionWindowMs: 60_000 });
    for (let i = 0; i < 12; i++) {
      buffer.observe(makeEvent(1000 + i * 100, i % 2 === 0 ? "agent-A" : "agent-C"), "test_result:v1");
    }
    const result = buffer.replay({ window_ms: 1000, align: "epoch", group_by: ["agentId"] });
    assert.deepEqual(result.groups?.map((g) => g.label), ["agent-A", "agent-C"]);
    assert.equal(result.groups?.[0].windows.reduce((s, w) => s + w.count, 0), 6);
  });
});
