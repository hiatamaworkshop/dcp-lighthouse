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

import { MIN_VALID_COUNT, type LensGroup, type LensResult, type WindowStat } from "./lens.js";

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
  /**
   * Which group_by group this tile belongs to (LensGroup.label), when the
   * observation lens declared group_by. Absent on tiles from an ungrouped lens
   * and on the package-level baseline tile.
   */
  group?: string;
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
   *
   * `eventCount` is that pooled event total — the yardstick's actual
   * statistical weight, which `windowCount` does not convey (three windows can
   * hold three events or three thousand). It is what the comparator's standard
   * error divides by: `sqrt(var_ref × (1/n_w + 1/n_ref))` inflates by
   * `sqrt(1 + n_w/n_ref)` relative to an unlimited reference, so a reader can
   * tell a yardstick that costs 2% from one that costs 40%. Reported rather
   * than acted on — nothing here changes a score or a threshold; the judgment
   * about whether a thin reference is good enough belongs to whoever reads the
   * package. Made visible after a decayed reference collapsed to 18 events
   * (ROADMAP_BRIEF.md 2026-08-17) with nothing in the package saying so.
   */
  globalStats: { mean: number; stdDev: number; windowCount: number; eventCount: number };
  /**
   * False when the reference lens could not support a comparison (empty, fewer
   * than 2 pooled events, or every pooled event identical so the variance is
   * zero). Detection is then impossible and `tiles` carries no anomalies —
   * which is BLINDNESS, not
   * quiet. Callers must distinguish the two: an empty tile list with
   * referenceUsable=false means "I have no yardstick", and reading it as "all
   * clear" is exactly the failure mode recorded in the silence-vs-blindness
   * field finding. Only reference-derived tiles (spike/dip/step/divergence) are
   * suppressed; gap tiles are structural and still emitted.
   */
  referenceUsable: boolean;
  /**
   * Group labels that were observed but could not be scored, because the
   * reference lens had no same-group population to compare them against (the
   * group is new, or it fell silent during the reference span).
   *
   * The group-level form of silence-vs-blindness: without this, a group with
   * no yardstick contributes no tiles and reads exactly like a group that was
   * checked and found healthy. Present only for grouped lenses; omitted when
   * every observed group was scorable.
   */
  unscoredGroups?: string[];
  /**
   * How this package was selected — the multiple-comparisons context behind
   * every tile in it.
   *
   * A tile says "this window is 2.9σ from baseline". What it cannot say on
   * its own is "and it is the most extreme of 10 windows I scanned", which is
   * the difference between a finding and a coincidence. Before this field the
   * package simply dropped that context: `curate()` computed the family size
   * and the corrected threshold, used them for its own gate, and discarded
   * both — leaving the Brain-facing artifact unable to state the very thing
   * 対策A had to correct for internally.
   *
   * Measured consequence (ROADMAP_BRIEF.md 2026-08-17): Sonnet 5 and Opus 5
   * confirmed every false-positive tile they were shown, and their stated
   * reasons were substantive — σ values, neighbouring windows, shape. They
   * were not rubber-stamping; they were reasoning correctly from a prompt
   * that never mentioned the tile was one of N. This is the 07-28 "対策A" note
   * ("閾値は動かさず、タイルに『N窓中の1本』という文脈を明示して判断は Brain に委ねる")
   * made available: 対策A moved the threshold, this hands over the context so
   * a Brain can weigh multiplicity itself.
   */
  selection: SelectionContext;
  /** The curated tiles, sorted by regionStart ascending. */
  tiles: SnapshotTile[];
}

/** The comparison family a package's tiles were selected out of. */
export interface SelectionContext {
  /**
   * Number of windows eligible to be scored — the family size N the Šidák
   * correction was computed over. Not the same as
   * `globalStats.windowCount`, which counts REFERENCE windows.
   */
  scoredWindowCount: number;
  /** The per-comparison two-sided z threshold, before correcting for N. */
  baseZThreshold: number;
  /**
   * The threshold actually applied to each window, Šidák-corrected for
   * `scoredWindowCount`. Carried so the package can explain its own gate;
   * note that a consumer handed only this number learns the curator's
   * conclusion rather than the facts behind it — the transcription confound
   * the 2026-07-28 re-analysis found. Readers wanting the Brain to do its own
   * multiplicity reasoning should hand over scoredWindowCount and
   * baseZThreshold instead.
   */
  effectiveZThreshold: number;
}

// ── Curation options ────────────────────────────────────────────────────────

export interface CurationOptions {
  /**
   * z-score threshold above which a window is classified "spike" (default 2.0).
   * Lower = more sensitive; raise if the stream is noisy.
   *
   * Read as a FAMILY-WISE budget for the whole snapshot, not a per-window one
   * (2026-07-28, "対策A" — ROADMAP_BRIEF.md). A curate() call scores every
   * eligible window independently; applying this threshold per-window lets the
   * package-level false-positive rate climb with window count (measured: 29%
   * of 10-window QUIET packages contained a spurious tile — see ROADMAP_BRIEF.md
   * "A/B ハーネス実行 第二弾" and its Opus 5 review). The two-sided alpha implied
   * by this threshold is Šidák-corrected per call so the *package's* surprise
   * budget stays constant as N grows, rather than each window silently getting
   * its own fresh 2.0σ roll. This is not an exception bolted onto the lens: a
   * curate() call over N windows *is* N comparisons, and correcting for that is
   * what the "N windows in one lens" choice already implies.
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
   *  2. Score each observation window via a standard error derived from the
   *     reference's pooled variance only (not the window's own variance — an
   *     earlier Welch-style version used both and produced a self-referential
   *     false-positive/false-negative pathology on bounded data; see
   *     ROADMAP_BRIEF.md 2026-07-25 "自己レビューで実装バグ"). `MIN_VALID_COUNT`
   *     remains a separate precondition: a window with too few events cannot be
   *     *scored* (normal-approximation validity), though it still contributes
   *     its events to any reference that includes it. The spike/dip gate itself
   *     uses a Šidák-corrected threshold (see spikeZThreshold doc, "対策A"
   *     2026-07-28) so the package's false-positive budget doesn't inflate with
   *     the number of scored windows; reported magnitudes stay uncorrected.
   *  3. Detect sustained step changes the same way, over window runs.
   *  4. Detect gaps between consecutive observation windows.
   *  5. If `reference` is a distinct LensResult, also detect per-window
   *     divergence (paired by windowStart).
   *  6. Pick one baseline tile (window closest to the reference mean).
   *  7. Sort by magnitude desc, cap at maxTiles.
   *
   * When the observation lens declared `group_by`, steps 2–4 run once PER GROUP
   * against that same group's reference population, instead of once over the
   * mixed stream (ROADMAP L4). This is the reason group_by belongs after the
   * reference-lens redesign rather than before it: the comparator assumes its
   * reference is one population, and a mixed stream is not one. Concretely, on
   * the pilot's four-agent stream a single agent dropping to 0.20 pass rate
   * shows up in the mixture as (3×0.92 + 0.20)/4 ≈ 0.74 — diluted to roughly a
   * quarter of its real depth, sitting on the threshold and firing or not
   * depending on the run (ROADMAP_BRIEF.md 2026-07-25). Scored inside its own
   * group it is simply a 0.20 against a 0.95 baseline.
   *
   * The Šidák family stays the whole PACKAGE, not each group: grouping turns N
   * windows into N×G comparisons, and letting each group carry its own fresh
   * budget would reintroduce exactly the inflation 対策A removed.
   */
  curate(observation: LensResult, reference: LensResult = observation): SnapshotPackage {
    const { windows, window_ms } = observation;
    const now = Date.now();

    const refStats = poolStats(reference.windows);
    // A reference with no variance to offer cannot ground any comparison. Say so
    // explicitly rather than returning an empty tile list that reads as "quiet".
    //
    // `variance > 0` is part of that test, not a pedantic addition (fixed
    // 2026-08-17). `Number.isFinite(0)` is true, so a reference whose events
    // are all identical — 18 consecutive passes on a pass/fail stream, easily
    // produced by a short or decayed reference span — used to report
    // referenceUsable=TRUE while comparisonSE returned 0 for every window and
    // `!(se > 0)` skipped them all. Measured: a 17σ dip vanished with the flag
    // still claiming a usable yardstick, which is exactly the silence-read-as-
    // quiet failure this flag exists to prevent, produced by the flag itself.
    //
    // Zero sample variance is blindness rather than certainty for the same
    // reason the Welch-form denominator was wrong (2026-07-25): a homogeneous
    // sample does not mean a homogeneous population, and treating it as one
    // makes every deviation infinitely significant precisely when the estimate
    // is least trustworthy. The scoring loop already declined to score these
    // windows; only the flag disagreed.
    const referenceUsable =
      refStats.count >= 2 && Number.isFinite(refStats.variance) && refStats.variance > 0;
    const globalStats = {
      mean: refStats.mean,
      stdDev: referenceUsable ? Math.sqrt(refStats.variance) : 0,
      windowCount: reference.windows.length,
      eventCount: refStats.count,
    };
    const minGapMs = this.opts.minGapMs > 0 ? this.opts.minGapMs : window_ms * 2;

    const tiles: SnapshotTile[] = [];

    // ── 0. Decide what gets compared against what ─────────────
    // Ungrouped: one unit, the whole stream against the whole reference.
    // Grouped: one unit per observed group, each against the SAME group in the
    // reference — paired by label, which is why applyLens puts every group on a
    // shared grid and sorts groups deterministically.
    const { units, unscoredGroups } = buildScoringUnits(observation, reference, refStats);

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
    //
    // The classification GATE uses a Šidák-corrected threshold (see
    // spikeZThreshold doc) so the package-wide false-positive budget stays
    // fixed as the number of scored windows N grows; the reported `magnitude`
    // stays the honest, uncorrected z so Brain sees the real effect size.
    const scorableCount = units.reduce(
      (n, u) => n + u.windows.filter((w) => w.count >= MIN_VALID_COUNT).length,
      0,
    );
    const effectiveZThreshold = sidakCorrectedThreshold(this.opts.spikeZThreshold, scorableCount);

    for (const unit of units) {
      const tag = unit.group !== undefined ? `[${unit.group}] ` : "";
      const inGroup = unit.group !== undefined ? ` in group "${unit.group}"` : "";

      for (const w of unit.windows) {
        if (w.count < MIN_VALID_COUNT) continue;
        const se = comparisonSE(w, unit.ref);
        if (!(se > 0)) continue;
        const z = (w.mean - unit.ref.mean) / se;
        if (z >= effectiveZThreshold) {
          tiles.push({
            label: `${tag}spike at t=${w.windowStart} (${w.mean.toFixed(3)} vs baseline ${unit.ref.mean.toFixed(3)})`,
            shapeTag: "spike",
            regionStart: w.windowStart,
            regionEnd: w.windowEnd,
            windows: [w],
            description: `Window mean ${w.mean.toFixed(3)} is ${z.toFixed(1)}σ above the reference baseline (${unit.ref.mean.toFixed(3)})${inGroup}. Count: ${w.count}.`,
            magnitude: z,
            ...(unit.group !== undefined ? { group: unit.group } : {}),
          });
        } else if (z <= -effectiveZThreshold) {
          tiles.push({
            label: `${tag}dip at t=${w.windowStart} (${w.mean.toFixed(3)} vs baseline ${unit.ref.mean.toFixed(3)})`,
            shapeTag: "dip",
            regionStart: w.windowStart,
            regionEnd: w.windowEnd,
            windows: [w],
            description: `Window mean ${w.mean.toFixed(3)} is ${Math.abs(z).toFixed(1)}σ below the reference baseline (${unit.ref.mean.toFixed(3)})${inGroup}. Count: ${w.count}.`,
            magnitude: Math.abs(z),
            ...(unit.group !== undefined ? { group: unit.group } : {}),
          });
        }
      }

      // ── 2. Sustained step changes ──────────────────────────────
      tiles.push(
        ...detectSteps(unit.windows, unit.ref, this.opts.stepThreshold, this.opts.stepWindowCount, unit.group),
      );

      // ── 3. Gaps ────────────────────────────────────────────────
      // Per unit, so that a single group falling silent is visible. On a
      // grouped lens the mixed stream almost never gaps (some other group is
      // still reporting), which is exactly the case CG cares about.
      for (let i = 0; i + 1 < unit.windows.length; i++) {
        const gap = unit.windows[i + 1].windowStart - unit.windows[i].windowEnd;
        if (gap >= minGapMs) {
          tiles.push({
            label: `${tag}gap ${gap}ms at t=${unit.windows[i].windowEnd}–${unit.windows[i + 1].windowStart}`,
            shapeTag: "gap",
            regionStart: unit.windows[i].windowEnd,
            regionEnd: unit.windows[i + 1].windowStart,
            windows: [unit.windows[i], unit.windows[i + 1]],
            description: `No events for ${gap}ms${inGroup}. Before: ${unit.windows[i].mean.toFixed(3)}, after: ${unit.windows[i + 1].mean.toFixed(3)}.`,
            ...(unit.group !== undefined ? { group: unit.group } : {}),
          });
        }
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
      ...(unscoredGroups.length > 0 ? { unscoredGroups } : {}),
      selection: {
        scoredWindowCount: scorableCount,
        baseZThreshold: this.opts.spikeZThreshold,
        effectiveZThreshold,
      },
      tiles: capped,
    };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * One (observation windows, reference population) pair to run detection over.
 * An ungrouped lens yields exactly one; a grouped lens yields one per group.
 */
interface ScoringUnit {
  /** LensGroup.label, or undefined for the ungrouped whole-stream unit. */
  group?: string;
  windows: WindowStat[];
  ref: RefStats;
}

/**
 * Pair each observation group with its own reference population.
 *
 * Pairing is by label, and a group with no counterpart in the reference is
 * dropped from scoring rather than silently falling back to the mixed-stream
 * reference. Falling back would be worse than not scoring: it would compare a
 * single agent against the four-agent mixture — the very dilution group_by
 * exists to remove — and would report the resulting z as if it meant something.
 * Dropped labels are returned so the package can say it was blind to them.
 */
function buildScoringUnits(
  observation: LensResult,
  reference: LensResult,
  packageRef: RefStats,
): { units: ScoringUnit[]; unscoredGroups: string[] } {
  const obsGroups = observation.groups;
  if (obsGroups === undefined || obsGroups.length === 0) {
    return { units: [{ windows: observation.windows, ref: packageRef }], unscoredGroups: [] };
  }

  const refByLabel = new Map<string, LensGroup>(
    (reference.groups ?? []).map((g) => [g.label, g]),
  );
  const units: ScoringUnit[] = [];
  const unscoredGroups: string[] = [];

  for (const g of obsGroups) {
    const refGroup = refByLabel.get(g.label);
    const ref = refGroup !== undefined ? poolStats(refGroup.windows) : undefined;
    // Same usability test the package applies: fewer than 2 pooled events means
    // there is no variance, so no comparison exists to make.
    if (ref === undefined || ref.count < 2 || !Number.isFinite(ref.variance)) {
      unscoredGroups.push(g.label);
      continue;
    }
    units.push({ group: g.label, windows: g.windows, ref });
  }

  return { units, unscoredGroups };
}

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

/**
 * Šidák-correct a two-sided z-threshold so a family of `n` independent
 * per-window tests keeps the same overall (package-level) false-positive
 * budget that a single test at `baseZ` would have (2026-07-28 "対策A").
 *
 * baseZ's two-sided alpha is treated as the *family-wise* target: shrink the
 * per-window alpha to alpha' = 1-(1-alpha)^(1/n), then convert back to a z.
 * n<=1 is a no-op (the formula already reduces to alpha'=alpha there).
 */
function sidakCorrectedThreshold(baseZ: number, n: number): number {
  if (n <= 1) return baseZ;
  const alpha = 2 * (1 - normalCdf(baseZ));
  const alphaCorrected = 1 - Math.pow(1 - alpha, 1 / n);
  return normalQuantile(1 - alphaCorrected / 2);
}

/** Standard normal CDF via the Abramowitz-Stegun 7.1.26 erf approximation (max error ~1.5e-7). */
function normalCdf(z: number): number {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const a1 = 0.254829592,
    a2 = -0.284496736,
    a3 = 1.421413741,
    a4 = -1.453152027,
    a5 = 1.061405429,
    p = 0.3275911;
  const t = 1 / (1 + p * x);
  const erf = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * erf);
}

/** Inverse standard normal CDF via Acklam's rational approximation (max error ~1.15e-9). */
function normalQuantile(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239e0];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e0, -2.549732539343734e0, 4.374664141464968e0, 2.938163982698783e0];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e0, 3.754408661907416e0];
  const plow = 0.02425;
  const phigh = 1 - plow;
  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= phigh) {
    const q = p - 0.5;
    const r = q * q;
    return (
      ((((( a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
    );
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

function detectSteps(
  windows: WindowStat[],
  ref: RefStats,
  threshold: number,
  minRun: number,
  group?: string,
): SnapshotTile[] {
  if (windows.length < minRun) return [];
  // No yardstick, no comparison — mirrors spike/dip's silent skip when the
  // reference can't ground a z-score (buildScoringUnits applies the same
  // test), rather than reporting a step_up/step_down with a fabricated
  // magnitude:0. Blindness must not read as "measured, no shift".
  if (!(ref.count >= 2 && Number.isFinite(ref.variance))) return [];
  const tiles: SnapshotTile[] = [];
  const tag = group !== undefined ? `[${group}] ` : "";
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
      label: `${tag}${shapeTag} t=${windows[start].windowStart}–${windows[end].windowEnd} (${(shift * 100).toFixed(1)}% shift)`,
      shapeTag,
      regionStart: windows[start].windowStart,
      regionEnd: windows[end].windowEnd,
      windows: run,
      description: `Sustained ${dir > 0 ? "elevation" : "drop"} over ${run.length} windows${group !== undefined ? ` in group "${group}"` : ""}. Run mean: ${runMean.toFixed(3)}, reference mean: ${ref.mean.toFixed(3)}.`,
      magnitude: z,
      ...(group !== undefined ? { group } : {}),
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
  // `valid` is definitionally count >= MIN_VALID_COUNT (lens.ts), so this is
  // the same precondition the comparator applies before scoring — one idiom,
  // two readers.
  const reliable = windows.filter((w) => w.valid);
  const pool = reliable.length > 0 ? reliable : windows;
  // Pick the window whose mean is closest to the global mean (most "normal").
  return pool.reduce((best, w) =>
    Math.abs(w.mean - globalMean) < Math.abs(best.mean - globalMean) ? w : best,
  );
}
