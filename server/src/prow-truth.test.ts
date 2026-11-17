import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ProwBuild } from "./prow-import.js";
import { deriveEpisodes, failureClassIndex, failureKey } from "./prow-truth.js";

const T0 = Date.parse("2026-11-01T00:00:00Z");
const HOUR = 3_600_000;

type Status = "passed" | "failed" | "skipped";

/** Build `i` of a job on a commit; `cases` maps a test name to its status (or several, for a test with several cases). */
function build(i: number, commit: string | undefined, cases: Record<string, Status | Status[]>, job = "ci-job"): ProwBuild {
  const b: ProwBuild = {
    job,
    id: String(1000 + i),
    scheduledMs: T0 + i * HOUR,
    startedMs: T0 + i * HOUR,
    finishedMs: T0 + i * HOUR + 600_000,
    result: "SUCCESS",
    files: [
      {
        file: "junit.xml",
        suites: [
          {
            name: "s",
            ts: T0 + i * HOUR,
            cases: Object.entries(cases).flatMap(([name, st]) => (Array.isArray(st) ? st : [st]).map((status) => ({ name, classname: "c", time: 1, status }))),
          },
        ],
      },
    ],
  };
  if (commit !== undefined) b.commit = commit;
  return b;
}

const one = (builds: ProwBuild[], test: string) => deriveEpisodes(builds).filter((e) => e.testId === `c::${test}`);

describe("deriveEpisodes — the rules fixed on 2026-11-17", () => {
  it("regression: failed in 2 or more consecutive builds and never passed on those commits", () => {
    const builds = [
      build(0, "a", { t: "passed" }),
      build(1, "b", { t: "failed" }),
      build(2, "b", { t: "failed" }),
      build(3, "c", { t: "failed" }),
      build(4, "d", { t: "passed" }),
    ];
    const eps = one(builds, "t");
    assert.equal(eps.length, 1);
    const e = eps[0]!;
    assert.equal(e.class, "regression");
    assert.deepEqual(e.buildIds, ["1001", "1002", "1003"]);
    assert.deepEqual(e.commits, ["b", "c"]);
    assert.deepEqual([e.split, e.open, e.fromStart], [false, false, false]);
    assert.deepEqual([e.firstMs, e.lastMs], [T0 + HOUR, T0 + 3 * HOUR]);
  });

  it("flaky: the same commit also passed it — before, after, or between, at any episode length", () => {
    // Same commit passes after a single failure.
    assert.equal(one([build(0, "a", { t: "failed" }), build(1, "a", { t: "passed" })], "t")[0]!.class, "flaky");
    // Same commit passed BEFORE the failure.
    assert.equal(one([build(0, "a", { t: "passed" }), build(1, "a", { t: "failed" }), build(2, "b", { t: "passed" })], "t")[0]!.class, "flaky");
    // Two consecutive failures, but one of their commits passes later: still flaky, not a regression.
    const two = one([build(0, "a", { t: "failed" }), build(1, "b", { t: "failed" }), build(2, "b", { t: "passed" })], "t");
    assert.equal(two.length, 1);
    assert.deepEqual([two[0]!.class, two[0]!.buildIds.length, two[0]!.split], ["flaky", 2, true]);
    // A pass on a DIFFERENT commit is not a split.
    assert.equal(one([build(0, "a", { t: "failed" }), build(1, "b", { t: "passed" })], "t")[0]!.class, "isolated");
  });

  it("flaky: another case of the same test passed in the failing build itself", () => {
    const eps = one([build(0, "a", { t: ["failed", "passed"] }), build(1, "b", { t: "passed" })], "t");
    assert.deepEqual([eps[0]!.class, eps[0]!.split], ["flaky", true]);
  });

  it("isolated: one failing build whose commit never ran the test again — the record cannot say", () => {
    const eps = one([build(0, "a", { t: "passed" }), build(1, "b", { t: "failed" }), build(2, "c", { t: "passed" })], "t");
    assert.deepEqual([eps[0]!.class, eps[0]!.buildIds.length, eps[0]!.split], ["isolated", 1, false]);
  });

  it("steps over builds where the test is absent or skipped: they neither extend nor end an episode", () => {
    const builds = [
      build(0, "a", { t: "passed", u: "passed" }),
      build(1, "b", { t: "failed", u: "passed" }),
      build(2, "c", { u: "passed" }), // t not run
      build(3, "d", { t: "skipped", u: "passed" }),
      build(4, "e", { t: "failed", u: "passed" }),
      build(5, "f", { t: "passed", u: "passed" }),
    ];
    const eps = one(builds, "t");
    assert.equal(eps.length, 1, "the two failures are consecutive among the builds that ran the test");
    assert.deepEqual([eps[0]!.class, eps[0]!.buildIds], ["regression", ["1001", "1004"]]);
    assert.equal(one(builds, "u").length, 0);
  });

  it("a build without a stated commit cannot show a split by commit", () => {
    const eps = one([build(0, undefined, { t: "failed" }), build(1, undefined, { t: "passed" })], "t");
    assert.deepEqual([eps[0]!.class, eps[0]!.commits], ["isolated", []]);
  });

  it("marks an episode still failing at the last build, and one already failing at the first", () => {
    const eps = one([build(0, "a", { t: "failed" }), build(1, "b", { t: "passed" }), build(2, "c", { t: "failed" }), build(3, "d", { t: "failed" })], "t");
    assert.deepEqual(eps.map((e) => [e.class, e.fromStart, e.open]), [["isolated", true, false], ["regression", false, true]]);
  });

  it("keeps jobs apart: the same test name in two jobs is two tests, and a pass in one job is no split in the other", () => {
    const builds = [
      build(0, "a", { t: "failed" }, "job-x"),
      build(1, "a", { t: "failed" }, "job-x"),
      build(0, "a", { t: "passed" }, "job-y"),
      build(2, "b", { t: "passed" }, "job-x"),
    ];
    const eps = deriveEpisodes(builds);
    assert.equal(eps.length, 1);
    assert.deepEqual([eps[0]!.job, eps[0]!.class], ["job-x", "regression"]);
  });

  it("reads builds in time order whatever order they are given in, and indexes each failure to its episode", () => {
    const builds = [build(3, "d", { t: "passed" }), build(1, "b", { t: "failed" }), build(2, "c", { t: "failed" }), build(0, "a", { t: "passed" })];
    const eps = deriveEpisodes(builds);
    assert.deepEqual(eps[0]!.buildIds, ["1001", "1002"]);
    const index = failureClassIndex(eps);
    assert.equal(index.get(failureKey("1002", "c::t"))?.class, "regression");
    assert.equal(index.get(failureKey("1003", "c::t")), undefined);
  });
});
