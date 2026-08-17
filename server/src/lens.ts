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
 * Implemented stages: group_by → window_ms (with the `origin`/`align` grid) →
 * downsample_factor → decay (step form only; see applyDecay). agg_func still
 * passes through — callers (replay) keep handing over the same observeParams
 * object unchanged, so filling it later needs no change at any call site.
 *
 * What `decay: "exp(tau=...)"` would take, recorded so the deferral is a
 * decision rather than an omission: exponential weighting gives each event a
 * weight, which turns count/mean/sumSq — the unweighted sufficient statistics
 * this module and snapshot-curator.ts both pool with — into weighted ones, and
 * replaces the sample size in the comparator's standard error with an
 * effective sample size (Kish: (Σw)²/Σw²). That means new fields on WindowStat,
 * matching changes in `downsample`'s pooling, and rewrites of poolStats and
 * comparisonSE in snapshot-curator.ts. It is a change to the comparator's
 * statistical model, on the same footing as the Šidák correction (対策A), and
 * it would move numbers the devlog has already published — so it needs its own
 * verification pass rather than riding along with the step form.
 *
 * Domain note: Phase 0 runs on a known-truth numeric stream (Minecraft + injected
 * anomalies), so the lens aggregates a numeric field into per-window {mean, count}.
 * pass/fail is the Phase 1 skin and is not modeled here.
 */

import type { DecayAnchor, QObserveParams, WindowAlign } from "./q-registry.js";

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
  /**
   * Weight sums, present only under a weighting lens. Absent means every event
   * weighed 1, which is what `count` already says — so an unweighted window
   * carries no extra fields and compares equal to one built before weighting
   * existed.
   *
   * Groundwork for `decay: exp(τ=...)` (ROADMAP_BRIEF.md 2026-08-17). Weighting
   * splits a job `count` currently does twice:
   *
   *   - HOW MANY EVENTS there were — the MIN_VALID_COUNT gate and the "Count:"
   *     a tile shows a human. Stays `count`.
   *   - HOW MUCH STATISTICAL WEIGHT they carry — what the comparator's standard
   *     error divides by, and what pooling accumulates. Becomes `sumW`, with
   *     Kish's effective sample size `sumW²/sumW2` as the denominator.
   *
   * Those two are the same number only while all weights are 1, and conflating
   * them under weighting would let a window of 100 events at weight 0.01 claim
   * the precision of 100 full observations. Same shape of error as
   * `spikeZThreshold` meaning both a per-window and a family-wise budget before
   * 対策A.
   *
   * `sumW2` is carried rather than the effective n itself because effective n
   * DOES NOT ADD: merging two windows gives (ΣW_a+ΣW_b)²/(ΣW2_a+ΣW2_b), which
   * cannot be recovered from the two n_eff values. sumW and sumW2 are additive,
   * so pooling stays exact — the same property that lets `downsample` merge
   * count/sum/sumSq without revisiting raw events.
   */
  weights?: { sumW: number; sumW2: number };
  /**
   * Smallest and largest raw value seen in this window.
   *
   * Carried because the comparator otherwise cannot tell a tail it DECLINED to
   * flag from a tail it COULD NOT REACH. Measured (ROADMAP_BRIEF.md
   * 2026-08-17): on the pilot's 0.95-pass stream at ~100 events per window,
   * the largest attainable window mean is 1.0, which sits 2.29σ above the
   * reference — below the 2.81σ Šidák-corrected gate. No spike can fire at
   * that geometry no matter what the stream does, and the package still
   * reported "no spikes" exactly as if it had looked and found none. 136 dips
   * to 1 spike across 2000 null trials is that asymmetry, not a property of
   * the data.
   *
   * min/max are the natural sufficient statistics for that question: they pool
   * associatively (min of mins, max of maxes), so downsampling and reference
   * pooling stay exact, and they say nothing about what the values MEAN — the
   * lens stays domain-blind. Inferring the same bound from an assumed [0,1]
   * range would hard-code the Phase 1 skin into a module whose whole contract
   * is that `value` is an arbitrary number.
   */
  range?: { min: number; max: number };
}

/**
 * The total weight a window carries — what its mean is an average over, and
 * what pooling accumulates. `count` for an unweighted window.
 */
export function weightTotal(w: WindowStat): number {
  return w.weights?.sumW ?? w.count;
}

/**
 * Σw² for a window — the second weight moment. Additive across windows, and
 * the reason effective n can be recovered after pooling.
 *
 * Has its own accessor because three call sites (downsample, poolStats, the
 * step-run standard error) need it, and three copies of
 * `w.weights?.sumW2 ?? w.count` is three chances for one of them to keep the
 * old meaning through a change.
 */
export function weightSquaredTotal(w: WindowStat): number {
  return w.weights?.sumW2 ?? w.count;
}

/**
 * Kish's effective sample size: the number of equally-weighted observations
 * that would carry the same precision as this window's weighted ones.
 *
 * This — not `count` — is what a standard error divides by. For an unweighted
 * window it is exactly `count` (n²/n), which is why routing the comparator
 * through here changes no number until a weighting lens exists.
 */
export function effectiveN(w: WindowStat): number {
  return kishEffectiveN(weightTotal(w), weightSquaredTotal(w));
}

/**
 * Effective sample size from summed weight moments. Separate from effectiveN
 * because pooled populations (a reference, a step run) have moments but no
 * WindowStat to read them off, and they must use the same formula — summing
 * per-window effective n instead would be wrong, since it is not additive.
 */
export function kishEffectiveN(sumW: number, sumW2: number): number {
  return sumW2 > 0 ? (sumW * sumW) / sumW2 : 0;
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

// ── decay stage ─────────────────────────────────────────────────────────────

/** A parsed `decay` string. */
export type DecaySpec =
  /** Drop events older than `anchor - cutoffMs`. */
  | { kind: "step"; cutoffMs: number }
  /** Weight events by exp(-age/tauMs). Parsed but not yet applied. */
  | { kind: "exp"; tauMs: number };

/** What the decay stage measures age against. Defaults to the reproducible anchor. */
export function resolveDecayAnchor(lens: QObserveParams): DecayAnchor {
  return lens.decay_anchor ?? "segment_end";
}

const DECAY_CALL = /^\s*(step|exp)\s*\(\s*([^=\s]+)\s*=\s*([^)]+?)\s*\)\s*$/;
const DURATION = /^(\d+(?:\.\d+)?)\s*(ms|s)$/;

/** Parse "300s" / "1500ms" into milliseconds. Bare numbers are rejected — an unlabeled duration is exactly the kind of ambiguity a $Q row should not carry. */
function parseDuration(raw: string, spec: string): number {
  const m = DURATION.exec(raw);
  if (!m) {
    throw new RangeError(
      `invalid decay duration "${raw}" in "${spec}" — expected a number with a unit, e.g. "300s" or "1500ms"`,
    );
  }
  return Number(m[1]) * (m[2] === "s" ? 1000 : 1);
}

/**
 * Parse MODEL.md §228's decay syntax.
 *
 *   step(cutoff=now-60s)   → { kind: "step", cutoffMs: 60000 }
 *   exp(tau=300s)          → { kind: "exp",  tauMs: 300000 }
 *
 * The `now-` prefix is accepted and dropped: `now` names the anchor, and which
 * anchor it is comes from `decay_anchor`, not from the string. Writing the age
 * into the string and the anchor policy into a field keeps the documented
 * syntax working while leaving the reproducibility decision somewhere a reader
 * can actually see it.
 *
 * `τ` and `tau` are both accepted as the exp parameter name — the doc uses the
 * Greek letter, keyboards mostly do not.
 */
export function parseDecay(spec: string): DecaySpec {
  const m = DECAY_CALL.exec(spec);
  if (!m) {
    throw new RangeError(
      `invalid decay "${spec}" — expected "step(cutoff=now-60s)" or "exp(tau=300s)"`,
    );
  }
  const [, kind, key, rawValue] = m;

  if (kind === "step") {
    if (key !== "cutoff") {
      throw new RangeError(`invalid decay "${spec}" — step takes "cutoff", not "${key}"`);
    }
    // "now-60s" and "60s" mean the same thing: an age measured back from the anchor.
    const age = rawValue.startsWith("now-") ? rawValue.slice("now-".length).trim() : rawValue;
    return { kind: "step", cutoffMs: parseDuration(age, spec) };
  }

  if (key !== "τ" && key !== "tau") {
    throw new RangeError(`invalid decay "${spec}" — exp takes "tau" (or "τ"), not "${key}"`);
  }
  return { kind: "exp", tauMs: parseDuration(rawValue, spec) };
}

/**
 * Apply the decay stage to an already-ts-sorted event list.
 *
 * Operates on EVENTS, not on the windows produced downstream, even though
 * MODEL.md §137 lists decay after window_ms/downsample_factor in the chain.
 * The operation that section itself describes — "drop everything older than
 * 1 min" (§229) — is defined on events, and applying it at the event level is
 * what makes the cutoff exact: filtering whole windows instead would either
 * keep or discard a window straddling the boundary, and neither is what the
 * lens was asked for.
 *
 * `exp` throws instead of falling through as a no-op. A lens that silently
 * ignores a stage it was told to apply reports numbers under a lens that was
 * never used — for an observation layer that is a worse outcome than failing,
 * because every downstream figure is then misattributed. See applyLens's doc
 * for what implementing it actually requires.
 *
 * TWO CONSEQUENCES A CALLER MUST KNOW (measured 2026-08-17, ROADMAP_BRIEF.md):
 *
 * 1. Decay trims the REFERENCE too. The curator scores observation against
 *    reference, and index.ts/dashboard.ts hand the same lens to both replays,
 *    so each is cut back from its own segment end. On the RC-shaped fixture a
 *    5s cutoff dropped the reference from 3000 events to 474. Detection barely
 *    moved there (17.1σ → 16.1σ) because comparisonSE is dominated by the
 *    observation window's own count, and the smaller family also lowers the
 *    Šidák bar — the two effects partly cancel. Do not assume that holds at
 *    other geometries.
 *
 * 2. An aggressive cutoff degrades to SILENT QUIET, not to blindness. At a
 *    200ms cutoff the same fixture's 17σ dip vanished entirely while
 *    `referenceUsable` stayed TRUE — the reference still had 18 events, enough
 *    to clear the "variance exists" gate, and nothing else reports that the
 *    yardstick has become useless. An empty tile list then reads as "checked,
 *    all clear" when the truth is "trimmed until nothing could be compared".
 *    That is exactly the silence-vs-blindness failure the referenceUsable flag
 *    exists to prevent, reached by a route the flag does not cover. Nothing
 *    guards this yet.
 */
function applyDecay(sorted: readonly LensEvent[], lens: QObserveParams): readonly LensEvent[] {
  if (lens.decay === undefined) return sorted;
  const spec = parseDecay(lens.decay);

  // Unreachable via applyLens (validateObserveParams rejects exp first) and
  // kept anyway: "never silently skip a stage you were told to apply" is the
  // rule this function must not be able to break, whoever calls it.
  if (spec.kind === "exp") throw new RangeError(expNotImplemented(lens.decay));
  if (sorted.length === 0) return sorted;

  const anchor =
    resolveDecayAnchor(lens) === "now" ? Date.now() : sorted[sorted.length - 1].ts;
  const floorTs = anchor - spec.cutoffMs;
  return sorted.filter((e) => e.ts >= floorTs);
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

/** Shared so applyDecay and validateObserveParams cannot describe the deferral differently. */
function expNotImplemented(spec: string): string {
  return (
    `decay "${spec}" is parsed but not implemented: exponential weighting needs ` +
    `weighted sufficient statistics (effective sample size) throughout WindowStat, ` +
    `poolStats and comparisonSE, which changes the comparator's statistical model. ` +
    `Only step(cutoff=...) is applied today.`
  );
}

/**
 * Reject a lens that applyLens could not honour — the single rulebook for what
 * "a valid $Q[observe] row" means.
 *
 * Exported so the registry can enforce it AT WRITE TIME (q-registry.ts). That
 * placement is the point: applyLens runs inside the tick loop and inside HTTP
 * handlers, neither of which had a catch, so an unusable lens reaching the
 * registry meant a thrown RangeError on every subsequent read and a dead
 * process. MODEL.md §183's own example row carries `decay: "exp(τ=300s)"`,
 * so writing exactly what the design doc shows was enough to trigger it.
 * Validating on write turns that into one rejected write.
 *
 * applyLens calls this too rather than keeping its own copy of the checks.
 * Two lists of rules in two places is how one of them ends up missing a case —
 * the same failure shape as two independent readers of the window grid
 * (ROADMAP_BRIEF.md 2026-07-29). One rulebook, two callers.
 *
 * Unknown fields are deliberately tolerated: RuleBrain's replayRequest writes
 * its `fromTs`/`toTs` into the same row as the lens (index.ts), and applyLens
 * ignores anything it does not recognise, so rejecting extras here would break
 * a shipped flow to enforce a tidiness the lens itself does not require.
 */
export function validateObserveParams(lens: QObserveParams): void {
  if (lens.window_ms !== undefined && (!Number.isFinite(lens.window_ms) || lens.window_ms <= 0)) {
    // Finite, not just > 0: NaN fails every comparison, so a `<= 0` guard lets
    // it through and every windowStart downstream becomes NaN — windows that
    // serialise as null and a lens that reports nonsense instead of failing.
    throw new RangeError(`window_ms must be a positive finite number, got ${lens.window_ms}`);
  }
  if (lens.origin !== undefined && !Number.isFinite(lens.origin)) {
    throw new RangeError(`origin must be a finite number, got ${lens.origin}`);
  }
  if (lens.align !== undefined && lens.align !== "epoch" && lens.align !== "first_event") {
    throw new RangeError(`align must be "epoch" or "first_event", got "${lens.align}"`);
  }
  if (
    lens.downsample_factor !== undefined &&
    (!Number.isInteger(lens.downsample_factor) || lens.downsample_factor < 1)
  ) {
    throw new RangeError(
      `downsample_factor must be a positive integer, got ${lens.downsample_factor}`,
    );
  }
  if (
    lens.group_by !== undefined &&
    (!Array.isArray(lens.group_by) || lens.group_by.some((k) => typeof k !== "string"))
  ) {
    throw new RangeError("group_by must be an array of key names");
  }
  if (
    lens.decay_anchor !== undefined &&
    lens.decay_anchor !== "segment_end" &&
    lens.decay_anchor !== "now"
  ) {
    throw new RangeError(
      `decay_anchor must be "segment_end" or "now", got "${lens.decay_anchor}"`,
    );
  }
  if (lens.decay !== undefined) {
    // parseDecay throws on malformed syntax; exp parses but has no implementation.
    if (parseDecay(lens.decay).kind === "exp") throw new RangeError(expNotImplemented(lens.decay));
  }
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
 * When the lens declares `downsample_factor` (> 1), every `factor` consecutive
 * grid slots of window_ms are merged into one output window (same grid, same
 * origin — see `downsample`), and the returned `window_ms` is scaled up to
 * match so `windowEnd - windowStart === window_ms` keeps holding for every
 * window a caller sees. Applied per group as well as to the mixed view, so a
 * grouped and downsampled lens still shares one grid across every slice.
 *
 * When the lens declares `decay`, events are filtered before any of the above:
 * the step form drops everything older than its cutoff, measured back from the
 * anchor `decay_anchor` names (segment end by default, so a replay is
 * reproducible). Every later stage — the grid origin included — sees only the
 * survivors. The exp form parses but throws; see applyDecay and this module's
 * header for why it is deferred rather than silently ignored.
 *
 * Events need not be sorted; they are sorted by ts internally so that ts-driven
 * aggregation matches in-order aggregation (the late-arrival guarantee).
 */
export function applyLens(events: readonly LensEvent[], lens: QObserveParams = {}): LensResult {
  // One rulebook, shared with the registry's write-time check. A lens read out
  // of $Q has already passed this; a lens handed in directly has not.
  validateObserveParams(lens);

  const window_ms = lens.window_ms ?? DEFAULT_WINDOW_MS;
  const downsampleFactor = lens.downsample_factor ?? 1;
  const outputWindowMs = window_ms * downsampleFactor;

  // Stages not yet implemented — declared so the chain is visible and the
  // wiring contract is honest. agg_func: passes through.

  if (events.length === 0) return { window_ms: outputWindowMs, windows: [] };

  const sorted = [...events].sort((a, b) => a.ts - b.ts);
  // Decay runs before anything downstream reads the events, so every later
  // stage sees only what survived: the grid anchors to the first SURVIVING
  // event, and groups are built from survivors. Anchoring to a dropped event
  // would put the grid outside the data the lens actually observed.
  const kept = applyDecay(sorted, lens);
  if (kept.length === 0) return { window_ms: outputWindowMs, windows: [] };

  const origin = resolveAlign(lens) === "epoch" ? (lens.origin ?? 0) : kept[0].ts;

  const windows = downsample(aggregate(kept, window_ms, origin), window_ms, downsampleFactor, origin);

  const groupBy = lens.group_by;
  if (!groupBy || groupBy.length === 0) return { window_ms: outputWindowMs, windows };

  const buckets = new Map<string, { key: string[]; events: LensEvent[] }>();
  for (const ev of kept) {
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
    .map(([label, b]) => ({
      key: b.key,
      label,
      windows: downsample(aggregate(b.events, window_ms, origin), window_ms, downsampleFactor, origin),
    }))
    .sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));

  return { window_ms: outputWindowMs, windows, groups };
}

/**
 * Merge every `factor` consecutive grid slots of window_ms into one output
 * window, using pooled sufficient statistics (count / sum / sumSq) rather than
 * re-aggregating raw events — exact, not an approximation, since count/sum/sumSq
 * are themselves sufficient statistics for mean and pooled variance (the same
 * property the reference-lens pooling already relies on). Buckets sit on the
 * origin-anchored grid (`floorToWindow`), so downsampled output stays on the
 * same grid guarantee as window_ms itself: comparable across groups and across
 * segments requested at different times.
 */
function downsample(
  windows: readonly WindowStat[],
  window_ms: number,
  factor: number,
  origin: number,
): WindowStat[] {
  if (factor <= 1 || windows.length === 0) return [...windows];

  const bucketMs = window_ms * factor;
  interface Bucket {
    count: number;
    sumW: number;
    sumW2: number;
    sum: number;
    sumSq: number;
    weighted: boolean;
    min: number;
    max: number;
  }
  const buckets = new Map<number, Bucket>();
  for (const w of windows) {
    const bucketStart = floorToWindow(w.windowStart, bucketMs, origin);
    let b = buckets.get(bucketStart);
    if (b === undefined) {
      b = { count: 0, sumW: 0, sumW2: 0, sum: 0, sumSq: 0, weighted: false, min: Infinity, max: -Infinity };
      buckets.set(bucketStart, b);
    }
    b.count += w.count;
    // sumW/sumW2 are additive; the effective n derived from them is not, which
    // is why they are what gets carried (see WindowStat.weights).
    b.sumW += weightTotal(w);
    b.sumW2 += weightSquaredTotal(w);
    b.sum += w.mean * weightTotal(w);
    b.sumSq += w.sumSq;
    if (w.weights !== undefined) b.weighted = true;
    // min of mins / max of maxes — associative, so a downsampled window bounds
    // its events exactly as an un-downsampled one would.
    if (w.range !== undefined) {
      b.min = Math.min(b.min, w.range.min);
      b.max = Math.max(b.max, w.range.max);
    }
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([bucketStart, b]) => ({
      windowStart: bucketStart,
      windowEnd: bucketStart + bucketMs,
      count: b.count,
      mean: b.sum / b.sumW,
      sumSq: b.sumSq,
      valid: b.count >= MIN_VALID_COUNT,
      // Emitted only when something upstream was actually weighted, so an
      // unweighted downsample produces byte-identical windows to before.
      ...(b.weighted ? { weights: { sumW: b.sumW, sumW2: b.sumW2 } } : {}),
      ...(Number.isFinite(b.min) ? { range: { min: b.min, max: b.max } } : {}),
    }));
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
  let min = Infinity;
  let max = -Infinity;

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
      range: { min, max },
    });
    sum = 0;
    sumSq = 0;
    count = 0;
    min = Infinity;
    max = -Infinity;
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
    if (ev.value < min) min = ev.value;
    if (ev.value > max) max = ev.value;
  }
  flush();

  return windows;
}
