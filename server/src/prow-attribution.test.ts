import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyAttribution, replayCoarseThenRegroup } from "./prow-attribution.js";
import { prowLensEvent, type ProwEvent } from "./prow-events.js";
import { TEST_STREAM_WIRING } from "./prow-replay.js";

const T0 = Date.parse("2026-11-01T00:00:00Z");
const HOUR = 3_600_000;
const JOBS = ["ci-unit", "ci-integration", "ci-e2e"];

/** 45 hourly runs of 150 tests per job; background 1 failure every 3 hours per job; `drops` adds failures in one hour of one job. */
function stream(drops: Array<{ hour: number; job: string; fails: number }>): ProwEvent[] {
  const events: ProwEvent[] = [];
  for (let h = 0; h < 45; h++) {
    for (const job of JOBS) {
      const extra = drops.find((d) => d.hour === h && d.job === job)?.fails;
      const fails = extra ?? (h % 3 === 0 ? 1 : 0);
      for (let k = 0; k < 150; k++) {
        events.push({
          $schema: "test_result:v1", ts: T0 + h * HOUR + k * 10, testId: `${job}::t${k}`, agentId: job, areas: [],
          result: k < fails ? "fail" : "pass", duration: 1, weight: 1, commitHash: `c${h}`, area: "sig-x", buildId: `${job}-${h}`,
        });
      }
    }
  }
  return events.sort((a, b) => a.ts - b.ts);
}

describe("classifyAttribution (ROADMAP C28 rules)", () => {
  const truth = new Set(["a", "b"]);
  it("reads named groups against the true ones", () => {
    assert.equal(classifyAttribution([], truth), "none");
    assert.equal(classifyAttribution(["a", "b"], truth), "exact");
    assert.equal(classifyAttribution(["a"], truth), "partial");
    assert.equal(classifyAttribution(["a", "c"], truth), "extra");
    assert.equal(classifyAttribution(["a", "b", "c"], truth), "extra");
    assert.equal(classifyAttribution(["c"], truth), "wrong");
    assert.equal(classifyAttribution(["a"], new Set(["a"])), "exact");
  });
});

describe("replayCoarseThenRegroup (ROADMAP C28)", () => {
  for (const job of JOBS) {
    it(`names the job that dropped (${job}), and only it`, () => {
      const events = stream([{ hour: 40, job, fails: 15 }]).map(prowLensEvent);
      const fires = replayCoarseThenRegroup(events, T0, T0 + 45 * HOUR, TEST_STREAM_WIRING);
      const at40 = fires.filter((f) => f.windowStart === T0 + 40 * HOUR);
      assert.equal(at40.length, 1, "the window fires once");
      assert.equal(at40[0]!.blind, false);
      assert.deepEqual(at40[0]!.groups, [job]);
      assert.equal(classifyAttribution(at40[0]!.groups, new Set([job])), "exact");
    });
  }

  it("names both jobs when two drop in the same window", () => {
    const events = stream([{ hour: 40, job: "ci-unit", fails: 15 }, { hour: 40, job: "ci-e2e", fails: 15 }]).map(prowLensEvent);
    const fires = replayCoarseThenRegroup(events, T0, T0 + 45 * HOUR, TEST_STREAM_WIRING);
    const at40 = fires.find((f) => f.windowStart === T0 + 40 * HOUR)!;
    assert.deepEqual(at40.groups, ["ci-e2e", "ci-unit"]);
  });

  it("refuses a grouped wiring (the coarse view is the combined one)", () => {
    assert.throws(() => replayCoarseThenRegroup([], T0, T0 + HOUR, { ...TEST_STREAM_WIRING, groupBy: ["agentId"] }), RangeError);
  });
});
