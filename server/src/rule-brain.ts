/**
 * RuleBrain — rule-based BrainAdapter (Phase 1 Step 6).
 *
 * Deterministic rules for the three pilot scenarios (AR/CG/RC).
 * Modeled on Minecraft's GameRuleBrain: stateful, tick-driven, proposals only.
 *
 * Rule thresholds live here (Brain code), not in $Q[schema]. A value is promoted
 * to $Q[schema] only if a second Brain implementation needs to read the same
 * threshold (PILOT_DATA.md §11, "Brain write surface").
 *
 * Three rules:
 *   AR  — agent pass rate drops below REGRESSION_THRESHOLD for REGRESSION_TICKS
 *          → emit rerouteSchema proposal for that agent
 *   CG  — a domain's coverage gap persists for GAP_TICKS consecutive ticks
 *          → emit schemaUpdate proposal
 *   RC  — a pass rate window is near-flat but just below REPLAY_TRIGGER_FLOOR
 *          → emit replayRequest so RetentionBuffer is re-observed at fine window
 */

import type { BrainAdapter, BrainDecision } from "./brain-adapter.js";
import type { STSnapshot, AgentStats, DomainStats } from "./testor-adapter.js";

// ── Thresholds ──────────────────────────────────────────────────────────────

const REGRESSION_THRESHOLD = 0.80;   // pass rate below this = regression suspect
const REGRESSION_TICKS = 3;          // must persist for N ticks to fire
const GAP_THRESHOLD = 4;             // bits: gap larger than this triggers CG
const GAP_TICKS = 5;                 // gap must persist for N ticks
const REPLAY_TRIGGER_FLOOR = 0.85;   // near-flat but below this → suspect hidden burst
const REPLAY_TRIGGER_CEIL  = 0.95;   // above this = normal, no replay needed
const REPLAY_FINE_WINDOW_MS = 1000;

// ── RuleBrain ───────────────────────────────────────────────────────────────

export class RuleBrain implements BrainAdapter {
  /** Consecutive tick count per agent below regression threshold. */
  private readonly agentRegressionTicks = new Map<string, number>();
  /** Agents for which rerouteSchema has already been emitted (avoid spam). */
  private readonly rerouted = new Set<string>();

  /** Consecutive tick count per domain with coverage gap. */
  private readonly domainGapTicks = new Map<string, number>();
  /** Domains for which schemaUpdate has already been emitted. */
  private readonly gapAlerted = new Set<string>();

  /** Consecutive ticks in the replay-suspect band. */
  private replayBandTicks = 0;
  /** Whether a replayRequest was already emitted this session. */
  private replayEmitted = false;

  private lastSnapshot: STSnapshot | null = null;
  private pendingDecisions: BrainDecision[] = [];

  observe(snapshot: STSnapshot): void {
    this.lastSnapshot = snapshot;
    this.pendingDecisions = [];
    this.checkAR(snapshot.agents);
    this.checkCG(snapshot.domains);
    this.checkRC(snapshot.agents);
  }

  decide(): BrainDecision[] {
    return [...this.pendingDecisions];
  }

  describe(): string {
    return "RuleBrain v1 (AR/CG/RC rules)";
  }

  // ── AR: agent regression ──────────────────────────────────────────────────

  private checkAR(agents: AgentStats[]): void {
    for (const a of agents) {
      if (a.passRate < REGRESSION_THRESHOLD) {
        const ticks = (this.agentRegressionTicks.get(a.agentId) ?? 0) + 1;
        this.agentRegressionTicks.set(a.agentId, ticks);

        if (ticks >= REGRESSION_TICKS && !this.rerouted.has(a.agentId)) {
          this.rerouted.add(a.agentId);
          this.pendingDecisions.push({
            type: "rerouteSchema",
            reason: `Agent ${a.agentId} pass rate ${(a.passRate * 100).toFixed(1)}% below ${(REGRESSION_THRESHOLD * 100).toFixed(0)}% for ${ticks} ticks`,
            qProposal: {
              scope: `schema:test_result:v1`,
              params: { reroute_agent: a.agentId, destination: "audit" },
            },
            meta: { agentId: a.agentId, passRate: a.passRate, ticks },
          });
        }
      } else {
        // Recovery: reset tick count and re-enable future alerts
        this.agentRegressionTicks.set(a.agentId, 0);
        this.rerouted.delete(a.agentId);
      }
    }
  }

  // ── CG: coverage gap ──────────────────────────────────────────────────────

  private checkCG(domains: DomainStats[]): void {
    for (const d of domains) {
      if (d.gap > GAP_THRESHOLD) {
        const ticks = (this.domainGapTicks.get(d.domain) ?? 0) + 1;
        this.domainGapTicks.set(d.domain, ticks);

        if (ticks >= GAP_TICKS && !this.gapAlerted.has(d.domain)) {
          this.gapAlerted.add(d.domain);
          this.pendingDecisions.push({
            type: "schemaUpdate",
            reason: `Coverage gap in domain "${d.domain}": ${d.coveredBits}/${d.requiredBits} bits covered, gap=${d.gap}, persisting for ${ticks} ticks`,
            qProposal: {
              scope: `schema:test_result:v1`,
              params: { coverage_alert_domain: d.domain, gap: d.gap },
            },
            meta: { domain: d.domain, coveredBits: d.coveredBits, requiredBits: d.requiredBits, ticks },
          });
        }
      } else {
        this.domainGapTicks.set(d.domain, 0);
        this.gapAlerted.delete(d.domain);
      }
    }
  }

  // ── RC: retroactive re-observation trigger ────────────────────────────────

  private checkRC(agents: AgentStats[]): void {
    if (this.replayEmitted) return;

    // Overall pass rate across all agents in this tick
    const total = agents.reduce((s, a) => s + a.eventCount, 0);
    const passes = agents.reduce((s, a) => s + a.passRate * a.eventCount, 0);
    const overallRate = total > 0 ? passes / total : 1;

    if (overallRate >= REPLAY_TRIGGER_FLOOR && overallRate < REPLAY_TRIGGER_CEIL) {
      this.replayBandTicks++;
      if (this.replayBandTicks >= 3) {
        this.replayEmitted = true;
        this.pendingDecisions.push({
          type: "replayRequest",
          reason: `Overall pass rate ${(overallRate * 100).toFixed(1)}% in suspect band [${(REPLAY_TRIGGER_FLOOR * 100).toFixed(0)}%–${(REPLAY_TRIGGER_CEIL * 100).toFixed(0)}%) for ${this.replayBandTicks} ticks — requesting fine-window re-observation`,
          qProposal: {
            scope: "observe:test_result:v1#fine",
            params: { window_ms: REPLAY_FINE_WINDOW_MS },
          },
          meta: { overallPassRate: overallRate, targetWindowMs: REPLAY_FINE_WINDOW_MS },
        });
      }
    } else {
      this.replayBandTicks = 0;
    }
  }
}
