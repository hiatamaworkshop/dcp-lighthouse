import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ProwBuild } from "./prow-import.js";
import { C35_FLAKY_HISTORY, describeFlakyHistory, detectPersistence, flakyTag } from "./prow-persist.js";
import { deriveEpisodes } from "./prow-truth.js";

const T0 = Date.parse("2026-11-01T00:00:00Z");
const HOUR = 3_600_000;
type Status = "passed" | "failed" | "skipped";

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
        suites: [{ name: "s", ts: T0 + i * HOUR, cases: Object.entries(cases).flatMap(([name, st]) => (Array.isArray(st) ? st : [st]).map((status) => ({ name, classname: "c", time: 1, status }))) }],
      },
    ],
  };
  if (commit !== undefined) b.commit = commit;
  return b;
}

const ann = (builds: ProwBuild[], test = "t") => detectPersistence(builds).filter((a) => a.testId === `c::${test}`);

describe("detectPersistence — the rule fixed on 2026-11-17 (C21)", () => {
  it("announces at the 2nd build of a run, once, when no commit of the two has passed the test", () => {
    const a = ann([build(0, "a", { t: "passed" }), build(1, "b", { t: "failed" }), build(2, "c", { t: "failed" }), build(3, "d", { t: "failed" }), build(4, "e", { t: "passed" })]);
    assert.equal(a.length, 1);
    assert.deepEqual([a[0]!.buildId, a[0]!.firstBuildId, a[0]!.firstMs, a[0]!.atMs], ["1002", "1001", T0 + HOUR, T0 + 2 * HOUR + 600_000]);
  });

  it("does not announce a single failure, or a run broken by a pass", () => {
    assert.equal(ann([build(0, "a", { t: "failed" }), build(1, "b", { t: "passed" }), build(2, "c", { t: "failed" })]).length, 0);
  });

  it("does not announce when either build's commit already passed the test (before the run)", () => {
    assert.equal(ann([build(0, "a", { t: "passed" }), build(1, "a", { t: "failed" }), build(2, "b", { t: "failed" })]).length, 0, "the first build's commit passed");
    assert.equal(ann([build(0, "b", { t: "passed" }), build(1, "a", { t: "failed" }), build(2, "b", { t: "failed" })]).length, 0, "the second build's commit passed");
  });

  it("does not announce when another case of the test passed in either build", () => {
    assert.equal(ann([build(0, "a", { t: ["failed", "passed"] }), build(1, "b", { t: "failed" })]).length, 0);
    assert.equal(ann([build(0, "a", { t: "failed" }), build(1, "b", { t: ["failed", "passed"] })]).length, 0);
  });

  it("cannot see a same-commit pass that comes later: that is the price", () => {
    const builds = [build(0, "a", { t: "failed" }), build(1, "b", { t: "failed" }), build(2, "b", { t: "passed" })];
    assert.equal(ann(builds).length, 1);
    assert.equal(deriveEpisodes(builds)[0]!.class, "flaky", "C13 reading the whole record calls it flaky");
  });

  it("steps over builds where the test is absent or skipped", () => {
    const a = ann([build(0, "a", { t: "failed", u: "passed" }), build(1, "b", { u: "passed" }), build(2, "c", { t: "skipped", u: "passed" }), build(3, "d", { t: "failed", u: "passed" })]);
    assert.deepEqual(a.map((x) => x.buildId), ["1003"]);
  });

  it("a build without a stated commit cannot show a pass by commit", () => {
    assert.equal(ann([build(0, undefined, { t: "failed" }), build(1, undefined, { t: "failed" })]).length, 1);
  });

  it("starts a new run after a pass, and keeps jobs apart", () => {
    const builds = [
      build(0, "a", { t: "failed" }), build(1, "b", { t: "failed" }), build(2, "c", { t: "passed" }), build(3, "d", { t: "failed" }), build(4, "e", { t: "failed" }),
      build(0, "a", { t: "passed" }, "other"), build(1, "b", { t: "failed" }, "other"),
    ];
    assert.deepEqual(ann(builds).map((x) => [x.job, x.buildId, x.firstBuildId]), [["ci-job", "1001", "1000"], ["ci-job", "1004", "1003"]]);
  });

  it("C35 flakyHistory: absent unless asked, and never changes what is announced", () => {
    const builds = [build(0, "a", { t: "failed" }), build(1, "b", { t: "passed" }), build(2, "c", { t: "failed" }), build(3, "d", { t: "failed" }), build(4, "e", { t: "passed" }), build(5, "f", { t: "failed" }), build(6, "g", { t: "failed" })];
    const plain = detectPersistence(builds);
    assert.ok(plain.every((a) => !("history" in a)), "no history field without the option");
    const withHist = detectPersistence(builds, {}, { runs: 3 });
    assert.deepEqual(withHist.map(({ history: _h, ...rest }) => rest), plain, "same announcements, same fields otherwise");
  });

  it("C35 flakyHistory: the ≤ N builds before the run's first failing build, short histories stated", () => {
    const builds = [build(0, "a", { t: "failed" }), build(1, "b", { t: "passed" }), build(2, "c", { t: "failed" }), build(3, "d", { t: "failed" }), build(4, "e", { t: "passed" }), build(5, "f", { t: "failed" }), build(6, "g", { t: "failed" })];
    const a = detectPersistence(builds, {}, { runs: 3 }).filter((x) => x.testId === "c::t");
    assert.deepEqual(a.map((x) => [x.buildId, x.history]), [
      ["1003", { runs: 2, fails: 1 }], // before build 2: [fail, pass] — shorter than 3, stated
      ["1006", { runs: 3, fails: 2 }], // before build 5: last 3 of [f, p, f, f, p] = [f, f, p]; the run's own failures are not counted
    ]);
  });

  it("C35 flakyHistory: a first-ever failing run has an empty history, and runs must be a positive integer", () => {
    const a = detectPersistence([build(0, "a", { t: "failed" }), build(1, "b", { t: "failed" })], {}, { runs: 20 });
    assert.deepEqual(a[0]!.history, { runs: 0, fails: 0 });
    assert.throws(() => detectPersistence([], {}, { runs: 0 }), RangeError);
    assert.throws(() => detectPersistence([], {}, { runs: 2.5 }), RangeError);
  });

  it("C35/C36 flakyTag: short below N runs, quiet at ≤ F, flaky above; the description names where it was measured", () => {
    const { runs, quietMax } = C35_FLAKY_HISTORY;
    assert.equal(flakyTag(undefined, runs, quietMax), "short");
    assert.equal(flakyTag({ runs: 9, fails: 0 }, runs, quietMax), "short");
    assert.equal(flakyTag({ runs: 10, fails: 1 }, runs, quietMax), "quiet");
    assert.equal(flakyTag({ runs: 10, fails: 2 }, runs, quietMax), "flaky");
    assert.match(describeFlakyHistory(10, "X").basis, /Treeherder autoland; not measured on X\. /);
    assert.match(describeFlakyHistory(20, "X").basis, /N=20 was not measured anywhere/);
  });

  it("everything C13 calls regression is announced", () => {
    const builds = [build(0, "a", { t: "passed" }), build(1, "b", { t: "failed" }), build(2, "c", { t: "failed" }), build(3, "d", { t: "failed" }), build(4, "e", { t: "passed" })];
    const eps = deriveEpisodes(builds).filter((e) => e.class === "regression");
    const announced = new Set(ann(builds).map((a) => a.firstBuildId));
    assert.ok(eps.length === 1 && eps.every((e) => announced.has(e.buildIds[0]!)));
  });
});
