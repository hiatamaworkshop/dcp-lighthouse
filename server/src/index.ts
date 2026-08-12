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
import { bindPipelineRetention } from "./q-retention-binding.js";
import { ObservationOverlay } from "./lens-view.js";
import { SnapshotCurator } from "./snapshot-curator.js";
import { RuleBrain } from "./rule-brain.js";
import { DashboardServer } from "./dashboard.js";
import type { TestEvent } from "./mock-stream-generator.js";

// ── $Q bootstrap ─────────────────────────────────────────────────────────────

const registry = new QRegistry();

/**
 * Bootstrap retention width. The literal appears exactly once: the $Q row below
 * is the live authority (bindPipelineRetention keeps the buffer following it),
 * and this constant only seeds the buffer's constructor before the bind runs.
 */
const RETENTION_WINDOW_MS = 120_000;

// Default observe params: coarse live view + fine view for replay.
//
// Both declare align:"epoch" (ROADMAP L4 `origin` stage). The grid is then a
// property of the lens rather than of whichever segment happens to be handed
// over, so the same event lands in the same window on every tick — the
// anchor-slide that made an unchanging past burst flicker across ticks
// (ROADMAP_BRIEF.md 2026-07-29). dashboard.ts's liveSpans snaps its requests
// to this same grid via lens.ts's floorToWindow.
registry.set("observe:test_result:v1#coarse", { window_ms: 10_000, align: "epoch" });
registry.set("observe:test_result:v1#fine",   { window_ms: 1_000, align: "epoch" });
registry.set("pipeline:*", { retention_window_ms: RETENTION_WINDOW_MS });
// AR/RC regression threshold delta (ROADMAP L2-1, "Brain write surface" demo,
// PILOT_DATA.md §11). RuleBrain reads this live via QRegistry.getSchema — a
// write to this scope reconfigures its threshold without a restart.
registry.set("schema:test_result:v1", { baseline_delta: 0.10 });

// ── Build layers ──────────────────────────────────────────────────────────────

const generator  = new MockStreamGenerator();
const adapter    = new TestorAdapter({ windowMs: 5_000 });
const buffer     = new RetentionBuffer<TestEvent>(testEventExtractor, { retentionWindowMs: RETENTION_WINDOW_MS });
const overlay    = new ObservationOverlay(registry);
const curator    = new SnapshotCurator({ spikeZThreshold: 2.0, includeBaseline: true });
const brain      = new RuleBrain(registry);
const dashboard  = new DashboardServer(generator, adapter, brain, registry, curator, overlay, buffer);

// Two parallel observation views
overlay.add("coarse", "test_result:v1", { view: "coarse" });
overlay.add("fine",   "test_result:v1", { view: "fine"   });

// $Q[pipeline] is now the live authority for retention width: a write to that
// scope resizes the freshness zone in place, the same way $Q[observe] reshapes
// a collector's window. Without this the row was set and never read.
bindPipelineRetention(registry, buffer);

// ── Wire event flow ───────────────────────────────────────────────────────────

generator.onEvent((event) => {
  // Domain adapter
  adapter.push(event);

  // Observation overlay (Phase 0 core). Built by the same extractor the
  // retention buffer uses, so the overlay and the replay path see identical
  // events — including the `keys` a group_by lens reads. Hand-rolling the
  // value mapping here is how the two drifted apart before.
  const lensEv = testEventExtractor(event, "test_result:v1");
  if (lensEv !== null) overlay.push("test_result:v1", lensEv);

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
      // RC replayRequest: re-observe the retention buffer at the proposed fine window
      if (d.type === "replayRequest" && d.qProposal) {
        const proposedParams = d.qProposal.params as Record<string, unknown> & {
          window_ms?: number;
          fromTs?: number;
          toTs?: number;
        };
        registry.set(d.qProposal.scope, proposedParams);
        // Interval-specified replay (ROADMAP L2-2): re-observe only the segment
        // RuleBrain flagged, not the whole retention buffer. fromTs/toTs select
        // the segment; everything else in the proposal is the lens and is handed
        // over unchanged (lens.ts's contract) — rebuilding a `{ window_ms }`
        // literal here would silently drop the rest of the chain once L4 adds
        // group_by and the later stages.
        const { fromTs, toTs, ...lens } = proposedParams;
        const fineResult = buffer.replay(lens, fromTs, toTs);
        // Explicit reference lens (ROADMAP_BRIEF.md 2026-07-25 "参照レンズ設計"):
        // score the flagged interval against the equal-length interval
        // immediately before it, replayed through the same lens — a declared,
        // bounded, reproducible baseline instead of the implicit self-reference
        // that drifted as more history accumulated (the "late-firing coarse
        // dip" finding — an old burst window would retroactively re-cross the
        // threshold as quiet windows piled up and shrank the population stdDev).
        const referenceResult =
          fromTs !== undefined && toTs !== undefined
            ? buffer.replay(lens, fromTs - (toTs - fromTs), fromTs)
            : fineResult;
        const pkg = curator.curate(fineResult, referenceResult);
        if (!pkg.referenceUsable) {
          // Blindness, not quiet: the preceding interval fell outside retention
          // (or was empty), so no comparison was possible. Without this line an
          // empty tile list would read as "the replay found nothing wrong".
          console.warn(
            `[brain] replay reference UNUSABLE (no comparison possible) — ` +
            `requested [${fromTs}, ${toTs}], reference windows: ${referenceResult.windows.length}`,
          );
        }
        console.log(`[brain] replay snapshot: ${pkg.tiles.length} tiles, span ${JSON.stringify(pkg.spanMs)}`);
        dashboard.broadcastReplay(pkg);
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
