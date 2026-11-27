import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectPersistence } from "./prow-persist.js";
import type { THJob, THPush } from "./treeherder-import.js";
import { classOf, eventAsBuild, incidentsOf, jobOutcome, osFamily, pushesBetween, pushesToStream, thLensEvent } from "./treeherder-stream.js";

const T0 = Date.parse("2026-11-10T00:00:00Z") / 1000;

function job(id: number, over: Partial<THJob> = {}): THJob {
  return {
    id, job_type_name: "test-linux2404-64/opt-mochitest-1", job_group_symbol: "M", platform: "linux2404-64", platform_option: "opt",
    tier: 1, result: "success", state: "completed", failure_classification_id: 1,
    submit_timestamp: T0, start_timestamp: T0, end_timestamp: T0 + id * 60, ...over,
  };
}
const push = (id: number, at: number, jobs: THJob[], revision = `rev${id}`): THPush => ({ id, revision, push_timestamp: T0 + at, revision_count: 1, backout: false, jobs });

describe("treeherder-stream: the fixed rules", () => {
  it("names the OS family of the platforms autoland uses", () => {
    assert.deepEqual(
      ["linux2404-64-asan", "windows11-64-24h2", "windows2012-64", "macosx1500-aarch64", "osx-cross", "android-em-14-x86_64", "android-hw-a55-14-0-aarch64", "gecko-decision", "lint"].map(osFamily),
      ["linux", "windows", "windows", "macos", "macos", "android", "android", "other", "other"],
    );
  });

  it("makes events only of completed tier-1 success / testfailed / busted jobs, and counts the rest", () => {
    assert.equal(jobOutcome(job(1)), "pass");
    assert.equal(jobOutcome(job(1, { result: "testfailed" })), "fail");
    assert.equal(jobOutcome(job(1, { result: "busted" })), "fail");
    assert.equal(jobOutcome(job(1, { result: "retry" })), "retry");
    assert.equal(jobOutcome(job(1, { result: "exception" })), "exception");
    assert.equal(jobOutcome(job(1, { state: "running", result: "unknown" })), "state running");
    assert.equal(jobOutcome(job(1, { tier: 2 })), "not tier 1");
    const s = pushesToStream([push(1, 0, [job(3, { result: "testfailed", failure_classification_id: 4 }), job(2), job(4, { result: "retry" })])]);
    assert.deepEqual(s.events.map((e) => [e.jobId, e.fail, e.cls]), [[2, false, undefined], [3, true, "intermittent"]]);
    assert.deepEqual([...s.excluded], [["retry", 1]]);
    assert.deepEqual(thLensEvent(s.events[1]!), { ts: (T0 + 180) * 1000, value: 0, keys: { agentId: "linux", area: "M" } });
  });

  it("classifies by the failure classification", () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8].map(classOf), ["unclassified", "regression", "expected", "intermittent", "infra", "unclassified", "intermittent", "intermittent"]);
  });

  it("groups regressions by the fixing revision, finds the fixing push by prefix, and gives unnamed ones one incident per push", () => {
    const fbc = (id: number, fixedBy: string | undefined, platform = "linux2404-64"): THJob => ({ ...job(id, { result: "testfailed", failure_classification_id: 2, platform, job_type_name: `t-${platform}-${id % 2}` }), ...(fixedBy !== undefined ? { fixedBy } : {}) });
    const pushes = [
      push(1, 0, [fbc(10, "abcdef123456"), fbc(11, "")]),
      push(2, 600, [fbc(12, "abcdef123456", "windows11-64-24h2"), fbc(13, undefined)]),
      push(3, 7200, [job(14)], "abcdef1234567890abcdef1234567890abcdef12"),
    ];
    const { events } = pushesToStream(pushes);
    const inc = incidentsOf(events, pushes);
    assert.deepEqual(inc.map((i) => [i.key, i.events.map((e) => e.jobId), i.families, i.fixedMs]), [
      ["abcdef123456", [10, 12], ["linux", "windows"], (T0 + 7200) * 1000],
      ["unnamed@push1", [11], ["linux"], undefined],
      ["unnamed@push2", [13], ["linux"], undefined],
    ]);
    assert.equal(inc[0]!.startMs, (T0 + 600) * 1000);
    assert.equal(inc[0]!.firstPushMs, T0 * 1000);
  });

  it("feeds C21's detector unchanged: a job type's two consecutive failing runs announce, a pass on the same push does not", () => {
    const f = (id: number, pushId: number): THJob => job(id, { result: "testfailed", failure_classification_id: 2, job_type_name: "A" });
    const p = (id: number, pushId: number): THJob => job(id, { job_type_name: "A" });
    // A fails on push 1, fails on push 2 → announced at the 2nd failure's end.
    const announced = pushesToStream([push(1, 0, [f(1, 1)]), push(2, 60, [f(2, 2)])]).events;
    const a = detectPersistence(announced.map(eventAsBuild));
    assert.deepEqual(a.map((x) => [x.job, x.firstBuildId, x.buildId, x.atMs]), [["A", "1", "2", (T0 + 120) * 1000]]);
    // A passes on push 1, then fails on push 1 (a retrigger) and on push 2 → push 1 has a pass: split, not announced.
    const split = pushesToStream([push(1, 0, [p(1, 1), f(2, 1)]), push(2, 60, [f(3, 2)])]).events;
    assert.deepEqual(detectPersistence(split.map(eventAsBuild)).map((x) => x.buildId), []);
    // A pass between two failures ends the run: fail, pass, fail, fail announces at the 4th run only.
    const rerun = pushesToStream([push(1, 0, [f(1, 1), p(2, 1)]), push(2, 60, [f(3, 2), f(4, 2)])]).events;
    assert.deepEqual(detectPersistence(rerun.map(eventAsBuild)).map((x) => [x.firstBuildId, x.buildId]), [["3", "4"]]);
  });

  it("counts the pushes that landed after one instant up to another", () => {
    const ms = Float64Array.from([10, 20, 20, 30, 40]);
    assert.equal(pushesBetween(ms, 10, 30), 3);
    assert.equal(pushesBetween(ms, 30, 10), 0);
    assert.equal(pushesBetween(ms, 0, 100), 5);
  });
});
