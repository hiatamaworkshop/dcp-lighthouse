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
 *   RC  — an agent pass rate briefly dips into [BRIEF_DIP_FLOOR, REGRESSION_THRESHOLD)
 *          then recovers above REGRESSION_THRESHOLD
 *          → emit replayRequest so RetentionBuffer is re-observed at fine window
 *          Rationale: the coarse live window averages away short dips; fine replay
 *          recovers the burst shape. Trigger on recovery (not on dip) so it fires
 *          exactly when the live view declares "all clear" — the moment that
 *          retroactive re-observation adds the most information.
 */

import type { BrainAdapter, BrainDecision } from "./brain-adapter.js";
import type { STSnapshot, AgentStats, DomainStats } from "./testor-adapter.js";

// ── Thresholds ──────────────────────────────────────────────────────────────

const REGRESSION_THRESHOLD = 0.80;   // pass rate below this = regression suspect
const REGRESSION_TICKS = 3;          // must persist for N ticks to fire
const GAP_THRESHOLD = 4;             // bits: gap larger than this triggers CG
const GAP_TICKS = 5;                 // gap must persist for N ticks

// RC: brief dip zone is [BRIEF_DIP_FLOOR, REGRESSION_THRESHOLD).
// Below BRIEF_DIP_FLOOR the dip is too severe (AR handles the sustained case);
// above REGRESSION_THRESHOLD the agent is healthy. The trigger fires on
// *recovery* from the dip zone, not on entry — so the live view says "all clear"
// and we retroactively inspect the buffer to see what caused the dip.
const BRIEF_DIP_FLOOR = 0.40;        // below this = too severe for brief-dip RC path
const DIP_REQUIRE_TICKS = 2;         // min consecutive ticks in dip zone to confirm a brief dip
                                     // guards against single-tick statistical noise (agent-B σ≈0.04)
const DIP_MAX_TICKS = 4;             // if dip persists > this many ticks, it is AR territory not RC
                                     // prevents AR regression from also emitting replayRequest on recovery
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

  /** Consecutive tick count per agent currently in the brief-dip zone. */
  private readonly agentDipTicks = new Map<string, number>();
  /** Agents with a confirmed brief dip (dipTicks in [DIP_REQUIRE_TICKS, DIP_MAX_TICKS]). */
  private readonly agentDipActive = new Set<string>();
  /** Agents for which replayRequest has already been emitted this session. */
  private readonly agentReplayEmitted = new Set<string>();

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

  /**
   * Reset per-scenario state. Call between scenario runs so each run starts
   * with a clean slate — e.g. so RC can fire again in a second scenario.
   */
  reset(): void {
    this.agentRegressionTicks.clear();
    this.rerouted.clear();
    this.domainGapTicks.clear();
    this.gapAlerted.clear();
    this.agentDipTicks.clear();
    this.agentDipActive.clear();
    this.agentReplayEmitted.clear();
    this.pendingDecisions = [];
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
  //
  // Fires when an agent's pass rate briefly dips into [BRIEF_DIP_FLOOR,
  // REGRESSION_THRESHOLD) and then recovers above REGRESSION_THRESHOLD.
  // The coarse live window smears the dip over several ticks; the fine-window
  // replay of the RetentionBuffer reveals the original burst shape.

  private checkRC(agents: AgentStats[]): void {
    for (const a of agents) {
      const inDipZone =
        a.passRate >= BRIEF_DIP_FLOOR && a.passRate < REGRESSION_THRESHOLD;

      if (inDipZone) {
        const ticks = (this.agentDipTicks.get(a.agentId) ?? 0) + 1;
        this.agentDipTicks.set(a.agentId, ticks);

        if (ticks >= DIP_REQUIRE_TICKS && ticks <= DIP_MAX_TICKS) {
          // Confirmed brief dip (not noise, not AR-length)
          this.agentDipActive.add(a.agentId);
        } else if (ticks > DIP_MAX_TICKS) {
          // Sustained: not "brief" anymore — AR territory, cancel RC tracking
          this.agentDipActive.delete(a.agentId);
        }
      } else if (
        a.passRate >= REGRESSION_THRESHOLD &&
        this.agentDipActive.has(a.agentId)
      ) {
        // Recovery from confirmed brief dip: emit replayRequest once per session
        this.agentDipTicks.set(a.agentId, 0);
        this.agentDipActive.delete(a.agentId);
        if (!this.agentReplayEmitted.has(a.agentId)) {
          this.agentReplayEmitted.add(a.agentId);
          this.pendingDecisions.push({
            type: "replayRequest",
            reason: `Agent ${a.agentId} recovered from a brief pass-rate dip — requesting fine-window re-observation to recover burst shape averaged by coarse window`,
            qProposal: {
              scope: "observe:test_result:v1#fine",
              params: { window_ms: REPLAY_FINE_WINDOW_MS },
            },
            meta: { agentId: a.agentId, targetWindowMs: REPLAY_FINE_WINDOW_MS },
          });
        }
      } else {
        // Below BRIEF_DIP_FLOOR (too severe) or healthy without active dip: reset state
        this.agentDipTicks.set(a.agentId, 0);
        this.agentDipActive.delete(a.agentId);
      }
    }
  }
}
