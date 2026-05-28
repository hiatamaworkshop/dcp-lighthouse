/**
 * applyLens — re-observe a retained segment of raw events through a $Q[observe]
 * lens (Phase 0 Step 2).
 *
 * The lens is a synth-style effector chain (user's framing): one source (the
 * retained events) passed through ordered stages. MODEL.md §137 defines the
 * stages: group_by → window_ms → downsample_factor → decay → agg_func. Feeding
 * the same source through a different chain yields a different shape — that *is*
 * retroactive re-observation (MODEL.md §5): a new lens on old data, not a
 * precision gain from repetition.
 *
 * This is the Step 2 wiring-readiness contract: the signature accepts the whole
 * chain (QObserveParams), but only the window_ms stage is implemented for now.
 * Other stages pass through. Adding group_by later means filling a stage here —
 * callers (replay) keep handing over the same observeParams object unchanged.
 *
 * Domain note: Phase 0 runs on a known-truth numeric stream (Minecraft + injected
 * anomalies), so the lens aggregates a numeric field into per-window {mean, count}.
 * pass/fail is the Phase 1 skin and is not modeled here.
 */

import type { QObserveParams } from "./q-registry.js";

/** A retained raw event: a timestamp and a numeric observable value. */
export interface LensEvent {
  ts: number;
  value: number;
}

/** One window's aggregate. */
export interface WindowStat {
  /** window start (inclusive), aligned to windowStart of the segment. */
  windowStart: number;
  /** window end (exclusive). */
  windowEnd: number;
  count: number;
  /** mean of `value` over the window; NaN-free: 0 when count===0 is not emitted. */
  mean: number;
}

/** Result of re-observing a segment: the lens applied and the windows produced. */
export interface LensResult {
  window_ms: number;
  windows: WindowStat[];
}

const DEFAULT_WINDOW_MS = 1000;

/**
 * Apply a $Q[observe] lens to a list of events, producing per-window aggregates.
 *
 * Windows are aligned to the first event's timestamp and are half-open
 * [start, start+window_ms). Empty windows between events are omitted (a hole is
 * visible as a time gap between consecutive WindowStats, which is what CG needs).
 *
 * Events need not be sorted; they are sorted by ts internally so that ts-driven
 * aggregation matches in-order aggregation (the late-arrival guarantee).
 */
export function applyLens(events: readonly LensEvent[], lens: QObserveParams = {}): LensResult {
  const window_ms = lens.window_ms ?? DEFAULT_WINDOW_MS;
  if (window_ms <= 0) throw new RangeError("window_ms must be positive");

  // Stages not yet implemented — declared so the chain is visible and the
  // wiring contract is honest. Filling these is future work (Step 2b+).
  // group_by, downsample_factor, decay, agg_func: pass through.

  if (events.length === 0) return { window_ms, windows: [] };

  const sorted = [...events].sort((a, b) => a.ts - b.ts);
  const origin = sorted[0].ts;

  const windows: WindowStat[] = [];
  let curIdx = -1;
  let sum = 0;
  let count = 0;

  const flush = (): void => {
    if (count === 0) return;
    const windowStart = origin + curIdx * window_ms;
    windows.push({
      windowStart,
      windowEnd: windowStart + window_ms,
      count,
      mean: sum / count,
    });
    sum = 0;
    count = 0;
  };

  for (const ev of sorted) {
    const idx = Math.floor((ev.ts - origin) / window_ms);
    if (idx !== curIdx) {
      flush();
      curIdx = idx;
    }
    sum += ev.value;
    count++;
  }
  flush();

  return { window_ms, windows };
}
