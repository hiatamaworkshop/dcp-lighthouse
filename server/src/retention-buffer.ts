/**
 * RetentionBuffer — the freshness zone of the lighthouse retention model
 * (Phase 0 Step 2).
 *
 * Sits on IngestionBus.tap (the core's read-only seam) and keeps raw events for
 * retention_window_ms so a past segment can be re-observed under a different
 * $Q[observe] lens after the fact. The core holds no buffer — this is where the
 * lighthouse builds one. dcp-wrap never names $Q or retention.
 *
 * Two-zone design (user, 2026-05-28): full-resolution FRESHNESS ZONE inside
 * retention_window_ms, where fine-window recovery of a coarse-window-averaged
 * burst holds, plus an older REFERENCE ZONE (ROADMAP L5, 2026-08-22) that a
 * freshness-zone event is thinned into instead of being discarded outright.
 *
 * Thinning keeps a fixed 1-in-N events and gives the survivor `LensEvent.weight
 * = N` — "the one I kept stands in for the N that aged out" — which is the
 * decay stage's move run in reverse (a real event's contribution scaled up
 * rather than down) through the SAME WindowStat.weights/effectiveN plumbing
 * lens.ts already calibrated for decay (ROADMAP_BRIEF.md 2026-08-18 (5) §B).
 * No parallel statistic, no new comparator model.
 *
 * `count` is never inflated to the represented total — a thinned window's
 * `count` stays "how many LensEvent objects are actually here", because that
 * is what isScorable's sample-size gate reads. Only `weight` may say a kept
 * event stands for more than itself.
 *
 * The API is unchanged for callers that do not opt in (no referenceWindowMs/
 * thinningRatio): segment()/replay() reach into the reference zone only when
 * it exists, so every existing caller and test is byte-identical. Philosophy:
 * the pipeline is fast and nothing accumulates unbounded — both zones are
 * time-bounded (the reference zone by its OWN width, evicted the same way the
 * freshness zone is: anchored to its own newest retained event, not wall
 * clock) — anything heavier belongs outside.
 */

import { applyLens, type LensEvent, type LensResult } from "./lens.js";
import type { QObserveParams } from "./q-registry.js";

/** Extract a retained event from a raw record. Domain-specific → injected. */
export type EventExtractor<T = unknown> = (raw: T, schemaId: string) => LensEvent | null;

export interface RetentionBufferOptions {
  /** Freshness-zone width. Events older than now - this are evicted. */
  retentionWindowMs: number;
  /**
   * Reference-zone width (ROADMAP L5). A freshness-zone event that ages out
   * is thinned into this zone instead of discarded, and lives here until it
   * ages out of THIS window (measured from the reference zone's own newest
   * retained event — the same anchoring evict() uses for the freshness zone).
   * Must be given together with `thinningRatio`, or not at all — the reference
   * zone is opt-in and off by default (byte-identical for every existing caller).
   */
  referenceWindowMs?: number;
  /**
   * Keep 1 in this many freshness-zone events that age out; the survivor's
   * `weight` is set to this ratio. Must be an integer >= 2 — a ratio of 1
   * would not be thinning, and would put weight-1 events into a zone the rest
   * of the design treats as "always weighted" (isReferenceUsable and callers
   * distinguish zones by that, not by a separate flag).
   */
  thinningRatio?: number;
  /** Clock, injected for deterministic tests. Defaults to Date.now. */
  now?: () => number;
}

export class RetentionBuffer<T = unknown> {
  private readonly events: LensEvent[] = [];
  private readonly referenceEvents: LensEvent[] = [];
  private readonly extract: EventExtractor<T>;
  private retentionWindowMs: number;
  private readonly referenceWindowMs?: number;
  private readonly thinningRatio?: number;
  private thinCounter = 0;
  private readonly now: () => number;

  constructor(extractor: EventExtractor<T>, opts: RetentionBufferOptions) {
    if (opts.retentionWindowMs <= 0) throw new RangeError("retentionWindowMs must be positive");
    const { referenceWindowMs, thinningRatio } = opts;
    if ((referenceWindowMs === undefined) !== (thinningRatio === undefined)) {
      throw new RangeError("referenceWindowMs and thinningRatio must be set together, or not at all");
    }
    if (referenceWindowMs !== undefined && referenceWindowMs <= 0) {
      throw new RangeError("referenceWindowMs must be positive");
    }
    if (thinningRatio !== undefined && (!Number.isInteger(thinningRatio) || thinningRatio < 2)) {
      throw new RangeError("thinningRatio must be an integer >= 2");
    }
    this.extract = extractor;
    this.retentionWindowMs = opts.retentionWindowMs;
    this.referenceWindowMs = referenceWindowMs;
    this.thinningRatio = thinningRatio;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Tap handler — wire via `bus.tap(buffer.observe)`. Read-only: it copies out a
   * LensEvent and never mutates the record or affects routing. Non-extractable
   * records (extractor returns null) are skipped.
   */
  readonly observe = (raw: T, schemaId: string): void => {
    const ev = this.extract(raw, schemaId);
    if (ev === null) return;
    this.events.push(ev);
    this.evict();
  };

  /** Drop events older than the freshness window relative to the latest event. */
  private evict(): void {
    // Anchor eviction to the newest event's ts, not wall-clock: replayed/late
    // events should not be evicted just because wall time moved on. The freshness
    // zone is "the last retentionWindowMs of stream time we have seen".
    const newest = this.events.length > 0 ? this.events[this.events.length - 1].ts : this.now();
    const cutoff = newest - this.retentionWindowMs;
    let drop = 0;
    while (drop < this.events.length && this.events[drop].ts < cutoff) drop++;
    if (drop > 0) {
      const aged = this.events.splice(0, drop);
      if (this.thinningRatio !== undefined) this.absorbIntoReference(aged);
    }
  }

  /**
   * Thin a run of freshness-zone events that just aged out: keep 1 in
   * `thinningRatio`, weighted at the ratio, discard the rest. The counter is
   * a running total across every eviction, not reset per call, so a ratio
   * that does not evenly divide one eviction's batch still keeps exactly 1 in
   * N overall rather than biasing toward "keep the last of each batch".
   */
  private absorbIntoReference(aged: readonly LensEvent[]): void {
    const ratio = this.thinningRatio!;
    for (const e of aged) {
      this.thinCounter++;
      if (this.thinCounter % ratio === 0) {
        this.referenceEvents.push({ ...e, weight: ratio });
      }
    }
    this.evictReference();
  }

  /** Drop reference-zone events older than referenceWindowMs, same anchoring as evict(). */
  private evictReference(): void {
    if (this.referenceWindowMs === undefined || this.referenceEvents.length === 0) return;
    const newest = this.referenceEvents[this.referenceEvents.length - 1].ts;
    const cutoff = newest - this.referenceWindowMs;
    let drop = 0;
    while (drop < this.referenceEvents.length && this.referenceEvents[drop].ts < cutoff) drop++;
    if (drop > 0) this.referenceEvents.splice(0, drop);
  }

  /** Number of retained events (freshness zone only — matches what isScorable's count reads). */
  size(): number {
    return this.events.length;
  }

  /** Number of retained events in the reference zone (0 if not configured). */
  referenceSize(): number {
    return this.referenceEvents.length;
  }

  /** Current freshness-zone width. */
  getRetentionWindowMs(): number {
    return this.retentionWindowMs;
  }

  /** Resize the freshness zone at runtime ($Q[pipeline].retention_window_ms). */
  setRetentionWindowMs(ms: number): void {
    if (ms <= 0) throw new RangeError("retentionWindowMs must be positive");
    this.retentionWindowMs = ms;
    this.evict();
  }

  /**
   * Copy of retained events in [fromTs, toTs] (inclusive), sorted by ts —
   * freshness zone plus reference zone (if configured), transparently. This is
   * the "layered on without changing callers" seam: a caller asking for a span
   * that reaches back past the freshness zone now gets thinned, weighted
   * events from the reference zone instead of nothing, with no call-site change.
   * Omit bounds to take everything retained in both zones.
   */
  segment(fromTs = -Infinity, toTs = Infinity): LensEvent[] {
    const source = this.referenceEvents.length > 0
      ? [...this.referenceEvents, ...this.events]
      : this.events;
    return source
      .filter((e) => e.ts >= fromTs && e.ts <= toTs)
      .sort((a, b) => a.ts - b.ts);
  }

  /**
   * Retroactive re-observation: re-aggregate a retained segment through a
   * $Q[observe] lens. This is the Step 2 operation — "re-observe the t=a–b
   * segment at window_ms=W" — a new lens on old data, not a precision gain.
   */
  replay(lens: QObserveParams, fromTs?: number, toTs?: number): LensResult {
    return applyLens(this.segment(fromTs, toTs), lens);
  }
}
