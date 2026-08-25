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
 * reset() deliberately does NOT open that latch. A scenario boundary
 * (/demo/start) arrives while a call is very likely still outstanding — a
 * deliberation runs 5-10s against a 15s floor — and clearing the flag there let
 * a second call start beside the first, which is the one thing the latch exists
 * to prevent. The outstanding call keeps the latch until it returns; what reset
 * changes is that its ANSWER is then thrown away (see `generation`).
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
import type { AskMeta } from "./anthropic-ask.js";
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
  /**
   * The rulebook a proposed lens must pass to become a BrainDecision at all
   * (the "関所 on the Brain side" principle, ROADMAP L3). Defaults to
   * lens.ts's `validateObserveParams`.
   *
   * Injectable because that default is STATIC and some reasons a lens cannot
   * run are not (2026-08-25 review): agg_func:"median" is a legal declaration
   * that throws at aggregation time if the retention buffer hands over
   * reference-zone-thinned — i.e. weighted — events, and whether it does is
   * runtime wiring this class has no business knowing. The owner of that
   * wiring (index.ts) composes the extra refusal and passes it here, so the
   * decision log keeps its invariant: everything in it is something the
   * pipeline could actually have done.
   */
  lensGate?: (lens: QObserveParams) => void;
  clockFn?: () => number;
  /**
   * Called when a deliberation throws. Failures must be loud: a Brain that
   * silently stops thinking looks exactly like a Brain that sees nothing
   * wrong (the blindness/silence distinction the curator draws elsewhere).
   */
  onError?: (err: Error) => void;
}

/**
 * Counters over the LIFETIME of the process, deliberately not cleared by
 * reset(). They answer "how has this model behaved, and what has it cost",
 * which are questions about the model and the account rather than about the
 * scenario currently running. `getDeliberations()` is the scenario-scoped view
 * and IS cleared, so the two disagree after a reset by design.
 */
export interface ClaudeBrainStats {
  deliberations: number;
  failures: number;
  /** Answers that produced no parseable decision list. */
  unparseable: number;
  /** Decisions dropped because their type or their proposed lens was invalid. */
  rejectedProposals: number;
  /**
   * rerouteSchema/quarantine decisions dropped because the curator found no
   * matching per-agent tile at the decision's snapshotTs — the model named
   * an agent but the data didn't back it. A different kind of finding than
   * `rejectedProposals` (malformed request vs. unsubstantiated claim): the
   * former says the model can't write JSON, the latter says its aim was off.
   * Recorded by the caller that runs the gate (index.ts), not by this class —
   * ClaudeBrain never sees curated packages (ROADMAP_BRIEF.md 2026-08-18 (5)
   * §A point 2, the transcription-trap precedent from §12).
   */
  gateRejected: number;
  /**
   * Answers the model DECLINED to give (`stop_reason: "refusal"`), which arrive
   * as an empty string and would otherwise land in `unparseable` — reading as
   * "the model cannot write JSON" when it is "the model would not answer". Not
   * hypothetical: Opus 5 refuses this Brain's prompt 11 times out of 11
   * (ROADMAP_BRIEF.md 2026-08-18). Refusals are counted here AND in
   * `unparseable`, because an empty answer really did fail to parse; this
   * counter says how many of them had a known reason.
   */
  refusals: number;
  /** Answers cut off at the token budget (`stop_reason: "max_tokens"`). */
  truncated: number;
  /** Answers that arrived after a reset() and were thrown away (see `generation`). */
  discarded: number;
  /** The most recent `stop_reason` seen, or null when the seam reports none. */
  lastStopReason: string | null;
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
  /**
   * Per-answer diagnostics, when the askFn reports them (see noteAnswerMeta).
   * Absent under a stub or a recorded transcript, which have no stop_reason.
   */
  answerMeta?: AskMeta;
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
export function parseBrainAnswer(
  text: string,
  replayScope: string,
  lensGate: (lens: QObserveParams) => void = validateObserveParams,
): ParseOutcome {
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
        lensGate(lens);
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
  /** See ClaudeBrainOptions.lensGate. */
  private readonly lensGate: (lens: QObserveParams) => void;
  private readonly clockFn: () => number;
  private readonly onError?: (err: Error) => void;

  private history: STSnapshot[] = [];
  /** Decisions that have arrived and not yet been drained by decide(). */
  private arrived: BrainDecision[] = [];
  private deliberations: DeliberationRecord[] = [];

  private inFlight = false;
  private lastDeliberationAt = Number.NEGATIVE_INFINITY;
  /**
   * Bumped by reset(). A deliberation captures it before awaiting and compares
   * on the way back: an answer from a superseded generation is about a stream
   * that no longer exists and must not reach `arrived`.
   */
  private generation = 0;
  /** Diagnostics for the answer currently being awaited (see noteAnswerMeta). */
  private pendingMeta?: AskMeta;
  /**
   * `inFlight` is NOT held here — getStats() reads the live field. Two copies
   * of one fact is how the curator's scorability test drifted into three
   * disagreeing versions; one is enough.
   */
  private stats: Omit<ClaudeBrainStats, "inFlight"> = {
    deliberations: 0,
    failures: 0,
    unparseable: 0,
    rejectedProposals: 0,
    gateRejected: 0,
    refusals: 0,
    truncated: 0,
    discarded: 0,
    lastStopReason: null,
  };

  constructor(opts: ClaudeBrainOptions) {
    this.askFn = opts.askFn;
    this.minIntervalMs = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.historySize = opts.historySize ?? DEFAULT_HISTORY_SIZE;
    this.observationTicks = opts.observationTicks ?? DEFAULT_OBSERVATION_TICKS;
    this.replayScope = opts.replayScope ?? DEFAULT_REPLAY_SCOPE;
    this.lensGate = opts.lensGate ?? validateObserveParams;
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

  /**
   * Mirrors RuleBrain.reset(): clear per-scenario state, keep nothing stale.
   *
   * "Nothing stale" has to include the answer already in the post. RuleBrain
   * decides synchronously, so for it a reset is complete the moment it returns;
   * this Brain may have a call outstanding, and that call was reasoning about
   * the stream the reset just ended. Bumping the generation makes the answer
   * arrive into a void. Measured before this existed: a `quarantine agent-C`
   * provoked at ts=1000 was drained by the NEXT scenario and, had this Brain
   * been primary rather than shadow, would have reached registry.set.
   *
   * `inFlight` is left alone on purpose — see the class comment. The
   * outstanding call still owns the latch and clears it when it returns, and
   * `lastDeliberationAt` is rewound here so a fresh deliberation starts on the
   * first tick after that, without waiting out the interval floor as well.
   */
  reset(): void {
    this.generation++;
    this.history = [];
    this.arrived = [];
    this.deliberations = [];
    this.lastDeliberationAt = Number.NEGATIVE_INFINITY;
  }

  getStats(): ClaudeBrainStats {
    return { ...this.stats, inFlight: this.inFlight };
  }

  /** Called by the §A gate (index.ts) when it drops an unbacked assertion. */
  recordGateRejection(): void {
    this.stats.gateRejected++;
  }

  /**
   * Record the diagnostics for the answer now being awaited.
   *
   * The AskFn seam returns a bare string so that a stub, a recorded transcript
   * and the live SDK are interchangeable — which means `stop_reason` cannot
   * travel with the answer, and a refusal (zero content blocks, empty text)
   * looks exactly like a model that wrote no JSON. index.ts wires this to
   * makeAnthropicAsk's `onMeta` to close that gap.
   *
   * Association with the right call is safe because at most one call is ever
   * outstanding (the in-flight latch, which reset() no longer opens), and
   * because makeAnthropicAsk reports meta before it resolves the promise —
   * so this always lands before the awaiting deliberation resumes.
   */
  noteAnswerMeta(meta: AskMeta): void {
    this.pendingMeta = meta;
    this.stats.lastStopReason = meta.stopReason;
    if (meta.stopReason === "refusal") this.stats.refusals++;
    else if (meta.stopReason === "max_tokens") this.stats.truncated++;
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
    const generation = this.generation;
    this.inFlight = true;
    this.pendingMeta = undefined;
    const startedAt = this.clockFn();
    const prompt = renderBrainPrompt(this.history, this.observationTicks);

    try {
      const answer = await this.askFn(prompt);
      const answerMeta = this.pendingMeta;
      this.pendingMeta = undefined;
      // Superseded by a reset while we were waiting. The call was issued and
      // billed, so it is counted; its CONTENT belongs to a stream that no
      // longer exists and goes no further. Counting it under `discarded`
      // rather than dropping it silently keeps a run whose scenarios are
      // switched faster than the model answers from looking like a run where
      // the model had nothing to say.
      if (generation !== this.generation) {
        this.stats.discarded++;
        return;
      }
      const { decisions, rejected, unparseable } = parseBrainAnswer(answer, this.replayScope, this.lensGate);

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
        ...(answerMeta !== undefined ? { answerMeta } : {}),
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      // Counted and reported even when superseded: a throw says something about
      // the model or the network, and that is true regardless of which scenario
      // was running. Only the per-scenario RECORD is withheld.
      this.stats.failures++;
      this.onError?.(error);
      if (generation !== this.generation) {
        this.stats.discarded++;
        return;
      }
      this.deliberations.push({
        snapshotTs: snapshot.ts,
        latencyMs: this.clockFn() - startedAt,
        decisions: [],
        rawAnswer: "",
        error: error.message,
      });
    } finally {
      // Unconditional: this call owns the latch. Only one deliberation can be
      // outstanding (observe() latches, reset() no longer opens it), so the
      // call that set the flag is always the call that must clear it —
      // making it conditional on the generation would strand the latch closed
      // after a reset and the Brain would never deliberate again.
      this.inFlight = false;
    }
  }
}
