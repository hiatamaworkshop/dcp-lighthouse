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

import {
  MIN_VALID_COUNT,
  effectiveN,
  kishEffectiveN,
  weightSquaredTotal,
  weightTotal,
  type LensGroup,
  type LensResult,
  type WindowStat,
} from "./lens.js";

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
  /**
   * Spike/dip tiles under `nullModel: "variogram"` only: the window's event
   * count over the median count of the reference windows it was scored
   * against. A description, not a gate — nothing fires or stays quiet on it.
   *
   * Why (ROADMAP_BRIEF.md 2026-10-14 (7)): on real data the variogram null is
   * calibrated in windows of ordinary volume, and its excess alarms at 10 s sit
   * in windows whose volume moved with their rate (≥ 2× the reference's median:
   * 7–35% past 3σ, against 0.2–0.3% at ordinary volume). That is the stream's
   * make-up changing — a real event, kept as one (user decision) — and this
   * field lets a reader tell it from a rate moving at steady volume.
   */
  volumeRatio?: number;
}

// ── Snapshot package ────────────────────────────────────────────────────────

/** What QCompareParams.history_clean did to the history the variogram null read. */
export interface HistoryCleaning {
  rule: "median";
  /** Windows left in / out, over the series the curator reads (the groups of a grouped lens, else the stream). */
  kept: number;
  removed: number;
  /** True when too large a share would have been removed in some series: that series was used whole. */
  declined?: true;
}

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
   * Fraction (0–1) of the reference span's windows that actually held events.
   * Set only by callers that know the span they ASKED for (see
   * Comparator.compare in comparison.ts) — the curator sees the windows it
   * was handed, not the request, so it cannot tell a sparse reference from a
   * short one.
   *
   * A declaration, not a gate. `referenceUsable` answers "can any comparison
   * be made"; this answers "how much of the yardstick was there". They came
   * apart in practice: an RC run started right after /demo/stop scored its
   * replay against a reference of 1 window out of 16 (18 events), reported
   * referenceUsable=true, and the injected dip did not appear (2026-09-27
   * review, finding 3d). Gating on it would change the calibrated scoring
   * path, so for now it is only reported — and logged by index.ts when low.
   */
  referenceCoverage?: number;
  /**
   * The comparison this package came from, as actually run: which spans were
   * read as reference and history, and the null the gate assumed. Set by the
   * caller that resolved $Q[compare] (comparison.ts) — the curator sees the
   * windows it was handed, not the spans or the row that chose them.
   *
   * A tile is a relation between two lens outputs (2026-07-25), so without
   * this a tile cannot say what it was compared against; harmless while there
   * was one reference and one null in production, not once there are more
   * (ROADMAP_BRIEF.md 2026-10-14 (2) item 2). Spans are the inclusive
   * [fromTs, toTs] requests ReplaySource.replay was given.
   */
  comparison?: {
    reference: { kind: "preceding"; fromTs: number; toTs: number };
    nullModel: NullModel;
    /**
     * `source`: "window-summaries" = the standing, unthinned history
     * (window-history.ts); "replay" = re-aggregated from the retained events,
     * whose older part is the thinned reference zone.
     */
    history?: {
      fromTs: number;
      toTs: number;
      windowCount: number;
      source: "window-summaries" | "replay";
      /** With `history_clean`: what was left out of γ̂ (comparison.ts, cleanHistoryByMedian). */
      cleaned?: HistoryCleaning;
    };
  };
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
   * True when this package's observation or reference lens declared
   * agg_func:"median" — the whole-package form of `unscoredGroups`
   * (ROADMAP_BRIEF.md 2026-08-18 (5) §C / 2026-08-23). A median window's
   * `mean` field holds a median, not a mean, and carries no `sumSq`/`weights`
   * that mean anything to a normal-approximation z-test — there is no
   * Gaussian reference model to score against, by design, not because no one
   * got around to it yet (median/percentile cannot be pooled from the
   * sufficient statistics this comparator's whole model depends on).
   *
   * Set this instead of quietly running the z-test machinery over numbers it
   * was never derived for. `tiles` is always empty and `referenceUsable` is
   * left `false` when this is `true` — read this flag FIRST: a median
   * package was never eligible for scoring, independent of what the data
   * looked like, which is exactly the distinction `referenceUsable` draws
   * for a missing yardstick, applied here to an incompatible statistic
   * instead of an absent one. `observation.windows`/`.groups` (the raw
   * LensResult, not part of this package) still carry every window's actual
   * median in `mean` for direct inspection — this curator declines to judge
   * it, it does not withhold it.
   */
  aggFuncUnscored?: boolean;
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
  /**
   * Tails the gate could not have fired on, whatever the stream did.
   *
   * The silence-vs-blindness rule applied to a DIRECTION rather than to the
   * whole package. `referenceUsable` answers "was any comparison possible";
   * this answers "was a spike possible", and the two come apart: a package can
   * have a perfectly good yardstick and still be structurally unable to report
   * one side.
   *
   * How it happens (measured, ROADMAP_BRIEF.md 2026-08-17): a window mean
   * cannot exceed the largest value the stream produces. On the pilot's
   * 0.95-pass stream that ceiling is 1.0, which at ~100 events per window sits
   * 2.29σ above the reference — under the 2.81σ Šidák-corrected gate. So no
   * spike could fire at any point in 2000 null trials, and the package
   * reported "no spikes" in exactly the words it would have used after
   * looking. 136 dips to 1 spike is that, not the data.
   *
   * Reported, never acted on: no threshold moves and no tile appears or
   * disappears because of this field. It says which half of the answer was
   * never on offer, so a reader stops treating "no spikes" as evidence.
   */
  unreachableTails: UnreachableTail[];
  /**
   * Present only under `nullModel: "overdispersed"`: the between-window
   * variance τ̂² each scoring unit's gate added, estimated from that unit's
   * reference windows (group absent = the ungrouped stream). A τ̂² of 0 means
   * the reference showed no spread beyond independent sampling and that unit
   * was gated exactly as under "independent". Carried so a package can say how
   * much of its yardstick is the dependence it allowed for.
   */
  overdispersion?: Array<{ group?: string; tau2: number }>;
  /**
   * Present only under `nullModel: "variogram"`: per scoring unit, the latent
   * semivariogram the gate used — γ̂(h) for lags 0…maxLag in windows (γ̂(0) = 0)
   * — with what it rests on. `extrapolatedFromLag` is the first lag the history
   * had no window pairs for (its γ̂ and every later one repeat the last
   * estimated value, an UNDERSTATEMENT when γ is still rising); absent when
   * every lag was estimated.
   */
  variogram?: Array<{
    group?: string;
    gamma: number[];
    historyWindows: number;
    df: number;
    extrapolatedFromLag?: number;
  }>;
  /**
   * Present only with `CurationOptions.recordWindowScores`: every scorable
   * window's comparison, in scoring order — the windows the gate passed over as
   * well as those it fired on. For calibration measurements only.
   */
  windowScores?: WindowScore[];
  /**
   * Present only with `CurationOptions.sensitivityPower`: how large a change
   * this package could have reported (see that option). Read it beside an
   * empty tile list — "no dip" from a unit whose median dip MDE is 0.35 says
   * far less than from one whose MDE is 0.03.
   */
  sensitivity?: SensitivityReport;
  /**
   * Present only with `CurationOptions.volumeChannel`: the stream's VOLUME
   * judged on its own — windows whose event count left the reference's ordinary
   * range, scored in a channel of their own. The rate gate above is untouched by
   * it: no score, threshold or tile there reads this (ROADMAP C3).
   */
  volume?: VolumeChannel;
  /** The curated tiles, sorted by regionStart ascending. */
  tiles: SnapshotTile[];
}

/** SnapshotPackage.sensitivity: the smallest one-window shift the gate would catch, per scoring unit. */
export interface SensitivityReport {
  /** The detection probability the shifts are quoted at (CurationOptions.sensitivityPower). */
  power: number;
  units: SensitivityUnit[];
}

export interface SensitivityUnit {
  /** LensGroup.label, when the lens was grouped. */
  group?: string;
  /** Scorable windows the shifts were computed over. */
  windows: number;
  /** Median event count of those windows. */
  typicalCount: number;
  /**
   * Windows whose shifts came from the exact tail (two-valued data on the
   * gate's exact path); the rest are the normal approximation, least accurate
   * on thin windows of three-level data near a bound.
   */
  exactWindows: number;
  /** Shift DOWN of one window's mean (value units, positive); null when no window could reach it. */
  dip: MdeSummary | null;
  /** Shift UP of one window's mean; null when no window could reach it. */
  spike: MdeSummary | null;
}

/** One direction's minimum detectable shift over a unit's scorable windows. */
export interface MdeSummary {
  median: number;
  min: number;
  max: number;
  /**
   * Scorable windows in which no shift in this direction could clear the gate
   * at the quoted power: the data's range ends first (a 0.98 pass rate cannot
   * rise by 0.05). The per-window form of `unreachableTails`.
   */
  unreachable: number;
}

/**
 * SnapshotPackage.volume: the volume channel (CurationOptions.volumeChannel).
 *
 * Why a channel of its own (ROADMAP_BRIEF.md 2026-11-02 (3)): the rate gate's
 * yardstick (the variogram null) is built from a history, and a stream whose
 * make-up changes — a bot batch starting or stopping — puts windows into that
 * history whose volume and rate both moved. They widen γ̂ and so make the gate
 * conservative at ordinary volume (H-mix: var z 0.533 → 1.101 once cleaned), and
 * until now the only trace of the change was `SnapshotTile.volumeRatio`, a
 * description. This channel says it as a finding of its own, on the quantity
 * that actually moved: how many events the window held.
 */
export interface VolumeChannel {
  /** The family-wise budget the gate was given (CurationOptions.spikeZThreshold) and the Šidák-corrected gate used. */
  baseZThreshold: number;
  effectiveZThreshold: number;
  /** Windows scored across all units — the Šidák family. */
  scoredWindowCount: number;
  units: VolumeUnit[];
  /** Windows whose volume left the reference's range, by regionStart. */
  tiles: VolumeTile[];
  /** With `recordWindowScores`: every scored window's volume z, for calibration measurements. */
  scores?: VolumeScore[];
}

/** One scoring unit's volume yardstick. A unit with too few reference windows is `blind`, not quiet. */
export interface VolumeUnit {
  group?: string;
  /** Reference windows that held events (the volume yardstick's sample). */
  referenceWindows: number;
  /** Median window volume of the reference — what a tile's `volumeRatio` is read against. */
  typicalVolume: number;
  /** Spread of ln(volume) the gate used: 1.4826·MAD of the reference, floored at the Poisson 1/√typical. */
  logScale: number;
  /** Degrees of freedom the scale's own uncertainty is carried with (Infinity when the Poisson floor set the scale). */
  df: number;
  /** True when the reference had fewer than MIN_VOLUME_REFERENCE_WINDOWS windows: no volume yardstick, nothing scored. */
  blind: boolean;
}

export interface VolumeTile {
  label: string;
  /** "up": more events than the reference's ordinary range; "down": fewer. */
  direction: "up" | "down";
  regionStart: number;
  regionEnd: number;
  group?: string;
  /** The window's volume and its ratio to the reference's median window. */
  volume: number;
  volumeRatio: number;
  /** (ln volume − reference centre) / the yardstick's SE, uncorrected; signed. */
  z: number;
  /** The z the gate compared with the Šidák threshold: `z` carried through the t tail of the scale's estimate. */
  gateZ: number;
  description: string;
}

export interface VolumeScore {
  windowStart: number;
  group?: string;
  volume: number;
  volumeRatio: number;
  z: number;
  /** The studentized z the gate compares (VolumeTile.gateZ) — what calibration reads against N(0, 1). */
  gateZ: number;
}

/**
 * Degrees of freedom per reference window of a MAD-based scale: its efficiency
 * against the SD on normal data (0.37). The scale of m reference windows is
 * then as uncertain as an SD from 0.37·(m − 1) of them, and a window's z is
 * t-like in that many df — measured without this, 13.3% of iid packages
 * (60-window reference, 60 observed) fired against a 4.55% budget.
 */
export const MAD_EFFICIENCY = 0.37;

/** Fewest reference windows a volume yardstick is built from. */
export const MIN_VOLUME_REFERENCE_WINDOWS = 8;

/**
 * One scorable window's comparison (CurationOptions.recordWindowScores). The
 * gate fires when |gateZ| ≥ the package's effectiveZThreshold, so a measurement
 * can read the gate's whole predictive distribution — its bulk as well as the
 * tail the few fired windows show — and split it by the window's volume.
 */
export interface WindowScore {
  windowStart: number;
  /** LensGroup.label, when the lens was grouped. */
  group?: string;
  count: number;
  /** count ÷ the median count of the reference windows it was scored against (SnapshotTile.volumeRatio's definition). */
  volumeRatio: number;
  /** (window mean − reference mean) / comparison SE, uncorrected — what a tile reports as `magnitude`. */
  z: number;
  /** The signed z the gate compares with the Šidák threshold (continuity-corrected / exact tail / studentized). */
  gateZ: number;
  /** With `CurationOptions.sensitivityPower`: this window's minimum detectable shift by direction (null = unreachable). */
  mde?: { dip: number | null; spike: number | null };
}

/** One direction the gate could not fire in, and the arithmetic that says so. */
export interface UnreachableTail {
  direction: "spike" | "dip";
  /** Group label when the lens was grouped; absent for the ungrouped population. */
  group?: string;
  /** Most extreme z the data's own observed range allows in this direction. */
  attainableZ: number;
  /** The gate it would have had to clear. */
  requiredZ: number;
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
   * This defines the SHAPE only; the run must also clear the spike/dip gate
   * (see detectSteps).
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
  /**
   * What the spike/dip gate assumes about events inside one window (default
   * "independent", the model every figure up to 2026-10-06 was measured under).
   *
   * "overdispersed" drops the assumption that a window's events are independent
   * draws at the reference rate — the assumption H1 found false on real data
   * (ROADMAP_BRIEF.md 2026-10-06: φ 7.63 at 10 s, R_real 99.8% vs FA_shuffle
   * 5.0%). Each window then has its own latent rate, scattered around the
   * reference's with a between-window variance τ² estimated from the
   * REFERENCE windows alone (one-way ANOVA, see betweenWindowVariance), and the
   * gate asks whether the observation window is a plausible NEW window from
   * that population: τ² is added to the normal path's standard error and folded
   * into the exact path's Dirichlet concentration. Where the reference shows no
   * excess spread (τ̂² = 0) the gate is bit-identical to "independent".
   *
   * Step tiles are gated under both models; "overdispersed" adds τ² to the
   * run's error (see detectSteps).
   *
   * "variogram" drops the next assumption, that those latent rates are drawn
   * independently of each other (ROADMAP_BRIEF.md 2026-10-14 (2)(4): on real
   * data the alarm rate climbs with the distance from the reference, 6.7‰ →
   * 30.3‰ per window at 60 s). The latent rate is a process over time with
   * semivariogram γ(h), estimated from a HISTORY of window summaries ending
   * where the reference ends (curate's `context.history`), and the gate uses
   * the variance of the actual contrast between the window and the reference
   * mean — see latentModel. A flat γ = τ² reproduces "overdispersed"'s
   * τ²(1 + refShare) exactly. Step tiles only describe windows the gate fired
   * on and are not tested (2026-10-14 (6)). Heavy-tailed latent moves are NOT
   * covered (γ is a second moment; 2026-10-14 (4)): on real data they sit in
   * windows whose volume moved too, kept as real events and labelled with
   * SnapshotTile.volumeRatio (2026-10-14 (7)).
   */
  nullModel?: NullModel;
  /**
   * Record every scorable window's comparison on the package
   * (`SnapshotPackage.windowScores`), not only the windows the gate fired on.
   * For calibration measurements (ROADMAP_BRIEF.md 2026-10-22 (5)): on real data
   * the package alarm rate is hostage to a few real events, while the gate's z
   * over ALL windows — split by volume — says whether the predictive
   * distribution itself is right. Off by default; nothing else changes with it.
   */
  recordWindowScores?: boolean;
  /**
   * Also say what the gate could have SEEN: per scoring unit, the smallest
   * shift of one window's mean that this package's gate would catch with this
   * probability (e.g. 0.8), by direction (`SnapshotPackage.sensitivity`, and
   * `WindowScore.mde` when window scores are recorded). Off when absent; set,
   * it changes no score, no threshold and no tile — a description, like
   * `volumeRatio`.
   *
   * Why (ROADMAP_BRIEF.md 2026-11-02 (2)): a package states its false-alarm
   * budget (`selection`) but not its reach, and every loss of detection so far
   * was found afterwards, by diagnosis — H4's 10 s payment windows held ~10
   * spans (2026-10-22 (5)), and stage 4's conservative null left a 0.1 shift
   * at 4% over one 60 s window (2026-11-02). "Silent" can mean the world was
   * quiet, the observer was blind (`referenceUsable`), or the lens was too
   * coarse-grained to see a change this size; this names the third.
   *
   * Computed from the gate's own yardstick: the window's comparison SE (with
   * the null's latent variance), the Šidák threshold carried back through the
   * Student-t widening, the continuity correction where the normal path is
   * the gate, and — on two-valued data — the window's own sampling variance
   * at the shifted mean. The alternative is "this window's latent rate moved
   * by Δ beyond what the null predicts". Where the gate reads the exact tail
   * on two-valued data the shift is computed from that tail too (the normal
   * approximation was measurably optimistic there); elsewhere it is the normal
   * approximation, least accurate on thin three-level windows near a bound
   * (`SensitivityUnit.exactWindows` says which). Either way it is measured
   * against planted shifts in the harness (runSensitivityCheck), not assumed.
   * Shifts sustained over k windows are caught at least as often (any one
   * window firing is a tile).
   */
  sensitivityPower?: number;
  /**
   * Also judge the stream's VOLUME as a channel of its own (`SnapshotPackage.volume`).
   * Off when absent; set, it changes no rate score, no threshold and no tile —
   * the rate gate does not read it (default output is byte-identical).
   *
   * A window's volume is its event count (its weight sum under a weighting
   * lens, so a thinned reference zone counts what it stands for). The yardstick
   * is the reference's own windows: centre = median of ln(volume), spread =
   * 1.4826·MAD of it, floored at the Poisson spread 1/√typical, and the
   * comparison SE carries the reference's finite size (×√(1 + 1/m)). Robust on
   * purpose: the reference of a stream whose make-up changes contains the very
   * windows this channel exists to flag, and a plain SD would widen over them.
   * (That is the opposite of the rate side's lesson, 2026-10-14 (4)(5), where
   * a robust γ̂ was rightly rejected: there the heavy tail is a property of the
   * quantity and the null must carry it. Here the question IS "is this window's
   * volume off the ordinary range".) The gate is the same Šidák-corrected
   * `spikeZThreshold`, with the family being the volume windows scored.
   *
   * Assumes full-width windows (an `align:"epoch"` grid or a span of whole
   * windows): a partial window at a span's edge would read as "down".
   */
  volumeChannel?: boolean;
}

/** CurationOptions.nullModel's values — also what $Q[compare]'s `null_model` names. */
export type NullModel = "independent" | "overdispersed" | "variogram";

/** What curate() may read besides the two lens outputs it compares. */
export interface CurationContext {
  /**
   * Window summaries of a stretch ending where the reference ends — read by
   * `nullModel: "variogram"` only, to estimate how the latent rate varies with
   * lag. Same lens (window_ms, group_by) as the reference and on the same
   * grid; windows ending after the reference's last window are dropped, so an
   * anomaly in the observation can never widen its own yardstick. Absent: the
   * reference windows stand in, lags beyond them are extrapolated flat, and
   * the package says so (`variogram[].extrapolatedFromLag`).
   */
  history?: LensResult;
  /**
   * The inclusive [fromTs, toTs] the observation was requested over. Read by
   * `volumeChannel` only: a window that is not wholly inside it (a grid-snapped
   * first window, the 1 ms tail a replay of [from, from + k·W] leaves) holds part
   * of a window's events and would read as a drop in volume, so it is not
   * scored. Absent: every observation window is taken as full.
   */
  span?: { fromTs: number; toTs: number };
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
      nullModel: opts.nullModel ?? "independent",
      recordWindowScores: opts.recordWindowScores ?? false,
      sensitivityPower: opts.sensitivityPower ?? 0,
      volumeChannel: opts.volumeChannel ?? false,
    };
    const p = opts.sensitivityPower;
    if (p !== undefined && !(p > 0 && p < 1)) {
      throw new RangeError(`sensitivityPower must lie strictly between 0 and 1 (a detection probability), got ${p}`);
    }
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
  curate(observation: LensResult, reference: LensResult = observation, context: CurationContext = {}): SnapshotPackage {
    const { windows, window_ms } = observation;
    const now = Date.now();

    // agg_func:"median" windows carry no Gaussian sufficient statistics for
    // this comparator's z-test to read — refuse before poolStats/isScorable
    // ever touch one, rather than letting mean/sumSq/weights (meaningless on
    // a median window) silently produce a number (ROADMAP_BRIEF.md
    // 2026-08-18 (5) §C / 2026-08-23, aggFuncUnscored's doc comment). Checked
    // on both observation and reference: a median window can reach this
    // comparator from either side (e.g. a mean observation scored against a
    // median reference would be just as meaningless).
    if (hasMedianWindows(observation) || hasMedianWindows(reference)) {
      const spanMs =
        windows.length > 0
          ? { start: windows[0].windowStart, end: windows[windows.length - 1].windowEnd }
          : undefined;
      return {
        generatedAt: now,
        window_ms,
        spanMs,
        globalStats: { mean: 0, stdDev: 0, windowCount: 0, eventCount: 0 },
        referenceUsable: false,
        aggFuncUnscored: true,
        selection: {
          scoredWindowCount: 0,
          baseZThreshold: this.opts.spikeZThreshold,
          effectiveZThreshold: this.opts.spikeZThreshold,
        },
        unreachableTails: [],
        tiles: [],
      };
    }

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
    const referenceUsable = isReferenceUsable(refStats);
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
    const overdispersed = this.opts.nullModel === "overdispersed";
    if (overdispersed) {
      for (const unit of units) unit.ref = { ...unit.ref, ...betweenWindowVariance(unit.refWindows) };
    }
    const variogram = this.opts.nullModel === "variogram";
    if (variogram) {
      for (const unit of units) {
        unit.latent = latentModel(unit.windows, unit.refWindows, historyFor(context.history, unit.group, unit.refWindows), window_ms);
      }
    }
    // The yardstick a given window is scored with: the unit's pooled reference,
    // plus — under "variogram" — the latent variance of THIS window's contrast,
    // which depends on how far the window sits from the reference.
    const refFor = (unit: ScoringUnit, w: WindowStat): RefStats =>
      unit.latent === undefined ? unit.ref : { ...unit.ref, ...windowLatent(unit.latent, w) };

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
    const scorableCount = units.reduce((n, u) => n + u.windows.filter(isScorable).length, 0);
    // Under "variogram" a step is not a test, so the family is the windows
    // alone (see detectSteps' `variogram`).
    const effectiveZThreshold = sidakCorrectedThreshold(this.opts.spikeZThreshold, scorableCount);
    const unreachableTails: UnreachableTail[] = [];
    const windowScores: WindowScore[] | undefined = this.opts.recordWindowScores ? [] : undefined;
    const power = this.opts.sensitivityPower;
    const sensitivityUnits: SensitivityUnit[] | undefined = power > 0 ? [] : undefined;

    for (const unit of units) {
      const tag = unit.group !== undefined ? `[${unit.group}] ` : "";
      const inGroup = unit.group !== undefined ? ` in group "${unit.group}"` : "";

      // The gate is applied to a continuity-corrected z where the data is
      // lattice-valued (see detectLattice); the z that gets REPORTED stays the
      // raw one, for the same reason the Šidák correction is not folded into it
      // — the correction belongs to the tail probability, not to the effect
      // size Brain reads.
      const lattice = detectLattice(unit.windows, unit.refWindows);
      const model = categoricalModel(unit.windows, unit.refWindows, unit.ref);

      collectUnreachableTails(unit, effectiveZThreshold, lattice, model, unreachableTails, (w) => refFor(unit, w));

      // Under "variogram", each spike/dip says how its volume compares with the
      // reference's typical window (SnapshotTile.volumeRatio).
      const typicalCount = unit.latent === undefined ? undefined : medianCount(unit.refWindows);
      const volume = (w: WindowStat): { volumeRatio?: number; note: string } => {
        if (!(typicalCount !== undefined && typicalCount > 0)) return { note: "" };
        const volumeRatio = w.count / typicalCount;
        return { volumeRatio, note: ` Volume ${volumeRatio.toFixed(2)}× the reference's median window.` };
      };

      // Windows the gate fired on, by direction — what a step may describe
      // under "variogram".
      const gatedDir = new Map<WindowStat, 1 | -1>();
      const scoreCount = windowScores !== undefined ? medianCount(unit.refWindows) : 0;
      const mdes = { dip: [] as number[], spike: [] as number[], dipOut: 0, spikeOut: 0, exact: 0, counts: [] as number[] };
      for (const w of unit.windows) {
        if (!isScorable(w)) continue;
        const wref = refFor(unit, w);
        const se = comparisonSE(w, wref);
        if (!(se > 0)) continue;
        const z = (w.mean - unit.ref.mean) / se;
        const gated = gate(w, wref, se, lattice, model);
        let mde: WindowScore["mde"];
        if (sensitivityUnits !== undefined) {
          const m = windowMde(w, wref, se, effectiveZThreshold, lattice, model, power);
          mde = { dip: m.dip, spike: m.spike };
          if (m.exact) mdes.exact++;
          if (mde.dip === null) mdes.dipOut++;
          else mdes.dip.push(mde.dip);
          if (mde.spike === null) mdes.spikeOut++;
          else mdes.spike.push(mde.spike);
          mdes.counts.push(w.count);
        }
        windowScores?.push({
          windowStart: w.windowStart,
          ...(unit.group !== undefined ? { group: unit.group } : {}),
          count: w.count,
          volumeRatio: scoreCount > 0 ? w.count / scoreCount : NaN,
          z,
          gateZ: gated,
          ...(mde !== undefined ? { mde } : {}),
        });
        if (gated >= effectiveZThreshold) {
          gatedDir.set(w, 1);
          const v = volume(w);
          tiles.push({
            label: `${tag}spike at t=${w.windowStart} (${w.mean.toFixed(3)} vs baseline ${unit.ref.mean.toFixed(3)})`,
            shapeTag: "spike",
            regionStart: w.windowStart,
            regionEnd: w.windowEnd,
            windows: [w],
            description: `Window mean ${w.mean.toFixed(3)} is ${z.toFixed(1)}σ above the reference baseline (${unit.ref.mean.toFixed(3)})${inGroup}. Count: ${w.count}.${v.note}`,
            magnitude: z,
            ...(unit.group !== undefined ? { group: unit.group } : {}),
            ...(v.volumeRatio !== undefined ? { volumeRatio: v.volumeRatio } : {}),
          });
        } else if (gated <= -effectiveZThreshold) {
          gatedDir.set(w, -1);
          const v = volume(w);
          tiles.push({
            label: `${tag}dip at t=${w.windowStart} (${w.mean.toFixed(3)} vs baseline ${unit.ref.mean.toFixed(3)})`,
            shapeTag: "dip",
            regionStart: w.windowStart,
            regionEnd: w.windowEnd,
            windows: [w],
            description: `Window mean ${w.mean.toFixed(3)} is ${Math.abs(z).toFixed(1)}σ below the reference baseline (${unit.ref.mean.toFixed(3)})${inGroup}. Count: ${w.count}.${v.note}`,
            magnitude: Math.abs(z),
            ...(unit.group !== undefined ? { group: unit.group } : {}),
            ...(v.volumeRatio !== undefined ? { volumeRatio: v.volumeRatio } : {}),
          });
        }
      }
      if (sensitivityUnits !== undefined && mdes.counts.length > 0) {
        mdes.counts.sort((a, b) => a - b);
        sensitivityUnits.push({
          ...(unit.group !== undefined ? { group: unit.group } : {}),
          windows: mdes.counts.length,
          typicalCount: mdes.counts[mdes.counts.length >> 1],
          exactWindows: mdes.exact,
          dip: summarizeMde(mdes.dip, mdes.dipOut),
          spike: summarizeMde(mdes.spike, mdes.spikeOut),
        });
      }

      // ── 2. Sustained step changes ──────────────────────────────
      // A step is a STATISTICAL claim under both nulls: the ratio rule defines
      // the shape (≥ stepThreshold, ≥ stepWindowCount windows), and the run must
      // clear the same Šidák gate spike/dip use. The ratio alone is blind to
      // noise — a 30% shift is under one window-SD at a 0.4 rate with 10 events
      // per window, so the ungated rule raised a step in 72% of iid packages
      // there (98% at 2 events). It was gated under "overdispersed" only until
      // ROADMAP_BRIEF.md 2026-10-14 (3); every figure up to then, including the
      // stage-1 and H3 judgments, was measured with the ungated rule under
      // "independent" (commit d5d13d4).
      //
      // Under "variogram" a step is a DESCRIPTION, not a claim (ROADMAP_BRIEF.md
      // 2026-10-14 (6)): it names the shape around windows the gate already
      // fired on, and never fires on its own. As a test it searched the run the
      // ratio rule picked out of the data, which no family count bounds — 1 s
      // windows put 2.6–3.4% of real-data packages over design on steps alone,
      // and a longer history did not cure it (2026-10-14 (5)).
      tiles.push(
        ...detectSteps(
          unit.windows, unit.ref, this.opts.stepThreshold, this.opts.stepWindowCount, effectiveZThreshold, unit.group,
          unit.latent === undefined ? undefined : { latent: unit.latent, gatedDir },
        ),
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

    // ── 3b. Volume channel (opt-in; reads nothing the rate gate wrote) ──
    const volume = this.opts.volumeChannel
      ? scoreVolume(units, this.opts.spikeZThreshold, this.opts.recordWindowScores, context.span)
      : undefined;

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
      unreachableTails,
      ...(overdispersed
        ? {
            overdispersion: units.map((u) => ({
              ...(u.group !== undefined ? { group: u.group } : {}),
              tau2: u.ref.tau2 ?? 0,
            })),
          }
        : {}),
      ...(variogram
        ? {
            variogram: units.map((u) => ({
              ...(u.group !== undefined ? { group: u.group } : {}),
              gamma: Array.from(u.latent!.gamma),
              historyWindows: u.latent!.historyWindows,
              df: u.latent!.df,
              ...(u.latent!.extrapolatedFromLag !== undefined ? { extrapolatedFromLag: u.latent!.extrapolatedFromLag } : {}),
            })),
          }
        : {}),
      ...(windowScores !== undefined ? { windowScores } : {}),
      ...(sensitivityUnits !== undefined ? { sensitivity: { power, units: sensitivityUnits } } : {}),
      ...(volume !== undefined ? { volume } : {}),
      tiles: capped,
    };
  }
}

// ── Sensitivity (CurationOptions.sensitivityPower) ───────────────────────────

/**
 * The raw |z| (deviation over comparison SE) whose studentized value is `zGate`
 * — the Šidák threshold carried back through studentizeZ, which widens the
 * tail when the null's latent variance is estimated (overdispersed: τ̂²'s
 * Satterthwaite df; variogram: the block df). studentizeZ is odd and
 * increasing, so a bisection finds it; where it is the identity (independent,
 * or a df past 10⁶) the threshold comes back unchanged.
 */
function rawGateZ(zGate: number, w: WindowStat, ref: RefStats): number {
  if (!(zGate > 0) || !Number.isFinite(zGate)) return zGate;
  if (Math.abs(studentizeZ(zGate, w, ref) - zGate) < 1e-12) return zGate;
  let lo = zGate;
  let hi = 2 * zGate;
  while (studentizeZ(hi, w, ref) < zGate && hi < 1e4) {
    lo = hi;
    hi *= 2;
  }
  for (let k = 0; k < 60; k++) {
    const mid = 0.5 * (lo + hi);
    if (studentizeZ(mid, w, ref) < zGate) lo = mid;
    else hi = mid;
  }
  return hi;
}

/**
 * Window `w`'s minimum detectable shift in both directions
 * (CurationOptions.sensitivityPower), and whether it came from the exact tail.
 *
 * The alternative is the same for both paths: the window's LATENT rate moved by
 * Δ — every event's chance of sitting at the upper level shifted — on top of
 * whatever the null already predicts for it (its latent spread, the
 * reference's own uncertainty). Where the gate reads the exact tail on
 * two-valued data, so does this (exactWindowMde): on thin windows near a bound
 * the normal approximation is optimistic for moves away from the bound — a
 * 0.9 rate in 20-event windows caught a quoted 80%-power dip 66% of the time,
 * because Binomial(20, 0.9)'s long left tail makes the exact gate harder to
 * clear (2026-11-02 (2)). Elsewhere the normal approximation
 * (normalWindowMde), including three-level data on the exact path.
 */
function windowMde(
  w: WindowStat,
  ref: RefStats,
  se: number,
  zGate: number,
  lattice: Lattice | null,
  model: CategoricalModel | null,
  power: number,
): { dip: number | null; spike: number | null; exact: boolean } {
  // exactZ's own conditions for reading the exact tail, without its O(n²) work on three levels.
  const exactPath = model !== null && w.count > 0 && w.count <= EXACT_MAX_COUNT && levelCounts(w, model.min, model.step, model.levels) !== null;
  if (exactPath && model!.levels === 2) {
    return { dip: exactWindowMde(w, ref, zGate, model!, power, -1), spike: exactWindowMde(w, ref, zGate, model!, power, 1), exact: true };
  }
  return {
    dip: normalWindowMde(w, ref, se, zGate, lattice, model, exactPath, power, -1),
    spike: normalWindowMde(w, ref, se, zGate, lattice, model, exactPath, power, 1),
    exact: false,
  };
}

/**
 * The normal approximation to the gate's power. The gate fires in direction
 * `dir` when the deviation exceeds D* = z_raw·se + cc (cc = the continuity
 * correction, applied only where the normal path IS the gate: the exact path's
 * mid-p tail is closer to the uncorrected normal). Under the shift the
 * deviation is ~ N(Δ, se₁²), where se₁ swaps the window's own sampling
 * variance for the one at the shifted mean on two-valued data (the latent and
 * reference parts are unchanged), so Δ = D* + z_power·se₁(Δ), solved by
 * fixed-point iteration. Null when the data's range ends first.
 */
function normalWindowMde(
  w: WindowStat,
  ref: RefStats,
  se: number,
  zGate: number,
  lattice: Lattice | null,
  model: CategoricalModel | null,
  exactPath: boolean,
  power: number,
  dir: 1 | -1,
): number | null {
  const n = effectiveN(w);
  if (!(n > 0) || !(se > 0)) return null;
  const cc = lattice !== null && !exactPath ? (0.5 * lattice.step) / n : 0;
  const threshold = rawGateZ(zGate, w, ref) * se + cc;
  if (!Number.isFinite(threshold)) return null;
  const zp = normalQuantile(power);
  const bounds: [number, number] | undefined =
    lattice !== null ? [lattice.min, lattice.min + lattice.step]
    : model !== null ? [model.min, model.min + (model.levels - 1) * model.step]
    : undefined;
  let delta = threshold + zp * se;
  if (lattice !== null) {
    for (let k = 0; k < 50; k++) {
      const m1 = Math.min(lattice.min + lattice.step, Math.max(lattice.min, ref.mean + dir * delta));
      const v1 = (m1 - lattice.min) * (lattice.min + lattice.step - m1);
      const se1 = Math.sqrt(Math.max(0, se * se + (v1 - ref.variance) / n));
      const next = threshold + zp * se1;
      const done = Math.abs(next - delta) < 1e-12;
      delta = next;
      if (done) break;
    }
  }
  if (!(delta > 0) || !Number.isFinite(delta)) return null;
  if (bounds !== undefined) {
    const target = ref.mean + dir * delta;
    if (target < bounds[0] - 1e-12 || target > bounds[1] + 1e-12) return null;
  }
  return delta;
}

/**
 * The exact counterpart on two-valued data, where the gate itself reads
 * exactZ. Two steps, both on the gate's own terms:
 *
 *   1. the critical count: the largest upper-level count c* the gate fires a
 *      dip on (the smallest, for a spike) — exactZ, studentized, against the
 *      Šidák threshold, by bisection (the gate is monotone in the count);
 *   2. the shift: the window's count under the alternative is beta-binomial
 *      with the null predictive's total concentration (concentration(): the
 *      reference's uncertainty and the null's latent spread) and its upper-
 *      level share moved by δ; δ is solved by bisection so that
 *      P(count ≤ c*) (dip) or P(count ≥ c*) (spike) equals `power`.
 *
 * Returned in value units (δ·step). Null when the gate cannot fire in that
 * direction at this window's size, or cannot reach `power` before the share
 * runs into 0 or 1.
 */
function exactWindowMde(w: WindowStat, ref: RefStats, zGate: number, model: CategoricalModel, power: number, dir: 1 | -1): number | null {
  const n = w.count;
  const { min, step } = model;
  const atCount = (c: number): WindowStat => ({
    ...w,
    mean: min + (step * c) / n,
    sumSq: (n - c) * min * min + c * (min + step) * (min + step),
    weights: undefined,
  });
  const gated = (c: number): number => {
    const x = atCount(c);
    const e = exactZ(x, model, ref.latentVar);
    return e === null ? NaN : studentizeZ(e, x, ref);
  };
  // 1. Critical count.
  let crit: number;
  if (dir < 0) {
    if (!(gated(0) <= -zGate)) return null;
    let lo = 0;
    let hi = n;
    if (gated(n) <= -zGate) lo = n;
    else {
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (gated(mid) <= -zGate) lo = mid;
        else hi = mid;
      }
    }
    crit = lo;
  } else {
    if (!(gated(n) >= zGate)) return null;
    let lo = 0;
    let hi = n;
    if (gated(0) >= zGate) hi = 0;
    else {
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (gated(mid) >= zGate) hi = mid;
        else lo = mid;
      }
    }
    crit = hi;
  }
  // 2. The share shift that reaches `power`.
  const alpha = concentration(
    model.refCounts.map((r) => r + 0.5),
    model.overdispersion,
    ref.latentVar === undefined ? undefined : ref.latentVar / (step * step),
  );
  const A = alpha[0] + alpha[1];
  const p0 = alpha[1] / A;
  const tail = (delta: number): number => {
    const q = p0 + dir * delta;
    const a1 = q * A;
    const a0 = (1 - q) * A;
    // P(count ≤ last) by the pmf's ratio recurrence from c = 0 (log P carried, so
    // a far-off start cannot underflow the terms that matter); a spike's firing
    // side c ≥ crit is its complement — fine at the powers asked for here.
    const last = dir < 0 ? crit : crit - 1;
    let lp = logGamma(n + a0) - logGamma(n + A) + logGamma(A) - logGamma(a0);
    let below = 0;
    for (let c = 0; c <= last; c++) {
      if (c > 0) lp += Math.log(((n - c + 1) * (c - 1 + a1)) / (c * (n - c + a0)));
      below += Math.exp(lp);
    }
    return dir < 0 ? below : 1 - below;
  };
  const room = dir < 0 ? p0 : 1 - p0;
  const far = room * (1 - 1e-9);
  if (!(tail(far) >= power)) return null;
  let lo = 0;
  let hi = far;
  if (tail(lo) >= power) return 0;
  for (let k = 0; k < 50; k++) {
    const mid = 0.5 * (lo + hi);
    if (tail(mid) >= power) hi = mid;
    else lo = mid;
  }
  return hi * step;
}

function summarizeMde(values: number[], unreachable: number): MdeSummary | null {
  if (values.length === 0) return null;
  const s = values.slice().sort((a, b) => a - b);
  return { median: s[s.length >> 1], min: s[0], max: s[s.length - 1], unreachable };
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
  /**
   * The reference's windows, not just their pooled summary.
   *
   * `ref` is everything the z-score needs, but `detectLattice` asks a question
   * pooling throws away — whether the underlying values are two-valued, and
   * across what span. Answering it from both sides makes the answer robust to an
   * observation that happens to have seen only one of the two values.
   */
  refWindows: WindowStat[];
  /** Under `nullModel: "variogram"`: the latent process the unit's gate reads (latentModel). */
  latent?: LatentModel;
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
    return {
      units: [{ windows: observation.windows, ref: packageRef, refWindows: reference.windows }],
      unscoredGroups: [],
    };
  }

  const refByLabel = new Map<string, LensGroup>(
    (reference.groups ?? []).map((g) => [g.label, g]),
  );
  const units: ScoringUnit[] = [];
  const unscoredGroups: string[] = [];

  for (const g of obsGroups) {
    const refGroup = refByLabel.get(g.label);
    const ref = refGroup !== undefined ? poolStats(refGroup.windows) : undefined;
    // Same usability test the package applies (isReferenceUsable) — a group
    // whose own reference pool cannot ground a comparison is unscored, not
    // silently scored against nothing.
    if (refGroup === undefined || ref === undefined || !isReferenceUsable(ref)) {
      unscoredGroups.push(g.label);
      continue;
    }
    units.push({ group: g.label, windows: g.windows, ref, refWindows: refGroup.windows });
  }

  return { units, unscoredGroups };
}

/** Pooled aggregate of a reference lens's windows: {mean, variance, count}. */
/** A two-valued lattice: every event is `min` or `min + step`. See detectLattice. */
interface Lattice {
  min: number;
  step: number;
}

interface RefStats {
  mean: number;
  /** Bessel-corrected pooled variance over every retained event, weighted by
   * each window's own count — NaN when fewer than 2 events are pooled (spread
   * is unresolvable, not zero). */
  variance: number;
  /** Raw events pooled — for reporting (globalStats.eventCount), not for denominators. */
  count: number;
  /** Kish effective sample size of the pool — what standard errors divide by. */
  effectiveN: number;
  /**
   * Between-window variance of the latent rate (value units²). Set only under
   * `nullModel: "overdispersed"` (betweenWindowVariance); absent or 0 = the
   * independent-events model.
   */
  tau2?: number;
  /**
   * Σnₖ²/N² over the reference windows — how much of τ² survives into the
   * reference mean itself (1/K for K equal windows). Paired with tau2.
   */
  refShare?: number;
  /**
   * Degrees of freedom τ̂² was estimated with (Satterthwaite, from MSB's K−1).
   * Paired with tau2; the gate reads it to widen the tail (studentize).
   */
  tau2Df?: number;
  /**
   * Under `nullModel: "variogram"`, set per WINDOW (windowLatent): the latent
   * variance of this window's contrast with the reference mean, value units²,
   * and the degrees of freedom it rests on. When present it replaces
   * τ²·(1 + refShare) / tau2Df everywhere those are read.
   */
  latentVar?: number;
  latentDf?: number;
}

/**
 * One-way random-effects ANOVA over the reference windows: how much the
 * windows' means spread beyond what independent sampling inside each window
 * explains. That excess is τ², the variance of the windows' own latent rates.
 *
 *   MSB = Σ nₖ(mₖ − m̄)² / (K − 1)       between windows
 *   MSW = Σ nₖ·s²ₖ      / (N − K)       within windows
 *   τ̂²  = max(0, (MSB − MSW) / n₀),     n₀ = (N − Σnₖ²/N) / (K − 1)
 *
 * The textbook moment estimator (the DerSimonian–Laird form for unequal
 * cluster sizes): under independence E[MSB] = E[MSW], so τ̂² is 0 up to
 * noise, and the max(0, ·) clamp means a reference with no excess spread
 * leaves the gate untouched — that is what keeps synthetic iid calibration
 * bit-identical whenever the clamp lands.
 *
 * Read from the REFERENCE windows only, never the observation: estimating the
 * spread from the windows being scored would let an anomaly widen its own
 * error bar — the self-reference comparisonSE's doc already rules out.
 *
 * nₖ is the window's effective n (its count when unweighted) and s²ₖ its
 * weighted population variance, so `nₖ·s²ₖ` is exactly the within-window sum
 * of squares on unweighted data. Windows with no events carry no information
 * and are skipped; fewer than two informative windows, or no within-window
 * degrees of freedom, give no estimate (τ̂² = 0, i.e. the independent model).
 *
 * τ̂² is itself an estimate from K windows, and with the RC-sized reference
 * (10 one-second windows) a noisy one: plugged in as if known, it left the
 * standardized deviations of real Wikimedia windows at variance ≈1.45 instead
 * of 1 (ROADMAP_BRIEF.md 2026-10-07). `tau2Df` carries how many degrees of
 * freedom it rests on so the gate can studentize: Var(τ̂²) ≈ 2·MSB²/((K−1)n₀²)
 * gives ν = (K−1)(1 − MSW/MSB)² — near K−1 when the excess spread is
 * unmistakable, near 0 when τ̂² barely clears the clamp (and then τ̂² is also
 * small, so studentizeZ's Satterthwaite combination still lands near ∞).
 */
function betweenWindowVariance(windows: readonly WindowStat[]): { tau2: number; refShare: number; tau2Df: number } {
  const ws = windows.filter((w) => w.count > 0 && effectiveN(w) > 0);
  const K = ws.length;
  const ns = ws.map(effectiveN);
  const N = ns.reduce((s, n) => s + n, 0);
  const sumN2 = ns.reduce((s, n) => s + n * n, 0);
  const refShare = N > 0 ? sumN2 / (N * N) : 1;
  if (K < 2 || !(N - K > 0)) return { tau2: 0, refShare, tau2Df: Infinity };

  const grand = ws.reduce((s, w, k) => s + ns[k] * w.mean, 0) / N;
  const ssb = ws.reduce((s, w, k) => s + ns[k] * (w.mean - grand) ** 2, 0);
  const ssw = ws.reduce((s, w, k) => s + ns[k] * Math.max(0, w.sumSq / weightTotal(w) - w.mean * w.mean), 0);
  const msb = ssb / (K - 1);
  const msw = ssw / (N - K);
  const n0 = (N - sumN2 / N) / (K - 1);
  const tau2 = n0 > 0 ? Math.max(0, (msb - msw) / n0) : 0;
  if (!(tau2 > 0)) return { tau2: 0, refShare, tau2Df: Infinity };
  return { tau2, refShare, tau2Df: (K - 1) * (1 - msw / msb) ** 2 };
}

/** The variogram null's latent process for one scoring unit (latentModel). */
interface LatentModel {
  /** γ̂(h) for h = 0…maxLag, in windows; γ̂(0) = 0. */
  gamma: Float64Array;
  /** A window's lag index is round((windowStart − origin) / window_ms); origin = the first reference window. */
  origin: number;
  window_ms: number;
  /** Reference windows as (index, weight nₖ/N), and ΣⱼΣₖ wⱼwₖ·γ(rⱼ − rₖ). */
  ref: Array<{ i: number; w: number }>;
  refSelf: number;
  df: number;
  historyWindows: number;
  extrapolatedFromLag?: number;
}

/** The history windows a unit reads: its own group's, else the reference standing in (CurationContext.history). */
function historyFor(history: LensResult | undefined, group: string | undefined, refWindows: WindowStat[]): WindowStat[] {
  if (history === undefined) return refWindows;
  if (group === undefined) return history.windows;
  return history.groups?.find((g) => g.label === group)?.windows ?? refWindows;
}

/**
 * The latent rate as a process over time (ROADMAP_BRIEF.md 2026-10-14 (2)):
 * semivariogram γ(h) = ½·E[(θ_{t+h} − θ_t)²] in window lags, estimated from
 * the history, and the contrast variance every gate reads from it.
 *
 *   γ̂(h) = max(0, mean over pairs at lag h of ½(mₐ − m_b)² − ½(vₐ + v_b))
 *
 * vᵢ = the window's own sampling variance of its mean (Bessel: s²/n, so
 * m(1 − m)/(n − 1) on 0/1 data) — the same job ANOVA's MSW does for τ̂².
 * The classical (Matheron) estimator, not a robust one: the heavy-tailed moves
 * real data showed (2026-10-14 (4)) belong to the null, and a robust scale
 * would understate exactly the variance the gate needs.
 *
 * History windows ending after the reference's end are dropped (the
 * observation must not widen its own yardstick); only scorable windows with
 * n_eff > 1 enter (a sampling variance must exist to subtract). Lags with no
 * pairs repeat the last estimated γ̂ and are reported (extrapolatedFromLag).
 *
 * Degrees of freedom, for studentizing like tau2Df: the history is cut into
 * B ≤ 8 blocks of at least two comparison spans, each block's γ̂ gives its own
 * mean contrast variance V̄_b over the observation windows, and ν = 2B·V̄²/s²_b
 * (the χ² moment match). It is data-driven on purpose: on independent latent
 * rates the blocks agree and ν is large; when the latent process wanders, the
 * long lags are known only from a few spans' worth of history and the blocks
 * disagree. Fewer than two blocks: ν = 1.
 */
function latentModel(
  obsWindows: readonly WindowStat[],
  refWindows: readonly WindowStat[],
  histWindows: readonly WindowStat[],
  window_ms: number,
): LatentModel {
  const origin = refWindows[0]?.windowStart ?? 0;
  const idx = (w: WindowStat): number => Math.round((w.windowStart - origin) / window_ms);
  const refW = refWindows.filter((w) => w.count > 0 && effectiveN(w) > 0);
  const N = refW.reduce((s, w) => s + effectiveN(w), 0);
  const ref = refW.map((w) => ({ i: idx(w), w: effectiveN(w) / N }));
  const refEnd = Math.max(...refWindows.map((w) => w.windowEnd));
  const refLo = Math.min(...ref.map((r) => r.i));
  const refHi = Math.max(...ref.map((r) => r.i));
  const maxLag = Math.max(1, refHi - refLo, ...obsWindows.map((w) => idx(w) - refLo));

  const est = semivariogramFromWindows(histWindows, refEnd, window_ms, maxLag, origin);
  const { gamma, extrapolatedFromLag: from } = est;
  const B = est.blockGammas.length;

  const selfOf = (g: Float64Array): number => {
    let s = 0;
    for (const a of ref) for (const b of ref) s += a.w * b.w * g[Math.abs(a.i - b.i)];
    return s;
  };
  const obsIs = obsWindows.filter(isScorable).map(idx);
  const meanContrast = (g: Float64Array): number => {
    if (obsIs.length === 0) return 0;
    const self = selfOf(g);
    let total = 0;
    for (const i of obsIs) total += Math.max(0, contrastCross(g, ref, i, maxLag) - self);
    return total / obsIs.length;
  };
  let df = 1;
  if (B >= 2) {
    const vb = est.blockGammas.map((g) => meanContrast(g));
    const vbar = meanContrast(gamma);
    const mb = vb.reduce((s, x) => s + x, 0) / B;
    const s2 = vb.reduce((s, x) => s + (x - mb) ** 2, 0) / (B - 1);
    df = s2 > 0 ? (2 * B * vbar * vbar) / s2 : Infinity;
  }
  return {
    gamma, origin, window_ms, ref, refSelf: selfOf(gamma), df, historyWindows: est.historyWindows,
    ...(from !== undefined ? { extrapolatedFromLag: from } : {}),
  };
}

/** What semivariogramFromWindows estimated. */
export interface SemivariogramEstimate {
  /** γ̂(h) for h = 0…maxLag, in window lags; γ̂(0) = 0. */
  gamma: Float64Array;
  /** The first lag no window pair reached: its γ̂ and every later one repeat the last estimate. Absent when every lag was estimated. */
  extrapolatedFromLag?: number;
  /**
   * The same curve from each of B ≤ 8 consecutive blocks of the history (B =
   * how many blocks of at least two maxLag spans it holds) — the variogram
   * null's degrees of freedom are read from how far they disagree.
   */
  blockGammas: Float64Array[];
  /** Windows the estimate rests on (ending by `until`, scorable, n_eff > 1). */
  historyWindows: number;
}

/**
 * The latent semivariogram of a run of window summaries — the variogram null's
 * estimator (latentModel), shared with the forecast (forecast.ts) so a
 * forecast and the gate that later judges it read one γ̂:
 *
 *   γ̂(h) = max(0, mean over pairs at lag h of ½(mₐ − m_b)² − ½(vₐ + v_b))
 *
 * vᵢ = the window's own sampling variance of its mean (Bessel: s²/n, so
 * m(1 − m)/(n − 1) on 0/1 data). The classical (Matheron) estimator, not a
 * robust one (see latentModel). Only windows ending by `until` enter — the
 * caller's "nothing from what is being judged or predicted" — and only
 * scorable ones with n_eff > 1 (a sampling variance must exist to subtract).
 * Lags are window steps from `origin` (any point on the windows' grid).
 */
export function semivariogramFromWindows(
  histWindows: readonly WindowStat[],
  until: number,
  window_ms: number,
  maxLag: number,
  origin = 0,
): SemivariogramEstimate {
  const idx = (w: WindowStat): number => Math.round((w.windowStart - origin) / window_ms);
  const hist = histWindows.filter((w) => w.windowEnd <= until && isScorable(w) && effectiveN(w) > 1);
  const his = hist.map(idx);
  const lo = his.length > 0 ? Math.min(...his) : 0;
  const len = his.length > 0 ? Math.max(...his) - lo + 1 : 0;
  const m = new Float64Array(len).fill(NaN);
  const v = new Float64Array(len);
  hist.forEach((w, k) => {
    m[his[k] - lo] = w.mean;
    v[his[k] - lo] = Math.max(0, w.sumSq / weightTotal(w) - w.mean * w.mean) / (effectiveN(w) - 1);
  });

  const B = Math.min(8, Math.floor(len / (2 * maxLag)));
  const blockLen = B > 0 ? len / B : Infinity;
  const sum = new Float64Array(maxLag + 1);
  const cnt = new Float64Array(maxLag + 1);
  const bsum = Array.from({ length: B }, () => new Float64Array(maxLag + 1));
  const bcnt = Array.from({ length: B }, () => new Float64Array(maxLag + 1));
  for (let a = 0; a < len; a++) {
    if (Number.isNaN(m[a])) continue;
    const b = Math.min(B - 1, Math.floor(a / blockLen));
    for (let h = 1; h <= maxLag && a + h < len; h++) {
      if (Number.isNaN(m[a + h])) continue;
      const term = 0.5 * (m[a] - m[a + h]) ** 2 - 0.5 * (v[a] + v[a + h]);
      sum[h] += term;
      cnt[h]++;
      if (B > 0) {
        bsum[b][h] += term;
        bcnt[b][h]++;
      }
    }
  }
  const curve = (s: Float64Array, c: Float64Array): { gamma: Float64Array; from?: number } => {
    const gamma = new Float64Array(maxLag + 1);
    let from: number | undefined;
    for (let h = 1; h <= maxLag; h++) {
      if (c[h] > 0) gamma[h] = Math.max(0, s[h] / c[h]);
      else {
        from ??= h;
        gamma[h] = gamma[h - 1];
      }
    }
    return { gamma, from };
  };
  const { gamma, from } = curve(sum, cnt);
  return {
    gamma,
    ...(from !== undefined ? { extrapolatedFromLag: from } : {}),
    blockGammas: bsum.map((s, b) => curve(s, bcnt[b]).gamma),
    historyWindows: hist.length,
  };
}

/** 2·Σₖ wₖ·γ(i − rₖ): the cross term of a window at index i with the reference mean. */
function contrastCross(g: Float64Array, ref: LatentModel["ref"], i: number, maxLag: number): number {
  let s = 0;
  for (const r of ref) s += r.w * g[Math.min(maxLag, Math.abs(i - r.i))];
  return 2 * s;
}

/**
 * Var(θ_window − θ̄_ref) = 2·Σₖ wₖγ(o − rₖ) − ΣⱼΣₖ wⱼwₖγ(rⱼ − rₖ): the latent part
 * of this window's comparison. Flat γ = τ² gives τ²(1 + Σwₖ²) — the
 * overdispersed null's τ²(1 + refShare).
 */
function windowLatent(model: LatentModel, w: WindowStat): { latentVar: number; latentDf: number } {
  const maxLag = model.gamma.length - 1;
  const i = Math.round((w.windowStart - model.origin) / model.window_ms);
  return { latentVar: Math.max(0, contrastCross(model.gamma, model.ref, i, maxLag) - model.refSelf), latentDf: model.df };
}

/** The same contrast for a step run's pooled mean (weights uⱼ = nⱼ/Σn), minus the run's own ΣΣ uᵢuⱼγ(oᵢ − oⱼ). */
function runLatent(model: LatentModel, run: readonly WindowStat[]): { latentVar: number; latentDf: number } {
  const maxLag = model.gamma.length - 1;
  const ws = run.filter((w) => w.count > 0 && effectiveN(w) > 0);
  const n = ws.reduce((s, w) => s + effectiveN(w), 0);
  const pts = ws.map((w) => ({
    i: Math.round((w.windowStart - model.origin) / model.window_ms),
    u: effectiveN(w) / n,
  }));
  let cross = 0;
  let self = 0;
  for (const p of pts) {
    cross += p.u * contrastCross(model.gamma, model.ref, p.i, maxLag);
    for (const q of pts) self += p.u * q.u * model.gamma[Math.min(maxLag, Math.abs(p.i - q.i))];
  }
  return { latentVar: Math.max(0, cross - self - model.refSelf), latentDf: model.df };
}

/**
 * Turn a z computed with τ̂² plugged in as if known into the normal z with the
 * same tail under the Student-t that τ̂²'s uncertainty implies.
 *
 * Satterthwaite: the squared standard error is A + B, A = the independent-
 * sampling part (estimated from hundreds of events — treated as exact) and
 * B = τ̂²·(1 + refShare) on ν = tau2Df degrees of freedom, so
 * df = (A + B)² / (B²/ν). As B → 0 the df runs to ∞ and the z comes back
 * unchanged, which is how this stays continuous with "independent".
 *
 * Applied after the exact path as well as the normal one. That composition is
 * an approximation — the exact tail handles the window's discreteness and skew
 * at a plug-in concentration, the t handles the concentration being estimated
 * — and is not an exact predictive; it is the smallest step that gives the
 * K−1 degrees of freedom a voice at all.
 */
function studentizeZ(z: number, w: WindowStat, ref: RefStats): number {
  return studentizeWith(z, ref.variance * (1 / effectiveN(w) + 1 / ref.effectiveN), ref);
}

/** studentizeZ with the independent-sampling part `a` of the squared SE given directly (a step run's, say). */
function studentizeWith(z: number, a: number, ref: RefStats): number {
  if (ref.latentVar !== undefined) return studentizeParts(z, a, ref.latentVar, ref.latentDf ?? Infinity);
  const tau2 = ref.tau2 ?? 0;
  const nu = ref.tau2Df ?? Infinity;
  if (!(tau2 > 0) || !Number.isFinite(nu) || !Number.isFinite(z)) return z;
  const b = tau2 * (1 + (ref.refShare ?? 0));
  const df = ((a + b) * (a + b)) / ((b * b) / nu);
  if (!(df > 0) || df > 1e6) return z;
  const tail = studentUpperTail(Math.abs(z), df);
  return Math.sign(z) * -normalQuantile(tail);
}

/** The same Satterthwaite step with the estimated part `b` and its `nu` given directly (the variogram null's). */
function studentizeParts(z: number, a: number, b: number, nu: number): number {
  if (!(b > 0) || !Number.isFinite(nu) || !Number.isFinite(z)) return z;
  const df = ((a + b) * (a + b)) / ((b * b) / nu);
  if (!(df > 0) || df > 1e6) return z;
  return Math.sign(z) * -normalQuantile(studentUpperTail(Math.abs(z), df));
}

/** P(T > t) for t ≥ 0 under Student-t with `df` degrees of freedom: ½·I_{df/(df+t²)}(df/2, ½). */
export function studentUpperTail(t: number, df: number): number {
  return 0.5 * regularizedIncompleteBeta(df / (df + t * t), df / 2, 0.5);
}

/** I_x(a, b) via the Lentz continued fraction (Numerical Recipes betacf), symmetry-swapped for convergence. */
function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lnFront = logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x);
  if (x > (a + 1) / (a + b + 2)) return 1 - (Math.exp(lnFront) * betaContinuedFraction(1 - x, b, a)) / b;
  return (Math.exp(lnFront) * betaContinuedFraction(x, a, b)) / a;
}

function betaContinuedFraction(x: number, a: number, b: number): number {
  const tiny = 1e-300;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-14) break;
  }
  return h;
}

/** ln Γ(x) for x > 0, Lanczos (g = 7, n = 9; ~1e-15 relative). */
function logGamma(x: number): number {
  const g = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - logGamma(1 - x);
  const xx = x - 1;
  let s = g[0];
  for (let i = 1; i < 9; i++) s += g[i] / (xx + i);
  const t = xx + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (xx + 0.5) * Math.log(t) - t + Math.log(s);
}

/**
 * Pool reference windows into one {mean, variance, count} triple. This is the
 * baseline-population step of detection-as-binary-operation (ROADMAP_BRIEF.md
 * 2026-07-25): unlike averaging window means (which weights a count=1 window
 * the same as a count=500 window), this pools at the event level via each
 * window's own (count, mean, sumSq) so the population stat is honestly
 * count-weighted.
 *
 * Weight-aware since the `decay` groundwork (2026-08-17), and exactly
 * equivalent to the previous form while nothing is weighted:
 *
 *   - the mean averages over ΣW rather than raw count (identical when W≡1);
 *   - the variance denominator is `ΣW - ΣW²/ΣW`, the reliability-weight
 *     analogue of Bessel's correction, which collapses to `n - 1` when W≡1
 *     (ΣW²/ΣW = n/n = 1). Reliability weights, not frequency weights: a
 *     half-decayed event is a less relevant observation, not half an
 *     occurrence, and using the frequency form `ΣW - 1` there would understate
 *     the variance of a heavily decayed pool.
 */
function poolStats(windows: WindowStat[]): RefStats {
  const count = windows.reduce((s, w) => s + w.count, 0);
  if (count === 0) return { mean: 0, variance: 0, count: 0, effectiveN: 0 };

  const sumW = windows.reduce((s, w) => s + weightTotal(w), 0);
  const sumW2 = windows.reduce((s, w) => s + weightSquaredTotal(w), 0);
  const nEff = kishEffectiveN(sumW, sumW2);
  const mean = windows.reduce((s, w) => s + w.mean * weightTotal(w), 0) / sumW;

  if (nEff < 2) return { mean, variance: NaN, count, effectiveN: nEff };
  const sumSq = windows.reduce((s, w) => s + w.sumSq, 0);
  const denom = sumW - sumW2 / sumW;
  const variance = Math.max(0, (sumSq - sumW * mean * mean) / denom);
  return { mean, variance, count, effectiveN: nEff };
}

/**
 * Can this pooled reference ground a comparison at all?
 *
 * ONE predicate, called by all three places that read a reference's
 * usability: the package-level `referenceUsable` flag, buildScoringUnits'
 * per-group pairing, and detectSteps' per-run guard. Before this they were
 * three independent copies that had already drifted apart — only the
 * package-level flag checked `variance > 0` (added 2026-08-17, after a
 * reference whose pooled events were all identical reported "usable" while
 * grounding no comparison, ROADMAP_BRIEF.md 2026-08-17); the group and step
 * paths still read a zero-variance reference as usable. Same failure shape
 * as isScorable's history above — three copies that happened to agree,
 * until one of them silently didn't.
 *
 * The floor is also raised here, from `effectiveN >= 2` to
 * `effectiveN >= MIN_VALID_COUNT`. `effectiveN >= 2` is the bare minimum for
 * Bessel's correction to produce a number at all, not a claim that the
 * number MEANS anything — at n_eff≈2 the variance estimate carries close to
 * zero degrees of freedom and can land almost anywhere. MIN_VALID_COUNT is
 * already this codebase's answer to "how many samples does a normal
 * approximation need before it means something" (see isScorable, same
 * reasoning, applied to the window being scored); reusing it here applies
 * the identical rule to the yardstick doing the scoring, rather than
 * inventing a second unmeasured constant.
 *
 * This precondition matters most for L5 (ROADMAP_BRIEF.md 2026-08-18 (5)
 * §B): thinning a retained reference keeps its raw event `count` intact
 * while shrinking `effectiveN`, unlike decay, which shrinks both together
 * and is easier to notice going wrong. A floor of exactly 2 would let a
 * heavily-thinned reference keep reporting "usable" long after it stopped
 * being one — the silence-vs-blindness failure this project treats as its
 * worst case, reached this time on the reference side instead of the
 * observation side.
 */
function isReferenceUsable(ref: RefStats): boolean {
  return ref.effectiveN >= MIN_VALID_COUNT && Number.isFinite(ref.variance) && ref.variance > 0;
}

/**
 * Can this window be scored at all?
 *
 * ONE predicate, called by all three places that need the answer: the Šidák
 * family size, the scoring loop, and the unreachable-tail bound. They were
 * three copies of `w.count >= MIN_VALID_COUNT` that happened to agree, and a
 * family sized differently from the set of windows actually tested is the exact
 * failure this project has already recorded once — a degenerate window that
 * cannot fire still raises the bar for every window that can.
 *
 * The two conditions do different jobs, and the second is deliberately NOT a
 * second sample-size threshold:
 *
 *   - `count >= MIN_VALID_COUNT` — how many events there were. Below that the
 *     mean is noise regardless of weighting. This is the sample-size test, and
 *     it stays on the raw count.
 *   - `effectiveN > 0` — that a standard error EXISTS at all. Not "is large
 *     enough": a window carrying the evidence of one observation is scorable
 *     and simply has a wide error bar, which is the honest outcome.
 *
 * Requiring `effectiveN >= MIN_VALID_COUNT` was tried and is wrong — under any
 * weighting the events in a window differ slightly in age, so a healthy
 * 3-event window lands at n_eff 2.999998 and would be discarded on a 2e-6
 * shortfall. The sample-size job belongs to `count`; asking `effectiveN` to
 * repeat it just adds a boundary artifact.
 *
 * The degenerate case this exists for is reachable rather than theoretical:
 * past about 414τ of age every weight underflows its own square, so ΣW² is
 * exactly 0 while ΣW is not, and effective n collapses to 0. `exp(tau=1s)` over
 * a segment seven minutes deep is enough, and replaying historical spans is
 * what the model is for. Such a window has an infinite standard error, so it
 * could never fire — but it counted toward the family and made every other
 * window harder to flag. Measured before this guard: a lone anomalous window's
 * bar rose from 2.00σ to 2.27σ because of one companion that was structurally
 * silent.
 */
export function isScorable(w: WindowStat): boolean {
  return w.count >= MIN_VALID_COUNT && effectiveN(w) > 0;
}

/**
 * Does any window in this LensResult carry agg_func:"median"? A single
 * applyLens() call produces windows under one agg_func uniformly (lens.ts),
 * so checking the mixed `windows` array is enough — a grouped lens's
 * `groups[*].windows` are built by the same call and carry the same tag, but
 * every path that can reach this (both `curate()` call sites) starts from
 * `windows`, so there is no case where `windows` says "mean" while a group
 * secretly says "median".
 */
function hasMedianWindows(result: LensResult): boolean {
  return result.windows.some((w) => w.aggFunc !== undefined);
}

/**
 * Note the tails this unit's gate could not have fired in.
 *
 * A window mean is an average of values the stream actually produced, so it
 * cannot exceed the largest value observed nor fall below the smallest. That
 * ceiling and floor, converted to z against the same reference and the same
 * standard error the gate uses, bound what the gate could ever see. When the
 * bound falls short of the threshold, "no tile in that direction" carries no
 * information at all.
 *
 * The bound comes from the OBSERVED range rather than an assumed domain, which
 * keeps this domain-blind and makes it conservative in the right direction: a
 * real ceiling can only be lower than the largest value seen, so the tail is at
 * least as unreachable as reported.
 *
 * Uses the most generous window in the unit — the one with the largest
 * effective n, since a bigger window has the smallest standard error and
 * therefore the best chance of clearing the gate. If even that window cannot,
 * none can.
 */
function collectUnreachableTails(
  unit: { windows: WindowStat[]; ref: RefStats; group?: string },
  requiredZ: number,
  lattice: Lattice | null,
  model: CategoricalModel | null,
  out: UnreachableTail[],
  refFor: (w: WindowStat) => RefStats = () => unit.ref,
): void {
  const scorable = unit.windows.filter((w) => isScorable(w) && w.range !== undefined);
  if (scorable.length === 0 || !(unit.ref.variance > 0)) return;

  const best = scorable.reduce((a, b) => (effectiveN(b) > effectiveN(a) ? b : a));
  const ref = refFor(best);
  const se = comparisonSE(best, ref);
  if (!(se > 0)) return;

  const observedMax = Math.max(...scorable.map((w) => w.range!.max));
  const observedMin = Math.min(...scorable.map((w) => w.range!.min));
  // Scored through the same gate, continuity correction included. Asking a
  // different question here than the gate asks would be a slow way to start
  // declaring reachable tails unreachable, or worse, the reverse.
  // Every event AT the extreme value, sumSq included: exactZ decomposes a
  // window from mean and sumSq together, and a mean moved on its own would
  // not decompose (it would silently fall back to the normal gate — a
  // different question than the one the scoring loop asks).
  const ceiling: WindowStat = { ...best, mean: observedMax, sumSq: best.count * observedMax * observedMax };
  const floor: WindowStat = { ...best, mean: observedMin, sumSq: best.count * observedMin * observedMin };
  const maxZ = gate(ceiling, ref, se, lattice, model);
  const minZ = gate(floor, ref, se, lattice, model);

  const group = unit.group !== undefined ? { group: unit.group } : {};
  if (maxZ < requiredZ) {
    out.push({ direction: "spike", ...group, attainableZ: maxZ, requiredZ });
  }
  if (-minZ < requiredZ) {
    out.push({ direction: "dip", ...group, attainableZ: minZ, requiredZ });
  }
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
 * The `1/ref.effectiveN` term carries the reference's own estimation
 * uncertainty, so a short reference widens the error bar instead of being
 * trusted absolutely. NaN (reference too small to have a variance) propagates
 * and silences firing.
 *
 * Both denominators are EFFECTIVE sample sizes, not raw event counts. They are
 * the same number until a weighting lens exists (effectiveN of an unweighted
 * window is exactly its count), and they stop being the same the moment one
 * does: 100 events at weight 0.01 carry the precision of one observation, not
 * a hundred, and dividing by the raw count there would shrink the error bar by
 * 10x on evidence that does not support it.
 */
function comparisonSE(w: WindowStat, ref: RefStats): number {
  const independent = ref.variance * (1 / effectiveN(w) + 1 / ref.effectiveN);
  if (ref.latentVar !== undefined) return Math.sqrt(independent + ref.latentVar);
  // Overdispersed null: the window's own latent rate is off the population's
  // by τ², and the reference mean carries τ² too, shrunk by refShare (≈1/K).
  // ref.variance stays the TOTAL event variance rather than the within-window
  // part, which counts τ² once more over n — a slight overstatement, kept so
  // that τ̂² = 0 reproduces "independent" exactly.
  const tau2 = ref.tau2 ?? 0;
  if (!(tau2 > 0)) return Math.sqrt(independent);
  return Math.sqrt(independent + tau2 * (1 + (ref.refShare ?? 0)));
}

/**
 * The spacing of the value lattice this comparison lives on, or null when the
 * data is not verifiably lattice-valued.
 *
 * The z-score treats the window mean as continuous. It is not: on a pass/fail
 * stream a window of n events can only produce n+1 distinct means, spaced
 * `(max-min)/n` apart, and the gate falls wherever it falls between two of them.
 * That coarseness is the larger half of the calibration gap measured on
 * 2026-08-17 — see ROADMAP_BRIEF.md, where a smooth skewness correction
 * (Cornish-Fisher) was tried first and failed precisely because the error it
 * models is not smooth.
 *
 * Two-valuedness is DETECTED, not assumed. If every event is either `min` or
 * `max`, then the mean fixes the mix, and the mean of squares is forced:
 *
 *     E[v]  = min + q·(max-min),  q = fraction at max
 *     E[v²] = min² + q·(max²-min²)
 *
 * so `sumSq/count` must equal that second expression. Checking the identity
 * costs nothing (both quantities are already carried as sufficient statistics)
 * and keeps the curator domain-blind in the way the rest of the module is: it
 * asks the data a question rather than assuming values are pass/fail, and
 * measurably declines on continuous data — a uniform[0,1] stream scores
 * bit-identically with and without this path.
 *
 * WEIGHTED WINDOWS ARE INCLUDED, and the identity is unchanged apart from what
 * "how many" means. Under weights w, Σw·v = min·W + (max-min)·W_max and
 * Σw·v² = min²·W + (max²-min²)·W_max, so eliminating W_max gives exactly the
 * same relation with total weight in place of count. Refusing to answer here
 * was the first thing tried and it was measurably wrong: under `decay: exp(τ)`
 * the false-alarm rate went straight back to 7.1% — the pre-correction figure —
 * because switching the correction off is all that a weighting lens was doing
 * to the gate (ROADMAP_BRIEF.md 2026-08-17).
 */
function detectLattice(observation: readonly WindowStat[], reference: readonly WindowStat[]): Lattice | null {
  let min = Infinity;
  let max = -Infinity;
  let sumSq = 0;
  let sum = 0;
  let weight = 0;

  for (const w of [...observation, ...reference]) {
    if (w.count === 0) continue;
    if (w.range === undefined) return null;
    min = Math.min(min, w.range.min);
    max = Math.max(max, w.range.max);
    sumSq += w.sumSq;
    sum += w.mean * weightTotal(w);
    weight += weightTotal(w);
  }
  if (!(weight > 0) || !(max > min)) return null;

  const q = (sum / weight - min) / (max - min);
  const predicted = min * min + (max * max - min * min) * q;
  const tolerance = 1e-9 * Math.max(1, Math.abs(predicted));
  return Math.abs(sumSq / weight - predicted) <= tolerance ? { min, step: max - min } : null;
}

/**
 * The window's deviation from the reference, in standard errors, with a
 * continuity correction applied when the data is lattice-valued.
 *
 * Half a step of the MEAN's lattice — `latticeStep / n`, since the sum moves by
 * `latticeStep` and the mean by that over n — is taken off the magnitude of the
 * deviation, never off its sign, and never past zero. This is the textbook
 * correction for approximating a discrete tail by a continuous one, and it is
 * the direction that matters here: it makes the gate harder to clear, which is
 * what a rate measured ABOVE its design target needs.
 *
 * The n is the EFFECTIVE sample size, which is exactly `count` for an
 * unweighted window (so no published figure moves) and is the conservative
 * choice under weights. Flipping event i moves a weighted mean by
 * `w_i·latticeStep/ΣW`, so the achievable means are no longer evenly spaced;
 * `latticeStep/n_eff` is the average step inflated by the spread of the
 * weights, which errs toward correcting slightly too much rather than too
 * little. Measured under `decay: exp(τ)` the difference from using raw count is
 * negligible anyway — events inside one window are close in age, so their
 * weights are nearly equal and n_eff lands within a fraction of a percent of
 * count (lens.ts's scale-invariance note).
 *
 * Measured at the pilot's own shape (0.95 pass, ~100 events/window, 2000 null
 * trials): 6.85% package false-alarm rate against a 4.55% design target, down to
 * 4.40% with this correction. The full sweep, including where it does NOT close
 * the gap (p=0.99, and windows under ~50 events), is in ROADMAP_BRIEF.md
 * 2026-08-17.
 */
function gateZ(w: WindowStat, ref: RefStats, se: number, latticeStep: number | null): number {
  const deviation = w.mean - ref.mean;
  const n = effectiveN(w);
  if (latticeStep === null || !(n > 0)) return deviation / se;
  const shrunk = Math.max(0, Math.abs(deviation) - 0.5 * (latticeStep / n));
  return (Math.sign(deviation) * shrunk) / se;
}

/**
 * The gate every window passes through: the exact tail where the data allows
 * one (exactZ), the continuity-corrected normal approximation where it does
 * not (weighted windows or references, or values not on a small even lattice).
 */
function gate(
  w: WindowStat,
  ref: RefStats,
  se: number,
  lattice: Lattice | null,
  model: CategoricalModel | null,
): number {
  const exact = model === null ? null : exactZ(w, model, ref.latentVar);
  return studentizeZ(exact ?? gateZ(w, ref, se, lattice?.step ?? null), w, ref);
}

/**
 * Events on an evenly spaced lattice of 2 or 3 levels, with the reference's
 * count at each level — what exactZ needs to compute a window's exact null
 * distribution. Null when that distribution is not available (see below).
 */
interface CategoricalModel {
  min: number;
  step: number;
  levels: 2 | 3;
  /** Reference events at each level, pooled over every reference window. */
  refCounts: number[];
  /**
   * Overdispersed null only: τ² in step units² and the reference's refShare,
   * which exactZ folds into the Dirichlet concentration. Absent = independent.
   */
  overdispersion?: { tau2Step: number; refShare: number };
}

/**
 * Per-level event counts of an UNWEIGHTED window, recovered exactly from the
 * sufficient statistics it already carries — no raw values needed.
 *
 * In step units u = (v − min)/step ∈ {0, 1, 2}, the window gives Σu (from the
 * mean) and Σu² (from sumSq). Two equations, two unknowns: c₂ = (Σu² − Σu)/2,
 * c₁ = Σu − 2c₂, c₀ = n − c₁ − c₂. The answer is only accepted when all three
 * come out as non-negative integers — that IS the lattice test, the same
 * "ask the data" move detectLattice makes for two levels, extended by one.
 */
function levelCounts(w: WindowStat, min: number, step: number, levels: 2 | 3): number[] | null {
  if (w.weights !== undefined) return null;
  const n = w.count;
  if (n === 0) return levels === 2 ? [0, 0] : [0, 0, 0];
  const sum = w.mean * n;
  const su = (sum - n * min) / step;
  const su2 = (w.sumSq - 2 * min * sum + n * min * min) / (step * step);
  const tol = 1e-6 * Math.max(1, n);
  const asCount = (v: number): number | null => {
    const r = Math.round(v);
    return Math.abs(v - r) <= tol && r >= 0 && r <= n ? r : null;
  };
  if (levels === 2) {
    // Two levels: every u is 0 or 1, so Σu² must equal Σu.
    if (Math.abs(su2 - su) > tol) return null;
    const c1 = asCount(su);
    return c1 === null ? null : [n - c1, c1];
  }
  const c2 = asCount((su2 - su) / 2);
  const c1 = c2 === null ? null : asCount(su - 2 * c2);
  if (c1 === null || c2 === null || n - c1 - c2 < 0) return null;
  return [n - c1 - c2, c1, c2];
}

/**
 * Decide, once per scoring unit, whether exactZ can run: every window —
 * observation and reference — unweighted and decomposable onto the same 2- or
 * 3-level lattice. Two levels are tried first so that pass/fail data keeps its
 * plain beta-binomial model; three cover the pilot's own pass/flaky/fail
 * mapping (1 / 0.5 / 0), which is not two-valued and therefore never reached
 * detectLattice's continuity correction either (2026-09-27 review).
 */
function categoricalModel(
  observation: readonly WindowStat[],
  reference: readonly WindowStat[],
  ref: RefStats,
): CategoricalModel | null {
  const all = [...observation, ...reference].filter((w) => w.count > 0);
  if (all.length === 0 || reference.every((w) => w.count === 0)) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const w of all) {
    if (w.range === undefined || w.weights !== undefined) return null;
    min = Math.min(min, w.range.min);
    max = Math.max(max, w.range.max);
  }
  if (!(max > min)) return null;

  for (const levels of [2, 3] as const) {
    const step = (max - min) / (levels - 1);
    if (!all.every((w) => levelCounts(w, min, step, levels) !== null)) continue;
    const refCounts = new Array<number>(levels).fill(0);
    for (const w of reference) {
      const c = levelCounts(w, min, step, levels)!;
      for (let i = 0; i < levels; i++) refCounts[i] += c[i];
    }
    const tau2 = ref.tau2 ?? 0;
    return tau2 > 0
      ? { min, step, levels, refCounts, overdispersion: { tau2Step: tau2 / (step * step), refShare: ref.refShare ?? 0 } }
      : { min, step, levels, refCounts };
  }
  return null;
}

/** Windows above this size skip the exact path: O(n²) for three levels, and the normal approximation is sound there anyway. */
const EXACT_MAX_COUNT = 2_000;

/**
 * The window's surprise under the reference, from the EXACT sampling
 * distribution of its score, expressed as the normal z with the same one-sided
 * tail — so it feeds the unchanged Šidák gate and nothing downstream needs to
 * know which path produced it.
 *
 * Why this exists (2026-09-27 review, finding 4). The z-test's normal
 * approximation is fine when a window holds ~100 events near p=0.95 (the shape
 * the 4.40% calibration was measured on) and badly wrong when it holds ~12:
 * the count of failures is then close to Poisson with a mean under 1, whose
 * upper tail is far heavier than a normal one. The RC replay lens (1s windows
 * × group_by:agentId) lives exactly there and raised a false dip in 41% of
 * quiet packages against a 4.55% design. The continuity correction cannot fix
 * it — it is a first-order term for a lattice, not for skew — and
 * Cornish-Fisher already failed here once (2026-08-17) because the error is
 * not smooth.
 *
 * The null distribution is the reference's POSTERIOR PREDICTIVE, not a
 * multinomial at the reference's point estimate: level counts ~
 * DirichletMultinomial(n, refCounts + ½) (Jeffreys prior), the exact
 * counterpart of comparisonSE's `1/ref.effectiveN` term — a short reference
 * widens the distribution instead of being trusted absolutely. With two
 * levels this is the beta-binomial. The score whose tail is taken is the
 * window sum in step units, Σ i·cᵢ — the exact version of what the z-test
 * standardises.
 *
 * MID-p, not the plain exact tail. The plain exact test was measured on
 * 2026-08-17 as never reaching its design rate (a discrete statistic can only
 * reject at the attainable tail sizes, so it rejects less than asked); mid-p
 * counts half the probability of the observed score itself, the standard
 * remedy.
 */
function exactZ(w: WindowStat, model: CategoricalModel, latentVar?: number): number | null {
  const n = w.count;
  if (!(n > 0) || n > EXACT_MAX_COUNT) return null;
  const c = levelCounts(w, model.min, model.step, model.levels);
  if (c === null) return null;
  const x = c.reduce((s, ci, i) => s + i * ci, 0);

  const alpha = concentration(
    model.refCounts.map((r) => r + 0.5),
    model.overdispersion,
    latentVar === undefined ? undefined : latentVar / (model.step * model.step),
  );
  const A = alpha.reduce((s, a) => s + a, 0);
  // Cumulative tables, so each composition costs a few additions:
  //   logFact[j] = ln j!,  g[i][j] = ln Γ(αᵢ + j) − ln Γ(αᵢ).
  const logFact = new Float64Array(n + 1);
  for (let j = 1; j <= n; j++) logFact[j] = logFact[j - 1] + Math.log(j);
  const g = alpha.map((a) => {
    const t = new Float64Array(n + 1);
    for (let j = 1; j <= n; j++) t[j] = t[j - 1] + Math.log(a + j - 1);
    return t;
  });
  let logConst = logFact[n];
  for (let j = 0; j < n; j++) logConst -= Math.log(A + j);

  let below = 0;
  let above = 0;
  let at = 0;
  const add = (score: number, lp: number): void => {
    const p = Math.exp(lp);
    if (score < x) below += p;
    else if (score > x) above += p;
    else at += p;
  };
  if (model.levels === 2) {
    for (let c1 = 0; c1 <= n; c1++) {
      const c0 = n - c1;
      add(c1, logConst - logFact[c0] - logFact[c1] + g[0][c0] + g[1][c1]);
    }
  } else {
    for (let c2 = 0; c2 <= n; c2++) {
      for (let c1 = 0; c1 + c2 <= n; c1++) {
        const c0 = n - c1 - c2;
        add(c1 + 2 * c2, logConst - logFact[c0] - logFact[c1] - logFact[c2] + g[0][c0] + g[1][c1] + g[2][c2]);
      }
    }
  }
  const expected = (n * alpha.reduce((s, a, i) => s + i * a, 0)) / A;
  // Each side from its own tail sum, never as 1 − (the other): the tail that
  // matters is the small one, and subtracting it from 1 would round it away.
  return x < expected ? normalQuantile(below + 0.5 * at) : -normalQuantile(above + 0.5 * at);
}

/**
 * The Dirichlet parameters of exactZ's null, widened for an overdispersed
 * reference by lowering the total concentration and keeping the proportions.
 *
 * Under Dirichlet(α) with A = Σα, the window's latent score-rate Σ i·θᵢ has
 * variance s²/(A+1), s² being the categorical variance (step units) at the
 * proportions α/A. Under independence that is all of it — the posterior
 * uncertainty of the reference rate. The overdispersed null adds the window's
 * own latent deviation τ² and τ²'s share in the reference mean:
 *
 *   V = s²/(A+1) + τ²·(1 + refShare),   and A' + 1 = s²/V
 *
 * so the beta-binomial (2 levels) / Dirichlet-multinomial (3) is moment-matched
 * to the same predictive variance comparisonSE uses on the normal path. One
 * concentration for every level means the 3-level case assumes the latent
 * rates co-vary like a Dirichlet does — the simplest overdispersed multinomial,
 * not a fitted one. τ² = 0 returns α untouched (bit-identical).
 */
function concentration(alpha: number[], od: CategoricalModel["overdispersion"], latentStep?: number): number[] {
  // The latent variance in step units²: the variogram null's per-window value
  // when given, else the overdispersed null's τ²·(1 + refShare).
  const extra = latentStep ?? (od === undefined ? 0 : od.tau2Step * (1 + od.refShare));
  if (!(extra > 0)) return alpha;
  const A = alpha.reduce((s, a) => s + a, 0);
  const meanStep = alpha.reduce((s, a, i) => s + i * a, 0) / A;
  const s2 = alpha.reduce((s, a, i) => s + i * i * a, 0) / A - meanStep * meanStep;
  if (!(s2 > 0)) return alpha;
  const v = s2 / (A + 1) + extra;
  // A' below ~1e-6 would make the predictive a pair of point masses; the
  // floor only guards the arithmetic (lgamma of ~0), it is not a tuning knob.
  const scaled = Math.max(1e-6, s2 / v - 1);
  return alpha.map((a) => (a * scaled) / A);
}

/** Median of an ascending-sorted array (the upper middle for an even length). */
function sortedMedian(xs: readonly number[]): number {
  return xs[xs.length >> 1];
}

/**
 * The volume channel (CurationOptions.volumeChannel): each unit's windows against
 * the unit's own reference volume, on the log scale, robustly. See the option's
 * doc for the yardstick; the family is every window scored across units.
 */
function scoreVolume(
  units: readonly ScoringUnit[], baseZ: number, recordScores: boolean, span?: { fromTs: number; toTs: number },
): VolumeChannel {
  const full = (w: WindowStat) => weightTotal(w) > 0 && (span === undefined || (w.windowStart >= span.fromTs && w.windowEnd - 1 <= span.toTs));
  interface Yard { unit: ScoringUnit; vu: VolumeUnit; centre: number; se: number; df: number }
  const yards: Yard[] = [];
  for (const unit of units) {
    const vols = unit.refWindows.map(weightTotal).filter((v) => v > 0);
    const blind = vols.length < MIN_VOLUME_REFERENCE_WINDOWS;
    if (blind) {
      yards.push({
        unit, centre: 0, se: NaN, df: Infinity,
        vu: { ...(unit.group !== undefined ? { group: unit.group } : {}), referenceWindows: vols.length, typicalVolume: 0, logScale: 0, df: Infinity, blind: true },
      });
      continue;
    }
    const sorted = vols.slice().sort((a, b) => a - b);
    const typical = sortedMedian(sorted);
    const logs = sorted.map(Math.log);
    const centre = sortedMedian(logs);
    const mad = sortedMedian(logs.map((x) => Math.abs(x - centre)).sort((a, b) => a - b));
    const poisson = 1 / Math.sqrt(Math.max(typical, 1));
    const logScale = Math.max(1.4826 * mad, poisson);
    // The spread was estimated from the reference unless the Poisson floor set it.
    const df = 1.4826 * mad >= poisson ? MAD_EFFICIENCY * (vols.length - 1) : Infinity;
    yards.push({
      unit, centre, df, se: logScale * Math.sqrt(1 + 1 / vols.length),
      vu: { ...(unit.group !== undefined ? { group: unit.group } : {}), referenceWindows: vols.length, typicalVolume: typical, logScale, df, blind: false },
    });
  }
  const family = yards.reduce((n, y) => n + (y.vu.blind ? 0 : y.unit.windows.filter(full).length), 0);
  const gate = sidakCorrectedThreshold(baseZ, family);
  const tiles: VolumeTile[] = [];
  const scores: VolumeScore[] = [];
  for (const y of yards) {
    if (y.vu.blind) continue;
    const tag = y.unit.group !== undefined ? `[${y.unit.group}] ` : "";
    const inGroup = y.unit.group !== undefined ? ` in group "${y.unit.group}"` : "";
    for (const w of y.unit.windows) {
      if (!full(w)) continue;
      const v = weightTotal(w);
      const z = (Math.log(v) - y.centre) / y.se;
      const gateZ = Number.isFinite(y.df) ? Math.sign(z) * -normalQuantile(studentUpperTail(Math.abs(z), y.df)) : z;
      const volumeRatio = v / y.vu.typicalVolume;
      if (recordScores) scores.push({ windowStart: w.windowStart, ...(y.unit.group !== undefined ? { group: y.unit.group } : {}), volume: v, volumeRatio, z, gateZ });
      if (Math.abs(gateZ) < gate) continue;
      const direction = z > 0 ? "up" : "down";
      tiles.push({
        label: `${tag}volume ${direction} at t=${w.windowStart} (${volumeRatio.toFixed(2)}× the reference's median window)`,
        direction,
        regionStart: w.windowStart,
        regionEnd: w.windowEnd,
        ...(y.unit.group !== undefined ? { group: y.unit.group } : {}),
        volume: v,
        volumeRatio,
        z,
        gateZ,
        description: `Window volume ${v.toFixed(0)} is ${volumeRatio.toFixed(2)}× the reference's median window (${y.vu.typicalVolume.toFixed(0)})${inGroup}, ${Math.abs(z).toFixed(1)}σ ${direction === "up" ? "above" : "below"} on the log scale. The stream's make-up changed; this is not a rate finding.`,
      });
    }
  }
  tiles.sort((a, b) => a.regionStart - b.regionStart);
  return {
    baseZThreshold: baseZ,
    effectiveZThreshold: gate,
    scoredWindowCount: family,
    units: yards.map((y) => y.vu),
    tiles,
    ...(recordScores ? { scores } : {}),
  };
}

/** Median event count of `windows` (the upper middle for an even count); 0 when empty. */
function medianCount(windows: readonly WindowStat[]): number {
  if (windows.length === 0) return 0;
  const counts = windows.map((w) => w.count).sort((a, b) => a - b);
  return counts[counts.length >> 1];
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
export function sidakCorrectedThreshold(baseZ: number, n: number): number {
  if (n <= 1) return baseZ;
  const alpha = familyWiseAlpha(baseZ);
  const alphaCorrected = 1 - Math.pow(1 - alpha, 1 / n);
  return normalQuantile(1 - alphaCorrected / 2);
}

/**
 * The package-level false-alarm budget a given `spikeZThreshold` declares.
 *
 * Since 対策A the threshold means a FAMILY-wise rate, so this is the fraction
 * of null packages that are expected to raise at least one spurious tile — the
 * number a calibration measurement has to be compared against. Exported so
 * that comparison is against the design, derived from the same formula the
 * gate uses, rather than against a figure someone once measured and pasted
 * into a test.
 */
export function familyWiseAlpha(baseZ: number): number {
  return 2 * (1 - normalCdf(baseZ));
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
export function normalQuantile(p: number): number {
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
  gateZ: number,
  group?: string,
  /**
   * Given = the "variogram" null, and describe only: a run becomes a tile when
   * it holds a window the spike/dip gate fired on in the same direction
   * (`gatedDir`), and is not tested itself. Its magnitude is the run's contrast
   * z under `latent`, in the same yardstick as the windows'.
   */
  variogram?: { latent: LatentModel; gatedDir: ReadonlyMap<WindowStat, 1 | -1> },
): SnapshotTile[] {
  const latent = variogram?.latent;
  const describeOnly = variogram?.gatedDir;
  if (windows.length < minRun) return [];
  // No yardstick, no comparison — mirrors spike/dip's silent skip when the
  // reference can't ground a z-score (buildScoringUnits applies the same
  // test, via the same isReferenceUsable predicate), rather than reporting a
  // step_up/step_down with a fabricated magnitude:0. Blindness must not read
  // as "measured, no shift".
  if (!isReferenceUsable(ref)) return [];
  const tiles: SnapshotTile[] = [];
  const tag = group !== undefined ? `[${group}] ` : "";
  let runDir: 1 | -1 | null = null;
  let runStart = 0;

  const emit = (start: number, end: number, dir: 1 | -1): void => {
    const run = windows.slice(start, end + 1);
    // Same split as comparisonSE: the mean averages over total weight, while
    // the standard error divides by effective sample size. Both reduce to the
    // raw event count while nothing is weighted. Effective n across a run is
    // derived from the summed weight moments rather than summing each window's
    // n_eff, because effective n is not additive (see WindowStat.weights).
    const runSumW = run.reduce((s, w) => s + weightTotal(w), 0);
    const runSumW2 = run.reduce((s, w) => s + weightSquaredTotal(w), 0);
    const runEffectiveN = kishEffectiveN(runSumW, runSumW2);
    const runMean = run.reduce((s, w) => s + w.mean * weightTotal(w), 0) / runSumW;
    const shift = Math.abs(runMean - ref.mean) / (ref.mean || 1);
    const shapeTag: ShapeTag = dir > 0 ? "step_up" : "step_down";
    const independentVar = ref.variance * (1 / runEffectiveN + 1 / ref.effectiveN);
    const se = Math.sqrt(independentVar);
    const z = se > 0 ? Math.abs(runMean - ref.mean) / se : 0;
    // See the gate note at the call site. Under "independent" ref.tau2 is
    // absent, so odVar is independentVar and studentizeWith returns z as is.
    // Under "overdispersed" the run's latent level is ONE draw of τ², not m
    // independent ones: consecutive windows are autocorrelated on real data
    // (lag-1 0.17–0.33), so dividing τ² by the run length would credit a
    // sustained drift with evidence it does not carry. Conservative by construction.
    // Under "variogram" the run is a contrast of its own (runLatent): the
    // data, not a convention, decides how much a run's length shrinks the
    // latent part — 1/m when the latent rates are independent, not at all when
    // they move together.
    const gateRef = latent === undefined ? ref : { ...ref, ...runLatent(latent, run) };
    const odVar = gateRef.latentVar !== undefined
      ? independentVar + gateRef.latentVar
      : independentVar + (ref.tau2 ?? 0) * (1 + (ref.refShare ?? 0));
    if (describeOnly !== undefined) {
      if (!run.some((w) => describeOnly.get(w) === dir)) return;
    } else {
      const zGate = odVar > 0 ? studentizeWith(Math.abs(runMean - ref.mean) / Math.sqrt(odVar), independentVar, gateRef) : 0;
      if (zGate < gateZ) return;
    }
    tiles.push({
      label: `${tag}${shapeTag} t=${windows[start].windowStart}–${windows[end].windowEnd} (${(shift * 100).toFixed(1)}% shift)`,
      shapeTag,
      regionStart: windows[start].windowStart,
      regionEnd: windows[end].windowEnd,
      windows: run,
      description: `Sustained ${dir > 0 ? "elevation" : "drop"} over ${run.length} windows${group !== undefined ? ` in group "${group}"` : ""}. Run mean: ${runMean.toFixed(3)}, reference mean: ${ref.mean.toFixed(3)}.` +
        (describeOnly !== undefined ? ` Describes the ${dir > 0 ? "spike" : "dip"} window(s) it contains; not a test of its own.` : ""),
      magnitude: describeOnly !== undefined && odVar > 0 ? Math.abs(runMean - ref.mean) / Math.sqrt(odVar) : z,
      ...(group !== undefined ? { group } : {}),
    });
  };

  for (let i = 0; i < windows.length; i++) {
    const delta = (windows[i].mean - ref.mean) / (ref.mean || 1);
    // A window spike/dip cannot score cannot carry a run either: it breaks
    // one, the way a below-threshold window does. Otherwise runs of 1–2-event
    // windows, whose means jump between 0 and 1, pass the ratio rule by chance.
    const dir: 1 | -1 | null =
      !isScorable(windows[i]) ? null : delta >= threshold ? 1 : delta <= -threshold ? -1 : null;
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
