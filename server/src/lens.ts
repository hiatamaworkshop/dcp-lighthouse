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
 * Implemented stages: group_by → window_ms (with the `origin`/`align` grid).
 * downsample_factor, decay and agg_func still pass through — callers (replay)
 * keep handing over the same observeParams object unchanged, so filling them
 * later needs no change at any call site.
 *
 * Domain note: Phase 0 runs on a known-truth numeric stream (Minecraft + injected
 * anomalies), so the lens aggregates a numeric field into per-window {mean, count}.
 * pass/fail is the Phase 1 skin and is not modeled here.
 */

import type { QObserveParams, WindowAlign } from "./q-registry.js";

/** A retained raw event: a timestamp and a numeric observable value. */
export interface LensEvent {
  ts: number;
  value: number;
  /**
   * Grouping attributes, read by the group_by stage (e.g. {agentId: "agent-C"}).
   * Carried on the event rather than re-derived at aggregation time because the
   * lens is deliberately domain-blind: it groups by whatever key names $Q asks
   * for, and the extractor that built the event decides what those names mean.
   */
  keys?: Readonly<Record<string, string>>;
}

/**
 * Minimum event count for a window's mean/std to be treated as statistically
 * meaningful (ROADMAP_BRIEF L1-2, field finding A2: sparse/bursty
 * streams produce low-count windows whose mean is noise, not signal — e.g.
 * count=1 has std=0 and can look like a "perfectly stable" spike/dip).
 *
 * Role since the reference-lens redesign (ROADMAP_BRIEF 2026-07-25): this is
 * the comparator's validity domain — a window below it cannot be *scored*
 * (the z-test is a normal approximation and needs a handful of samples) —
 * but the window still contributes its events to reference pooling. It no
 * longer excludes windows from baseline stats (the old dual role).
 */
export const MIN_VALID_COUNT = 3;

/** One window's aggregate. */
export interface WindowStat {
  /** window start (inclusive), aligned to windowStart of the segment. */
  windowStart: number;
  /** window end (exclusive). */
  windowEnd: number;
  count: number;
  /** mean of `value` over the window; NaN-free: 0 when count===0 is not emitted. */
  mean: number;
  /**
   * Sum of squared values over the window. Carried so windows can be pooled
   * into an event-level reference variance (Bessel-corrected:
   * (Σ sumSq - N*mean²) / (N-1)) without assuming a distribution family —
   * the reference-lens design (ROADMAP_BRIEF.md 2026-07-25) scores each
   * observation window against the reference's pooled variance, not against
   * window-mean spread and not against the window's own variance (the latter
   * was the Welch-form bug fixed the same day).
   */
  sumSq: number;
  /** Whether this window has enough events (>= MIN_VALID_COUNT) to trust its mean. */
  valid: boolean;
}

/** One group's slice of a grouped lens result. */
export interface LensGroup {
  /** Key values in the order $Q's group_by named them, e.g. ["agent-C"]. */
  key: string[];
  /** Canonical label — key.join("|"). Used to pair a group across two lens runs. */
  label: string;
  /** That group's events, windowed on the SAME grid as every other group. */
  windows: WindowStat[];
}

/** Result of re-observing a segment: the lens applied and the windows produced. */
export interface LensResult {
  window_ms: number;
  /**
   * Every event, windowed as one population. Present whether or not group_by
   * was declared, so a grouped lens is strictly additive: existing readers keep
   * seeing the mixed view they always saw.
   */
  windows: WindowStat[];
  /**
   * Per-group windows, present only when the lens declared a non-empty
   * group_by. Sorted by label so two runs enumerate groups in the same order.
   */
  groups?: LensGroup[];
}

const DEFAULT_WINDOW_MS = 1000;

/** Group label for an event missing the key $Q asked to group by. */
export const UNKEYED_GROUP = "(none)";

/**
 * Which grid a lens declares. Explicit `align` wins; otherwise setting an
 * `origin` implies the absolute grid it is the phase of, and a lens that says
 * neither keeps the original first-event anchoring.
 */
export function resolveAlign(lens: QObserveParams): WindowAlign {
  return lens.align ?? (lens.origin !== undefined ? "epoch" : "first_event");
}

/**
 * Start of the window containing `ts` on the grid anchored at `origin`.
 *
 * Exported because the grid has two readers that must agree: applyLens, which
 * places events into windows, and any caller choosing which span to *request*
 * (dashboard.ts's liveSpans). Two independent `floor` expressions that happen
 * to match today is precisely how the anchor-slide bug survived a green suite.
 */
export function floorToWindow(ts: number, window_ms: number, origin = 0): number {
  return origin + Math.floor((ts - origin) / window_ms) * window_ms;
}

/**
 * Apply a $Q[observe] lens to a list of events, producing per-window aggregates.
 *
 * Windows are half-open [start, start+window_ms), placed on the grid the lens
 * declares (see resolveAlign / QObserveParams.align). Empty windows between
 * events are omitted (a hole is visible as a time gap between consecutive
 * WindowStats, which is what CG needs).
 *
 * When the lens declares `group_by`, the events are additionally split by the
 * named key values and each group is windowed separately — on the SAME grid,
 * which is the whole reason the `origin` stage had to land first. Per-group
 * windows anchored to each group's own first event would sit on different
 * grids and could not be paired, so a grouped comparison would be comparing
 * offset windows. With a shared origin, group X's window at t and group Y's
 * window at t cover the same interval by construction.
 *
 * Events need not be sorted; they are sorted by ts internally so that ts-driven
 * aggregation matches in-order aggregation (the late-arrival guarantee).
 */
export function applyLens(events: readonly LensEvent[], lens: QObserveParams = {}): LensResult {
  const window_ms = lens.window_ms ?? DEFAULT_WINDOW_MS;
  if (window_ms <= 0) throw new RangeError("window_ms must be positive");

  // Stages not yet implemented — declared so the chain is visible and the
  // wiring contract is honest. downsample_factor, decay, agg_func: pass through.

  if (events.length === 0) return { window_ms, windows: [] };

  const sorted = [...events].sort((a, b) => a.ts - b.ts);
  const origin = resolveAlign(lens) === "epoch" ? (lens.origin ?? 0) : sorted[0].ts;

  const windows = aggregate(sorted, window_ms, origin);

  const groupBy = lens.group_by;
  if (!groupBy || groupBy.length === 0) return { window_ms, windows };

  const buckets = new Map<string, { key: string[]; events: LensEvent[] }>();
  for (const ev of sorted) {
    const key = groupBy.map((k) => ev.keys?.[k] ?? UNKEYED_GROUP);
    const label = key.join("|");
    let bucket = buckets.get(label);
    if (bucket === undefined) {
      bucket = { key, events: [] };
      buckets.set(label, bucket);
    }
    bucket.events.push(ev);
  }

  const groups: LensGroup[] = [...buckets.entries()]
    .map(([label, b]) => ({ key: b.key, label, windows: aggregate(b.events, window_ms, origin) }))
    .sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));

  return { window_ms, windows, groups };
}

/**
 * Window one already-ts-sorted event list onto the grid anchored at `origin`.
 * Shared by the ungrouped pass and every group so all of them land on one grid.
 */
function aggregate(sorted: readonly LensEvent[], window_ms: number, origin: number): WindowStat[] {
  const windows: WindowStat[] = [];
  let curIdx = -1;
  let sum = 0;
  let sumSq = 0;
  let count = 0;

  const flush = (): void => {
    if (count === 0) return;
    const windowStart = origin + curIdx * window_ms;
    windows.push({
      windowStart,
      windowEnd: windowStart + window_ms,
      count,
      mean: sum / count,
      sumSq,
      valid: count >= MIN_VALID_COUNT,
    });
    sum = 0;
    sumSq = 0;
    count = 0;
  };

  for (const ev of sorted) {
    const idx = Math.floor((ev.ts - origin) / window_ms);
    if (idx !== curIdx) {
      flush();
      curIdx = idx;
    }
    sum += ev.value;
    sumSq += ev.value * ev.value;
    count++;
  }
  flush();

  return windows;
}
