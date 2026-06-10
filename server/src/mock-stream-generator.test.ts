/**
 * MockStreamGenerator determinism tests.
 *
 * Verifies that injecting seededRng produces identical event sequences across
 * runs, and that sleepFn injection lets scenario phases execute without real
 * wall-clock delays.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { MockStreamGenerator, seededRng, type ScenarioLogEntry } from "./mock-stream-generator.js";
import type { TestEvent } from "./mock-stream-generator.js";

// ── seededRng ─────────────────────────────────────────────────────────────────

describe("seededRng", () => {
  test("same seed produces same sequence", () => {
    const a = seededRng(42);
    const b = seededRng(42);
    for (let i = 0; i < 50; i++) {
      assert.equal(a(), b(), `diverged at index ${i}`);
    }
  });

  test("different seeds produce different sequences", () => {
    const a = seededRng(1);
    const b = seededRng(2);
    const seqA = Array.from({ length: 20 }, () => a());
    const seqB = Array.from({ length: 20 }, () => b());
    assert.ok(seqA.some((v, i) => v !== seqB[i]), "sequences should differ");
  });

  test("values are in [0, 1)", () => {
    const rng = seededRng(99);
    for (let i = 0; i < 200; i++) {
      const v = rng();
      assert.ok(v >= 0 && v < 1, `value ${v} out of range at index ${i}`);
    }
  });
});

// ── Deterministic event generation ───────────────────────────────────────────

describe("MockStreamGenerator — determinism with seededRng", () => {
  function collectTicks(seed: number, n: number): TestEvent[] {
    const events: TestEvent[] = [];
    const gen = new MockStreamGenerator({ rng: seededRng(seed) });
    gen.onEvent((e) => events.push(e));
    for (let i = 0; i < n; i++) gen.singleTick();
    return events;
  }

  test("same seed → identical event sequence (agentId, result, duration)", () => {
    const a = collectTicks(1234, 30);
    const b = collectTicks(1234, 30);
    assert.equal(a.length, 30);
    assert.equal(b.length, 30);
    for (let i = 0; i < a.length; i++) {
      assert.equal(a[i].agentId,  b[i].agentId,  `agentId mismatch at index ${i}`);
      assert.equal(a[i].result,   b[i].result,   `result mismatch at index ${i}`);
      assert.equal(a[i].duration, b[i].duration, `duration mismatch at index ${i}`);
      assert.deepEqual(a[i].areas, b[i].areas,   `areas mismatch at index ${i}`);
    }
  });

  test("different seeds → different sequences", () => {
    const a = collectTicks(1, 20);
    const b = collectTicks(2, 20);
    const sameAgent = a.every((e, i) => e.agentId === b[i].agentId);
    assert.ok(!sameAgent, "different seeds should produce different agent selections");
  });

  test("singleTick emits exactly one event per call", () => {
    const events: TestEvent[] = [];
    const gen = new MockStreamGenerator({ rng: seededRng(7) });
    gen.onEvent((e) => events.push(e));
    gen.singleTick();
    assert.equal(events.length, 1);
    gen.singleTick();
    assert.equal(events.length, 2);
  });

  test("all emitted agentIds are valid", () => {
    const valid = new Set(["agent-A", "agent-B", "agent-C", "agent-D"]);
    const events = collectTicks(5, 40);
    for (const e of events) {
      assert.ok(valid.has(e.agentId), `unknown agentId: ${e.agentId}`);
    }
  });
});

// ── sleepFn injection (scenario phases run without real timers) ───────────────

describe("MockStreamGenerator — sleepFn injection for scenarios", () => {
  const instant: (ms: number) => Promise<void> = () => Promise.resolve();

  test("RC scenario records all four log phases with instant sleepFn", async () => {
    const gen = new MockStreamGenerator({
      rng: seededRng(42),
      sleepFn: instant,
    });
    // Start a background event pump so the generator isn't idle
    gen.start({ rate: 1000, timingScale: 0 });
    await gen.runScenario("RC");
    gen.stop();

    const log = gen.getScenarioLog();
    const phases = log.map((e) => e.phase);
    assert.ok(phases.includes("baseline"),     "should log baseline phase");
    assert.ok(phases.includes("burst_start"),  "should log burst_start phase");
    assert.ok(phases.includes("burst_end"),    "should log burst_end phase");
    assert.ok(phases.includes("scenario_end"), "should log scenario_end phase");
  });

  test("RC scenario log records correct passRate at burst_start (0.20)", async () => {
    const gen = new MockStreamGenerator({ sleepFn: instant });
    await gen.runScenario("RC");
    const entry = gen.getScenarioLog().find((e) => e.phase === "burst_start");
    assert.ok(entry, "burst_start entry should exist");
    assert.equal(entry!.passRate, 0.20);
  });

  test("AR scenario completes without hanging (instant sleepFn)", async () => {
    const gen = new MockStreamGenerator({ sleepFn: instant });
    const before = Date.now();
    await gen.runScenario("AR");
    const elapsed = Date.now() - before;
    assert.ok(elapsed < 500, `AR scenario should complete in <500ms with instant sleepFn (took ${elapsed}ms)`);
  });

  test("CG scenario completes without hanging (instant sleepFn)", async () => {
    const gen = new MockStreamGenerator({ sleepFn: instant });
    const before = Date.now();
    await gen.runScenario("CG");
    const elapsed = Date.now() - before;
    assert.ok(elapsed < 500, `CG scenario should complete in <500ms with instant sleepFn (took ${elapsed}ms)`);
  });
});

// ── Agent profile under scenario override ────────────────────────────────────

describe("MockStreamGenerator — profile overrides during scenarios", () => {
  test("agent-C events during AR burst skew toward fail", async () => {
    const instant: (ms: number) => Promise<void> = () => Promise.resolve();
    const gen = new MockStreamGenerator({ rng: seededRng(100), sleepFn: instant });

    const eventsBeforeBurst: TestEvent[] = [];
    const eventsDuringBurst: TestEvent[] = [];

    // Phase 1: collect baseline ticks before scenario modifies profile
    gen.onEvent((e) => { if (e.agentId === "agent-C") eventsBeforeBurst.push(e); });
    for (let i = 0; i < 200; i++) gen.singleTick();

    // Phase 2: manually override profile to simulate burst (AR scenario does this internally)
    gen.setAgentProfile("agent-C", { passRate: 0.20, flakyRate: 0.01, areasPerTest: { min: 2, max: 6 } });
    gen.onEvent((e) => { if (e.agentId === "agent-C") eventsDuringBurst.push(e); });
    // reset baseline listener
    const allEvents: TestEvent[] = [];
    gen.onEvent((e) => allEvents.push(e));
    for (let i = 0; i < 200; i++) gen.singleTick();

    const cDuring = eventsDuringBurst.filter((e) => e.agentId === "agent-C");
    if (cDuring.length >= 5) {
      const passRateDuring = cDuring.filter((e) => e.result === "pass").length / cDuring.length;
      // With passRate=0.20 and seeded rng, pass rate should be well below baseline ~0.95
      assert.ok(passRateDuring < 0.60,
        `burst passRate should be low (got ${passRateDuring.toFixed(2)})`);
    }
  });
});
