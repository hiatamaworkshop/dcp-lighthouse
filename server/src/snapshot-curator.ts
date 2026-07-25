/**
 * SnapshotCurator ($U) — Brain-facing observation UI (Phase 0 Step 3b).
 *
 * Implements the "snapshot package" artifact described in PILOT_DATA.md §12:
 * a curated set of (shape + label + region numbers) tiles covering characteristic
 * and exceptional moments of the observed window. This is the LLM-facing output;
 * animated charts are the human-facing side (two artifacts, not one).
 *
 * $U selects tiles mechanically — not LLM-driven. Brain then interprets them.
 * This separation matters: $U's job is to surface structure; Brain's job is to
 * decide what to do about it.
 *
 * Shape vocabulary (§12 framing):
 *   spike       — a window whose mean is significantly above the local baseline
 *   gap         — a missing window region (no events; CG signal)
 *   step_up     — a sustained level change detected as a persistent elevation
 *   step_down   — sustained level drop (AR regression framing)
 *   divergence  — when comparing parallel views, a window where views disagree
 *   baseline    — a representative quiet window, included for contrast
 *
 * The snapshot package is the "present" step of the interactive observation loop
 * (MODEL.md §5). When Brain wants finer detail it changes $Q[observe] and
 * requests a new replay — the curator does NOT regenerate; the caller re-runs.
 */

import { MIN_VALID_COUNT, type LensResult, type WindowStat } from "./lens.js";

// ── Shape tags ─────────────────────────────────────────────────────────────

export type ShapeTag =
  | "spike"
  | "dip"
  | "gap"
  | "step_up"
  | "step_down"
  | "divergence"
  | "baseline";

// ── Tile ───────────────────────────────────────────────────────────────────

/**
 * One tile in the snapshot package. A tile represents one characteristic or
 * exceptional moment. The pair (shapeTag + stats) is the currency: the shape
 * directs Brain's attention; the numbers confirm magnitude. Shape alone
 * under-determines magnitude; numbers alone are slow to interpret.
 */
export interface SnapshotTile {
  /** Human- and LLM-readable label, e.g. "spike at t=2000 (3.5×baseline)". */
  label: string;
  /** Mechanical shape classification, so Brain can filter by type. */
  shapeTag: ShapeTag;
  /** Start timestamp of the highlighted region (ms, same epoch as LensEvent.ts). */
  regionStart: number;
  /** End timestamp of the highlighted region. */
  regionEnd: number;
  /**
   * The windows in this region — the exact numbers. For gaps these are the
   * bracketing windows (the gap is the absence between them).
   */
  windows: WindowStat[];
  /** Short narrative for the tile. Intentionally brief: Brain reads, not skims. */
  description: string;
  /**
   * z-score magnitude of the anomaly above baseline, when applicable. Omitted for
   * gap/baseline tiles. Lets Brain compare anomaly sizes across tiles.
   */
  magnitude?: number;
}

// ── Snapshot package ────────────────────────────────────────────────────────

/** The full LLM-facing artifact for one observation pass. */
export interface SnapshotPackage {
  /** Generation timestamp (wall-clock ms). */
  generatedAt: number;
  /** The lens params this package was built under. */
  window_ms: number;
  /**
   * Span of the observed data: earliest and latest window boundaries seen.
   * Missing when result has no windows.
   */
  spanMs?: { start: number; end: number };
  /**
   * The reference population every tile was scored against: the event-count-
   * weighted mean and standard deviation pooled over the reference lens's
   * windows, plus how many reference windows contributed. Brain uses this as
   * the global context before reading individual tiles.
   *
   * Note this is pooled at the *event* level, not the spread of window means:
   * a count=1 window no longer weighs as much as a count=500 one.
   */
  globalStats: { mean: number; stdDev: number; windowCount: number };
  /**
   * False when the reference lens could not support a comparison (empty, or
   * fewer than 2 pooled events, so no variance exists). Detection is then
   * impossible and `tiles` carries no anomalies — which is BLINDNESS, not
   * quiet. Callers must distinguish the two: an empty tile list with
   * referenceUsable=false means "I have no yardstick", and reading it as "all
   * clear" is exactly the failure mode recorded in the silence-vs-blindness
   * field finding. Only reference-derived tiles (spike/dip/step/divergence) are
   * suppressed; gap tiles are structural and still emitted.
   */
  referenceUsable: boolean;
  /** The curated tiles, sorted by regionStart ascending. */
  tiles: SnapshotTile[];
}

// ── Curation options ────────────────────────────────────────────────────────

export interface CurationOptions {
  /**
   * z-score threshold above which a window is classified "spike" (default 2.0).
   * Lower = more sensitive; raise if the stream is noisy.
   */
  spikeZThreshold?: number;
  /**
   * Ratio of mean-shift sustained over at least stepThresholdWindows consecutive
   * windows to classify "step_up" / "step_down" (default 0.3 = 30% shift).
   */
  stepThreshold?: number;
  /**
   * Number of consecutive windows needed to count as a sustained step (default 3).
   */
  stepWindowCount?: number;
  /**
   * Minimum gap duration (ms) to emit a "gap" tile (default 2× window_ms).
   * Gaps shorter than this are noise, not CG.
   */
  minGapMs?: number;
  /**
   * Maximum number of tiles to include. Tiles are sorted by magnitude desc before
   * capping so the most striking moments survive (default 12).
   */
  maxTiles?: number;
  /**
   * Whether to include a baseline tile for contrast (default true). If no
   * anomalies are found, the baseline tile is always included.
   */
  includeBaseline?: boolean;
  /**
   * z-score threshold for divergence across two parallel views (default 1.5).
   * Divergence only runs when `reference` passed to curate() is a distinct
   * LensResult from `observation` (see curate() doc) — comparing a view to
   * itself window-by-window is meaningless.
   */
  divergenceZThreshold?: number;
}

// ── SnapshotCurator ─────────────────────────────────────────────────────────

export class SnapshotCurator {
  private readonly opts: Required<CurationOptions>;

  constructor(opts: CurationOptions = {}) {
    this.opts = {
      spikeZThreshold: opts.spikeZThreshold ?? 2.0,
      stepThreshold: opts.stepThreshold ?? 0.3,
      stepWindowCount: opts.stepWindowCount ?? 3,
      minGapMs: opts.minGapMs ?? 0,  // computed from window_ms when 0
      maxTiles: opts.maxTiles ?? 12,
      includeBaseline: opts.includeBaseline !== false,
      divergenceZThreshold: opts.divergenceZThreshold ?? 1.5,
    };
  }

  /**
   * Curate a snapshot package by comparing an observation lens output against a
   * reference lens output. This is the $U "present" step.
   *
   * Detection is a binary operation, not a property of a single window
   * (ROADMAP_BRIEF.md 2026-07-25 "参照レンズ設計"): a tile is a relation between
   * two lens outputs — `reference` supplies the baseline population (mean +
   * pooled variance) that `observation`'s windows are scored against. Computing
   * that baseline is itself a lens application, so `reference` is a LensResult,
   * not a config value.
   *
   * `reference` defaults to `observation` — self-reference is a legitimate
   * declared comparison (accumulate stats over the same windows being scored),
   * not a special case. Callers that want a reproducible, non-drifting baseline
   * (e.g. RC replay re-scoring a flagged interval) pass an explicit `reference`
   * segment instead.
   *
   * Algorithm:
   *  1. Pool reference windows into {mean, variance, count} (Bessel-corrected,
   *     weighted by each window's own event count — not the spread of window
   *     means).
   *  2. Score each observation window via a two-sample standard error derived
   *     from both the window's own variance and the reference's pooled variance
   *     (Welch-style). Low-count windows naturally get unresolvable (NaN)
   *     standard error and can never cross a threshold — this subsumes the old
   *     MIN_VALID_COUNT gate without a special case.
   *  3. Detect sustained step changes the same way, over window runs.
   *  4. Detect gaps between consecutive observation windows.
   *  5. If `reference` is a distinct LensResult, also detect per-window
   *     divergence (paired by windowStart).
   *  6. Pick one baseline tile (window closest to the reference mean).
   *  7. Sort by magnitude desc, cap at maxTiles.
   */
  curate(observation: LensResult, reference: LensResult = observation): SnapshotPackage {
    const { windows, window_ms } = observation;
    const now = Date.now();

    const refStats = poolStats(reference.windows);
    // A reference with no variance to offer cannot ground any comparison. Say so
    // explicitly rather than returning an empty tile list that reads as "quiet".
    const referenceUsable = refStats.count >= 2 && Number.isFinite(refStats.variance);
    const globalStats = {
      mean: refStats.mean,
      stdDev: referenceUsable ? Math.sqrt(refStats.variance) : 0,
      windowCount: reference.windows.length,
    };
    const minGapMs = this.opts.minGapMs > 0 ? this.opts.minGapMs : window_ms * 2;

    const tiles: SnapshotTile[] = [];

    // ── 1. Spikes and dips ────────────────────────────────────
    // Each window is scored against the reference population via a standard
    // error built from the reference's variance and the window's event count.
    //
    // MIN_VALID_COUNT is applied here as the z-test's validity domain, not as a
    // noise filter: the score is a normal approximation, which needs a handful
    // of samples to mean anything. Note what changed from the pre-2026-07-25
    // design — the window is no longer *excluded from the population*, it only
    // cannot be *scored*. It still contributes its events to any reference that
    // includes it. One uniform precondition on the comparator, rather than a
    // gate that both filtered the baseline and suppressed firing.
    for (const w of windows) {
      if (w.count < MIN_VALID_COUNT) continue;
      const se = comparisonSE(w, refStats);
      if (!(se > 0)) continue;
      const z = (w.mean - refStats.mean) / se;
      if (z >= this.opts.spikeZThreshold) {
        tiles.push({
          label: `spike at t=${w.windowStart} (${w.mean.toFixed(3)} vs baseline ${refStats.mean.toFixed(3)})`,
          shapeTag: "spike",
          regionStart: w.windowStart,
          regionEnd: w.windowEnd,
          windows: [w],
          description: `Window mean ${w.mean.toFixed(3)} is ${z.toFixed(1)}σ above the reference baseline (${refStats.mean.toFixed(3)}). Count: ${w.count}.`,
          magnitude: z,
        });
      } else if (z <= -this.opts.spikeZThreshold) {
        tiles.push({
          label: `dip at t=${w.windowStart} (${w.mean.toFixed(3)} vs baseline ${refStats.mean.toFixed(3)})`,
          shapeTag: "dip",
          regionStart: w.windowStart,
          regionEnd: w.windowEnd,
          windows: [w],
          description: `Window mean ${w.mean.toFixed(3)} is ${Math.abs(z).toFixed(1)}σ below the reference baseline (${refStats.mean.toFixed(3)}). Count: ${w.count}.`,
          magnitude: Math.abs(z),
        });
      }
    }

    // ── 2. Sustained step changes ──────────────────────────────
    const stepTiles = detectSteps(windows, refStats, this.opts.stepThreshold, this.opts.stepWindowCount);
    tiles.push(...stepTiles);

    // ── 3. Gaps ────────────────────────────────────────────────
    for (let i = 0; i + 1 < windows.length; i++) {
      const gap = windows[i + 1].windowStart - windows[i].windowEnd;
      if (gap >= minGapMs) {
        tiles.push({
          label: `gap ${gap}ms at t=${windows[i].windowEnd}–${windows[i + 1].windowStart}`,
          shapeTag: "gap",
          regionStart: windows[i].windowEnd,
          regionEnd: windows[i + 1].windowStart,
          windows: [windows[i], windows[i + 1]],
          description: `No events for ${gap}ms. Before: ${windows[i].mean.toFixed(3)}, after: ${windows[i + 1].mean.toFixed(3)}.`,
        });
      }
    }

    // ── 4. Divergence vs an explicit reference ─────────────────
    // Only meaningful when reference is a genuinely different lens output —
    // comparing observation to itself window-by-window is always zero.
    if (reference !== observation) {
      const divTiles = detectDivergence(windows, reference.windows, this.opts.divergenceZThreshold);
      tiles.push(...divTiles);
    }

    // ── 5. Baseline tile ───────────────────────────────────────
    if (this.opts.includeBaseline && windows.length > 0) {
      const baseWin = pickBaselineWindow(windows, refStats.mean);
      if (baseWin && !tiles.some((t) => t.regionStart === baseWin.windowStart && t.shapeTag !== "baseline")) {
        tiles.push({
          label: `baseline at t=${baseWin.windowStart} (${baseWin.mean.toFixed(3)})`,
          shapeTag: "baseline",
          regionStart: baseWin.windowStart,
          regionEnd: baseWin.windowEnd,
          windows: [baseWin],
          description: `Representative quiet window. Mean: ${baseWin.mean.toFixed(3)}, count: ${baseWin.count}.`,
        });
      }
    }

    // ── 6. Sort by magnitude desc, cap ────────────────────────
    tiles.sort((a, b) => {
      // gaps and divergence before baseline in ties
      const order = { spike: 0, dip: 0, step_up: 1, step_down: 1, divergence: 2, gap: 3, baseline: 4 };
      const magA = a.magnitude ?? 0;
      const magB = b.magnitude ?? 0;
      if (Math.abs(magA - magB) > 0.01) return magB - magA;
      return (order[a.shapeTag] ?? 9) - (order[b.shapeTag] ?? 9);
    });

    const capped = tiles.slice(0, this.opts.maxTiles);

    // Resort final tiles chronologically for readability
    capped.sort((a, b) => a.regionStart - b.regionStart);

    const spanMs =
      windows.length > 0
        ? { start: windows[0].windowStart, end: windows[windows.length - 1].windowEnd }
        : undefined;

    return {
      generatedAt: now,
      window_ms,
      spanMs,
      globalStats,
      referenceUsable,
      tiles: capped,
    };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Pooled aggregate of a reference lens's windows: {mean, variance, count}. */
interface RefStats {
  mean: number;
  /** Bessel-corrected pooled variance over every retained event, weighted by
   * each window's own count — NaN when fewer than 2 events are pooled (spread
   * is unresolvable, not zero). */
  variance: number;
  count: number;
}

/**
 * Pool reference windows into one {mean, variance, count} triple. This is the
 * baseline-population step of detection-as-binary-operation (ROADMAP_BRIEF.md
 * 2026-07-25): unlike averaging window means (which weights a count=1 window
 * the same as a count=500 window), this pools at the event level via each
 * window's own (count, mean, sumSq) so the population stat is honestly
 * count-weighted.
 */
function poolStats(windows: WindowStat[]): RefStats {
  const count = windows.reduce((s, w) => s + w.count, 0);
  if (count === 0) return { mean: 0, variance: 0, count: 0 };
  const sum = windows.reduce((s, w) => s + w.mean * w.count, 0);
  const mean = sum / count;
  if (count < 2) return { mean, variance: NaN, count };
  const sumSq = windows.reduce((s, w) => s + w.sumSq, 0);
  const variance = Math.max(0, (sumSq - count * mean * mean) / (count - 1));
  return { mean, variance, count };
}

/**
 * Standard error for "is this window consistent with the reference?".
 *
 * The null hypothesis names the reference as the population the window's events
 * were drawn from, so the yardstick is the REFERENCE's variance — spread over
 * the window's own event count. Using the window's own variance here (a Welch
 * two-sample form) is wrong for this question and was measurably harmful: for
 * bounded data the within-window variance is a function of the mean, so a window
 * whose mean is extreme necessarily has near-zero variance, collapsing its own
 * standard error exactly when the numerator is largest. Measured on a healthy
 * 0.95-pass stream, an all-pass window scored a constant 6.57σ "spike" at every
 * window size — a false alarm baked into the formula rather than sampled noise
 * (2026-07-25 self-review; see ROADMAP_BRIEF.md).
 *
 * Judging the observation by its own dispersion is also residual self-reference:
 * the very thing the reference-lens design exists to remove.
 *
 * The `1/ref.count` term carries the reference's own estimation uncertainty, so
 * a short reference widens the error bar instead of being trusted absolutely.
 * NaN (reference too small to have a variance) propagates and silences firing.
 */
function comparisonSE(w: WindowStat, ref: RefStats): number {
  return Math.sqrt(ref.variance * (1 / w.count + 1 / ref.count));
}

function detectSteps(
  windows: WindowStat[],
  ref: RefStats,
  threshold: number,
  minRun: number,
): SnapshotTile[] {
  if (windows.length < minRun) return [];
  const tiles: SnapshotTile[] = [];
  let runDir: 1 | -1 | null = null;
  let runStart = 0;

  const emit = (start: number, end: number, dir: 1 | -1): void => {
    const run = windows.slice(start, end + 1);
    const runCount = run.reduce((s, w) => s + w.count, 0);
    const runMean = run.reduce((s, w) => s + w.mean * w.count, 0) / runCount;
    const shift = Math.abs(runMean - ref.mean) / (ref.mean || 1);
    const shapeTag: ShapeTag = dir > 0 ? "step_up" : "step_down";
    const se = Math.sqrt(ref.variance * (1 / runCount + 1 / ref.count));
    const z = se > 0 ? Math.abs(runMean - ref.mean) / se : 0;
    tiles.push({
      label: `${shapeTag} t=${windows[start].windowStart}–${windows[end].windowEnd} (${(shift * 100).toFixed(1)}% shift)`,
      shapeTag,
      regionStart: windows[start].windowStart,
      regionEnd: windows[end].windowEnd,
      windows: run,
      description: `Sustained ${dir > 0 ? "elevation" : "drop"} over ${run.length} windows. Run mean: ${runMean.toFixed(3)}, reference mean: ${ref.mean.toFixed(3)}.`,
      magnitude: z,
    });
  };

  for (let i = 0; i < windows.length; i++) {
    const delta = (windows[i].mean - ref.mean) / (ref.mean || 1);
    const dir: 1 | -1 | null = delta >= threshold ? 1 : delta <= -threshold ? -1 : null;
    if (dir !== null && dir === runDir) {
      // continue run
    } else {
      if (runDir !== null && i - runStart >= minRun) {
        emit(runStart, i - 1, runDir);
      }
      runDir = dir;
      runStart = i;
    }
  }
  if (runDir !== null && windows.length - runStart >= minRun) {
    emit(runStart, windows.length - 1, runDir);
  }

  return tiles;
}

function detectDivergence(
  windowsA: WindowStat[],
  windowsB: WindowStat[],
  zThreshold: number,
): SnapshotTile[] {
  // Build a map from windowStart → mean for B
  const mapB = new Map<number, number>(windowsB.map((w) => [w.windowStart, w.mean]));
  const pairs: { start: number; end: number; diff: number }[] = [];

  for (const wa of windowsA) {
    const mb = mapB.get(wa.windowStart);
    if (mb === undefined) continue;
    pairs.push({ start: wa.windowStart, end: wa.windowEnd, diff: Math.abs(wa.mean - mb) });
  }

  if (pairs.length === 0) return [];

  const diffs = pairs.map((p) => p.diff);
  const meanDiff = diffs.reduce((s, v) => s + v, 0) / diffs.length;
  const stdDiff = Math.sqrt(diffs.reduce((s, v) => s + (v - meanDiff) ** 2, 0) / diffs.length);

  return pairs
    .filter((p) => stdDiff > 0 && (p.diff - meanDiff) / stdDiff >= zThreshold)
    .map((p) => {
      const z = stdDiff > 0 ? (p.diff - meanDiff) / stdDiff : 0;
      const wa = windowsA.find((w) => w.windowStart === p.start)!;
      const mb = mapB.get(p.start)!;
      return {
        label: `divergence at t=${p.start} (diff ${p.diff.toFixed(3)})`,
        shapeTag: "divergence" as ShapeTag,
        regionStart: p.start,
        regionEnd: p.end,
        windows: [wa],
        description: `Views disagree at t=${p.start}: lens-A mean ${wa.mean.toFixed(3)}, lens-B mean ${mb.toFixed(3)}, diff ${p.diff.toFixed(3)} (${z.toFixed(1)}σ over pair baseline).`,
        magnitude: z,
      };
    });
}

function pickBaselineWindow(
  windows: WindowStat[],
  globalMean: number,
): WindowStat | null {
  if (windows.length === 0) return null;
  // Prefer a statistically reliable window as "representative" (L1-2); a
  // low-count window can look artificially close to the mean by chance.
  const reliable = windows.filter((w) => w.valid);
  const pool = reliable.length > 0 ? reliable : windows;
  // Pick the window whose mean is closest to the global mean (most "normal").
  return pool.reduce((best, w) =>
    Math.abs(w.mean - globalMean) < Math.abs(best.mean - globalMean) ? w : best,
  );
}
