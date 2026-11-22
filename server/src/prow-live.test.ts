import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ProwLiveSource, ProwPersistenceFeed, prowEventExtractor } from "./prow-live.js";
import type { ProwEvent } from "./prow-events.js";
import type { ProwBuild } from "./prow-import.js";
import { detectPersistence, type Announcement } from "./prow-persist.js";
import { SHIPPED_WIRING, replayThroughShippedWiring, wiringFromProfile, type ReplayEvaluation } from "./prow-replay.js";
import { TEST_STREAM_PROFILE } from "./stream-profile.js";
import { prowLensEvent } from "./prow-events.js";
import { QRegistry } from "./q-registry.js";
import { RetentionBuffer } from "./retention-buffer.js";
import { WindowHistory } from "./window-history.js";
import { Comparator } from "./comparison.js";
import { ObservationOverlay } from "./lens-view.js";
import { DashboardServer } from "./dashboard.js";
import type { TestEvent } from "./mock-stream-generator.js";

const T0 = Date.parse("2026-11-01T00:00:00Z");
const HOUR = 3_600_000;

function ev(ts: number, fail: boolean, agentId = "ci-unit", area = "sig-node"): ProwEvent {
  return {
    $schema: "test_result:v1", ts, testId: `t${ts}`, agentId, areas: [], result: fail ? "fail" : "pass",
    duration: 1, weight: 1, commitHash: "c", area, buildId: "b",
  };
}

/** One run per hour: `n` events at the start of hour `i`, the first `fails` failing. */
function run(i: number, n: number, fails = 0): ProwEvent[] {
  return Array.from({ length: n }, (_, k) => ev(T0 + i * HOUR + k * 100, k < fails));
}

describe("ProwLiveSource", () => {
  const events = [ev(T0 + 10, false), ev(T0 + 20, true), ev(T0 + 5 * HOUR, false)];
  const mk = (speed = 3600) => new ProwLiveSource({ events, fromMs: T0, toMs: T0 + 6 * HOUR, speed, startedAtMs: 1000 });

  it("runs the virtual clock from the range's start at the chosen speed and stops at its end", () => {
    const s = mk(3600);
    assert.equal(s.virtualNow(1000), T0);
    assert.equal(s.virtualNow(2000), T0 + 3_600_000, "one real second = one hour at 3600");
    assert.equal(s.virtualNow(1000 + 1e9), T0 + 6 * HOUR, "stops at the end of the range");
    assert.equal(s.virtualNow(0), T0, "a real time before the start does not run the clock backwards");
  });

  it("hands out each event once, only when its time has come, in order", () => {
    const s = mk();
    const got: number[] = [];
    assert.equal(s.advanceTo(T0 + 10, (e) => got.push(e.ts)), 0, "ts < now, not ts <= now");
    assert.equal(s.advanceTo(T0 + 21, (e) => got.push(e.ts)), 2);
    assert.equal(s.advanceTo(T0 + 21, (e) => got.push(e.ts)), 0, "never twice");
    assert.equal(s.advanceTo(T0, (e) => got.push(e.ts)), 0, "a time before the last one gives nothing and does not rewind");
    s.advanceTo(T0 + 6 * HOUR, (e) => got.push(e.ts));
    assert.deepEqual(got, [T0 + 10, T0 + 20, T0 + 5 * HOUR]);
  });

  it("says where it is, and when it has finished", () => {
    const s = mk();
    assert.deepEqual({ p: s.status().progress, f: s.status().finished, n: s.status().total }, { p: 0, f: false, n: 3 });
    s.advanceTo(T0 + 3 * HOUR, () => {});
    assert.equal(s.status().progress, 0.5);
    assert.equal(s.status().fed, 2);
    assert.equal(s.status().finished, false);
    s.advanceTo(T0 + 6 * HOUR, () => {});
    assert.equal(s.status().finished, true);
    assert.equal(s.status().fed, 3);
  });

  it("refuses a speed that is not positive, an empty range and events out of time order", () => {
    assert.throws(() => mk(0), RangeError);
    assert.throws(() => mk(Number.NaN), RangeError);
    assert.throws(() => new ProwLiveSource({ events, fromMs: T0, toMs: T0, speed: 1 }), RangeError);
    assert.throws(() => new ProwLiveSource({ events: [ev(5, false), ev(4, false)], fromMs: 0, toMs: 10, speed: 1 }), RangeError);
  });
});

describe("prowEventExtractor", () => {
  it("is the lens view of a Prow event: pass 1 / fail 0, keyed by job and SIG", () => {
    const e = ev(T0, true, "ci-e2e", "sig-network");
    assert.deepEqual(prowEventExtractor(e as TestEvent, "test_result:v1"), { ts: T0, value: 0, keys: { agentId: "ci-e2e", area: "sig-network" } });
    assert.deepEqual(prowEventExtractor(e as TestEvent, "test_result:v1"), prowLensEvent(e));
  });
});

describe("the live view over a recorded stream (ROADMAP C23)", () => {
  // Build what index.ts builds under LIGHTHOUSE_PROFILE=test-stream, around a DashboardServer.
  function liveWiring(withFailures = true) {
    const profile = TEST_STREAM_PROFILE;
    const registry = new QRegistry();
    registry.set("observe:test_result:v1#coarse", { ...profile.coarse });
    registry.set("compare:test_result:v1#coarse", { ...profile.coarseCompare });
    const buffer = new RetentionBuffer<TestEvent>(prowEventExtractor, { retentionWindowMs: profile.retentionMs });
    const history = new WindowHistory(buffer, { maxHistoryMs: profile.historyMs });
    history.track(registry.getObserve("test_result:v1", "coarse") ?? {});
    const comparator = new Comparator({
      spikeZThreshold: 2.0, includeBaseline: true, sensitivityPower: 0.8, volumeChannel: true,
      ...(withFailures && profile.failureBurstAt !== undefined ? { failureCount: profile.failureBurstAt } : {}),
    }, history);
    const overlay = new ObservationOverlay(registry);
    overlay.add("coarse", "test_result:v1", { view: "coarse" });
    const dashboard = new DashboardServer(null as never, null as never, { reset: () => {} } as never, registry, comparator, overlay, buffer);
    return { buffer, dashboard };
  }

  // 100 hourly runs of 200 results: 1-2 failures in most, a burst of 14 in hour 60, a run that breaks (40) in hour 80.
  const stream = Array.from({ length: 100 }, (_, i) => run(i, 200, i === 60 ? 14 : i === 80 ? 40 : i % 3 === 0 ? 1 : i % 3 === 1 ? 2 : 0)).flat();

  it("names, at each boundary, what the C12 replay names: blind or scored, the downward tiles and the bursts", () => {
    const wiring = wiringFromProfile(TEST_STREAM_PROFILE);
    const evals: ReplayEvaluation[] = [];
    const tally = replayThroughShippedWiring(stream.map(prowLensEvent), T0, T0 + 100 * HOUR, wiring, (e) => evals.push(e));
    assert.equal(tally.errors, 0, tally.firstError);
    assert.ok(evals.length > 50, "enough boundaries to compare");

    const { buffer, dashboard } = liveWiring();
    const source = new ProwLiveSource({ events: stream, fromMs: T0, toMs: T0 + 100 * HOUR, speed: 1, startedAtMs: 0 });
    const claimed = new Map<number, number>();
    for (const e of evals) {
      source.advanceTo(e.t, (x) => buffer.observe(x, "test_result:v1"));
      const pkg = dashboard.livePackage(e.t)!;
      assert.equal(pkg.referenceUsable, !e.blind, `blind or scored at ${e.t}`);
      for (const b of pkg.failures?.bursts ?? []) claimed.set(b.windowStart, b.failed);
      if (!e.blind) {
        const downs = pkg.tiles.filter((t) => t.shapeTag === "dip" || t.shapeTag === "step_down").map((t) => t.regionStart).sort((a, b) => a - b);
        assert.deepEqual(downs, e.downs.map((d) => d.regionStart).sort((a, b) => a - b), `downward tiles at ${e.t}`);
      }
    }
    // The burst of hour 60 and the broken run of hour 80 are named by the live view as the replay names them.
    assert.deepEqual([...claimed].sort((a, b) => a[0] - b[0]), [...tally.bursts!.claimed].sort((a, b) => a[0] - b[0]));
    assert.equal(claimed.get(T0 + 60 * HOUR), 14);
    assert.equal(claimed.get(T0 + 80 * HOUR), 40);
    assert.ok(evals.some((e) => !e.blind && e.downs.length > 0), "the broken run alarms downward");
  });

  it("a package from a comparator without the failure option carries no `failures` (the mock profile's packages are unchanged)", () => {
    const { buffer, dashboard } = liveWiring(false);
    const source = new ProwLiveSource({ events: stream, fromMs: T0, toMs: T0 + 100 * HOUR, speed: 1, startedAtMs: 0 });
    source.advanceTo(T0 + 70 * HOUR, (x) => buffer.observe(x, "test_result:v1"));
    const pkg = dashboard.livePackage(T0 + 70 * HOUR)!;
    assert.equal(pkg.failures, undefined);
    assert.ok("referenceUsable" in pkg);
  });
});

describe("the server with a recorded stream as its source (ROADMAP C23)", () => {
  async function serve(replayStatus?: () => ReturnType<ProwLiveSource["status"]> | undefined) {
    const registry = new QRegistry();
    const generator = { getCurrentLoad: () => ({ eventsPerSec: 0, running: false, activeScenario: null }) };
    const server = new DashboardServer(generator as never, null as never, { reset: () => {} } as never, registry, null as never, new ObservationOverlay(registry),
      { replay: () => ({ window_ms: 1000, windows: [] }), getRetentionWindowMs: () => 120_000 }, undefined, undefined, undefined, replayStatus).start({ port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const addr = server.address();
    const base = `http://127.0.0.1:${typeof addr === "object" && addr !== null ? addr.port : 0}`;
    return { base, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
  }
  const status = (finished: boolean) => ({ source: "prow" as const, virtualNow: T0, fromMs: T0, toMs: T0 + HOUR, speed: 3600, progress: 0.5, fed: 1, total: 2, finished });

  it("refuses a scenario (they drive the mock generator) and reports the playback in /status", async () => {
    const s = await serve(() => status(false));
    try {
      const r = await fetch(`${s.base}/demo/start?scenario=AR`);
      assert.equal(r.status, 409);
      const st = (await (await fetch(`${s.base}/status`)).json()) as { running: boolean; replay: { source: string; progress: number } };
      assert.equal(st.running, true, "the stream is flowing until the playback ends");
      assert.deepEqual({ source: st.replay.source, progress: st.replay.progress }, { source: "prow", progress: 0.5 });
      const done = await serve(() => status(true));
      try {
        assert.equal(((await (await fetch(`${done.base}/status`)).json()) as { running: boolean }).running, false);
      } finally {
        await done.close();
      }
    } finally {
      await s.close();
    }
  });

  it("without a recorded stream /status and /demo/start are as they were", async () => {
    const s = await serve();
    try {
      const st = (await (await fetch(`${s.base}/status`)).json()) as Record<string, unknown>;
      assert.equal("replay" in st, false);
      assert.equal(st.running, false);
    } finally {
      await s.close();
    }
  });
});

describe("per-test persistence output (ROADMAP C22)", () => {
  function mkBuild(id: string, job: string, scheduledMs: number, finishedMs: number, commit: string, cases: Array<{ name: string; status: "passed" | "failed" }>): ProwBuild {
    return {
      id, job, scheduledMs, startedMs: scheduledMs, finishedMs, result: cases.some((c) => c.status === "failed") ? "FAILURE" : "SUCCESS", commit,
      files: [{ file: "junit_01.xml", suites: [{ name: "s", ts: scheduledMs, cases: cases.map((c) => ({ classname: "pkg", name: c.name, time: 1, status: c.status })) }] }],
    };
  }

  const builds: ProwBuild[] = [
    mkBuild("b1", "ci-e2e", T0 + 1 * HOUR, T0 + 1 * HOUR + 1000, "c1", [{ name: "T1", status: "passed" }, { name: "T2", status: "passed" }]),
    // T1 fails twice on c2 (no pass on c2) → announced at b3's finishedMs
    mkBuild("b2", "ci-e2e", T0 + 2 * HOUR, T0 + 2 * HOUR + 1000, "c2", [{ name: "T1", status: "failed" }, { name: "T2", status: "failed" }]),
    mkBuild("b3", "ci-e2e", T0 + 3 * HOUR, T0 + 3 * HOUR + 2000, "c2", [{ name: "T1", status: "failed" }, { name: "T2", status: "passed" }]),
    // T2 passed on c2 in b3, so a subsequent fail on c2 is NOT persistent
    mkBuild("b4", "ci-e2e", T0 + 4 * HOUR, T0 + 4 * HOUR + 1000, "c2", [{ name: "T1", status: "failed" }, { name: "T2", status: "failed" }]),
  ];

  it("ProwPersistenceFeed surfaces each announcement at atMs and matches detectPersistence", () => {
    const feed = new ProwPersistenceFeed(builds);
    // Before b3 finishes, nothing is surfaced even though b3 was already scheduled
    assert.deepEqual(feed.advanceTo(T0 + 3 * HOUR + 1000), []);
    assert.deepEqual(feed.announcements(), []);
    // At b3's finish, T1 is announced
    const newly = feed.advanceTo(T0 + 3 * HOUR + 2000);
    assert.equal(newly.length, 1);
    assert.equal(newly[0]!.testId, "pkg::T1");
    assert.equal(newly[0]!.buildId, "b3");
    assert.equal(newly[0]!.firstBuildId, "b2");
    // Advance past all builds and compare with detectPersistence
    feed.advanceTo(T0 + 10 * HOUR);
    assert.deepEqual(feed.announcements(), detectPersistence(builds));
  });

  it("GET /persistence and SSE /events/snapshot serve the announcements outside SnapshotPackage, and stay inactive under mock", async () => {
    const feed = new ProwPersistenceFeed(builds);
    feed.advanceTo(T0 + 10 * HOUR);
    const expected = detectPersistence(builds);

    const registry = new QRegistry();
    const generator = { getCurrentLoad: () => ({ eventsPerSec: 0, running: false, activeScenario: null }) };
    const overlay = new ObservationOverlay(registry);
    const buf = { replay: () => ({ window_ms: 1000, windows: [] }), getRetentionWindowMs: () => 120_000 };
    const dash = new DashboardServer(generator as never, null as never, { reset: () => {} } as never, registry, null as never, overlay, buf, undefined, undefined, undefined, undefined, () => feed.announcements());
    const server = dash.start({ port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const addr = server.address();
    const base = `http://127.0.0.1:${typeof addr === "object" && addr !== null ? addr.port : 0}`;
    try {
      const res = (await (await fetch(`${base}/persistence`)).json()) as { active: boolean; announcements: Announcement[] };
      assert.equal(res.active, true);
      assert.deepEqual(res.announcements, expected);

      // Verify SSE payload carries `persistence` as a top-level field separate from `snapshot`
      const ac = new AbortController();
      const sseRes = await fetch(`${base}/events/snapshot`, { signal: ac.signal });
      const reader = sseRes.body!.getReader();
      // Give the server a tick to register the subscriber, then broadcast
      await new Promise((r) => setTimeout(r, 20));
      dash.broadcast({ ts: T0 + 10 * HOUR, agents: [], domains: [], touchedBitsThisTick: [] }, []);
      const chunk = await reader.read();
      ac.abort();
      const text = new TextDecoder().decode(chunk.value);
      const line = text.split("\n\n")[0]!.replace(/^data: /, "");
      const payload = JSON.parse(line) as { snapshot: unknown; persistence?: Announcement[] };
      assert.deepEqual(payload.persistence, expected);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    // Without persistence wired (mock mode): GET /persistence reports active:false and SSE omits `persistence`
    const mockDash = new DashboardServer(generator as never, null as never, { reset: () => {} } as never, registry, null as never, overlay, buf);
    const mockServer = mockDash.start({ port: 0 });
    await new Promise<void>((resolve) => mockServer.once("listening", resolve));
    const mAddr = mockServer.address();
    const mBase = `http://127.0.0.1:${typeof mAddr === "object" && mAddr !== null ? mAddr.port : 0}`;
    try {
      const res = (await (await fetch(`${mBase}/persistence`)).json()) as { active: boolean; announcements: Announcement[] };
      assert.deepEqual(res, { active: false, announcements: [] });

      const ac = new AbortController();
      const sseRes = await fetch(`${mBase}/events/snapshot`, { signal: ac.signal });
      const reader = sseRes.body!.getReader();
      await new Promise((r) => setTimeout(r, 20));
      mockDash.broadcast({ ts: T0, agents: [], domains: [], touchedBitsThisTick: [] }, []);
      const chunk = await reader.read();
      ac.abort();
      const text = new TextDecoder().decode(chunk.value);
      const line = text.split("\n\n")[0]!.replace(/^data: /, "");
      const payload = JSON.parse(line) as Record<string, unknown>;
      assert.equal("persistence" in payload, false);
    } finally {
      await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    }
  });
});

