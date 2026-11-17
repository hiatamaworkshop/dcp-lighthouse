import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ProwBuild } from "./prow-import.js";
import { areaBit, buildToEvents, buildsToEvents, prowLensEvent, sigLabels } from "./prow-events.js";

const T0 = Date.parse("2026-11-01T10:00:00Z");

function build(over: Partial<ProwBuild> = {}): ProwBuild {
  return {
    job: "ci-job",
    id: "100",
    scheduledMs: T0,
    startedMs: T0 + 30_000,
    finishedMs: T0 + 30_000 + 600_000,
    result: "FAILURE",
    commit: "abc123",
    files: [
      {
        file: "artifacts/junit_1.xml",
        suites: [
          {
            name: "[sig-auth] pkg/a",
            ts: T0 + 60_000,
            cases: [
              { name: "t1", classname: "[sig-auth] pkg/a", time: 1.5, status: "passed" },
              { name: "t2", classname: "[sig-auth] pkg/a", time: 0.25, status: "failed" },
            ],
          },
          {
            name: "e2e",
            cases: [
              { name: "[It] [sig-node] [sig-storage] Pods run", classname: "e2e", time: 12, status: "passed" },
              { name: "[It] [sig-node] Pods skipped", classname: "e2e", time: 0, status: "skipped" },
              { name: "plain", classname: "pkg/none", time: 2, status: "passed" },
            ],
          },
        ],
      },
      { file: "artifacts/junit_runner.xml", suites: [{ name: "runner", cases: [{ name: "Up", classname: "e2e.go", time: 3, status: "failed" }] }] },
    ],
    ...over,
  };
}

describe("sigLabels / areaBit", () => {
  it("finds the SIG labels in order, once each, and nothing else in brackets", () => {
    assert.deepEqual(sigLabels("[It] [sig-node] [Feature:X] [SIG-Storage] thing [sig-node]"), ["sig-node", "sig-storage"]);
    assert.deepEqual(sigLabels("k8s.io/api/core"), []);
  });
  it("hashes a label to the same bit every time, inside the 256-bit space", () => {
    const bits = ["sig-node", "sig-auth", "sig-api-machinery", "sig-storage", "sig-network"].map(areaBit);
    for (const b of bits) assert.ok(Number.isInteger(b) && b >= 0 && b < 256);
    assert.deepEqual(bits, ["sig-node", "sig-auth", "sig-api-machinery", "sig-storage", "sig-network"].map(areaBit));
    assert.equal(new Set(bits).size, 5, "these five do not collide");
  });
});

describe("buildToEvents", () => {
  it("maps the eight fields as written down, drops skipped cases and the runner's steps", () => {
    const { events, skipped } = buildToEvents(build());
    assert.equal(skipped, 1);
    assert.equal(events.length, 4, "the runner file's failed step is not a test");
    const [t1, t2, pods, plain] = events;
    assert.deepEqual(
      { ...t1 },
      {
        $schema: "test_result:v1",
        ts: T0 + 60_000,
        testId: "[sig-auth] pkg/a::t1",
        agentId: "ci-job",
        areas: [areaBit("sig-auth")],
        result: "pass",
        duration: 1500,
        weight: 1,
        commitHash: "abc123",
        area: "sig-auth",
        buildId: "100",
      },
    );
    assert.equal(t2!.result, "fail");
    assert.equal(t2!.duration, 250);
    assert.equal(pods!.ts, T0 + 30_000, "a suite without a timestamp falls back to the build's start");
    assert.deepEqual(pods!.areas, [areaBit("sig-node"), areaBit("sig-storage")]);
    assert.equal(pods!.area, "sig-node");
    assert.deepEqual(plain!.areas, []);
    assert.equal(plain!.area, "");
    assert.ok(events.every((e) => e.result !== "flaky"), "a single junit never says flaky");
  });

  it("falls back to the scheduling instant and an empty commit when the build states neither", () => {
    const b = build();
    delete b.startedMs;
    delete b.commit;
    const { events } = buildToEvents(b);
    assert.equal(events[2]!.ts, T0);
    assert.equal(events[0]!.commitHash, "");
  });

  it("placement spread lays the cases evenly over the build's run in file order, inside it", () => {
    const { events } = buildToEvents(build(), { placement: "spread" });
    const start = T0 + 30_000;
    assert.deepEqual(events.map((e) => e.ts), [start + 75_000, start + 225_000, start + 375_000, start + 525_000]);
    assert.deepEqual(events.map((e) => e.testId.split("::")[1]), ["t1", "t2", "[It] [sig-node] [sig-storage] Pods run", "plain"]);
  });

  it("excludeFile can keep the runner's steps in", () => {
    assert.equal(buildToEvents(build(), { excludeFile: () => false }).events.length, 5);
  });
});

describe("buildsToEvents / prowLensEvent", () => {
  it("merges builds in time order and gives the lens pass 1 / fail 0 with job and area keys", () => {
    const later = build({ id: "200", scheduledMs: T0 + 3_600_000, startedMs: T0 + 3_600_000, finishedMs: T0 + 4_000_000, files: [{ file: "junit.xml", suites: [{ name: "s", ts: T0 + 40_000, cases: [{ name: "early", classname: "c", time: 1, status: "failed" }] }] }] });
    const { events, skipped } = buildsToEvents([later, build()]);
    assert.equal(skipped, 1);
    assert.deepEqual(events.map((e) => e.ts), [T0 + 30_000, T0 + 30_000, T0 + 40_000, T0 + 60_000, T0 + 60_000]);
    assert.deepEqual(prowLensEvent(events[2]!), { ts: T0 + 40_000, value: 0, keys: { agentId: "ci-job", area: "" } });
    assert.equal(prowLensEvent(events[3]!).value, 1);
  });
});
