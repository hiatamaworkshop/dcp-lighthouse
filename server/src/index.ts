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
import { ClaudeBrain } from "./claude-brain.js";
import { ShadowBrain } from "./shadow-brain.js";
import { makeAnthropicAsk } from "./anthropic-ask.js";
import { DashboardServer, replaySpanWithReference } from "./dashboard.js";
import type { ResettableBrain } from "./brain-adapter.js";
import type { TestEvent } from "./mock-stream-generator.js";

// ── $Q bootstrap ─────────────────────────────────────────────────────────────

const registry = new QRegistry();

/**
 * Bootstrap retention width. The literal appears exactly once: the $Q row below
 * is the live authority (bindPipelineRetention keeps the buffer following it),
 * and this constant only seeds the buffer's constructor before the bind runs.
 */
const RETENTION_WINDOW_MS = 120_000;

/**
 * Reference-zone width and thinning ratio (ROADMAP L5, 2026-08-22). Extends how
 * far a reference/replay request can reach past RETENTION_WINDOW_MS before
 * hitting referenceUsable:false, at reduced resolution instead of nothing.
 *
 * thinningRatio: 2 is the calibration-measured safe choice, not a round-number
 * guess (calibration.test.ts "under retention thinning" 2026-08-22) — at x2 the
 * false-alarm rate measured 4.0% against a 4.55% design target and power barely
 * moved; x5 already read 9.0% and x10 11.5%, because thinning trades reference
 * event count for weight and a small effective count overshoots design for the
 * same already-documented "thin windows" reason a small eventsPerSpan does
 * un-thinned. x2 was the ratio actually measured to sit near design, so it is
 * the one shipped — this is not extrapolated from the other rows.
 *
 * REFERENCE_WINDOW_MS: 10x the freshness zone (round number, not measured) —
 * generous enough to matter for a Brain reference request that reaches back
 * further than 120s, still time-bounded per this file's "nothing accumulates
 * unbounded" philosophy. No $Q binding yet: RetentionBuffer has no
 * setReferenceWindowMs()/setThinningRatio() (unlike retention_window_ms below),
 * so these are construction-time only for now.
 */
const REFERENCE_WINDOW_MS = RETENTION_WINDOW_MS * 10;
const REFERENCE_THINNING_RATIO = 2;

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
const buffer     = new RetentionBuffer<TestEvent>(testEventExtractor, {
  retentionWindowMs: RETENTION_WINDOW_MS,
  referenceWindowMs: REFERENCE_WINDOW_MS,
  thinningRatio: REFERENCE_THINNING_RATIO,
});
const overlay    = new ObservationOverlay(registry);
const curator    = new SnapshotCurator({ spikeZThreshold: 2.0, includeBaseline: true });
const ruleBrain  = new RuleBrain(registry);

/**
 * BRAIN_MODE (ROADMAP L3) — "rule" (default) or "claude".
 *
 * "claude" does NOT replace RuleBrain: it runs ClaudeBrain in shadow beside it
 * (see shadow-brain.ts). RuleBrain keeps the wheel, so a $Q write still comes
 * from a rule that has been calibrated, while the LLM's proposals are recorded
 * for comparison. Promoting the shadow to primary is a later, separate call
 * that should be made on evidence from these logs.
 *
 * A missing key fails at boot rather than on the first deliberation: the
 * failure would otherwise be a warning 15 seconds into a running server, which
 * reads as "the model had nothing to say".
 */
const BRAIN_MODE = process.env.BRAIN_MODE ?? "rule";
const CLAUDE_BRAIN_MODEL = process.env.CLAUDE_BRAIN_MODEL ?? "claude-sonnet-5";
/** Floor between deliberations. 15s at TICK_MS=1000 is one call per 15 ticks. */
const CLAUDE_BRAIN_INTERVAL_MS = Number(process.env.CLAUDE_BRAIN_INTERVAL_MS ?? 15_000);

let shadowBrain: ShadowBrain | undefined;
let brain: ResettableBrain = ruleBrain;
/** Backs GET /brain. Left undefined under BRAIN_MODE=rule (see dashboard.ts). */
let brainDiagnostics: (() => unknown) | undefined;

if (BRAIN_MODE === "claude") {
  // Declared before the askFn that reports into it: AskFn returns a bare string
  // by design, so `stop_reason` has to come back through this side channel, and
  // the channel's only possible destination is the Brain being built from it.
  // The closure runs per answer, long after the assignment below.
  let claudeBrain: ClaudeBrain | undefined;
  const askFn = makeAnthropicAsk({
    model: CLAUDE_BRAIN_MODEL,
    // effort:"low" + a 2048 budget: the Brain returns a short JSON decision, and
    // on Sonnet 5 / Opus 5 thinking is on by default and shares max_tokens with
    // the answer — an unbounded think can eat the budget and truncate the JSON.
    maxTokens: 2048,
    effort: "low",
    // Without this a refusal — Opus 5 declines this prompt outright, 11/11 on
    // 2026-08-18 — arrives as an empty string and is counted as "the model
    // could not write JSON". Two very different findings, one indistinguishable
    // symptom, until the stop_reason travels with it.
    onMeta: (meta) => claudeBrain?.noteAnswerMeta(meta),
  });
  claudeBrain = new ClaudeBrain({
    askFn,
    minIntervalMs: CLAUDE_BRAIN_INTERVAL_MS,
    onError: (err) => console.warn(`[shadow] deliberation failed: ${err.message}`),
  });
  shadowBrain = new ShadowBrain(ruleBrain, claudeBrain, {
    onShadowError: (err) => console.warn(`[shadow] ${err.message}`),
  });
  brain = shadowBrain;

  const shadow = shadowBrain;
  const llm = claudeBrain;
  brainDiagnostics = () => ({
    mode: "claude",
    model: CLAUDE_BRAIN_MODEL,
    minIntervalMs: CLAUDE_BRAIN_INTERVAL_MS,
    /** Lifetime counters — refusals/truncated/discarded do not reset per scenario. */
    llm: llm.getStats(),
    /** Run tallies for both sides. Only `primary` was ever applied. */
    tally: shadow.getSummary(),
    /** Newest first: the shape of what the model actually said, for eyeballing. */
    recent: llm
      .getDeliberations()
      .slice(-5)
      .reverse()
      .map((d) => ({
        snapshotTs: d.snapshotTs,
        latencyMs: d.latencyMs,
        stopReason: d.answerMeta?.stopReason ?? null,
        types: d.decisions.map((x) => x.type),
        error: d.error,
      })),
  });
  console.log(
    `[lighthouse] BRAIN_MODE=claude — ${CLAUDE_BRAIN_MODEL} running in shadow ` +
      `beside RuleBrain, deliberating at most every ${CLAUDE_BRAIN_INTERVAL_MS}ms. ` +
      `Only RuleBrain's decisions are applied.`,
  );
} else if (BRAIN_MODE !== "rule") {
  throw new Error(`BRAIN_MODE must be "rule" or "claude", got "${BRAIN_MODE}"`);
}

const dashboard  = new DashboardServer(generator, adapter, brain, registry, curator, overlay, buffer, brainDiagnostics);

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

/** Highest ShadowEntry.seq already printed (see the shadow block below). */
let shadowLogCursor = -1;

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
        // A Brain proposing an unusable lens must cost that Brain its proposal,
        // not cost everyone the process. registry.set validates observe-layer
        // writes (lens.ts's rulebook) and throws, and this call sits inside the
        // tick's setInterval callback, where an escaping exception reaches
        // uncaughtException and terminates the server. Rejecting the one
        // decision keeps every other failure loud: this catch is scoped to
        // applying a proposal, not wrapped around the tick.
        //
        // This matters more once BRAIN_MODE=claude lands (ROADMAP L3): an LLM
        // Brain writing $Q is exactly the caller most likely to propose a lens
        // the rulebook refuses.
        try {
          registry.set(d.qProposal.scope, proposedParams);
        } catch (err) {
          console.warn(
            `[brain] proposal REJECTED for ${d.qProposal.scope}: ` +
              `${err instanceof Error ? err.message : String(err)}`,
          );
          continue;
        }
        // Interval-specified replay (ROADMAP L2-2): re-observe only the segment
        // RuleBrain flagged, not the whole retention buffer. fromTs/toTs select
        // the segment; everything else in the proposal is the lens and is handed
        // over unchanged (lens.ts's contract) — rebuilding a `{ window_ms }`
        // literal here would silently drop the rest of the chain once L4 adds
        // group_by and the later stages.
        const { fromTs, toTs, ...lens } = proposedParams;
        // Explicit reference lens (ROADMAP_BRIEF.md 2026-07-25 "参照レンズ設計"):
        // score the flagged interval against the equal-length interval
        // immediately before it, replayed through the same lens — a declared,
        // bounded, reproducible baseline instead of the implicit self-reference
        // that drifted as more history accumulated (the "late-firing coarse
        // dip" finding — an old burst window would retroactively re-cross the
        // threshold as quiet windows piled up and shrank the population stdDev).
        // Shared with /control/replay (dashboard.ts) so the formula has one
        // copy (ROADMAP L5, 2026-08-22). No proposal has ever omitted
        // fromTs/toTs in practice, but a malformed one could, so that case
        // keeps its own fallback rather than handing NaN to the shared helper.
        const pkg =
          fromTs !== undefined && toTs !== undefined
            ? replaySpanWithReference(buffer, curator, lens, fromTs, toTs)
            : curator.curate(buffer.replay(lens, fromTs, toTs), buffer.replay(lens, fromTs, toTs));
        if (!pkg.referenceUsable) {
          // Blindness, not quiet: the preceding interval fell outside retention
          // (or was empty), so no comparison was possible. Without this line an
          // empty tile list would read as "the replay found nothing wrong".
          console.warn(
            `[brain] replay reference UNUSABLE (no comparison possible) — ` +
            `requested [${fromTs}, ${toTs}]`,
          );
        }
        console.log(`[brain] replay snapshot: ${pkg.tiles.length} tiles, span ${JSON.stringify(pkg.spanMs)}`);
        dashboard.broadcastReplay(pkg);
      }
    }
  }

  // Shadow log (ROADMAP L3). Printed as it arrives rather than only summarised
  // at exit, so a shadow run can be watched live next to the applied decisions
  // above. These are PROPOSALS: nothing here reached registry.set.
  if (shadowBrain !== undefined) {
    // Keyed on ShadowEntry.seq, not on an array index: the log is bounded and
    // trims from the front, so an index-based cursor would stop matching new
    // entries after the first trim and the channel would silently go quiet.
    for (const e of shadowBrain.getLog()) {
      if (e.seq <= shadowLogCursor || e.source !== "shadow") continue;
      const q = e.decision.qProposal ? ` ${JSON.stringify(e.decision.qProposal.params)}` : "";
      console.log(`[shadow] (not applied) ${e.decision.type}${q}: ${e.decision.reason}`);
    }
    const newest = shadowBrain.getLog().at(-1);
    if (newest !== undefined) shadowLogCursor = newest.seq;
  }

  dashboard.broadcast(snapshot, decisions);
}, TICK_MS);

// ── Start ─────────────────────────────────────────────────────────────────────

generator.start({ rate: 50 });
dashboard.start({ port: 3001 });

console.log("[lighthouse] Phase 1 pilot running. Generator: 50 evt/s");
console.log("[lighthouse] POST /demo/start?scenario=AR|CG|RC to run a scenario");
