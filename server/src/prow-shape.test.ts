import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { LensEvent } from "./lens.js";
import type { ProwBuild } from "./prow-import.js";
import { buildsToEvents } from "./prow-events.js";
import { quantiles, streamShape, windowShape } from "./prow-shape.js";

const T0 = Date.parse("2026-11-01T00:00:00Z");
const HOUR = 3_600_000;

/** A build of `n` cases, the listed ones failing, all stamped at its start. */
function build(i: number, n: number, failing: number[] = [], over: Partial<ProwBuild> = {}): ProwBuild {
  const start = T0 + i * HOUR;
  return {
    job: "ci-job",
    id: String(1000 + i),
    scheduledMs: start,
    startedMs: start,
    finishedMs: start + 20 * 60_000,
    result: failing.length > 0 ? "FAILURE" : "SUCCESS",
    commit: `c${Math.floor(i / 2)}`,
    files: [
      {
        file: "junit.xml",
        suites: [
          {
            name: "s",
            ts: start,
            cases: Array.from({ length: n }, (_, k) => ({ name: `t${k}`, classname: k % 2 === 0 ? "[sig-a] p" : "p", time: 1, status: failing.includes(k) ? ("failed" as const) : ("passed" as const) })),
          },
        ],
      },
    ],
    ...over,
  };
}

describe("quantiles", () => {
  it("is undefined for nothing and exact at the ends", () => {
    assert.equal(quantiles([]), undefined);
    assert.deepEqual(quantiles([5, 1, 3, 2, 4]), { n: 5, min: 1, p10: 1, median: 3, p90: 5, max: 5 });
  });
});

describe("streamShape", () => {
  it("counts the stream: results, units, failures per build, runs and commits", () => {
    const builds = [build(0, 10), build(1, 10, [3]), build(2, 10, [3, 4]), build(3, 10), build(4, 0, [], { result: "error" })];
    delete builds[3]!.commit;
    const { events, skipped } = buildsToEvents(builds);
    const s = streamShape(builds, events, skipped, [{ id: "9", scheduledMs: T0, reason: "x" }], 1);
    assert.equal(s.builds, 5);
    assert.equal(s.missingBuilds, 1);
    assert.deepEqual(s.buildResults, { SUCCESS: 2, FAILURE: 2, error: 1 });
    assert.deepEqual([s.events, s.pass, s.fail], [40, 37, 3]);
    assert.deepEqual([s.tests, s.areas, s.agents], [10, 2, 1]);
    assert.equal(s.unlabelled, 20);
    assert.equal(s.commits, 3, "c0, c1 and c2 (the build without a commit is not one)");
    assert.equal(s.buildsWithoutCommit, 1);
    assert.equal(s.buildsWithFailure, 2);
    assert.deepEqual([s.failuresPerFailingBuild?.min, s.failuresPerFailingBuild?.max], [1, 2]);
    assert.equal(s.failedBuildsWithoutFailedCase, 1, "the build that errored before writing any case");
    assert.deepEqual([s.testsEverFailed, s.testsFailedTwice], [2, 1]);
    assert.deepEqual([s.eventsPerBuild?.min, s.eventsPerBuild?.median], [0, 10]);
    assert.equal(s.startGapMinutes?.median, 60);
    assert.equal(s.buildMinutes?.median, 20);
    assert.deepEqual(s.eventsByHour.slice(0, 5), [10, 10, 10, 10, 0]);
  });
});

describe("windowShape", () => {
  const ev = (ts: number, value: number): LensEvent => ({ ts, value });
  /** `n` events in the window starting at `i` hours, the first `fails` of them failing. */
  const hour = (i: number, n: number, fails = 0): LensEvent[] => Array.from({ length: n }, (_, k) => ev(T0 + i * HOUR + k * 1000, k < fails ? 0 : 1));

  it("takes its shares over the whole grid, empty windows included", () => {
    // 24 one-hour windows; events in hours 0, 1, 2 (5 each) and hour 10 (2 events: not scorable).
    const events = [...hour(0, 5), ...hour(1, 5), ...hour(2, 5), ...hour(10, 2)];
    const w = windowShape(events, T0, T0 + 24 * HOUR, HOUR, 2);
    assert.equal(w.gridWindows, 24);
    assert.equal(w.nonEmpty, 4);
    assert.equal(w.scorable, 3);
    assert.equal(w.scorableAllPass, 3);
  });

  it("an all-pass reference is not usable — told apart from a thin one", () => {
    // hour 0: all pass. hour 1: all pass. hour 2: one failure. hour 3: all pass. hour 4: all pass.
    const events = [...hour(0, 5), ...hour(1, 5), ...hour(2, 5, 1), ...hour(3, 5), ...hour(4, 5)];
    const w = windowShape(events, T0, T0 + 5 * HOUR, HOUR, 2);
    assert.equal(w.scorable, 5);
    assert.equal(w.scorableWithFailure, 1);
    // hour 0: no reference at all → thin. hour 1: reference = hour 0 → all pass.
    // hour 2 (the failure): reference = hours 0-1 → all pass: the one window that matters has no yardstick.
    // hours 3 and 4: the reference holds hour 2's failure → usable.
    assert.equal(w.referenceThin, 1);
    assert.equal(w.referenceAllPass, 2);
    assert.equal(w.referenceUsable, 2);
    assert.equal(w.failureWithUsableReference, 0);
  });

  it("a longer reference reaches back to an earlier failure", () => {
    const events = [...hour(0, 5, 1), ...hour(1, 5), ...hour(2, 5), ...hour(3, 5, 1)];
    assert.equal(windowShape(events, T0, T0 + 4 * HOUR, HOUR, 2).failureWithUsableReference, 0);
    assert.equal(windowShape(events, T0, T0 + 4 * HOUR, HOUR, 3).failureWithUsableReference, 1);
  });

  it("counts only windows inside the range", () => {
    const events = [...hour(0, 5), ...hour(1, 5), ...hour(2, 5)];
    const w = windowShape(events, T0 + HOUR, T0 + 2 * HOUR, HOUR, 1);
    assert.equal(w.gridWindows, 1);
    assert.equal(w.scorable, 1);
    assert.equal(w.referenceAllPass, 1, "the reference may reach before the range");
  });
});
