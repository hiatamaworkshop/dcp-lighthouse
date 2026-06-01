/**
 * dcp-lighthouse server entry point (Phase 1).
 *
 * Wires all Phase 0 mechanism layers + Phase 1 domain skin into a running pilot:
 *
 *   MockStreamGenerator → TestorAdapter → ObservationOverlay (LensViews)
 *                                       → RetentionBuffer (RC replay)
 *                                       → RuleBrain (tick decisions)
 *                                       → DashboardServer (SSE)
 *
 * $Q is the coordination bus: Brain writes $Q rows; ObservationOverlay's
 * LensViews react via onChange; DashboardServer streams $Q history.
 */

import { QRegistry } from "./q-registry.js";
import { MockStreamGenerator } from "./mock-stream-generator.js";
import { TestorAdapter, testEventExtractor } from "./testor-adapter.js";
import { RetentionBuffer } from "./retention-buffer.js";
import { ObservationOverlay } from "./lens-view.js";
import { SnapshotCurator } from "./snapshot-curator.js";
import { RuleBrain } from "./rule-brain.js";
import { DashboardServer } from "./dashboard.js";
import type { TestEvent } from "./mock-stream-generator.js";

// ── $Q bootstrap ─────────────────────────────────────────────────────────────

const registry = new QRegistry();

// Default observe params: coarse live view + fine view for replay
registry.set("observe:test_result:v1#coarse", { window_ms: 10_000 });
registry.set("observe:test_result:v1#fine",   { window_ms: 1_000  });
registry.set("pipeline:*", { retention_window_ms: 120_000 });

// ── Build layers ──────────────────────────────────────────────────────────────

const generator  = new MockStreamGenerator();
const adapter    = new TestorAdapter({ windowMs: 5_000 });
const buffer     = new RetentionBuffer<TestEvent>(testEventExtractor, { retentionWindowMs: 120_000 });
const overlay    = new ObservationOverlay(registry);
const curator    = new SnapshotCurator({ spikeZThreshold: 2.0, includeBaseline: true });
const brain      = new RuleBrain();
const dashboard  = new DashboardServer(generator, adapter, brain, registry, curator, overlay);

// Two parallel observation views
overlay.add("coarse", "test_result:v1", { view: "coarse" });
overlay.add("fine",   "test_result:v1", { view: "fine"   });

// ── Wire event flow ───────────────────────────────────────────────────────────

generator.onEvent((event) => {
  // Domain adapter
  adapter.push(event);

  // Observation overlay (Phase 0 core)
  const lensEv = { ts: event.ts, value: event.result === "pass" ? 1 : event.result === "flaky" ? 0.5 : 0 };
  overlay.push("test_result:v1", lensEv);

  // Retention buffer (RC replay)
  buffer.observe(event, "test_result:v1");
});

// ── Tick loop (Brain + dashboard broadcast) ───────────────────────────────────

const TICK_MS = 1000;

setInterval(() => {
  const snapshot = adapter.snapshot();
  brain.observe(snapshot);
  const decisions = brain.decide();

  if (decisions.length > 0) {
    for (const d of decisions) {
      console.log(`[brain] ${d.type}: ${d.reason}`);
      // RC replayRequest: re-observe the retention buffer at the fine window
      if (d.type === "replayRequest" && d.qProposal) {
        registry.set(d.qProposal.scope, d.qProposal.params as Record<string, unknown> & { window_ms?: number });
        const fineResult = buffer.replay({ window_ms: 1_000 });
        const pkg = curator.curate(fineResult);
        console.log(`[brain] replay snapshot: ${pkg.tiles.length} tiles, span ${JSON.stringify(pkg.spanMs)}`);
      }
    }
  }

  dashboard.broadcast(snapshot, decisions);
}, TICK_MS);

// ── Start ─────────────────────────────────────────────────────────────────────

generator.start({ rate: 50 });
dashboard.start({ port: 3001 });

console.log("[lighthouse] Phase 1 pilot running. Generator: 50 evt/s");
console.log("[lighthouse] POST /demo/start?scenario=AR|CG|RC to run a scenario");
