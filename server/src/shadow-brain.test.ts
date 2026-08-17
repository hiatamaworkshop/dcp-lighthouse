/**
 * ShadowBrain tests (ROADMAP L3).
 *
 * The property under test is containment: the shadow sees everything and
 * changes nothing, including when it is broken.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ShadowBrain } from "./shadow-brain.js";
import type { BrainAdapter, BrainDecision } from "./brain-adapter.js";
import type { STSnapshot } from "./testor-adapter.js";

function snap(ts: number): STSnapshot {
  return {
    ts,
    agents: [{ agentId: "agent-C", passRate: 0.7, flakyRate: 0.01, eventCount: 20 }],
    domains: [{ domain: "auth", coveredBits: 24, requiredBits: 32, gap: 8 }],
    touchedBitsThisTick: [],
  };
}

/** A Brain that emits whatever it is told to, and records what it saw. */
class StubBrain implements BrainAdapter {
  seen: number[] = [];
  queued: BrainDecision[] = [];
  resetCalls = 0;
  constructor(private readonly name: string) {}
  observe(s: STSnapshot): void { this.seen.push(s.ts); }
  decide(): BrainDecision[] { const out = this.queued; this.queued = []; return out; }
  describe(): string { return this.name; }
  reset(): void { this.resetCalls++; }
}

class ExplodingBrain implements BrainAdapter {
  observe(): void { throw new Error("shadow observe blew up"); }
  decide(): BrainDecision[] { throw new Error("shadow decide blew up"); }
  describe(): string { return "ExplodingBrain"; }
}

const reroute = (agentId: string): BrainDecision => ({
  type: "rerouteSchema",
  reason: `${agentId} regressed`,
  meta: { agentId },
});

describe("ShadowBrain — containment", () => {
  test("both brains see every snapshot", () => {
    const primary = new StubBrain("primary");
    const shadow = new StubBrain("shadow");
    const sb = new ShadowBrain(primary, shadow);

    sb.observe(snap(1000));
    sb.observe(snap(2000));

    assert.deepEqual(primary.seen, [1000, 2000]);
    assert.deepEqual(shadow.seen, [1000, 2000]);
  });

  test("ONLY the primary's decisions are returned", () => {
    const primary = new StubBrain("primary");
    const shadow = new StubBrain("shadow");
    const sb = new ShadowBrain(primary, shadow);

    primary.queued = [reroute("agent-C")];
    shadow.queued = [reroute("agent-A"), { type: "quarantine", reason: "flaky", meta: { agentId: "agent-D" } }];

    sb.observe(snap(1000));
    const out = sb.decide();

    assert.equal(out.length, 1);
    assert.equal((out[0].meta as { agentId: string }).agentId, "agent-C");
  });

  test("the shadow's decisions are still drained, so its queue cannot grow forever", () => {
    const primary = new StubBrain("primary");
    const shadow = new StubBrain("shadow");
    const sb = new ShadowBrain(primary, shadow);

    shadow.queued = [reroute("agent-A")];
    sb.observe(snap(1000));
    sb.decide();

    assert.equal(shadow.queued.length, 0, "shadow.decide() must be called even though its output is discarded");
    assert.equal(sb.getLog().filter((e) => e.source === "shadow").length, 1);
  });

  test("a shadow that throws does not break the tick", () => {
    const primary = new StubBrain("primary");
    const errors: Error[] = [];
    const sb = new ShadowBrain(primary, new ExplodingBrain(), { onShadowError: (e) => errors.push(e) });

    primary.queued = [reroute("agent-C")];
    assert.doesNotThrow(() => sb.observe(snap(1000)));
    const out = assertNoThrowReturning(() => sb.decide());

    assert.equal(out.length, 1, "the primary's decision must survive the shadow failing");
    assert.equal(sb.getSummary().shadowErrors, 2, "one from observe, one from decide");
    assert.equal(errors.length, 2, "a dead shadow must be reported, not mistaken for an agreeing one");
  });

  test("reset reaches both brains", () => {
    const primary = new StubBrain("primary");
    const shadow = new StubBrain("shadow");
    const sb = new ShadowBrain(primary, shadow);

    primary.queued = [reroute("agent-C")];
    sb.observe(snap(1000));
    sb.decide();
    assert.equal(sb.getLog().length, 1);

    sb.reset();
    assert.equal(sb.getLog().length, 0);
    assert.equal(primary.resetCalls, 1);
    assert.equal(shadow.resetCalls, 1);
  });

  test("reset tolerates a Brain with no reset() — it is not on the interface", () => {
    const sb = new ShadowBrain(new StubBrain("primary"), {
      observe() {}, decide() { return []; }, describe() { return "minimal"; },
    });
    assert.doesNotThrow(() => sb.reset());
  });
});

describe("ShadowBrain — the record", () => {
  test("summarises both sides by decision type and subject", () => {
    const primary = new StubBrain("primary");
    const shadow = new StubBrain("shadow");
    const sb = new ShadowBrain(primary, shadow);

    primary.queued = [reroute("agent-C")];
    shadow.queued = [reroute("agent-C"), { type: "schemaUpdate", reason: "auth gap", meta: { domain: "auth" } }];
    sb.observe(snap(1000));
    sb.decide();

    const s = sb.getSummary();
    assert.deepEqual(s.primary, { rerouteSchema: 1 });
    assert.deepEqual(s.shadow, { rerouteSchema: 1, schemaUpdate: 1 });
    assert.deepEqual(s.primarySubjects, ["rerouteSchema:agent-C"]);
    assert.deepEqual(s.shadowSubjects, ["rerouteSchema:agent-C", "schemaUpdate:auth"]);
  });

  test("entries carry the tick they were drained on", () => {
    const primary = new StubBrain("primary");
    const sb = new ShadowBrain(primary, new StubBrain("shadow"));

    sb.observe(snap(1000));
    sb.decide();
    primary.queued = [reroute("agent-C")];
    sb.observe(snap(7000));
    sb.decide();

    assert.equal(sb.getLog()[0].ts, 7000);
  });

  test("the log is bounded", () => {
    const primary = new StubBrain("primary");
    const sb = new ShadowBrain(primary, new StubBrain("shadow"), { maxEntries: 3 });

    for (let i = 0; i < 10; i++) {
      primary.queued = [reroute(`agent-${i}`)];
      sb.observe(snap(1000 * i));
      sb.decide();
    }
    assert.equal(sb.getLog().length, 3);
    assert.equal((sb.getLog().at(-1)!.decision.meta as { agentId: string }).agentId, "agent-9");
  });

  test("seq keeps increasing across a trim, so a tailing reader does not go silent", () => {
    // index.ts prints shadow decisions by tailing this log. An index-based
    // cursor breaks the moment trimming starts: entries leave the front while
    // new ones arrive at the back, so length stops growing and the reader
    // silently stops printing. seq is monotonic and never reused.
    const primary = new StubBrain("primary");
    const sb = new ShadowBrain(primary, new StubBrain("shadow"), { maxEntries: 3 });

    const seen: number[] = [];
    let cursor = -1;
    for (let i = 0; i < 10; i++) {
      primary.queued = [reroute(`agent-${i}`)];
      sb.observe(snap(1000 * i));
      sb.decide();
      for (const e of sb.getLog()) {
        if (e.seq > cursor) seen.push(e.seq);
      }
      cursor = sb.getLog().at(-1)!.seq;
    }

    assert.deepEqual(seen, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      "every entry should be seen exactly once despite the log trimming under the reader");
  });

  test("describe() names both sides", () => {
    const sb = new ShadowBrain(new StubBrain("RuleBrain v1"), new StubBrain("ClaudeBrain"));
    assert.equal(sb.describe(), "ShadowBrain(primary=RuleBrain v1, shadow=ClaudeBrain)");
  });
});

function assertNoThrowReturning<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    assert.fail(`should not have thrown: ${err instanceof Error ? err.message : String(err)}`);
  }
}
