/**
 * RetentionBuffer — the freshness zone of the lighthouse retention model
 * (Phase 0 Step 2).
 *
 * Sits on IngestionBus.tap (the core's read-only seam) and keeps raw events for
 * retention_window_ms so a past segment can be re-observed under a different
 * $Q[observe] lens after the fact. The core holds no buffer — this is where the
 * lighthouse builds one. dcp-wrap never names $Q or retention.
 *
 * Two-zone design (user, 2026-05-28): this class is the FRESHNESS ZONE only —
 * full-resolution events inside retention_window_ms, where fine-window recovery
 * of a coarse-window-averaged burst holds. The older REFERENCE ZONE (exponential
 * sparsification, "one sample for old data") is deliberately deferred until real
 * data is seen; the API here is shaped so it can be layered on without changing
 * callers. Philosophy: the pipeline is fast and nothing accumulates unbounded —
 * the freshness zone is time-bounded; anything heavier belongs outside.
 */

import { applyLens, type LensEvent, type LensResult } from "./lens.js";
import type { QObserveParams } from "./q-registry.js";

/** Extract a retained event from a raw record. Domain-specific → injected. */
export type EventExtractor<T = unknown> = (raw: T, schemaId: string) => LensEvent | null;

export interface RetentionBufferOptions {
  /** Freshness-zone width. Events older than now - this are evicted. */
  retentionWindowMs: number;
  /** Clock, injected for deterministic tests. Defaults to Date.now. */
  now?: () => number;
}

export class RetentionBuffer<T = unknown> {
  private readonly events: LensEvent[] = [];
  private readonly extract: EventExtractor<T>;
  private retentionWindowMs: number;
  private readonly now: () => number;

  constructor(extractor: EventExtractor<T>, opts: RetentionBufferOptions) {
    if (opts.retentionWindowMs <= 0) throw new RangeError("retentionWindowMs must be positive");
    this.extract = extractor;
    this.retentionWindowMs = opts.retentionWindowMs;
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
    if (drop > 0) this.events.splice(0, drop);
  }

  /** Number of retained events (freshness zone). */
  size(): number {
    return this.events.length;
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
   * Copy of retained events in [fromTs, toTs] (inclusive), sorted by ts.
   * Omit bounds to take the whole freshness zone.
   */
  segment(fromTs = -Infinity, toTs = Infinity): LensEvent[] {
    return this.events
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
