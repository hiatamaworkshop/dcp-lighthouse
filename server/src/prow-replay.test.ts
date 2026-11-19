import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { LensEvent } from "./lens.js";
import { SHIPPED_WIRING, replayThroughShippedWiring, type ReplayWiring } from "./prow-replay.js";

const T0 = Date.parse("2026-11-01T00:00:00Z");
const HOUR = 3_600_000;

/** One run per hour: `n` events at the start of hour `i`, the first `fails` failing. */
function run(i: number, n: number, fails = 0): LensEvent[] {
  return Array.from({ length: n }, (_, k) => ({ ts: T0 + i * HOUR + k * 100, value: k < fails ? 0 : 1 }));
}

const hourly = (over: Partial<ReplayWiring> = {}): ReplayWiring => ({
  name: "test-1h",
  windowMs: HOUR,
  liveWindows: 3,
  referenceWindows: 10,
  retentionMs: 14 * HOUR,
  historyMs: SHIPPED_WIRING.historyMs,
  ...over,
});

describe("replayThroughShippedWiring", () => {
  it("is blind, not quiet, when the stream before a failure held none", () => {
    // 24 hourly runs of 200, all passing, except one failure in hour 20.
    const events = Array.from({ length: 24 }, (_, i) => run(i, 200, i === 20 ? 1 : 0)).flat();
    const t = replayThroughShippedWiring(events, T0, T0 + 24 * HOUR, hourly());
    assert.equal(t.errors, 0, t.firstError);
    assert.equal(t.evaluations, 22, "boundaries from hour 3 to hour 24");
    assert.equal(t.empty, 0);
    assert.equal(t.failingWindows, 1);
    // Hour 20 is observed at boundaries 21, 22, 23: each time the reference before it is all-pass.
    assert.equal(t.blindWithFailure, 3);
    assert.equal(t.failingWindowsOnlyBlind, 1, "the one failure was never inside a scored package");
    assert.equal(t.failingWindowsFlagged, 0);
    // Once the failure is in the reference (boundary 24: observes 21-23, reference 11-20) the package scores.
    assert.equal(t.scored, 1);
    assert.deepEqual(t.allPass, { n: 1, alarmed: 0 });
  });

  it("scores against a reference that holds failures: quiet on its usual rate, alarmed by a run that breaks", () => {
    // Background: every run of 200 has 2 failures (1%). Hour 30: 60 of 200 fail.
    const events = Array.from({ length: 36 }, (_, i) => run(i, 200, i === 30 ? 60 : 2)).flat();
    const t = replayThroughShippedWiring(events, T0, T0 + 36 * HOUR, hourly());
    assert.equal(t.errors, 0, t.firstError);
    assert.equal(t.allPass.n, 0, "every observed span holds a failure");
    assert.ok(t.blind <= 1, `only the first boundary can lack a reference (blind ${t.blind})`);
    // Hour 30 sits in three observed spans (boundaries 31, 32, 33); each must alarm downward.
    assert.ok(t.withFailure.down >= 3, `the broken run alarms every time it is observed (down ${t.withFailure.down})`);
    // The usual 1% does not: packages that never saw hour 30 stay quiet. Hours 31-35 score against a
    // reference holding hour 30, where a spike is a fair reading — so only the downward count is bounded.
    assert.ok(t.withFailure.down <= 4, `the usual rate is not a dip (down ${t.withFailure.down})`);
    assert.equal(t.failingWindows, 36);
    const three = t.failingByCount.find((b) => b.failures === "3+")!;
    assert.deepEqual({ n: three.n, flagged: three.flagged }, { n: 1, flagged: 1 }, "the tile covers the broken window itself");
    const two = t.failingByCount.find((b) => b.failures === "2")!;
    assert.equal(two.n, 35);
    assert.ok(two.flagged <= 1, `a usual window is not covered (${two.flagged})`);
  });

  it("does not ask about a span that held no event", () => {
    // Runs only in hours 0-5 and 20-23.
    const events = [...Array.from({ length: 6 }, (_, i) => run(i, 50, 1)).flat(), ...Array.from({ length: 4 }, (_, i) => run(20 + i, 50, 1)).flat()];
    const t = replayThroughShippedWiring(events, T0, T0 + 24 * HOUR, hourly());
    // Observed spans [t-3h, t): empty for boundaries 9..20 (hours 6-19 hold nothing).
    assert.equal(t.empty, 12);
    assert.equal(t.evaluations, 22);
    assert.equal(t.blind + t.scored + t.errors, 10);
  });

  it("as shipped (10 s windows, 2 min of freshness, thinned reference) a failure after an all-pass stretch is never scored", () => {
    // One run per hour whose 300 events all share an instant, as an e2e build's do.
    const events = Array.from({ length: 6 }, (_, i) => Array.from({ length: 300 }, (_, k) => ({ ts: T0 + i * HOUR + 5_000, value: i === 4 && k === 0 ? 0 : 1 }))).flat();
    const t = replayThroughShippedWiring(events, T0, T0 + 6 * HOUR, {
      name: "shipped-10s",
      windowMs: 10_000,
      liveWindows: SHIPPED_WIRING.liveWindows,
      retentionMs: SHIPPED_WIRING.retentionMs,
      referenceZoneMs: SHIPPED_WIRING.referenceZoneMs,
      thinningRatio: SHIPPED_WIRING.thinningRatio,
      historyMs: SHIPPED_WIRING.historyMs,
    });
    assert.equal(t.errors, 0, t.firstError);
    assert.equal(t.scored, 0, "the 30 s before each run are empty: there is never a reference");
    assert.equal(t.blind, 16, "each run is observed at 3 boundaries (the first run at 1: the range starts with it)");
    assert.equal(t.failingWindowsOnlyBlind, 1);
  });
});

describe("failure counts through the replay (ROADMAP C19)", () => {
  /** An hourly run of 200 tests; hour 20 drops 12 at once, hour 25 drops 3. */
  const events = Array.from({ length: 36 }, (_, i) => run(i, 200, i === 20 ? 12 : i === 25 ? 3 : i % 3 === 0 ? 1 : 0)).flat();
  const base = hourly({ referenceWindows: 10, retentionMs: 14 * HOUR });

  it("names exactly the windows the events say hold at least burstAt failures", () => {
    const t = replayThroughShippedWiring(events, T0, T0 + 36 * HOUR, { ...base, failureCount: 10 });
    assert.equal(t.errors, 0, t.firstError);
    const b = t.bursts!;
    assert.deepEqual([...b.inEvents], [[T0 + 20 * HOUR, 12]]);
    assert.deepEqual([...b.claimed], [[T0 + 20 * HOUR, 12]]);
    assert.equal(b.missed, 0);
    assert.equal(b.disagreed, 0);
  });

  it("counts and nothing else: every number of the replay is the one without the option", () => {
    const off = replayThroughShippedWiring(events, T0, T0 + 36 * HOUR, base);
    const on = replayThroughShippedWiring(events, T0, T0 + 36 * HOUR, { ...base, failureCount: 10 });
    assert.equal(off.bursts, undefined);
    const { bursts, wiring, ...restOn } = on;
    const { wiring: _w, ...restOff } = off;
    assert.ok(bursts !== undefined && wiring.failureCount === 10);
    assert.deepEqual(restOn, restOff);
  });
});
