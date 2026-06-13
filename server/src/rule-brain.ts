/**
 * RuleBrain — rule-based BrainAdapter (Phase 1 Step 6).
 *
 * Deterministic rules for the three pilot scenarios (AR/CG/RC).
 * Modeled on Minecraft's GameRuleBrain: stateful, tick-driven, proposals only.
 *
 * Rule thresholds live here (Brain code), not in $Q[schema]. A value is promoted
 * to $Q[schema] only if a second Brain implementation needs to read the same
 * threshold (PILOT_DATA.md §11, "Brain write surface"). The per-agent baseline
 * below is the prime candidate for that promotion (deferred to a follow-up).
 *
 * Thresholds are PER-AGENT and learned, not a single global bar. A global 0.80
 * sits only ~1.9σ above a legitimately-low-baseline agent (agent-B at 0.88, with
 * window σ≈0.04), so production noise crosses it ~2.6%/tick and produced spurious
 * regressions during quiet baseline (verified: ~30% of seeds fired falsely).
 * Instead each agent gets an EWMA baseline of its own healthy pass rate;
 * "regression" means a drop of BASELINE_DELTA below *that agent's* learned normal.
 * agent-B's low rate is its baseline, not a perpetual regression.
 * (See ROADMAP_BRIEF 2026-06-11 静穏テスト異議.)
 *
 * Three rules:
 *   AR  — agent pass rate drops BASELINE_DELTA below its learned baseline for
 *          REGRESSION_TICKS → emit rerouteSchema proposal for that agent
 *   CG  — a domain's coverage gap persists for GAP_TICKS consecutive ticks
 *          → emit schemaUpdate proposal
 *   RC  — an agent pass rate briefly dips into [BRIEF_DIP_FLOOR, agentThreshold)
 *          then recovers above its threshold
 *          → emit replayRequest so RetentionBuffer is re-observed at fine window
 *          Rationale: the coarse live window averages away short dips; fine replay
 *          recovers the burst shape. Trigger on recovery (not on dip) so it fires
 *          exactly when the live view declares "all clear" — the moment that
 *          retroactive re-observation adds the most information.
 */

import type { BrainAdapter, BrainDecision } from "./brain-adapter.js";
import type { STSnapshot, AgentStats, DomainStats } from "./testor-adapter.js";

// ── Per-agent baseline (learned) ──────────────────────────────────────────────

const BASELINE_ALPHA = 0.05;         // EWMA weight for the learned baseline.
                                     // Long memory (half-life ≈ 13 ticks) so a real
                                     // regression cannot quickly drag the baseline down
                                     // with it. Baseline is additionally FROZEN while an
                                     // agent is below its threshold (see updateBaselines).
const BASELINE_DELTA = 0.10;         // regression threshold = learned baseline − this.
                                     // agent-C(0.95)→0.85, agent-B(0.88)→0.78. agent-B's
                                     // window noise (σ≈0.04) is >2σ from 0.78 → quiet.
const WARMUP_TICKS = 10;             // ticks observed before an agent's threshold is trusted.
                                     // No AR/RC firing during warmup (no baseline yet).

// ── Thresholds ──────────────────────────────────────────────────────────────

const REGRESSION_TICKS = 2;          // consecutive sub-threshold ticks before AR fires.
                                     // 2 (not 3): with 5s window & 50 evt/s, passRate crosses
                                     // the per-agent threshold ~3–4s after onset; 3 ticks would
                                     // exceed §10's 5s criterion. Per-agent threshold makes this
                                     // safe — a low-baseline agent no longer false-fires (异议).
const GAP_THRESHOLD = 4;             // bits: gap larger than this triggers CG
const GAP_TICKS = 5;                 // gap must persist for N ticks

// RC: brief dip zone is [BRIEF_DIP_FLOOR, agentThreshold).
// Below BRIEF_DIP_FLOOR the dip is too severe (AR handles the sustained case);
// at/above the agent's threshold the agent is healthy. The trigger fires on
// *recovery* from the dip zone, not on entry — so the live view says "all clear"
// and we retroactively inspect the buffer to see what caused the dip.
const BRIEF_DIP_FLOOR = 0.40;        // absolute catastrophe floor: a drop this deep is too
                                     // severe to be a "brief dip" regardless of agent baseline
const DIP_REQUIRE_TICKS = 2;         // min consecutive ticks in dip zone to confirm a brief dip
                                     // guards against single-tick statistical noise (agent-B σ≈0.04)
const DIP_MAX_TICKS = 7;             // if dip persists > this many ticks, it is AR territory not RC.
                                     // 7 (not 4): a 2s burst seen through the 5s adapter window
                                     // depresses the windowed pass rate for ~6–7 ticks, and the
                                     // per-agent threshold widened the dip zone — a legitimate RC
                                     // burst now spans ~6 ticks. A genuinely sustained AR regression
                                     // does not recover, so it never reaches the RC recovery branch
                                     // regardless of this cap.
const REPLAY_FINE_WINDOW_MS = 1000;

// ── RuleBrain ───────────────────────────────────────────────────────────────

export class RuleBrain implements BrainAdapter {
  /** EWMA of each agent's healthy pass rate. Frozen while the agent is below threshold. */
  private readonly agentBaseline = new Map<string, number>();
  /** Ticks observed per agent, for warmup gating. */
  private readonly agentObsCount = new Map<string, number>();

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
    this.updateBaselines(snapshot.agents);
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
   * Reset per-scenario DETECTION state so each scenario run can fire again
   * (e.g. RC in a second scenario). The learned per-agent baselines are
   * deliberately NOT cleared: an agent's normal pass rate is long-lived
   * knowledge, not per-scenario state. Clearing it would force a 10-tick
   * re-warmup on every /demo/start — longer than a scenario's baseline phase —
   * and re-seed the baseline from the anomaly itself, masking the regression.
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

  // ── Per-agent baseline learning ───────────────────────────────────────────
  //
  // Each agent's healthy pass rate is tracked with an EWMA. The baseline is
  // FROZEN while the agent sits below its threshold, so a regression cannot drag
  // its own baseline down (which would silently re-normalize the regression and
  // suppress detection). During warmup the baseline is seeded/updated freely.

  private updateBaselines(agents: AgentStats[]): void {
    for (const a of agents) {
      const obs = this.agentObsCount.get(a.agentId) ?? 0;
      const prev = this.agentBaseline.get(a.agentId);

      if (prev === undefined) {
        // First observation: seed the baseline with it.
        this.agentBaseline.set(a.agentId, a.passRate);
      } else {
        const warming = obs < WARMUP_TICKS;
        const healthy = a.passRate >= prev - BASELINE_DELTA;
        if (warming || healthy) {
          this.agentBaseline.set(
            a.agentId,
            BASELINE_ALPHA * a.passRate + (1 - BASELINE_ALPHA) * prev,
          );
        }
        // else: below threshold — freeze baseline.
      }
      this.agentObsCount.set(a.agentId, obs + 1);
    }
  }

  /**
   * Per-agent regression threshold = learned baseline − BASELINE_DELTA.
   * Returns null while the agent is still in warmup (threshold not yet trusted).
   */
  private thresholdFor(agentId: string): number | null {
    if ((this.agentObsCount.get(agentId) ?? 0) < WARMUP_TICKS) return null;
    const baseline = this.agentBaseline.get(agentId);
    return baseline === undefined ? null : baseline - BASELINE_DELTA;
  }

  // ── AR: agent regression ──────────────────────────────────────────────────

  private checkAR(agents: AgentStats[]): void {
    for (const a of agents) {
      const threshold = this.thresholdFor(a.agentId);
      if (threshold === null) continue; // warmup: no baseline to judge against yet

      if (a.passRate < threshold) {
        const ticks = (this.agentRegressionTicks.get(a.agentId) ?? 0) + 1;
        this.agentRegressionTicks.set(a.agentId, ticks);

        if (ticks >= REGRESSION_TICKS && !this.rerouted.has(a.agentId)) {
          this.rerouted.add(a.agentId);
          const baseline = this.agentBaseline.get(a.agentId)!;
          this.pendingDecisions.push({
            type: "rerouteSchema",
            reason: `Agent ${a.agentId} pass rate ${(a.passRate * 100).toFixed(1)}% dropped below its learned baseline ${(baseline * 100).toFixed(1)}% (threshold ${(threshold * 100).toFixed(1)}%) for ${ticks} ticks`,
            qProposal: {
              scope: `schema:test_result:v1`,
              params: { reroute_agent: a.agentId, destination: "audit" },
            },
            meta: { agentId: a.agentId, passRate: a.passRate, baseline, threshold, ticks },
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
  // agentThreshold) and then recovers above its threshold. The dip-zone upper
  // bound is the same per-agent threshold AR uses; the lower bound is an absolute
  // catastrophe floor. The coarse live window smears the dip over several ticks;
  // the fine-window replay of the RetentionBuffer reveals the original burst shape.

  private checkRC(agents: AgentStats[]): void {
    for (const a of agents) {
      const threshold = this.thresholdFor(a.agentId);
      if (threshold === null) continue; // warmup

      const inDipZone =
        a.passRate >= BRIEF_DIP_FLOOR && a.passRate < threshold;

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
        a.passRate >= threshold &&
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
