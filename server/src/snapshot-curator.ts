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

import type { LensResult, WindowStat } from "./lens.js";

// ── Shape tags ─────────────────────────────────────────────────────────────

export type ShapeTag =
  | "spike"
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
   * Overall shape of the observed window: the mean and std-dev over all window
   * means. Brain uses this as the global context before reading individual tiles.
   */
  globalStats: { mean: number; stdDev: number; windowCount: number };
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
   * Optional second LensResult for divergence detection — when the same stream is
   * observed under two different lenses (parallel overlay), windows where the views
   * disagree strongly are tagged "divergence". Divergence is per-window absolute
   * difference / mean of the two views.
   */
  compareLens?: LensResult;
  /**
   * z-score threshold for divergence across two parallel views (default 1.5).
   */
  divergenceZThreshold?: number;
}

// ── SnapshotCurator ─────────────────────────────────────────────────────────

export class SnapshotCurator {
  private readonly opts: Required<Omit<CurationOptions, "compareLens">> & {
    compareLens?: LensResult;
  };

  constructor(opts: CurationOptions = {}) {
    this.opts = {
      spikeZThreshold: opts.spikeZThreshold ?? 2.0,
      stepThreshold: opts.stepThreshold ?? 0.3,
      stepWindowCount: opts.stepWindowCount ?? 3,
      minGapMs: opts.minGapMs ?? 0,  // computed from window_ms when 0
      maxTiles: opts.maxTiles ?? 12,
      includeBaseline: opts.includeBaseline !== false,
      divergenceZThreshold: opts.divergenceZThreshold ?? 1.5,
      compareLens: opts.compareLens,
    };
  }

  /**
   * Curate a snapshot package from a LensResult. This is the $U "present" step.
   *
   * Algorithm:
   *  1. Compute global stats (mean + std-dev of window means).
   *  2. Detect anomalies per window: spikes, step changes.
   *  3. Detect gaps between consecutive windows.
   *  4. Optionally detect divergence vs compareLens.
   *  5. Pick one baseline tile (median-closest quiet window).
   *  6. Sort by magnitude desc, cap at maxTiles.
   */
  curate(result: LensResult): SnapshotPackage {
    const { windows, window_ms } = result;
    const now = Date.now();

    const globalStats = computeGlobalStats(windows);
    const minGapMs = this.opts.minGapMs > 0 ? this.opts.minGapMs : window_ms * 2;

    const tiles: SnapshotTile[] = [];

    // ── 1. Spikes ──────────────────────────────────────────────
    for (const w of windows) {
      if (globalStats.stdDev === 0) break;
      const z = (w.mean - globalStats.mean) / globalStats.stdDev;
      if (z >= this.opts.spikeZThreshold) {
        tiles.push({
          label: `spike at t=${w.windowStart} (${w.mean.toFixed(3)} vs baseline ${globalStats.mean.toFixed(3)})`,
          shapeTag: "spike",
          regionStart: w.windowStart,
          regionEnd: w.windowEnd,
          windows: [w],
          description: `Window mean ${w.mean.toFixed(3)} is ${z.toFixed(1)}σ above the observed baseline (${globalStats.mean.toFixed(3)}). Count: ${w.count}.`,
          magnitude: z,
        });
      }
    }

    // ── 2. Sustained step changes ──────────────────────────────
    const stepTiles = detectSteps(windows, globalStats, this.opts.stepThreshold, this.opts.stepWindowCount);
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

    // ── 4. Divergence vs compareLens ──────────────────────────
    if (this.opts.compareLens) {
      const divTiles = detectDivergence(
        windows,
        this.opts.compareLens.windows,
        this.opts.divergenceZThreshold,
      );
      tiles.push(...divTiles);
    }

    // ── 5. Baseline tile ───────────────────────────────────────
    if (this.opts.includeBaseline && windows.length > 0) {
      const baseWin = pickBaselineWindow(windows, globalStats.mean);
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
      const order = { spike: 0, step_up: 1, step_down: 1, divergence: 2, gap: 3, baseline: 4 };
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
      tiles: capped,
    };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function computeGlobalStats(windows: WindowStat[]): {
  mean: number;
  stdDev: number;
  windowCount: number;
} {
  if (windows.length === 0) return { mean: 0, stdDev: 0, windowCount: 0 };
  const means = windows.map((w) => w.mean);
  const mean = means.reduce((s, v) => s + v, 0) / means.length;
  const variance = means.reduce((s, v) => s + (v - mean) ** 2, 0) / means.length;
  return { mean, stdDev: Math.sqrt(variance), windowCount: windows.length };
}

function detectSteps(
  windows: WindowStat[],
  global: { mean: number; stdDev: number },
  threshold: number,
  minRun: number,
): SnapshotTile[] {
  if (windows.length < minRun) return [];
  const tiles: SnapshotTile[] = [];
  let runDir: 1 | -1 | null = null;
  let runStart = 0;

  const emit = (start: number, end: number, dir: 1 | -1): void => {
    const run = windows.slice(start, end + 1);
    const runMean = run.reduce((s, w) => s + w.mean, 0) / run.length;
    const shift = Math.abs(runMean - global.mean) / (global.mean || 1);
    const shapeTag: ShapeTag = dir > 0 ? "step_up" : "step_down";
    const z = global.stdDev > 0 ? Math.abs(runMean - global.mean) / global.stdDev : 0;
    tiles.push({
      label: `${shapeTag} t=${windows[start].windowStart}–${windows[end].windowEnd} (${(shift * 100).toFixed(1)}% shift)`,
      shapeTag,
      regionStart: windows[start].windowStart,
      regionEnd: windows[end].windowEnd,
      windows: run,
      description: `Sustained ${dir > 0 ? "elevation" : "drop"} over ${run.length} windows. Run mean: ${runMean.toFixed(3)}, global mean: ${global.mean.toFixed(3)}.`,
      magnitude: z,
    });
  };

  for (let i = 0; i < windows.length; i++) {
    const delta = (windows[i].mean - global.mean) / (global.mean || 1);
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
  // Pick the window whose mean is closest to the global mean (most "normal").
  return windows.reduce((best, w) =>
    Math.abs(w.mean - globalMean) < Math.abs(best.mean - globalMean) ? w : best,
  );
}
