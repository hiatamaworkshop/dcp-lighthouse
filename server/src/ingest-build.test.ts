import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";

import {
  DuplicateBuildError,
  LiveBuildIngestor,
  MAX_INGEST_BODY_BYTES,
  parseIngestBuildJson,
  parseIngestBuildJunit,
} from "./ingest-build.js";
import { checkSourceProfile, parsePersistHistory, prowEventExtractor } from "./prow-live.js";
import { describeFlakyHistory } from "./prow-persist.js";
import { DashboardServer } from "./dashboard.js";
import { MockStreamGenerator, type TestEvent } from "./mock-stream-generator.js";
import { TestorAdapter } from "./testor-adapter.js";
import { QRegistry } from "./q-registry.js";
import { RetentionBuffer } from "./retention-buffer.js";
import { ObservationOverlay } from "./lens-view.js";
import { WindowHistory } from "./window-history.js";
import { Comparator } from "./comparison.js";
import { RuleBrain } from "./rule-brain.js";
import type { ProwEvent } from "./prow-events.js";

const SAMPLE_NODE_JUNIT = `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
  <testsuite name="auth.test.js" time="0.123" tests="3" failures="1" skipped="1">
    <testcase name="allows valid token" classname="auth" time="0.010"/>
    <testcase name="rejects expired token [sig-auth]" classname="auth" time="0.025">
      <failure type="AssertionError" message="expected 401">AssertionError: expected 401</failure>
    </testcase>
    <testcase name="pending mfa flow" classname="auth" time="0.000">
      <skipped type="skipped"/>
    </testcase>
  </testsuite>
</testsuites>`;

function startTestDashboard(opts: { withIngest: boolean; withHistory?: boolean }) {
  const registry = new QRegistry();
  registry.set("observe:test_result:v1#coarse", { window_ms: 10_000, align: "epoch" });
  registry.set("observe:test_result:v1#fine", { window_ms: 1_000, align: "epoch" });
  registry.set("compare:test_result:v1", { reference: "preceding", null_model: "independent" });
  const generator = new MockStreamGenerator();
  const adapter = new TestorAdapter({ windowMs: 5_000 });
  const buffer = new RetentionBuffer<TestEvent>(prowEventExtractor, { retentionWindowMs: 120_000 });
  const overlay = new ObservationOverlay(registry);
  overlay.add("coarse", "test_result:v1", { view: "coarse" });
  const history = new WindowHistory(buffer, { maxHistoryMs: 3_600_000 });
  const comparator = new Comparator({ spikeZThreshold: 2.0, includeBaseline: true }, history);
  const brain = new RuleBrain(registry);
  const received: ProwEvent[] = [];
  const ingestor = opts.withIngest
    ? new LiveBuildIngestor(
        (ev) => {
          received.push(ev);
          const lensEv = prowEventExtractor(ev, "test_result:v1");
          if (lensEv !== null) overlay.push("test_result:v1", lensEv);
          buffer.observe(ev, "test_result:v1");
        },
        opts.withHistory ? { flakyHistory: { runs: 10 } } : {},
      )
    : undefined;
  const persistHistory = opts.withIngest && opts.withHistory ? describeFlakyHistory(10, "the ingested build stream") : undefined;
  const dashboard = new DashboardServer(
    generator,
    adapter,
    brain,
    registry,
    comparator,
    overlay,
    buffer,
    undefined,
    undefined,
    undefined,
    undefined,
    ingestor !== undefined ? () => ingestor.announcements() : undefined,
    persistHistory,
    ingestor,
  );
  const server = dashboard.start({ port: 0 });
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const close = () => new Promise<void>((res) => server.close(() => res()));
  return { dashboard, server, baseUrl, close, received, ingestor, buffer };
}

describe("parseIngestBuildJson & parseIngestBuildJunit (ROADMAP C30)", () => {
  it("parses JSON build payload with aliases and defaults", () => {
    const b = parseIngestBuildJson(
      {
        job: "local-unit",
        commit: "abc1234",
        cases: [
          { name: "passes", status: "pass", durationMs: 250 },
          { name: "breaks [sig-api]", classname: "api", status: "fail", time: 1.5 },
          { name: "todo", status: "skip" },
        ],
      },
      1_700_000_000_000,
      "fallback-1",
    );
    assert.equal(b.job, "local-unit");
    assert.equal(b.id, "fallback-1");
    assert.equal(b.commit, "abc1234");
    assert.equal(b.result, "FAILURE");
    assert.equal(b.scheduledMs, 1_700_000_000_000);
    assert.equal(b.files[0]!.suites[0]!.cases.length, 3);
    assert.equal(b.files[0]!.suites[0]!.cases[0]!.status, "passed");
    assert.equal(b.files[0]!.suites[0]!.cases[0]!.time, 0.25);
    assert.equal(b.files[0]!.suites[0]!.cases[1]!.status, "failed");
    assert.equal(b.files[0]!.suites[0]!.cases[2]!.status, "skipped");
  });

  it("parses Node --test-reporter=junit XML", () => {
    const b = parseIngestBuildJunit(SAMPLE_NODE_JUNIT, { job: "node-unit", commit: "deadbeef", buildId: "run-7" }, 1_700_000_000_000);
    assert.equal(b.job, "node-unit");
    assert.equal(b.id, "run-7");
    assert.equal(b.commit, "deadbeef");
    assert.equal(b.result, "FAILURE");
    const cases = b.files[0]!.suites[0]!.cases;
    assert.deepEqual(
      cases.map((c) => [c.classname, c.name, c.status]),
      [
        ["auth", "allows valid token", "passed"],
        ["auth", "rejects expired token [sig-auth]", "failed"],
        ["auth", "pending mfa flow", "skipped"],
      ],
    );
  });

  it("rejects invalid JSON or JUnit payloads with RangeError", () => {
    assert.throws(() => parseIngestBuildJson(null), RangeError);
    assert.throws(() => parseIngestBuildJson({ job: "", cases: [] }), RangeError);
    assert.throws(() => parseIngestBuildJson({ job: "j", cases: "nope" }), RangeError);
    assert.throws(() => parseIngestBuildJson({ job: "j", cases: [{ name: "a", status: "unknown" }] }), RangeError);
    assert.throws(() => parseIngestBuildJson({ job: "j", startedMs: 200, finishedMs: 100, cases: [] }), RangeError);
    assert.throws(() => parseIngestBuildJunit(SAMPLE_NODE_JUNIT, { job: "  " }), RangeError);
    assert.throws(() => parseIngestBuildJunit("<not-junit/>", { job: "j" }), RangeError);
  });
});

describe("LiveBuildIngestor (ROADMAP C30)", () => {
  it("emits events and surfaces persistence announcement on 2nd consecutive failure", () => {
    const events: ProwEvent[] = [];
    let t = 1_700_000_000_000;
    const ing = new LiveBuildIngestor((e) => events.push(e), {
      flakyHistory: { runs: 10 },
      now: () => (t += 1000),
    });

    const r1 = ing.ingestJson({
      job: "ci-unit",
      buildId: "b1",
      commit: "c1",
      cases: [
        { name: "t1", classname: "pkg", status: "passed" },
        { name: "t2", classname: "pkg", status: "failed" },
      ],
    });
    assert.equal(r1.events, 2);
    assert.equal(r1.failed, 1);
    assert.equal(r1.announcements.length, 0);

    const r2 = ing.ingestJson({
      job: "ci-unit",
      buildId: "b2",
      commit: "c2",
      cases: [
        { name: "t1", classname: "pkg", status: "passed" },
        { name: "t2", classname: "pkg", status: "failed" },
      ],
    });
    assert.equal(r2.announcements.length, 1);
    assert.equal(r2.announcements[0]!.testId, "pkg::t2");
    assert.equal(r2.announcements[0]!.firstBuildId, "b1");
    assert.equal(r2.announcements[0]!.buildId, "b2");
    assert.deepEqual(r2.announcements[0]!.history, { runs: 0, fails: 0 });
    assert.equal(events.length, 4);
    assert.equal(ing.announcements().length, 1);
    assert.equal(ing.status().builds, 2);
    assert.equal(ing.status().failed, 2);
  });

  it("refuses out-of-order scheduledMs without mutating counters or emitting events", () => {
    const events: ProwEvent[] = [];
    const ing = new LiveBuildIngestor((e) => events.push(e));
    ing.ingestJson({ job: "j", buildId: "b2", scheduledMs: 2000, cases: [{ name: "a", status: "passed" }] });
    assert.throws(
      () => ing.ingestJson({ job: "j", buildId: "b1", scheduledMs: 1000, cases: [{ name: "a", status: "failed" }] }),
      RangeError,
    );
    assert.equal(events.length, 1);
    assert.equal(ing.status().builds, 1);
  });

  it("caps retained announcements FIFO via maxAnnouncements", () => {
    const ing = new LiveBuildIngestor(() => {}, { maxAnnouncements: 2 });
    let ts = 10_000;
    for (const testName of ["a", "b", "c"]) {
      for (let k = 0; k < 2; k++) {
        ts += 1000;
        ing.ingestJson({
          job: "j",
          buildId: `${testName}-${k}`,
          commit: `${testName}-c${k}`,
          scheduledMs: ts,
          cases: [{ name: testName, status: "failed" }],
        });
      }
    }
    assert.deepEqual(ing.announcements().map((a) => a.testId), ["::b", "::c"]);
  });

  it("refuses a resent (job, buildId) without emitting events or touching counters", () => {
    const events: ProwEvent[] = [];
    const ing = new LiveBuildIngestor((e) => events.push(e));
    const build = { job: "j", buildId: "b1", scheduledMs: 1000, cases: [{ name: "a", status: "failed" }] };
    ing.ingestJson(build);
    assert.throws(() => ing.ingestJson(build), DuplicateBuildError);
    // A CI retry with the same id but a later timestamp is still the same build.
    assert.throws(() => ing.ingestJson({ ...build, scheduledMs: 2000 }), DuplicateBuildError);
    assert.equal(events.length, 1);
    assert.equal(ing.status().builds, 1);
    assert.equal(ing.status().failed, 1);
    assert.equal(ing.announcements().length, 0, "a resend must not fake a consecutive failure");
    // The same id under another job is a different build.
    ing.ingestJson({ ...build, job: "k" });
    assert.equal(ing.status().builds, 2);
  });

  it("forgets the oldest seen build past maxSeenBuilds (FIFO)", () => {
    const ing = new LiveBuildIngestor(() => {}, { maxSeenBuilds: 2 });
    for (const [id, ms] of [["b1", 1000], ["b2", 2000], ["b3", 3000]] as const) {
      ing.ingestJson({ job: "j", buildId: id, scheduledMs: ms, cases: [{ name: "a", status: "passed" }] });
    }
    assert.throws(() => ing.ingestJson({ job: "j", buildId: "b3", scheduledMs: 4000, cases: [] }), DuplicateBuildError);
    ing.ingestJson({ job: "j", buildId: "b1", scheduledMs: 4000, cases: [{ name: "a", status: "passed" }] });
    assert.equal(ing.status().builds, 4);
    assert.throws(() => new LiveBuildIngestor(() => {}, { maxSeenBuilds: 0 }), RangeError);
  });

  it("parsePersistHistory accepts ingest alongside prow and still refuses mock", () => {
    assert.equal(parsePersistHistory("10", "ingest"), 10);
    assert.equal(parsePersistHistory("10", "prow"), 10);
    assert.throws(() => parsePersistHistory("10", "mock"), /LIGHTHOUSE_SOURCE=prow/);
  });

  it("checkSourceProfile refuses prow and ingest without the test-stream profile", () => {
    assert.throws(() => checkSourceProfile("ingest", "mock"), /LIGHTHOUSE_SOURCE=ingest needs LIGHTHOUSE_PROFILE=test-stream/);
    assert.throws(() => checkSourceProfile("prow", "mock"), /LIGHTHOUSE_SOURCE=prow needs LIGHTHOUSE_PROFILE=test-stream/);
    assert.doesNotThrow(() => checkSourceProfile("ingest", "test-stream"));
    assert.doesNotThrow(() => checkSourceProfile("prow", "test-stream"));
    assert.doesNotThrow(() => checkSourceProfile("mock", "mock"));
  });
});

describe("DashboardServer POST /ingest/build (ROADMAP C30)", () => {
  it("ingests JSON and JUnit XML over HTTP, updates /persistence, /status, and SSE", async () => {
    const env = startTestDashboard({ withIngest: true, withHistory: true });
    try {
      // 1st JUnit build: 1 fail, 1 pass, 1 skipped -> no persistence announcement yet
      const res1 = await fetch(`${env.baseUrl}/ingest/build?job=local-unit&commit=c1&buildId=j1`, {
        method: "POST",
        headers: { "Content-Type": "application/xml" },
        body: SAMPLE_NODE_JUNIT,
      });
      assert.equal(res1.status, 200);
      const body1 = (await res1.json()) as { accepted: boolean; events: number; failed: number; skipped: number; announcements: unknown[] };
      assert.equal(body1.accepted, true);
      assert.equal(body1.events, 2);
      assert.equal(body1.failed, 1);
      assert.equal(body1.skipped, 1);
      assert.equal(body1.announcements.length, 0);

      // 2nd JUnit build on new commit: same test fails again -> persistence announces
      const res2 = await fetch(`${env.baseUrl}/ingest/build?job=local-unit&commit=c2&buildId=j2`, {
        method: "POST",
        headers: { "Content-Type": "text/xml; charset=utf-8" },
        body: SAMPLE_NODE_JUNIT,
      });
      assert.equal(res2.status, 200);
      const body2 = (await res2.json()) as { announcements: Array<{ testId: string; firstBuildId: string; buildId: string }> };
      assert.equal(body2.announcements.length, 1);
      assert.equal(body2.announcements[0]!.testId, "auth::rejects expired token [sig-auth]");
      assert.equal(body2.announcements[0]!.firstBuildId, "j1");
      assert.equal(body2.announcements[0]!.buildId, "j2");

      // JSON build ingest works on the same endpoint
      const res3 = await fetch(`${env.baseUrl}/ingest/build`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          job: "local-json",
          commit: "c3",
          cases: [{ name: "smoke", status: "passed" }],
        }),
      });
      assert.equal(res3.status, 200);
      assert.equal(env.received.length, 5);
      // Verify SIG area bit extraction flowed into RetentionBuffer
      assert.equal(env.received[1]!.area, "sig-auth");

      // /persistence reflects active feed + announcement + flakyHistory
      const pers = (await (await fetch(`${env.baseUrl}/persistence`)).json()) as {
        active: boolean;
        announcements: Array<{ testId: string }>;
        flakyHistory?: { runs: number; basis: string };
      };
      assert.equal(pers.active, true);
      assert.equal(pers.announcements.length, 1);
      assert.equal(pers.flakyHistory?.runs, 10);
      assert.match(pers.flakyHistory?.basis ?? "", /ingested build stream/);

      // /status carries ingest counters
      const st = (await (await fetch(`${env.baseUrl}/status`)).json()) as {
        running: boolean;
        ingest?: { source: string; builds: number; events: number; failed: number };
      };
      assert.equal(st.running, true);
      assert.equal(st.ingest?.source, "ingest");
      assert.equal(st.ingest?.builds, 3);
      assert.equal(st.ingest?.events, 5);
      assert.equal(st.ingest?.failed, 2);

      // /demo/start refused with 409 under ingest
      const demo = await fetch(`${env.baseUrl}/demo/start?scenario=AR`);
      assert.equal(demo.status, 409);

      // SSE snapshot carries ingest + persistence + persistenceHistory
      const ac = new AbortController();
      const sseRes = await fetch(`${env.baseUrl}/events/snapshot`, { signal: ac.signal });
      const reader = sseRes.body!.getReader();
      env.dashboard.broadcast({ ts: Date.now(), agents: [], domains: [], touchedBitsThisTick: [] }, []);
      const { value } = await reader.read();
      ac.abort();
      const line = new TextDecoder().decode(value).trim();
      assert.ok(line.startsWith("data: "));
      const payload = JSON.parse(line.slice(6)) as {
        streamRunning: boolean;
        activeScenario: unknown;
        ingest?: { builds: number };
        persistence?: unknown[];
        persistenceHistory?: { runs: number };
      };
      assert.equal(payload.streamRunning, true);
      assert.equal(payload.activeScenario, null);
      assert.equal(payload.ingest?.builds, 3);
      assert.equal(payload.persistence?.length, 1);
      assert.equal(payload.persistenceHistory?.runs, 10);
    } finally {
      await env.close();
    }
  });

  it("enforces HTTP error codes: 409 when inactive or resent, 405 on GET, 400 on bad payloads, 404 off-route, 413 on oversize", async () => {
    const inactive = startTestDashboard({ withIngest: false });
    try {
      const r = await fetch(`${inactive.baseUrl}/ingest/build`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job: "j", cases: [] }),
      });
      assert.equal(r.status, 409);
      const st = (await (await fetch(`${inactive.baseUrl}/status`)).json()) as Record<string, unknown>;
      assert.equal("ingest" in st, false, "mock /status is unchanged when ingest is inactive");
    } finally {
      await inactive.close();
    }

    const active = startTestDashboard({ withIngest: true });
    try {
      assert.equal((await fetch(`${active.baseUrl}/ingest/build`)).status, 405);
      assert.equal(
        (await fetch(`${active.baseUrl}/ingest/build`, { method: "POST", body: "{bad json" })).status,
        400,
      );
      assert.equal(
        (
          await fetch(`${active.baseUrl}/ingest/build`, {
            method: "POST",
            headers: { "Content-Type": "application/xml" },
            body: SAMPLE_NODE_JUNIT,
          })
        ).status,
        400,
        "JUnit without ?job=... returns 400",
      );
      assert.equal(
        (
          await fetch(`${active.baseUrl}/ingest/build?job=j`, {
            method: "POST",
            headers: { "Content-Type": "application/xml" },
            body: "not xml",
          })
        ).status,
        400,
      );
      const once = JSON.stringify({ job: "dup", buildId: "d1", cases: [{ name: "a", status: "failed" }] });
      const post = () =>
        fetch(`${active.baseUrl}/ingest/build`, { method: "POST", headers: { "Content-Type": "application/json" }, body: once });
      assert.equal((await post()).status, 200);
      assert.equal((await post()).status, 409, "a resent (job, buildId) returns 409");
      assert.equal(
        (await fetch(`${active.baseUrl}/ingest/buildX`, { method: "POST", body: once })).status,
        404,
        "only /ingest/build itself is the ingest route",
      );
      const huge = "x".repeat(MAX_INGEST_BODY_BYTES + 1024);
      const bigRes = await fetch(`${active.baseUrl}/ingest/build`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: huge,
      });
      assert.equal(bigRes.status, 413);
    } finally {
      await active.close();
    }
  });
});
