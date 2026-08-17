/**
 * ClaudeBrain — an LLM BrainAdapter (ROADMAP L3, the 本丸).
 *
 * RuleBrain encodes three hand-written rules. This one hands the observation
 * state to a model and lets it choose, including which LENS to look through:
 * the point of L3 is not "an LLM can classify a dip" but "an LLM operates
 * $Q" — proposing a re-observation of retained raw data through a different
 * window / grouping / decay than the one that produced the view it was shown.
 *
 * ── Why decide() can return decisions from an EARLIER tick ──────────────────
 *
 * BrainAdapter.decide() is synchronous and the tick loop runs at 1s; a model
 * call is neither. Rather than change the interface for one implementation
 * (RuleBrain, dashboard, and the E2E tests all rely on it), deliberation runs
 * detached: observe() may START a call, and decide() drains whatever has
 * ARRIVED since it was last called. So a decision surfaces one or more ticks
 * after the snapshot that provoked it, and it names the ts it was reasoning
 * about (`meta.snapshotTs`) rather than the tick that emitted it. That lag is
 * real and is not hidden — a Brain that deliberates takes time to answer.
 *
 * ── Two guards, both about spend ────────────────────────────────────────────
 *
 * At TICK_MS=1000 an unguarded implementation would issue one API call per
 * second for as long as the server is up. `minIntervalMs` sets the floor
 * between deliberations and an in-flight latch means a slow call never stacks
 * a second one behind it.
 *
 * ── The proposal boundary ───────────────────────────────────────────────────
 *
 * index.ts already notes that an LLM Brain writing $Q is the caller most
 * likely to propose a lens the rulebook refuses, and catches the throw from
 * registry.set. That catch is the last line, not the first: a proposal whose
 * lens cannot pass lens.ts's validator is rejected HERE and never becomes a
 * BrainDecision, so the decision log records actions that could actually be
 * taken. Rejections are counted (`stats.rejectedProposals`) rather than
 * silently dropped — a model that keeps proposing invalid lenses is a finding,
 * not noise.
 *
 * The askFn seam is ab-harness.ts's, for the same reason: the entire module is
 * testable without touching the network, and the model contact point can be
 * swapped (direct SDK via anthropic-ask.ts, a stub, a recorded transcript).
 */

import type { AskFn } from "./ab-harness.js";
import type { BrainAdapter, BrainDecision, BrainDecisionType } from "./brain-adapter.js";
import type { STSnapshot } from "./testor-adapter.js";
import type { QObserveParams } from "./q-registry.js";
import { validateObserveParams } from "./lens.js";

// ── Configuration ───────────────────────────────────────────────────────────

/** Default floor between deliberations. At TICK_MS=1000 this is 1 call per 15 ticks. */
const DEFAULT_MIN_INTERVAL_MS = 15_000;

/** Snapshots retained to build the reference/observation contrast in the prompt. */
const DEFAULT_HISTORY_SIZE = 30;

/** Ticks rendered individually as the OBSERVATION block; the rest form the REFERENCE. */
const DEFAULT_OBSERVATION_TICKS = 5;

/** Scope a replayRequest proposal is written to, matching RuleBrain's. */
const DEFAULT_REPLAY_SCOPE = "observe:test_result:v1#fine";

const DECISION_TYPES: readonly BrainDecisionType[] = [
  "rerouteSchema",
  "schemaUpdate",
  "replayRequest",
  "quarantine",
  "noAction",
];

export interface ClaudeBrainOptions {
  /** Model contact point. Injected so tests never make a network call. */
  askFn: AskFn;
  /** Minimum ms between deliberations (spend guard). */
  minIntervalMs?: number;
  /** Snapshots kept for the reference/observation contrast. */
  historySize?: number;
  /** How many of the most recent ticks are rendered individually. */
  observationTicks?: number;
  /** $Q scope a replayRequest is proposed against. */
  replayScope?: string;
  clockFn?: () => number;
  /**
   * Called when a deliberation throws. Failures must be loud: a Brain that
   * silently stops thinking looks exactly like a Brain that sees nothing
   * wrong (the blindness/silence distinction the curator draws elsewhere).
   */
  onError?: (err: Error) => void;
}

export interface ClaudeBrainStats {
  deliberations: number;
  failures: number;
  /** Answers that produced no parseable decision list. */
  unparseable: number;
  /** Decisions dropped because their type or their proposed lens was invalid. */
  rejectedProposals: number;
  /** True while a call is outstanding. */
  inFlight: boolean;
}

/** One completed deliberation, kept for the dashboard / shadow comparison. */
export interface DeliberationRecord {
  snapshotTs: number;
  /** ms between issuing the call and its answer arriving. */
  latencyMs: number;
  decisions: BrainDecision[];
  /** Raw answer text, so an unparseable response can be inspected rather than guessed at. */
  rawAnswer: string;
  error?: string;
}

// ── Prompt rendering ────────────────────────────────────────────────────────

const PREAMBLE = `You are the Brain of an observation pipeline watching a stream of automated test results.
Several coding agents (agent-A..agent-D) emit test outcomes; each event is pass=1 or fail=0, so a pass rate is a window mean.
Coverage is tracked over a fixed 256-bit area space grouped into domains (auth, payment, ui, utils).

You are shown a REFERENCE period (older, treat as representative of normal) and an OBSERVATION period (most recent ticks).
Decide what, if anything, the pipeline should do.

Available decisions:
- rerouteSchema  send an agent's output to an audit pipeline. Requires "agentId".
- schemaUpdate   raise attention on a domain's coverage target. Requires "domain".
- replayRequest  re-observe RETAINED RAW DATA through a different lens. Requires "lens".
- quarantine     isolate a flaky agent. Requires "agentId".
- noAction       nothing warrants action.

About replayRequest: the pipeline keeps raw events, so a period that looks flat through
one lens can be re-observed through another. This is not re-running anything and not
smoothing an estimate — it is the same retained data viewed differently. A short, deep
dip in one agent is averaged away both by a wide window AND by mixing four agents
together, so recovering it usually needs both a narrower window_ms and group_by.

Lens ($Q[observe]) fields you may set:
  window_ms          positive ms per window
  group_by           array of key names, e.g. ["agentId"]
  downsample_factor  positive integer; merge N consecutive windows into one
  align              "epoch" or "first_event"
  origin             number; phase of the epoch grid
  decay              "step(cutoff=now-60s)" or "exp(tau=300s)"
  decay_anchor       "segment_end" or "now"
You may also set "fromTs" and "toTs" on a replayRequest to bound which retained
interval is re-observed. Use timestamps from the data below.

Respond with ONLY a JSON object, no other text:
{"decisions": [{"type": "<one of the above>", "reason": "<one or two sentences naming what in the data drove this>", "agentId": "<if applicable>", "domain": "<if applicable>", "lens": {<if replayRequest>}, "fromTs": <optional>, "toTs": <optional>}]}
Return {"decisions": [{"type": "noAction", "reason": "..."}]} if nothing warrants action.`;

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * Render the snapshot history as a reference/observation contrast.
 *
 * Exported because the prompt is the experiment: L3's claim is about what an
 * LLM does with the observation state, and a claim about a prompt that cannot
 * be inspected in a test is not checkable.
 */
export function renderBrainPrompt(
  history: readonly STSnapshot[],
  observationTicks: number,
): string {
  if (history.length === 0) return `${PREAMBLE}\n\n(no observations yet)`;

  const splitAt = Math.max(0, history.length - observationTicks);
  const reference = history.slice(0, splitAt);
  const observation = history.slice(splitAt);
  const latest = history[history.length - 1];

  const agentIds = [...new Set(history.flatMap((s) => s.agents.map((a) => a.agentId)))].sort();

  const refBlock =
    reference.length > 0
      ? agentIds
          .map((id) => {
            const rates = reference.flatMap((s) =>
              s.agents.filter((a) => a.agentId === id).map((a) => a.passRate),
            );
            const events = reference.reduce(
              (n, s) => n + (s.agents.find((a) => a.agentId === id)?.eventCount ?? 0),
              0,
            );
            return `  ${id} pass=${mean(rates).toFixed(3)} over ${rates.length} tick(s), ${events} event(s)`;
          })
          .join("\n")
      : "  (none yet — the observation period is all the history there is)";

  const obsBlock = observation
    .map((s) => {
      const per = agentIds
        .map((id) => {
          const a = s.agents.find((x) => x.agentId === id);
          return a === undefined ? `${id}=-` : `${id}=${a.passRate.toFixed(3)}`;
        })
        .join(" ");
      return `  ts=${s.ts} ${per}`;
    })
    .join("\n");

  const coverage = latest.domains
    .map((d) => `  ${d.domain} covered ${d.coveredBits}/${d.requiredBits}, gap ${d.gap}`)
    .join("\n");

  return `${PREAMBLE}

=== Stream: test_result:v1 ===
Current tick ts=${latest.ts}.

REFERENCE (${reference.length} tick(s) before the observation period):
${refBlock}

OBSERVATION (most recent ${observation.length} tick(s), newest last):
${obsBlock}

COVERAGE (current tick):
${coverage}`;
}

// ── Answer parsing ──────────────────────────────────────────────────────────

interface ParseOutcome {
  decisions: BrainDecision[];
  /** Entries dropped for an unknown type, a missing field, or an invalid lens. */
  rejected: number;
  /** True when no decision list could be extracted at all. */
  unparseable: boolean;
}

function asLens(raw: unknown): QObserveParams | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  return raw as QObserveParams;
}

/**
 * Turn a model answer into decisions, dropping anything the pipeline could not
 * act on.
 *
 * Tolerant about FORM (bare JSON, fenced, or embedded in prose — same
 * extraction as ab-harness.parseAnswer, because the same models answer both)
 * and strict about CONTENT. A decision naming a type the pipeline does not
 * have, or carrying a lens lens.ts would refuse, is not a decision; letting it
 * through would put an unexecutable proposal in the log next to real ones.
 */
export function parseBrainAnswer(text: string, replayScope: string): ParseOutcome {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return { decisions: [], rejected: 0, unparseable: true };

  let obj: unknown;
  try {
    obj = JSON.parse(text.slice(start, end + 1));
  } catch {
    return { decisions: [], rejected: 0, unparseable: true };
  }
  if (typeof obj !== "object" || obj === null) return { decisions: [], rejected: 0, unparseable: true };

  const list = (obj as Record<string, unknown>).decisions;
  if (!Array.isArray(list)) return { decisions: [], rejected: 0, unparseable: true };

  const decisions: BrainDecision[] = [];
  let rejected = 0;

  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) { rejected++; continue; }
    const rec = entry as Record<string, unknown>;

    const type = rec.type;
    if (typeof type !== "string" || !DECISION_TYPES.includes(type as BrainDecisionType)) {
      rejected++;
      continue;
    }
    const reason = typeof rec.reason === "string" && rec.reason.trim() !== ""
      ? rec.reason.trim()
      : null;
    if (reason === null) { rejected++; continue; }

    const agentId = typeof rec.agentId === "string" ? rec.agentId : undefined;
    const domain = typeof rec.domain === "string" ? rec.domain : undefined;

    // Decisions that name no subject cannot be acted on: "reroute an agent"
    // without saying which one is not a proposal, it is a sentiment.
    if ((type === "rerouteSchema" || type === "quarantine") && agentId === undefined) { rejected++; continue; }
    if (type === "schemaUpdate" && domain === undefined) { rejected++; continue; }

    const decision: BrainDecision = { type: type as BrainDecisionType, reason };
    const meta: Record<string, unknown> = {};
    if (agentId !== undefined) meta.agentId = agentId;
    if (domain !== undefined) meta.domain = domain;

    if (type === "replayRequest") {
      const lens = asLens(rec.lens);
      if (lens === null) { rejected++; continue; }
      try {
        validateObserveParams(lens);
      } catch {
        // The rulebook refused this lens. Counting it and moving on keeps a
        // bad proposal from costing the other decisions in the same answer.
        rejected++;
        continue;
      }
      const params: Record<string, unknown> = { ...lens };
      if (typeof rec.fromTs === "number" && Number.isFinite(rec.fromTs)) params.fromTs = rec.fromTs;
      if (typeof rec.toTs === "number" && Number.isFinite(rec.toTs)) params.toTs = rec.toTs;
      decision.qProposal = { scope: replayScope, params };
      meta.lens = lens;
      if (params.fromTs !== undefined) meta.fromTs = params.fromTs;
      if (params.toTs !== undefined) meta.toTs = params.toTs;
    }

    decision.meta = meta;
    decisions.push(decision);
  }

  return { decisions, rejected, unparseable: false };
}

// ── ClaudeBrain ─────────────────────────────────────────────────────────────

export class ClaudeBrain implements BrainAdapter {
  private readonly askFn: AskFn;
  private readonly minIntervalMs: number;
  private readonly historySize: number;
  private readonly observationTicks: number;
  private readonly replayScope: string;
  private readonly clockFn: () => number;
  private readonly onError?: (err: Error) => void;

  private history: STSnapshot[] = [];
  /** Decisions that have arrived and not yet been drained by decide(). */
  private arrived: BrainDecision[] = [];
  private deliberations: DeliberationRecord[] = [];

  private inFlight = false;
  private lastDeliberationAt = Number.NEGATIVE_INFINITY;
  private stats: ClaudeBrainStats = {
    deliberations: 0,
    failures: 0,
    unparseable: 0,
    rejectedProposals: 0,
    inFlight: false,
  };

  constructor(opts: ClaudeBrainOptions) {
    this.askFn = opts.askFn;
    this.minIntervalMs = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.historySize = opts.historySize ?? DEFAULT_HISTORY_SIZE;
    this.observationTicks = opts.observationTicks ?? DEFAULT_OBSERVATION_TICKS;
    this.replayScope = opts.replayScope ?? DEFAULT_REPLAY_SCOPE;
    this.clockFn = opts.clockFn ?? Date.now;
    this.onError = opts.onError;
  }

  observe(snapshot: STSnapshot): void {
    this.history.push(snapshot);
    if (this.history.length > this.historySize) {
      this.history = this.history.slice(this.history.length - this.historySize);
    }
    const now = this.clockFn();
    if (this.inFlight) return;
    if (now - this.lastDeliberationAt < this.minIntervalMs) return;
    this.lastDeliberationAt = now;
    void this.deliberate(snapshot);
  }

  /**
   * Drain decisions that have arrived. Returns [] on the ticks where the model
   * is still thinking — which is most of them, by design.
   */
  decide(): BrainDecision[] {
    if (this.arrived.length === 0) return [];
    const out = this.arrived;
    this.arrived = [];
    return out;
  }

  describe(): string {
    return `ClaudeBrain (LLM, min interval ${this.minIntervalMs}ms, history ${this.historySize} ticks)`;
  }

  /** Mirrors RuleBrain.reset(): clear per-scenario state, keep nothing stale. */
  reset(): void {
    this.history = [];
    this.arrived = [];
    this.deliberations = [];
    this.inFlight = false;
    this.stats.inFlight = false;
    this.lastDeliberationAt = Number.NEGATIVE_INFINITY;
  }

  getStats(): ClaudeBrainStats {
    return { ...this.stats, inFlight: this.inFlight };
  }

  /** Completed deliberations, newest last — for the dashboard and shadow log. */
  getDeliberations(): readonly DeliberationRecord[] {
    return this.deliberations;
  }

  /** The prompt this Brain would send for the current history. */
  currentPrompt(): string {
    return renderBrainPrompt(this.history, this.observationTicks);
  }

  private async deliberate(snapshot: STSnapshot): Promise<void> {
    this.inFlight = true;
    this.stats.inFlight = true;
    const startedAt = this.clockFn();
    const prompt = renderBrainPrompt(this.history, this.observationTicks);

    try {
      const answer = await this.askFn(prompt);
      const { decisions, rejected, unparseable } = parseBrainAnswer(answer, this.replayScope);

      this.stats.deliberations++;
      this.stats.rejectedProposals += rejected;
      if (unparseable) this.stats.unparseable++;

      // noAction is the ABSENCE of an action, and decide() is the action
      // channel — index.ts logs everything it returns. Emitting one per quiet
      // deliberation would bury the real decisions in a log of nothing
      // happening. It is still recorded on the DeliberationRecord, so "the
      // model considered this and chose not to act" stays distinguishable
      // from "the model was never asked".
      const actionable = decisions.filter((d) => d.type !== "noAction");
      for (const d of actionable) {
        d.meta = { ...d.meta, snapshotTs: snapshot.ts, brain: "claude" };
      }
      this.arrived.push(...actionable);

      this.deliberations.push({
        snapshotTs: snapshot.ts,
        latencyMs: this.clockFn() - startedAt,
        decisions,
        rawAnswer: answer,
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.stats.failures++;
      this.deliberations.push({
        snapshotTs: snapshot.ts,
        latencyMs: this.clockFn() - startedAt,
        decisions: [],
        rawAnswer: "",
        error: error.message,
      });
      this.onError?.(error);
    } finally {
      this.inFlight = false;
      this.stats.inFlight = false;
    }
  }
}
