import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CaseStatus, ProwBuild } from "./prow-import.js";
import { buildsToEvents } from "./prow-events.js";
import { FEW, applyPlant, choosePlant, isCommitStart, plantClasses, plantExtent, plantedFailures, scorePlant, seededRandom } from "./prow-plant.js";
import type { ReplayEvaluation } from "./prow-replay.js";

const T0 = Date.parse("2026-11-01T00:00:00Z");
const HOUR = 3_600_000;

/** Build `i` of a job: tests `t0..t{n-1}`, t0–t3 in [sig-a], the rest in [sig-b]; `status` overrides per test. */
function build(i: number, job = "ci-job", n = 10, status: Record<string, CaseStatus> = {}): ProwBuild {
  return {
    job,
    id: `${job}-${i}`,
    scheduledMs: T0 + i * HOUR,
    startedMs: T0 + i * HOUR,
    finishedMs: T0 + i * HOUR + 600_000,
    result: "SUCCESS",
    commit: `c${i}`,
    files: [
      {
        file: "junit.xml",
        suites: [
          {
            name: "s",
            ts: T0 + i * HOUR,
            cases: Array.from({ length: n }, (_, k) => ({ name: `t${k} [${k < 4 ? "sig-a" : "sig-b"}]`, classname: "c", time: 1, status: status[`t${k}`] ?? "passed" })),
          },
        ],
      },
    ],
  };
}

const id = (k: number): string => `c::t${k} [${k < 4 ? "sig-a" : "sig-b"}]`;

describe("choosePlant — targets drawn from the start build's passing tests", () => {
  it("draws 1 / FEW / one whole area, never a test that failed or was skipped there, and is seeded", () => {
    const start = build(0, "ci-job", 10, { t0: "failed", t5: "skipped" });
    const one = choosePlant(start, "one", 3, seededRandom(1))!;
    const few = choosePlant(start, "few", 3, seededRandom(1))!;
    const area = choosePlant(start, "area", 3, seededRandom(1))!;
    assert.equal(one.testIds.length, 1);
    assert.equal(few.testIds.length, FEW);
    for (const p of [one, few, area]) assert.ok(!p.testIds.includes(id(0)) && !p.testIds.includes(id(5)));
    assert.ok(area.area === "sig-a" || area.area === "sig-b");
    assert.deepEqual(area.testIds, area.area === "sig-a" ? [id(1), id(2), id(3)] : [4, 6, 7, 8, 9].map(id));
    assert.deepEqual(choosePlant(start, "few", 3, seededRandom(1))!.testIds, few.testIds, "same seed, same draw");
    assert.deepEqual([one.job, one.startBuildId, one.builds, one.size], ["ci-job", "ci-job-0", 3, "one"]);
  });

  it("refuses a start build with too few passing tests", () => {
    assert.equal(choosePlant(build(0, "ci-job", 3), "few", 3, seededRandom(1)), undefined);
  });
});

describe("applyPlant", () => {
  it("fails the targets' non-skipped cases in n consecutive builds of the job, copies those builds and leaves the rest alone", () => {
    const builds = [build(0), build(1, "ci-job", 10, { t1: "skipped" }), build(2), build(3), build(1, "other")];
    const before = JSON.stringify(builds);
    const plant = { job: "ci-job", startBuildId: "ci-job-1", builds: 2, size: "few" as const, testIds: [id(1), id(2)] };
    const { builds: out, plantedBuildIds } = applyPlant(builds, plant);
    assert.equal(JSON.stringify(builds), before, "the record is not mutated");
    assert.deepEqual(plantedBuildIds, ["ci-job-1", "ci-job-2"]);
    assert.equal(out[0], builds[0]);
    assert.equal(out[3], builds[3]);
    assert.equal(out[4], builds[4]);
    const st = (b: ProwBuild, k: number) => b.files[0]!.suites[0]!.cases[k]!.status;
    assert.deepEqual([st(out[1]!, 1), st(out[1]!, 2), st(out[1]!, 3)], ["skipped", "failed", "passed"]);
    assert.deepEqual([st(out[2]!, 1), st(out[2]!, 2)], ["failed", "failed"]);
    const fails = plantedFailures(buildsToEvents(out).events, plant, plantedBuildIds);
    assert.deepEqual(fails.map((e) => `${e.buildId} ${e.testId}`), [`ci-job-1 ${id(2)}`, `ci-job-2 ${id(1)}`, `ci-job-2 ${id(2)}`]);
  });

  it("stops at the job's last build", () => {
    const plant = { job: "ci-job", startBuildId: "ci-job-1", builds: 12, size: "one" as const, testIds: [id(1)] };
    assert.deepEqual(applyPlant([build(0), build(1), build(2)], plant).plantedBuildIds, ["ci-job-1", "ci-job-2"]);
  });

  it("runs on to the last build on its n-th build's commit, and starts only where a commit starts (amended rule)", () => {
    const on = (i: number, commit: string): ProwBuild => ({ ...build(i), commit });
    const builds = [on(0, "a"), on(1, "b"), on(2, "b"), on(3, "c"), on(4, "c"), on(5, "c"), on(6, "d")];
    assert.deepEqual(builds.map((_, i) => isCommitStart(builds, i)), [true, true, false, true, false, false, true]);
    assert.deepEqual(plantExtent(builds, 1, 2).map((b) => b.id), ["ci-job-1", "ci-job-2"], "ends with commit b");
    assert.deepEqual(plantExtent(builds, 1, 3).map((b) => b.id), ["ci-job-1", "ci-job-2", "ci-job-3", "ci-job-4", "ci-job-5"], "the 3rd build is on c: all of c");
    const plant = { job: "ci-job", startBuildId: "ci-job-1", builds: 3, size: "one" as const, testIds: [id(4)] };
    const { builds: out, plantedBuildIds } = applyPlant(builds, plant);
    assert.equal(plantedBuildIds.length, 5);
    assert.deepEqual(plantClasses(out, plant), ["regression"], "no build of a planted commit passes the test");
    // Cut mid-commit (the rehearsal's rule), the same code passes beside it: C13 says flaky.
    const midCommit = out.map((b) => (b.id === "ci-job-5" ? builds[5]! : b));
    assert.deepEqual(plantClasses(midCommit, plant), ["flaky"]);
  });

  it("is classified a regression by C13's rules once it lasts 2 builds on new commits", () => {
    const builds = [build(0), build(1), build(2), build(3)];
    const plant = { job: "ci-job", startBuildId: "ci-job-1", builds: 2, size: "one" as const, testIds: [id(4)] };
    assert.deepEqual(plantClasses(applyPlant(builds, plant).builds, plant), ["regression"]);
    assert.deepEqual(plantClasses(applyPlant(builds, { ...plant, builds: 1 }).builds, plant), ["isolated"]);
  });
});

describe("scorePlant — the detection rule fixed on 2026-11-17", () => {
  const W = HOUR;
  const fail = (ts: number, agentId = "ci-job", area = "sig-a") =>
    ({ ts, agentId, area, buildId: "b", testId: "x", result: "fail" }) as unknown as Parameters<typeof scorePlant>[2][number];
  const ev = (t: number, downs: ReplayEvaluation["downs"], blind = false): ReplayEvaluation => ({ t, blind, downs });

  it("credits the first boundary whose downward tile covers a planted window that the unplanted replay did not cover", () => {
    const failures = [fail(T0 + 10 * HOUR + 5)];
    const w = T0 + 10 * HOUR;
    const planted = [ev(T0 + 10 * HOUR, []), ev(T0 + 11 * HOUR, [{ regionStart: w, regionEnd: w + W }]), ev(T0 + 12 * HOUR, [{ regionStart: w, regionEnd: w + W }])];
    const s = scorePlant([], planted, failures, W);
    assert.deepEqual([s.detected, s.detectedAt, s.delayMs, s.failures], [true, T0 + 11 * HOUR, HOUR - 5, 1]);
    // Already covered at that boundary without the plant: not credited there, credited at the next.
    const base = [ev(T0 + 11 * HOUR, [{ regionStart: w, regionEnd: w + W }])];
    assert.equal(scorePlant(base, planted, failures, W).detectedAt, T0 + 12 * HOUR);
    // A tile over another window does not count.
    assert.equal(scorePlant([], [ev(T0 + 11 * HOUR, [{ regionStart: w + W, regionEnd: w + 2 * W }])], failures, W).detected, false);
  });

  it("on a grouped lens, the tile must be in a planted failure's group; an ungrouped tile does not count there", () => {
    const failures = [fail(T0 + 10 * HOUR, "job-x", "sig-a")];
    const w = T0 + 10 * HOUR;
    const at = (group?: string) => [ev(T0 + 11 * HOUR, [{ regionStart: w, regionEnd: w + W, ...(group !== undefined ? { group } : {}) }])];
    assert.equal(scorePlant([], at("job-y"), failures, W, ["agentId"]).detected, false);
    assert.equal(scorePlant([], at("job-x"), failures, W, ["agentId"]).detected, true);
    assert.equal(scorePlant([], at("sig-a"), failures, W, ["area"]).detected, true);
    assert.equal(scorePlant([], at(), failures, W, ["area"]).detected, false);
  });

  it("counts blind boundaries after the first planted failure", () => {
    const s = scorePlant([], [ev(T0 + 10 * HOUR, [], true), ev(T0 + 11 * HOUR, [], true), ev(T0 + 12 * HOUR, [])], [fail(T0 + 10 * HOUR + 1)], W);
    assert.deepEqual([s.detected, s.blindAfter], [false, 1]);
  });
});
