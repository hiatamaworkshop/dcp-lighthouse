/**
 * ShadowBrain — run a second BrainAdapter alongside the authoritative one
 * without letting it touch the pipeline (ROADMAP L3, `BRAIN_MODE=claude`).
 *
 * The pattern is dcp-minecraft's: a new Brain earns the wheel by being watched
 * driving next to the one that already has it. Both see every snapshot; only
 * the primary's decisions are returned from decide(), so nothing the shadow
 * says can reach registry.set or the decision log's action path. What the
 * shadow says is recorded instead.
 *
 * ── Why this does NOT compute a per-tick agreement rate ─────────────────────
 *
 * ClaudeBrain deliberates detached from the tick loop (see claude-brain.ts), so
 * its decisions surface some ticks after the snapshot that provoked them, and
 * it is asked at most once per `minIntervalMs` while RuleBrain is asked every
 * tick. Diffing the two tick-by-tick would therefore measure the cadence
 * difference, not the judgement difference — it would score the shadow as
 * disagreeing on every tick it was not even consulted.
 *
 * So this class records two timestamped streams and summarises them by
 * decision type and subject. Anything stronger (did they flag the SAME
 * regression?) needs a window-tolerant pairing that depends on what is being
 * asked, and inventing one here would bake an unvalidated matching rule into
 * the instrument — the mistake the §12 re-analysis found the first time round.
 */

import type { BrainAdapter, BrainDecision } from "./brain-adapter.js";
import type { STSnapshot } from "./testor-adapter.js";

export interface ShadowEntry {
  /**
   * Monotonic id, never reused. The log is bounded and trims from the front,
   * so array indices shift under any reader that holds one; a consumer
   * tailing the log ("print what I have not printed") must key off this
   * instead, or it goes silent the moment the first trim happens.
   */
  seq: number;
  /** Tick ts at which the decision was DRAINED (not necessarily when it was provoked). */
  ts: number;
  source: "primary" | "shadow";
  decision: BrainDecision;
}

/**
 * Totals over the whole run, NOT over the retained log.
 *
 * The log is bounded and trims from the front, so counting it would quietly
 * turn this into a summary of the tail — and it would do so exactly on the long
 * runs the comparison is for, always in the direction of reporting less
 * disagreement than there was. The counters below are accumulated as decisions
 * are recorded and survive the trim; `getLog()` remains the bounded detail view.
 */
export interface ShadowSummary {
  /** Decision counts by type, per side. */
  primary: Record<string, number>;
  shadow: Record<string, number>;
  /** Subjects (agentId/domain) either side named, for a quick eyeball comparison. */
  primarySubjects: string[];
  shadowSubjects: string[];
  /** Errors thrown by the shadow and swallowed (see observe/decide). */
  shadowErrors: number;
  /** Decisions recorded in total, and how many of those the log still holds. */
  recorded: number;
  retained: number;
}

export interface ShadowBrainOptions {
  /** Cap on retained log entries; oldest are dropped. */
  maxEntries?: number;
  /**
   * Called when the shadow throws. The shadow is not allowed to break the
   * pipeline, but it is also not allowed to fail invisibly — a shadow that
   * silently died would go on looking like a shadow that agreed with
   * everything, which is the most flattering possible failure.
   */
  onShadowError?: (err: Error) => void;
}

const DEFAULT_MAX_ENTRIES = 500;

function subjectOf(d: BrainDecision): string | null {
  const meta = d.meta as { agentId?: string; domain?: string } | undefined;
  if (meta?.agentId !== undefined) return `${d.type}:${meta.agentId}`;
  if (meta?.domain !== undefined) return `${d.type}:${meta.domain}`;
  return null;
}

export class ShadowBrain implements BrainAdapter {
  private readonly log: ShadowEntry[] = [];
  private readonly maxEntries: number;
  private readonly onShadowError?: (err: Error) => void;
  private shadowErrors = 0;
  private lastTs = 0;
  private nextSeq = 0;
  /** Run totals, accumulated at record() time so the log's trim cannot erode them. */
  private totals = { primary: emptyTally(), shadow: emptyTally() };
  private recorded = 0;

  constructor(
    private readonly primary: BrainAdapter,
    private readonly shadow: BrainAdapter,
    opts: ShadowBrainOptions = {},
  ) {
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.onShadowError = opts.onShadowError;
  }

  observe(snapshot: STSnapshot): void {
    this.lastTs = snapshot.ts;
    this.primary.observe(snapshot);
    this.guard(() => this.shadow.observe(snapshot));
  }

  /**
   * Returns the PRIMARY's decisions only. The shadow's are drained on the same
   * tick — draining is what clears its queue, so skipping it would let a
   * disabled-looking shadow accumulate decisions forever — and logged.
   */
  decide(): BrainDecision[] {
    const primaryDecisions = this.primary.decide();
    for (const d of primaryDecisions) this.record("primary", d);

    this.guard(() => {
      for (const d of this.shadow.decide()) this.record("shadow", d);
    });

    return primaryDecisions;
  }

  describe(): string {
    return `ShadowBrain(primary=${this.primary.describe()}, shadow=${this.shadow.describe()})`;
  }

  reset(): void {
    this.log.length = 0;
    this.shadowErrors = 0;
    this.totals = { primary: emptyTally(), shadow: emptyTally() };
    this.recorded = 0;
    resetIfPossible(this.primary);
    this.guard(() => resetIfPossible(this.shadow));
  }

  getLog(): readonly ShadowEntry[] {
    return this.log;
  }

  getSummary(): ShadowSummary {
    return {
      primary: { ...this.totals.primary.types },
      shadow: { ...this.totals.shadow.types },
      primarySubjects: [...this.totals.primary.subjects].sort(),
      shadowSubjects: [...this.totals.shadow.subjects].sort(),
      shadowErrors: this.shadowErrors,
      recorded: this.recorded,
      retained: this.log.length,
    };
  }

  private record(source: "primary" | "shadow", decision: BrainDecision): void {
    const tally = this.totals[source];
    tally.types[decision.type] = (tally.types[decision.type] ?? 0) + 1;
    const subject = subjectOf(decision);
    if (subject !== null) tally.subjects.add(subject);
    this.recorded++;

    this.log.push({ seq: this.nextSeq++, ts: this.lastTs, source, decision });
    if (this.log.length > this.maxEntries) this.log.splice(0, this.log.length - this.maxEntries);
  }

  /**
   * Run shadow work so that a throw is counted and reported but never reaches
   * the tick loop, where an escaping exception would take the server down
   * (index.ts's setInterval callback — the same reasoning as its registry.set
   * catch, applied to the whole shadow rather than one proposal).
   */
  private guard(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.shadowErrors++;
      this.onShadowError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }
}

interface Tally {
  types: Record<string, number>;
  subjects: Set<string>;
}

function emptyTally(): Tally {
  return { types: {}, subjects: new Set() };
}

function resetIfPossible(brain: BrainAdapter): void {
  const maybe = brain as BrainAdapter & { reset?: () => void };
  if (typeof maybe.reset === "function") maybe.reset();
}
