/**
 * A standing history of window summaries — what the variogram null reads as
 * CurationContext.history (ROADMAP_BRIEF.md 2026-10-14 (2) item 2b).
 *
 * The retention buffer keeps 120 s of events and a thinned reference zone
 * behind it. Neither is a history the null was calibrated with: the freshness
 * zone is too short for the lags a comparison spans, and the reference zone's
 * windows carry thinning weights the variogram was never measured under. A
 * window summary (count, mean, sumSq, per group) is a few numbers, so an hour
 * of them costs less than the events of a few seconds.
 *
 * Summaries are made where events leave the freshness zone, BEFORE thinning
 * (RetentionBuffer.onEvict): every stored window is full resolution and
 * unweighted, and it is built by applyLens itself, so it is bit-identical to a
 * replay of the same events. A request is answered from the stored windows
 * plus a replay of the events not yet summarized (the window the cutoff
 * straddles, and the freshness zone after it), on the lens's one epoch grid —
 * so the two meet on a window boundary, without a seam.
 *
 * A lens is tracked from the first time it is asked for (there is no way to
 * know in advance which lens a Brain will replay through). Its history starts
 * there, at the freshness zone's oldest whole window, and grows; a package
 * says how many windows it actually had (comparison.history.windowCount).
 * Events that age out behind a window already summarized — out-of-order
 * arrivals older than the freshness zone — are not folded in, and counted.
 */

import {
  applyLens,
  floorToWindow,
  resolveAlign,
  type LensEvent,
  type LensResult,
  type WindowStat,
} from "./lens.js";
import type { QObserveParams } from "./q-registry.js";

/** Where Comparator reads a variogram history from. */
export interface HistorySource {
  /** Whole windows of `lens` inside the inclusive request [fromTs, toTs]. */
  history(lens: QObserveParams, fromTs: number, toTs: number): LensResult;
}

/** The two RetentionBuffer seams the history needs. */
export interface EvictingSource {
  onEvict(listener: (aged: readonly LensEvent[], cutoff: number) => void): () => void;
  freshSegment(fromTs?: number, toTs?: number): LensEvent[];
}

export interface WindowHistoryOptions {
  /** How far back each lens's stored windows reach, behind the newest summarized one. */
  maxHistoryMs: number;
  /** Lenses tracked at once; the least recently asked-for is dropped beyond this. Default 8. */
  maxLenses?: number;
}

interface Tracked {
  lens: QObserveParams;
  /** Output window width (window_ms × downsample_factor) — the grid summaries are cut on. */
  windowMs: number;
  origin: number;
  /** Every event with ts < storedEnd is in `windows`/`groups`, or arrived before tracking began. */
  storedEnd: number;
  windows: WindowStat[];
  groups: Map<string, { key: string[]; windows: WindowStat[] }>;
  lastUsed: number;
}

export interface WindowHistoryStats {
  lenses: number;
  /** Aged events that fell behind a window already summarized, summed over lenses. */
  lateDropped: number;
}

export class WindowHistory implements HistorySource {
  private readonly tracked = new Map<string, Tracked>();
  /** Aged events not yet in every lens's summaries (ts >= the smallest storedEnd). */
  private pending: LensEvent[] = [];
  /** Highest eviction cutoff seen; -Infinity until the buffer first evicts. */
  private lastCutoff = -Infinity;
  private useCounter = 0;
  private lateDropped = 0;
  private readonly maxHistoryMs: number;
  private readonly maxLenses: number;

  constructor(private readonly source: EvictingSource, opts: WindowHistoryOptions) {
    if (!(Number.isFinite(opts.maxHistoryMs) && opts.maxHistoryMs > 0)) {
      throw new RangeError(`maxHistoryMs must be a positive number of ms, got ${String(opts.maxHistoryMs)}`);
    }
    this.maxHistoryMs = opts.maxHistoryMs;
    this.maxLenses = opts.maxLenses ?? 8;
    source.onEvict((aged, cutoff) => this.absorb(aged, cutoff));
  }

  getMaxHistoryMs(): number {
    return this.maxHistoryMs;
  }

  getStats(): WindowHistoryStats {
    return { lenses: this.tracked.size, lateDropped: this.lateDropped };
  }

  /**
   * Start keeping `lens`'s summaries now (history() does this on first use).
   * Throws for a lens whose windows cannot be summarized once and reused:
   * off an absolute grid, separate requests cut different windows; under
   * decay, a window's weights depend on the segment it was read in; a median
   * or percentile has no summary short of its raw values.
   */
  track(lens: QObserveParams): void {
    this.trackedFor(lens);
  }

  history(lens: QObserveParams, fromTs: number, toTs: number): LensResult {
    const t = this.trackedFor(lens);
    const inside = (w: WindowStat): boolean => w.windowStart >= fromTs && w.windowEnd <= toTs + 1;

    // Not yet summarized: the aged part of the window the cutoff straddles,
    // then the freshness zone. Disjoint — an event is pending or fresh, never both.
    const from = Math.max(fromTs, t.storedEnd);
    const unsummarized = from <= toTs
      ? applyLens(
          [...this.pending.filter((e) => e.ts >= from && e.ts <= toTs), ...this.source.freshSegment(from, toTs)],
          t.lens,
        )
      : { window_ms: t.windowMs, windows: [] as WindowStat[] };

    const windows = [...t.windows.filter(inside), ...unsummarized.windows.filter(inside)];
    const labels = new Set<string>([...t.groups.keys(), ...(unsummarized.groups ?? []).map((g) => g.label)]);
    const result: LensResult = { window_ms: t.windowMs, windows };
    if ((t.lens.group_by?.length ?? 0) > 0) {
      result.groups = [...labels].sort().map((label) => {
        const stored = t.groups.get(label);
        const fresh = unsummarized.groups?.find((g) => g.label === label);
        return {
          key: stored?.key ?? fresh!.key,
          label,
          windows: [...(stored?.windows.filter(inside) ?? []), ...(fresh?.windows.filter(inside) ?? [])],
        };
      });
    }
    return result;
  }

  private trackedFor(lens: QObserveParams): Tracked {
    const normalized = summarizable(lens);
    const key = JSON.stringify(normalized);
    let t = this.tracked.get(key);
    if (t === undefined) {
      const windowMs = (normalized.window_ms ?? 1_000) * (normalized.downsample_factor ?? 1);
      const origin = normalized.origin ?? 0;
      // Events behind the last cutoff are gone at full resolution; the first
      // window whose every event is still here starts at the next boundary.
      const start = this.lastCutoff === -Infinity
        ? -Infinity
        : floorToWindow(this.lastCutoff - 1, windowMs, origin) + windowMs;
      t = { lens: normalized, windowMs, origin, storedEnd: start, windows: [], groups: new Map(), lastUsed: 0 };
      this.tracked.set(key, t);
      if (this.tracked.size > this.maxLenses) {
        let oldest: string | undefined;
        let oldestUse = Infinity;
        for (const [k, v] of this.tracked) {
          if (v !== t && v.lastUsed < oldestUse) {
            oldest = k;
            oldestUse = v.lastUsed;
          }
        }
        if (oldest !== undefined) this.tracked.delete(oldest);
      }
    }
    t.lastUsed = ++this.useCounter;
    return t;
  }

  private absorb(aged: readonly LensEvent[], cutoff: number): void {
    this.lastCutoff = Math.max(this.lastCutoff, cutoff);
    if (this.tracked.size === 0) return;
    // The buffer evicts one or a few events per push, so keep this O(aged)
    // unless something actually completes: sort only when arrivals were out
    // of order, prune only when a lens moved on.
    const lastTs = this.pending.length > 0 ? this.pending[this.pending.length - 1].ts : -Infinity;
    const ordered = aged.every((e, i) => e.ts >= (i === 0 ? lastTs : aged[i - 1].ts));
    for (const e of aged) this.pending.push(e);
    if (!ordered) this.pending.sort((a, b) => a.ts - b.ts);
    let advanced = false;

    for (const t of this.tracked.values()) {
      for (const e of aged) if (e.ts < t.storedEnd) this.lateDropped++;
      const complete = floorToWindow(this.lastCutoff, t.windowMs, t.origin);
      if (!(complete > t.storedEnd)) continue;
      const r = applyLens(this.pending.filter((e) => e.ts >= t.storedEnd && e.ts < complete), t.lens);
      t.windows.push(...r.windows);
      for (const g of r.groups ?? []) {
        let stored = t.groups.get(g.label);
        if (stored === undefined) {
          stored = { key: g.key, windows: [] };
          t.groups.set(g.label, stored);
        }
        stored.windows.push(...g.windows);
      }
      t.storedEnd = complete;
      advanced = true;

      const keepFrom = complete - this.maxHistoryMs;
      t.windows = t.windows.filter((w) => w.windowStart >= keepFrom);
      for (const [label, g] of t.groups) {
        g.windows = g.windows.filter((w) => w.windowStart >= keepFrom);
        if (g.windows.length === 0) t.groups.delete(label);
      }
    }

    if (!advanced) return;
    const needFrom = Math.min(...[...this.tracked.values()].map((t) => t.storedEnd));
    this.pending = this.pending.filter((e) => e.ts >= needFrom);
  }
}

/**
 * The lens fields a summary depends on, or a RangeError for a lens that has
 * no reusable summary (see WindowHistory.track). The normalized form is also
 * the tracking key, so two rows naming the same lens differently — fromTs/toTs
 * riding along, `align` implied by `origin` — share one history.
 */
function summarizable(lens: QObserveParams): QObserveParams {
  if (resolveAlign(lens) !== "epoch") {
    throw new RangeError(`window history needs an absolute grid (align:"epoch"), so windows cut once can be reused`);
  }
  if (lens.decay !== undefined) {
    throw new RangeError(`window history cannot keep a decayed lens: its weights depend on the segment read`);
  }
  if (lens.agg_func !== undefined && lens.agg_func !== "mean") {
    throw new RangeError(`window history keeps mean summaries only, not agg_func "${lens.agg_func}"`);
  }
  return {
    window_ms: lens.window_ms ?? 1_000,
    align: "epoch",
    origin: lens.origin ?? 0,
    ...(lens.group_by !== undefined && lens.group_by.length > 0 ? { group_by: [...lens.group_by] } : {}),
    ...(lens.downsample_factor !== undefined && lens.downsample_factor !== 1
      ? { downsample_factor: lens.downsample_factor }
      : {}),
  };
}
