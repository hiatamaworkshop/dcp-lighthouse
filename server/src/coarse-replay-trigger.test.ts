import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { CoarseReplayTrigger, COARSE_REPLAY_VIEW, describeRelativeBurst, parseRelativeBurst } from "./coarse-replay-trigger.js";
import { C34_RELATIVE_BURST, type RelativeFailureBurst, type SnapshotPackage } from "./snapshot-curator.js";
import { ProwLiveSource, prowEventExtractor } from "./prow-live.js";
import type { ProwEvent } from "./prow-events.js";
import { TEST_STREAM_PROFILE } from "./stream-profile.js";
import { QRegistry, parseScope } from "./q-registry.js";
import { RetentionBuffer } from "./retention-buffer.js";
import { WindowHistory } from "./window-history.js";
import { Comparator } from "./comparison.js";
import { ObservationOverlay } from "./lens-view.js";
import { DashboardServer } from "./dashboard.js";
import type { TestEvent } from "./mock-stream-generator.js";

const T0 = Date.parse("2026-11-01T00:00:00Z");
const HOUR = 3_600_000;

function stubPackage(over: Partial<SnapshotPackage> = {}): SnapshotPackage {
  return {
    generatedAt: T0 + 10 * HOUR,
    window_ms: HOUR,
    globalStats: { mean: 0.999, stdDev: 0.01, windowCount: 30, eventCount: 30_000 },
    referenceUsable: true,
    selection: { scoredWindowCount: 3, baseZThreshold: 2.0, effectiveZThreshold: 2.39 },
    unreachableTails: [],
    tiles: [],
    ...over,
  };
}

describe("CoarseReplayTrigger (ROADMAP C24)", () => {
  it("fires a grouped replayRequest on a downward tile (dip / step_down) and ignores spike / baseline", () => {
    const trigger = new CoarseReplayTrigger({ groupBy: ["agentId"] });
    const pkg = stubPackage({
      tiles: [
        { shapeTag: "baseline", label: "baseline", description: "ok", regionStart: T0, regionEnd: T0 + HOUR, windows: [] },
        { shapeTag: "spike", label: "spike", description: "up", magnitude: 3.1, regionStart: T0 + HOUR, regionEnd: T0 + 2 * HOUR, windows: [] },
        { shapeTag: "dip", label: "dip", description: "down", magnitude: 4.2, regionStart: T0 + 2 * HOUR, regionEnd: T0 + 3 * HOUR, windows: [] },
      ],
    });
    const out = trigger.evaluate(pkg);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.type, "replayRequest");
    assert.deepEqual(out[0]!.qProposal, {
      scope: "observe:test_result:v1#regroup",
      params: {
        window_ms: HOUR,
        align: "epoch",
        group_by: ["agentId"],
        fromTs: T0 + 2 * HOUR,
        toTs: T0 + 3 * HOUR - 1,
      },
    });
  });

  it("fires on a concurrent-failure burst even when the coarse package is blind", () => {
    const trigger = new CoarseReplayTrigger({ groupBy: ["agentId"] });
    const pkg = stubPackage({
      referenceUsable: false,
      failures: {
        burstAt: 10,
        windows: [{ windowStart: T0 + 5 * HOUR, windowEnd: T0 + 6 * HOUR, failed: 14, total: 1000 }],
        bursts: [{ windowStart: T0 + 5 * HOUR, windowEnd: T0 + 6 * HOUR, failed: 14, total: 1000 }],
        unjudgedWindows: 0,
      },
    });
    const out = trigger.evaluate(pkg);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.qProposal?.params.fromTs, T0 + 5 * HOUR);
    assert.equal(out[0]!.qProposal?.params.toTs, T0 + 6 * HOUR - 1);
    assert.match(out[0]!.reason, /burst \(14 failed\)/);
  });

  it("deduplicates across ticks and merges dip + burst on the same window into one request", () => {
    const trigger = new CoarseReplayTrigger({ groupBy: ["domain"] });
    const pkg = stubPackage({
      tiles: [{ shapeTag: "dip", label: "dip", description: "down", magnitude: 5.0, regionStart: T0 + 2 * HOUR, regionEnd: T0 + 3 * HOUR, windows: [] }],
      failures: {
        burstAt: 10,
        windows: [{ windowStart: T0 + 2 * HOUR, windowEnd: T0 + 3 * HOUR, failed: 12, total: 500 }],
        bursts: [{ windowStart: T0 + 2 * HOUR, windowEnd: T0 + 3 * HOUR, failed: 12, total: 500 }],
        unjudgedWindows: 0,
      },
    });
    const first = trigger.evaluate(pkg);
    assert.equal(first.length, 1);
    assert.deepEqual(first[0]!.qProposal?.params.group_by, ["domain"]);
    assert.match(first[0]!.reason, /dip/);
    assert.match(first[0]!.reason, /burst/);
    // Evaluating the same window again (next tick or overlapping 3-window span) emits nothing
    assert.deepEqual(trigger.evaluate(pkg), []);
    trigger.reset();
    assert.equal(trigger.evaluate(pkg).length, 1);
  });

  it("attributes a combined-window failure burst to the failing job via automatic grouped replay and broadcasts it", async () => {
    const profile = TEST_STREAM_PROFILE;
    const registry = new QRegistry();
    registry.set("observe:test_result:v1#coarse", { ...profile.coarse });
    registry.set("observe:test_result:v1#fine", { ...profile.fine });
    registry.set("compare:test_result:v1#coarse", { ...profile.coarseCompare });
    registry.set(`compare:test_result:v1#${COARSE_REPLAY_VIEW}`, { ...profile.coarseCompare });
    const fineObserveBefore = registry.getObserve("test_result:v1", "fine");
    const fineCompareBefore = registry.getCompare("test_result:v1", "fine");

    const buffer = new RetentionBuffer<TestEvent>(prowEventExtractor, { retentionWindowMs: profile.retentionMs });
    const history = new WindowHistory(buffer, { maxHistoryMs: profile.historyMs });
    history.track(registry.getObserve("test_result:v1", "coarse") ?? {});
    const comparator = new Comparator({
      spikeZThreshold: 2.0, includeBaseline: true, sensitivityPower: 0.8, volumeChannel: true,
      ...(profile.failureBurstAt !== undefined ? { failureCount: profile.failureBurstAt } : {}),
    }, history);
    const overlay = new ObservationOverlay(registry);
    overlay.add("coarse", "test_result:v1", { view: "coarse" });
    const generator = { getCurrentLoad: () => ({ eventsPerSec: 0, running: false, activeScenario: null }) };
    const dashboard = new DashboardServer(generator as never, null as never, { reset: () => {} } as never, registry, comparator, overlay, buffer);
    const trigger = new CoarseReplayTrigger({ groupBy: ["agentId"] });

    // Build 45 hourly runs across 3 jobs: background 1 fail every 3 hours per job; hour 40 drops 15 tests ONLY in ci-e2e.
    const jobs = ["ci-unit", "ci-integration", "ci-e2e"];
    const events: ProwEvent[] = [];
    for (let h = 0; h < 45; h++) {
      for (const job of jobs) {
        const fails = h === 40 && job === "ci-e2e" ? 15 : h % 3 === 0 ? 1 : 0;
        for (let k = 0; k < 150; k++) {
          events.push({
            $schema: "test_result:v1",
            ts: T0 + h * HOUR + k * 10,
            testId: `${job}::t${k}`,
            agentId: job,
            areas: [],
            result: k < fails ? "fail" : "pass",
            duration: 1,
            weight: 1,
            commitHash: `c${h}`,
            area: job === "ci-e2e" ? "sig-network" : "sig-api",
            buildId: `${job}-${h}`,
          });
        }
      }
    }
    events.sort((a, b) => a.ts - b.ts);
    const source = new ProwLiveSource({ events, fromMs: T0, toMs: T0 + 45 * HOUR, speed: 1, startedAtMs: 0 });

    const server = dashboard.start({ port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const addr = server.address();
    const base = `http://127.0.0.1:${typeof addr === "object" && addr !== null ? addr.port : 0}`;
    try {
      const ac = new AbortController();
      const sseRes = await fetch(`${base}/events/decisions`, { signal: ac.signal });
      const reader = sseRes.body!.getReader();
      await new Promise((r) => setTimeout(r, 20));

      const replayedPackages: SnapshotPackage[] = [];
      for (let h = 3; h <= 44; h++) {
        const t = T0 + h * HOUR;
        source.advanceTo(t, (e) => buffer.observe(e, "test_result:v1"));
        const livePkg = dashboard.livePackage(t)!;
        const decisions = trigger.evaluate(livePkg);
        for (const d of decisions) {
          const p = d.qProposal!.params as Record<string, unknown> & { fromTs: number; toTs: number };
          const { fromTs, toTs, ...lens } = p;
          registry.set(d.qProposal!.scope, p as never);
          const scope = parseScope(d.qProposal!.scope);
          const pkg = comparator.compare(buffer, lens, registry.getCompare(scope.target, scope.view) ?? {}, { fromTs, toTs });
          replayedPackages.push(pkg);
          dashboard.broadcastReplay(pkg);
        }
      }

      // Hour 40 must have triggered exactly once (deduplicated across boundaries 41, 42, 43)
      const hour40 = replayedPackages.filter((p) => p.spanMs?.start === T0 + 40 * HOUR);
      assert.equal(hour40.length, 1, "hour 40 replayed exactly once");
      assert.equal(hour40[0]!.referenceUsable, true);
      const flaggedGroups = hour40[0]!.tiles.filter((t) => t.shapeTag === "dip" || t.shapeTag === "step_down").map((t) => t.group);
      assert.deepEqual(flaggedGroups, ["ci-e2e"], "grouped replay attributes the burst to ci-e2e only");
      // C27: the replays read their own 30-window reference and leave the live #fine rows as they were
      const ref = hour40[0]!.comparison!.reference;
      assert.equal(ref.toTs - ref.fromTs + 1, 30 * HOUR, "the replay is scored against 30 preceding windows");
      assert.deepEqual(registry.getObserve("test_result:v1", "fine"), fineObserveBefore, "the live fine view's lens is untouched");
      assert.deepEqual(registry.getCompare("test_result:v1", "fine"), fineCompareBefore, "the live fine view's comparison is untouched");
      assert.equal(registry.getObserve("test_result:v1", COARSE_REPLAY_VIEW)?.window_ms, HOUR, "the replay lens is recorded in its own row");

      // Confirm the replay_snapshot arrived on the /events/decisions SSE channel
      const chunk = await reader.read();
      ac.abort();
      const text = new TextDecoder().decode(chunk.value);
      const firstLine = text.split("\n\n")[0]!.replace(/^data: /, "");
      const msg = JSON.parse(firstLine) as { type: string; replayPackage: SnapshotPackage };
      assert.equal(msg.type, "replay_snapshot");
      assert.ok(msg.replayPackage.tiles.some((t) => t.group === "ci-e2e" && (t.shapeTag === "dip" || t.shapeTag === "step_down")));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// ── ROADMAP C39: C34's relative bursts in the live coarse view ───────────────

function relative(over: Partial<RelativeFailureBurst> = {}): RelativeFailureBurst {
  return {
    ...C34_RELATIVE_BURST,
    blind: false,
    refWindows: 30,
    refTrimmedWindows: 27,
    refMean: 0,
    refScale: 1,
    threshold: 3,
    windows: [],
    bursts: [],
    unjudgedWindows: 0,
    unjudgedRefWindows: 0,
    ...over,
  };
}

describe("CoarseReplayTrigger on relative failure bursts (ROADMAP C39)", () => {
  const W5 = { windowStart: T0 + 5 * HOUR, windowEnd: T0 + 6 * HOUR, failed: 6, total: 450 };

  it("fires a grouped replay on a relative burst the fixed 10 does not name, even with the rate reference unusable", () => {
    const trigger = new CoarseReplayTrigger({ groupBy: ["agentId"] });
    const out = trigger.evaluate(stubPackage({
      referenceUsable: false,
      failures: { burstAt: 10, windows: [W5], bursts: [], unjudgedWindows: 0 },
      relativeFailures: relative({ windows: [W5], bursts: [{ ...W5, score: 6 }] }),
    }));
    assert.equal(out.length, 1);
    assert.equal(out[0]!.qProposal?.params.fromTs, W5.windowStart);
    assert.equal(out[0]!.qProposal?.params.toTs, W5.windowEnd - 1);
    assert.match(out[0]!.reason, /relative burst \(6 failed > 3\.0\)/);
    assert.deepEqual(trigger.evaluate(stubPackage({ relativeFailures: relative({ windows: [W5], bursts: [{ ...W5, score: 6 }] }) })), [], "deduplicated by window");
  });

  it("merges a relative and a fixed burst on the same window into one request", () => {
    const trigger = new CoarseReplayTrigger();
    const big = { ...W5, failed: 14 };
    const out = trigger.evaluate(stubPackage({
      failures: { burstAt: 10, windows: [big], bursts: [big], unjudgedWindows: 0 },
      relativeFailures: relative({ windows: [big], bursts: [{ ...big, score: 14 }] }),
    }));
    assert.equal(out.length, 1);
    assert.match(out[0]!.reason, /burst \(14 failed\) \+ relative burst \(14 failed > 3\.0\)/);
    assert.deepEqual((out[0]!.meta as { triggers: string[] }).triggers.length, 2);
  });

  it("does not fire from a blind relative channel", () => {
    const trigger = new CoarseReplayTrigger();
    // A blind channel carries no bursts by construction; a stray one must still not fire.
    const out = trigger.evaluate(stubPackage({
      relativeFailures: relative({ blind: true, refWindows: 3, refTrimmedWindows: 0, refScale: 0, threshold: 0, windows: [W5], bursts: [{ ...W5, score: 6 }] }),
    }));
    assert.deepEqual(out, []);
  });

  it("parseRelativeBurst: unset is off, \"1\" under test-stream is on, anything else is refused at boot", () => {
    assert.equal(parseRelativeBurst(undefined, "mock"), false);
    assert.equal(parseRelativeBurst("", "mock"), false);
    assert.equal(parseRelativeBurst("1", "test-stream"), true);
    for (const bad of ["0", "true", "yes", "2", " 1"]) {
      assert.throws(() => parseRelativeBurst(bad, "test-stream"), /must be "1"/, bad);
    }
    assert.throws(() => parseRelativeBurst("1", "mock"), /needs LIGHTHOUSE_PROFILE=test-stream/);
  });

  it("index.ts refuses a bad LIGHTHOUSE_RELATIVE_BURST at boot, before it listens", () => {
    const cases: Array<{ env: Record<string, string>; err: RegExp }> = [
      { env: { LIGHTHOUSE_PROFILE: "test-stream", LIGHTHOUSE_SOURCE: "ingest", LIGHTHOUSE_RELATIVE_BURST: "yes" }, err: /LIGHTHOUSE_RELATIVE_BURST must be "1"/ },
      { env: { LIGHTHOUSE_RELATIVE_BURST: "1" }, err: /LIGHTHOUSE_RELATIVE_BURST needs LIGHTHOUSE_PROFILE=test-stream/ },
    ];
    for (const c of cases) {
      const env: Record<string, string | undefined> = { ...process.env, PORT: "0", ...c.env };
      // A child started from inside a node test must not report into this run (CLAUDE.md).
      delete env.NODE_TEST_CONTEXT;
      for (const k of ["LIGHTHOUSE_INGEST_LOG", "LIGHTHOUSE_INGEST_LOG_KEEP_HOURS", "LIGHTHOUSE_PERSIST_HISTORY"]) delete env[k];
      if (c.env.LIGHTHOUSE_PROFILE === undefined) delete env.LIGHTHOUSE_PROFILE;
      if (c.env.LIGHTHOUSE_SOURCE === undefined) delete env.LIGHTHOUSE_SOURCE;
      const r = spawnSync(process.execPath, [join(import.meta.dirname, "index.js")], { env, encoding: "utf8", timeout: 20_000 });
      assert.notEqual(r.status, 0, `exits non-zero for ${JSON.stringify(c.env)}`);
      assert.equal(r.signal, null, "refused at boot, not killed by the timeout");
      assert.match(r.stderr, c.err);
      assert.doesNotMatch(r.stdout, /listening on/);
    }
  });

  it("describeRelativeBurst carries C34's values and says this stream was not measured", () => {
    const d = describeRelativeBurst("the ingested build stream");
    assert.equal(d.zThreshold, C34_RELATIVE_BURST.zThreshold);
    assert.equal(d.trimTop, C34_RELATIVE_BURST.trimTop);
    assert.equal(d.minFailures, C34_RELATIVE_BURST.minFailures);
    assert.equal(d.minRefWindows, C34_RELATIVE_BURST.minRefWindows);
    assert.match(d.basis, /Treeherder/);
    assert.match(d.basis, /Prow/);
    assert.match(d.basis, /not measured on the ingested build stream/);
  });

  /** Three hourly jobs, all pass except `fails` failures in ci-e2e at `burstHour`. */
  function liveChain(opts: { relative: boolean; hours: number; burstHour: number; fails: number }) {
    const profile = TEST_STREAM_PROFILE;
    const registry = new QRegistry();
    registry.set("observe:test_result:v1#coarse", { ...profile.coarse });
    registry.set("compare:test_result:v1#coarse", { ...profile.coarseCompare });
    registry.set(`compare:test_result:v1#${COARSE_REPLAY_VIEW}`, { ...profile.coarseCompare });
    const buffer = new RetentionBuffer<TestEvent>(prowEventExtractor, { retentionWindowMs: profile.retentionMs });
    const history = new WindowHistory(buffer, { maxHistoryMs: profile.historyMs });
    history.track(registry.getObserve("test_result:v1", "coarse") ?? {});
    const comparator = new Comparator({
      spikeZThreshold: 2.0, includeBaseline: true, sensitivityPower: 0.8, volumeChannel: true,
      ...(profile.failureBurstAt !== undefined ? { failureCount: profile.failureBurstAt } : {}),
      ...(opts.relative ? { relativeFailureBurst: true } : {}),
    }, history);
    const overlay = new ObservationOverlay(registry);
    overlay.add("coarse", "test_result:v1", { view: "coarse" });
    const generator = { getCurrentLoad: () => ({ eventsPerSec: 0, running: false, activeScenario: null }) };
    const desc = opts.relative ? describeRelativeBurst("the test stream") : undefined;
    const dashboard = new DashboardServer(
      generator as never, null as never, { reset: () => {} } as never, registry, comparator, overlay, buffer,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, desc,
    );
    const events: ProwEvent[] = [];
    for (let h = 0; h < opts.hours; h++) {
      for (const job of ["ci-unit", "ci-integration", "ci-e2e"]) {
        const fails = h === opts.burstHour && job === "ci-e2e" ? opts.fails : 0;
        for (let k = 0; k < 150; k++) {
          events.push({
            $schema: "test_result:v1", ts: T0 + h * HOUR + k * 10, testId: `${job}::t${k}`, agentId: job, areas: [],
            result: k < fails ? "fail" : "pass", duration: 1, weight: 1, commitHash: `c${h}`, area: "sig-api", buildId: `${job}-${h}`,
          });
        }
      }
    }
    events.sort((a, b) => a.ts - b.ts);
    const source = new ProwLiveSource({ events, fromMs: T0, toMs: T0 + opts.hours * HOUR, speed: 1, startedAtMs: 0 });
    return { registry, buffer, comparator, dashboard, source };
  }

  async function withServer<T>(dashboard: DashboardServer, fn: (base: string) => Promise<T>): Promise<T> {
    const server = dashboard.start({ port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const addr = server.address();
    try {
      return await fn(`http://127.0.0.1:${typeof addr === "object" && addr !== null ? addr.port : 0}`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it("end to end: 6 failures in one job over an all-pass reference reach a grouped replay only with the opt-in, which is blind per job (C18)", async () => {
    for (const on of [false, true]) {
      const { registry, buffer, comparator, dashboard, source } = liveChain({ relative: on, hours: 45, burstHour: 40, fails: 6 });
      const trigger = new CoarseReplayTrigger({ groupBy: ["agentId"] });
      const replayed: SnapshotPackage[] = [];
      let lastLive: SnapshotPackage | null = null;
      for (let h = 3; h <= 44; h++) {
        const t = T0 + h * HOUR;
        source.advanceTo(t, (e) => buffer.observe(e, "test_result:v1"));
        lastLive = dashboard.livePackage(t)!;
        for (const d of trigger.evaluate(lastLive)) {
          const p = d.qProposal!.params as Record<string, unknown> & { fromTs: number; toTs: number };
          const { fromTs, toTs, ...lens } = p;
          registry.set(d.qProposal!.scope, p as never);
          const scope = parseScope(d.qProposal!.scope);
          replayed.push(comparator.compare(buffer, lens, registry.getCompare(scope.target, scope.view) ?? {}, { fromTs, toTs }));
        }
      }
      if (!on) {
        assert.equal(replayed.length, 0, "without the opt-in, 6 failures over an all-pass reference reach no grouped replay");
        assert.equal("relativeFailures" in lastLive!, false, "and the package carries no relative channel");
        await withServer(dashboard, async (base) => {
          const st = (await (await fetch(`${base}/status`)).json()) as Record<string, unknown>;
          assert.equal("relativeBurst" in st, false, "/status is unchanged without the opt-in");
        });
        continue;
      }
      assert.equal(replayed.length, 1, "the relative burst at hour 40 is replayed exactly once");
      assert.equal(replayed[0]!.spanMs?.start, T0 + 40 * HOUR);
      // The replay runs, but over an all-pass reference every job's rate reference has no variance: it is
      // blind per job and says so (unscoredGroups), rather than attributing. Scoring it is C18's job.
      assert.equal(replayed[0]!.referenceUsable, false);
      assert.deepEqual([...(replayed[0]!.unscoredGroups ?? [])].sort(), ["ci-e2e", "ci-integration", "ci-unit"]);
      assert.equal(replayed[0]!.tiles.some((t) => t.shapeTag === "dip" || t.shapeTag === "step_down"), false);
      assert.deepEqual(replayed[0]!.relativeFailures?.bursts.map((b) => [b.windowStart, b.failed]), [[T0 + 40 * HOUR, 6]], "the replay package still names the combined count");
      await withServer(dashboard, async (base) => {
        const st = (await (await fetch(`${base}/status`)).json()) as { relativeBurst?: { basis: string; minRefWindows: number; live: { blind: boolean; refWindows: number; at: number } | null } };
        assert.ok(st.relativeBurst, "/status names the relative channel");
        assert.match(st.relativeBurst.basis, /not measured on the test stream/);
        assert.equal(st.relativeBurst.minRefWindows, 8);
        assert.equal(st.relativeBurst.live?.blind, false);
        assert.equal(st.relativeBurst.live?.at, T0 + 44 * HOUR, "the state of the last live package");
      });
    }
  });

  it("a blind relative channel replays nothing and SSE and /status say it is blind", async () => {
    // Burst at hour 5: at boundaries 6–8 the reference holds at most 5 windows, fewer than 8.
    const { buffer, dashboard, source } = liveChain({ relative: true, hours: 9, burstHour: 5, fails: 6 });
    const trigger = new CoarseReplayTrigger();
    let fired = 0;
    for (let h = 3; h <= 8; h++) {
      const t = T0 + h * HOUR;
      source.advanceTo(t, (e) => buffer.observe(e, "test_result:v1"));
      const pkg = dashboard.livePackage(t)!;
      assert.equal(pkg.relativeFailures?.blind, true);
      fired += trigger.evaluate(pkg).length;
    }
    assert.equal(fired, 0);
    await withServer(dashboard, async (base) => {
      const st = (await (await fetch(`${base}/status`)).json()) as { relativeBurst?: { live: { blind: boolean; refWindows: number; bursts: unknown[] } | null } };
      assert.equal(st.relativeBurst?.live?.blind, true, "/status says blind");
      assert.ok((st.relativeBurst?.live?.refWindows ?? 99) < 8);
      assert.deepEqual(st.relativeBurst?.live?.bursts, []);

      const ac = new AbortController();
      const res = await fetch(`${base}/events/snapshot`, { signal: ac.signal });
      const reader = res.body!.getReader();
      await new Promise((r) => setTimeout(r, 20));
      dashboard.broadcast({ ts: T0 + 8 * HOUR, agents: [], domains: [], touchedBitsThisTick: [] }, []);
      let text = "";
      while (!text.includes("relativeBurst")) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += new TextDecoder().decode(chunk.value);
      }
      ac.abort();
      const line = text.split("\n\n").find((l) => l.includes("relativeBurst"))!.replace(/^data: /, "");
      const payload = JSON.parse(line) as { relativeBurst: { basis: string; live: { blind: boolean } } };
      assert.equal(payload.relativeBurst.live.blind, true, "SSE says blind");
      assert.match(payload.relativeBurst.basis, /a blind channel names none and is not quiet/);
    });
  });
});
