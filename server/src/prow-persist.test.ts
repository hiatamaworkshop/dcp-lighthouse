import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ProwBuild } from "./prow-import.js";
import { C35_FLAKY_HISTORY, PersistenceDetector, describeFlakyHistory, detectPersistence, flakyTag } from "./prow-persist.js";
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

  it("bounds remembered passing commits per test (FIFO) so long-running processes do not grow unbounded", () => {
    const det = new PersistenceDetector({}, undefined, 2);
    det.add(build(0, "c0", { t: "passed" }));
    det.add(build(1, "c1", { t: "passed" }));
    det.add(build(2, "c2", { t: "passed" })); // evicts c0; remembers c1, c2
    // c1 is still remembered → split, no announcement
    det.add(build(3, "c1", { t: "failed" }));
    assert.deepEqual(det.add(build(4, "c3", { t: "failed" })), []);
    // Reset run with a pass on c4 (evicts c1; remembers c2, c4)
    det.add(build(5, "c4", { t: "passed" }));
    // c0 was evicted earlier → consecutive failures on c0 and c5 announce
    det.add(build(6, "c0", { t: "failed" }));
    assert.equal(det.add(build(7, "c5", { t: "failed" })).length, 1);
    assert.throws(() => new PersistenceDetector({}, undefined, 0), RangeError);
  });

  it("everything C13 calls regression is announced", () => {
    const builds = [build(0, "a", { t: "passed" }), build(1, "b", { t: "failed" }), build(2, "c", { t: "failed" }), build(3, "d", { t: "failed" }), build(4, "e", { t: "passed" })];
    const eps = deriveEpisodes(builds).filter((e) => e.class === "regression");
    const announced = new Set(ann(builds).map((a) => a.firstBuildId));
    assert.ok(eps.length === 1 && eps.every((e) => announced.has(e.buildIds[0]!)));
  });
});

describe("PersistenceDetector state (ROADMAP C38)", () => {
  // Passing and failing commits, a rerun of a commit that passed (split), a mixed build, a build
  // with no commit, a run still going at the end, and a second job interleaved.
  const builds: ProwBuild[] = [
    build(0, "a", { t: "passed", u: "passed" }),
    build(1, "b", { t: "failed", u: "passed" }),
    build(2, "a", { t: "failed", u: "failed" }),
    build(3, "c", { t: "passed", u: "failed" }),
    build(4, undefined, { t: "failed", u: ["failed", "passed"] }),
    build(5, "d", { t: "failed", u: "failed" }),
    build(6, "e", { t: "failed", u: "passed" }, "other-job"),
    build(7, "e", { t: "failed", u: "failed" }),
    build(8, "f", { t: "failed", u: "passed" }, "other-job"),
    build(9, "g", { t: "failed", u: "failed" }),
  ];

  for (const flakyHistory of [undefined, { runs: 3 }]) {
    it(`reads on after a JSON round trip exactly as feeding every build (flaky history ${flakyHistory?.runs ?? "off"})`, () => {
      const whole = new PersistenceDetector({}, flakyHistory);
      const wholeOut = builds.flatMap((b) => whole.add(b));
      assert.ok(wholeOut.length >= 2);
      for (let k = 0; k <= builds.length; k++) {
        const head = new PersistenceDetector({}, flakyHistory);
        const out = builds.slice(0, k).flatMap((b) => head.add(b));
        const tail = new PersistenceDetector({}, flakyHistory);
        tail.importState(JSON.parse(JSON.stringify(head.exportState())));
        out.push(...builds.slice(k).flatMap((b) => tail.add(b)));
        assert.deepEqual(out, wholeOut, `split at ${k}`);
        assert.deepEqual(tail.exportState(), whole.exportState(), `state after split at ${k}`);
      }
    });
  }

  it("refuses a state made under other options, and a detector that has seen builds", () => {
    const d = new PersistenceDetector({}, { runs: 3 });
    d.add(builds[0]!);
    const state = d.exportState();
    assert.throws(() => new PersistenceDetector().importState(state), /LIGHTHOUSE_PERSIST_HISTORY must match/);
    assert.throws(() => new PersistenceDetector({}, { runs: 3 }, 8).importState(state), /remembered commits/);
    assert.throws(() => d.importState(state), /already seen builds/);
    assert.throws(() => new PersistenceDetector({}, { runs: 3 }).importState({ ...state, jobs: [{ job: "x", lastMs: 0, tests: [["t", { passedOn: [7] }]] }] }), /commit index 7/);
  });
});
