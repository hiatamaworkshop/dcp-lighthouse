import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CoarseReplayTrigger } from "./coarse-replay-trigger.js";
import type { SnapshotPackage } from "./snapshot-curator.js";
import { ProwLiveSource, prowEventExtractor } from "./prow-live.js";
import type { ProwEvent } from "./prow-events.js";
import { TEST_STREAM_PROFILE } from "./stream-profile.js";
import { QRegistry } from "./q-registry.js";
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
      scope: "observe:test_result:v1#fine",
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
    registry.set("compare:test_result:v1#fine", { ...profile.coarseCompare });

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
          const pkg = comparator.compare(buffer, lens, registry.getCompare("test_result:v1", "fine") ?? {}, { fromTs, toTs });
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
