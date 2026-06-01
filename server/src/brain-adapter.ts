/**
 * BrainAdapter interface (Phase 1 Step 6).
 *
 * Pilot ships RuleBrain. ClaudeBrain can be plugged in via BRAIN_MODE=claude
 * without touching the rest of the pipeline — same pattern as Minecraft.
 *
 * Brain's only write surface inside DCP is $Q parameter rows. Reroute /
 * quarantine / target-update decisions are proposals to an outer action layer;
 * the pilot logs them but does not execute them (PILOT_DATA.md §11).
 */

import type { STSnapshot } from "./testor-adapter.js";

// ── Decision types ──────────────────────────────────────────────────────────

export type BrainDecisionType =
  | "rerouteSchema"   // agent output to audit pipeline
  | "schemaUpdate"    // raise target-coverage attention
  | "replayRequest"   // retroactive re-observation at finer window
  | "quarantine"      // isolate flaky agent/test
  | "noAction";

export interface BrainDecision {
  type: BrainDecisionType;
  reason: string;
  /** The $Q change Brain is proposing (if applicable). */
  qProposal?: { scope: string; params: Record<string, unknown> };
  /** Metadata for logging / dashboard display. */
  meta?: Record<string, unknown>;
}

// ── BrainAdapter interface ──────────────────────────────────────────────────

export interface BrainAdapter {
  /** Called every tick with the current $ST snapshot. */
  observe(snapshot: STSnapshot): void;
  /** Called after observe() to get decisions for this tick. */
  decide(): BrainDecision[];
  /** Human-readable description (for logging). */
  describe(): string;
}
