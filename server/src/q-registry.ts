/**
 * $Q registry — observation-parameter store for the lighthouse layer.
 *
 * Lives entirely on the lighthouse side. The dcp-core core exposes only neutral
 * extension points (StCollector.setWindowMs, IngestionBus.tap,
 * PipelineControl.onExtraDecision) and never names $Q. This registry is the
 * thing $ST collectors and the ingestion bus read their lens parameters from.
 *
 * Row format (MODEL.md §"Row format"):
 *
 *   ["$Q", "<layer>:<target>", { ...parameters }]
 *
 *     <layer>  ::= "pipeline" | "observe" | "schema" | "compare"
 *     <target> ::= "*" | "<schema-id>" | "<schema-id>#<view-tag>"
 *
 * It does NOT ride on FieldMapping (path resolution only) — see MODEL.md §148.
 *
 * Importing lens.ts for its validator introduces no cycle: lens.ts's reference
 * back to this module is `import type` only, which the compiler erases, so the
 * emitted lens.js has no runtime dependency on q-registry.js.
 */

import { validateObserveParams } from "./lens.js";
import type { NullModel } from "./snapshot-curator.js";

// ── Layer + scope ──────────────────────────────────────────────

export type QLayer = "pipeline" | "observe" | "schema" | "compare";

/** Parsed form of a scope string like "observe:test_result:v1#agents". */
export interface QScope {
  layer: QLayer;
  /** schema-id (may itself contain colons, e.g. "test_result:v1") or "*". */
  target: string;
  /** optional "#view-tag" suffix, without the leading "#". */
  view?: string;
}

// ── Per-layer parameter shapes ─────────────────────────────────

/**
 * Where a lens anchors its window boundaries (ROADMAP L4, lens-chain `origin`
 * stage).
 *
 *   "first_event" — the grid starts at the first event of whatever segment is
 *                   handed over. The original behaviour, and the default:
 *                   for a one-off "re-observe exactly this segment" request it
 *                   is the only anchor that needs no external agreement.
 *   "epoch"       — the grid is absolute, anchored at `origin` (default 0) and
 *                   stepping by window_ms. The same event always lands in the
 *                   same window regardless of which segment it arrived in.
 *
 * The distinction is not cosmetic. Under "first_event", two overlapping
 * segments of the same stream produce windows on *different* grids, so their
 * results cannot be compared window-by-window — the failure recorded as
 * "anchor が tick ごとに滑る" (ROADMAP_BRIEF.md 2026-07-29), where an
 * unchanging past burst flickered on and off across ticks and swung 2.6σ–5.3σ
 * purely because each tick's request re-anchored the grid. The dashboard
 * worked around it by quantizing its *requests*; declaring the grid in $Q is
 * the same fix stated where it belongs — as a property of the lens.
 */
export type WindowAlign = "first_event" | "epoch";

/**
 * What the decay stage measures age against (ROADMAP L4, lens-chain `decay`).
 *
 *   "segment_end" — the newest event in the segment handed to the lens. The
 *                   default, and the only anchor under which re-observing a
 *                   past segment is reproducible: the same events through the
 *                   same lens give the same windows whenever it is run.
 *   "now"         — wall-clock time at the moment applyLens is called. For a
 *                   live view whose segment ends at roughly now, this is what
 *                   MODEL.md §229's "drop everything older than 1 min" means
 *                   literally.
 *
 * The distinction is the same one `align` draws, and it exists for the same
 * reason. Retroactive re-observation is the model's whole point (MODEL.md §5),
 * and under a wall-clock anchor a segment from an hour ago decays to nothing —
 * the lens would answer differently every time it ran, which is the
 * anchor-slide failure (ROADMAP_BRIEF.md 2026-07-29) reappearing on the decay
 * stage instead of the window stage. So the reproducible anchor is the default
 * and the clock-dependent one has to be asked for.
 */
export type DecayAnchor = "segment_end" | "now";

/** $Q[observe] — how one schema's statistics are aggregated. */
export interface QObserveParams {
  window_ms?: number;
  /**
   * Window-grid anchoring policy. Defaults to "first_event", or to "epoch"
   * when `origin` is set (setting an origin and getting no grid would be a
   * silent no-op).
   */
  align?: WindowAlign;
  /**
   * Phase of the absolute grid, in the same epoch as LensEvent.ts. Only read
   * when the resolved alignment is "epoch"; 0 (the Unix epoch) gives the
   * plain `floor(ts / window_ms) * window_ms` grid.
   */
  origin?: number;
  /**
   * Recency weighting, in MODEL.md §228's syntax:
   *
   *   "step(cutoff=now-60s)"  — drop everything older than the cutoff
   *   "exp(tau=300s)"         — keep everything, weighted by exp(-age/τ)
   *
   * The exp form makes the windows WEIGHTED, so the comparator divides by a
   * Kish effective sample size instead of a raw count and the curator's
   * lattice correction switches itself off (a weighted mean of two-valued
   * data no longer sits on an evenly spaced lattice). Calibration is a
   * property of the lens, so this one is measured separately —
   * calibration.test.ts, and ROADMAP_BRIEF.md 2026-08-17.
   *
   * `now` in the string is symbolic: it names the anchor, and `decay_anchor`
   * says what the anchor actually is. See DecayAnchor.
   */
  decay?: string;
  /**
   * What "now" means for the decay stage. Defaults to "segment_end" — the
   * newest event in the segment being observed — so that re-observing a past
   * segment yields the same answer whenever it is run.
   */
  decay_anchor?: DecayAnchor;
  group_by?: string[];       // e.g. ["agentId", "area"]
  /**
   * Merge every N consecutive window_ms grid slots into one output window
   * (lens.ts's `downsample`), scaling the returned window_ms by N. A positive
   * integer; 1 (default) is a no-op. Sits after window_ms/group_by and before
   * decay/agg_func in the chain (MODEL.md §137's stage order) — it thins the
   * already-aggregated windows via pooled count/sum/sumSq, it does not change
   * which raw events land in which window.
   */
  downsample_factor?: number;
  /**
   * What each window's WindowStat summarises. Only "mean" (or omitting the
   * field) is implemented — WindowStat already IS {mean, count, sumSq}, so
   * that case needs no code path. Anything else is rejected by
   * validateObserveParams at write time: median/percentile cannot be pooled
   * from those sufficient statistics (a merged window's median is not a
   * function of its parts' medians), which conflicts with how
   * downsample_factor and the reference lens pool windows. See
   * ROADMAP_BRIEF.md 2026-08-18 (5) §C — the throw ships ahead of any partial
   * agg_func implementation, on the same "parse but throw" precedent as
   * decay's exp form before it existed.
   */
  agg_func?: string;
  /**
   * Which percentile (strictly 0-100, e.g. 95) when agg_func is "percentile";
   * rejected alongside any other agg_func. Percent, not fraction: 0.95 is a
   * valid p0.95, so the range check cannot catch the unit slip.
   */
  agg_percentile?: number;
}

/** $Q[pipeline] — retention / replay / rate, pipeline-wide. */
export interface QPipelineParams {
  stream_rate_cap?: number;
  retention_window_ms?: number;
  /**
   * Reference-zone width and thinning ratio (ROADMAP L5 dynamic config,
   * 2026-08-23). Only takes effect on a buffer whose reference zone was
   * already opted in at construction (RetentionBufferOptions.referenceWindowMs
   * / thinningRatio) — a $Q write cannot turn the zone on from cold, same
   * boundary RetentionBuffer.setReferenceWindowMs()/setThinningRatio() draw.
   */
  reference_window_ms?: number;
  reference_thinning_ratio?: number;
}

/** $Q[schema] — measurement-defining thresholds. */
export interface QSchemaParams {
  pass_rate_floor?: number;
  flaky_threshold?: number;
  /**
   * AR regression threshold = per-agent learned baseline − this delta
   * (ROADMAP L2-1, PILOT_DATA §11 "Brain write surface"). Lives here rather
   * than only as a RuleBrain constant so a second Brain implementation reads
   * the same value RuleBrain does, and so a write to this scope visibly
   * reconfigures RuleBrain's live threshold.
   */
  baseline_delta?: number;
}

/**
 * Where the reference a detection is scored against comes from.
 *
 *   "preceding" — the span immediately before the observation span, as long
 *                 as the observation (or `reference_windows` windows). The
 *                 only kind so far; the periodic reference (ROADMAP_BRIEF.md
 *                 2026-10-14 (2) item 3) is the next value here.
 */
export type ReferenceKind = "preceding";

/**
 * $Q[compare] — what a detection compares against, and under which null
 * (ROADMAP_BRIEF.md 2026-10-14 (2) item 2, (8)).
 *
 * A detection is (observation lens, reference lens, comparison) — 2026-07-25
 * "参照レンズ設計". The observation lens has been declared in $Q[observe]
 * since Step 1; the other two were not: the reference span was a formula in
 * whichever function called the curator, and the null model a constructor
 * argument. That is the "隠れレンズ" shape 07-25 removed once already, and it
 * stops being harmless the moment a second kind of reference or null is in
 * use — a tile could not say which comparison raised it. Scoped like
 * $Q[observe] ("compare:<schema>#<view>" pairs with "observe:<schema>#<view>"),
 * and deliberately NOT a stage of the lens chain: a lens is unary
 * (segment → observation), a comparison is binary.
 */
export interface QCompareParams {
  /** Default "preceding". */
  reference?: ReferenceKind;
  /**
   * Length of a "preceding" reference in windows of the observation lens
   * (window_ms × downsample_factor). Absent = as long as the observation span.
   */
  reference_windows?: number;
  /** The null the gate assumes (SnapshotCurator's `nullModel`). Default "independent". */
  null_model?: NullModel;
  /**
   * History before the reference's end that the variogram null estimates the
   * latent rate's drift from (CurationContext.history), in ms. Variogram only:
   * the other nulls ignore history, so declaring it there would be a row that
   * reads as if it mattered. Absent under "variogram" = no history (the
   * reference stands in, and the package says so).
   */
  history_ms?: number;
}

export type QParams = QObserveParams | QPipelineParams | QSchemaParams | QCompareParams;

// Records keyed by the unions, so adding a value to a type without adding it
// here is a compile error rather than a runtime refusal.
const REFERENCE_KINDS = Object.keys({ preceding: true } satisfies Record<ReferenceKind, true>) as ReferenceKind[];
const NULL_MODELS = Object.keys(
  { independent: true, overdispersed: true, variogram: true } satisfies Record<NullModel, true>,
) as NullModel[];

/**
 * The $Q[compare] rulebook, run on write like validateObserveParams. Unknown
 * values are refused rather than defaulted: a misspelt null model that fell
 * back to "independent" would score every package under a null the row does
 * not name.
 */
export function validateCompareParams(p: QCompareParams): void {
  if (p.reference !== undefined && !REFERENCE_KINDS.includes(p.reference)) {
    throw new RangeError(`compare: unknown reference "${String(p.reference)}" (${REFERENCE_KINDS.join(" | ")})`);
  }
  if (p.reference_windows !== undefined && !(Number.isInteger(p.reference_windows) && p.reference_windows >= 1)) {
    throw new RangeError(`compare: reference_windows must be a positive integer, got ${String(p.reference_windows)}`);
  }
  if (p.null_model !== undefined && !NULL_MODELS.includes(p.null_model)) {
    throw new RangeError(`compare: unknown null_model "${String(p.null_model)}" (${NULL_MODELS.join(" | ")})`);
  }
  if (p.history_ms !== undefined) {
    if ((p.null_model ?? "independent") !== "variogram") {
      throw new RangeError(`compare: history_ms is read only by null_model "variogram", not "${p.null_model ?? "independent"}"`);
    }
    if (!(Number.isFinite(p.history_ms) && p.history_ms > 0)) {
      throw new RangeError(`compare: history_ms must be a positive number of ms, got ${String(p.history_ms)}`);
    }
  }
}

/**
 * A runtime check on writes to one layer, composed by whoever wires the
 * process (index.ts) — for what the static rulebook cannot know, such as
 * whether this process holds the history a declared null needs. Throws to
 * refuse; runs before the store, like the rulebook, so a refused row leaves
 * no trace.
 */
export type QWriteGate = (params: QParams) => void;

/** Canonical positional row as it appears in the swap-history stream. */
export type QRow = ["$Q", string, QParams];

// ── Registry ───────────────────────────────────────────────────

/** Notified after each set(). The seam an observation layer re-observes on. */
export type QChangeListener = (scope: QScope, params: QParams) => void;

export class QRegistry {
  /** keyed by canonical "<layer>:<target>[#view]" scope string. */
  private readonly store = new Map<string, QParams>();
  /** append-only swap history, in set() order, for the dashboard. */
  private readonly history: QRow[] = [];
  private readonly listeners: QChangeListener[] = [];
  private readonly gates = new Map<QLayer, QWriteGate[]>();

  /**
   * Set (or replace) the parameters at a scope.
   * Accepts either a parsed QScope or a raw "<layer>:<target>" string.
   * Each set is recorded in the swap history, even when it replaces a prior value,
   * then change listeners are notified.
   *
   * Observe-layer writes are validated against lens.ts's rulebook and REJECTED
   * here rather than at read time. The read-time alternative is not equivalent:
   * applyLens runs inside index.ts's tick loop and inside dashboard HTTP
   * handlers, so an unusable lens sitting in the registry threw on every
   * subsequent tick — a malformed `decay` string or a non-integer
   * `downsample_factor` is enough, and while the exp form was unimplemented,
   * MODEL.md §183's own example row was too: a $Q row copied straight out of
   * the design doc took the process down. Validating on write converts that
   * into a single failed write whose caller can report it.
   *
   * A rejected write leaves NO trace: validation runs before the store, the
   * history append and the listener notification, so the swap history can
   * never show a row that was not actually adopted. A history that lists
   * writes the registry refused would misdescribe what the observation layer
   * was configured with, which is the one thing that history exists to answer.
   */
  set(scope: QScope | string, params: QParams): void {
    const parsed = typeof scope === "string" ? parseScope(scope) : scope;
    if (parsed.layer === "observe") validateObserveParams(params as QObserveParams);
    if (parsed.layer === "compare") validateCompareParams(params as QCompareParams);
    for (const g of this.gates.get(parsed.layer) ?? []) g(params);
    const key = formatScope(parsed);
    this.store.set(key, params);
    this.history.push(["$Q", key, params]);
    for (const l of this.listeners) l(parsed, params);
  }

  /**
   * Add a runtime write check for one layer (QWriteGate). Returns a remove
   * function. Rows already stored are not re-checked — add gates before the
   * rows they guard are written.
   */
  addWriteGate(layer: QLayer, gate: QWriteGate): () => void {
    const list = this.gates.get(layer) ?? [];
    list.push(gate);
    this.gates.set(layer, list);
    return () => {
      const i = list.indexOf(gate);
      if (i !== -1) list.splice(i, 1);
    };
  }

  /** Register a listener fired after every set(). Returns an unregister function. */
  onChange(listener: QChangeListener): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i !== -1) this.listeners.splice(i, 1);
    };
  }

  /**
   * Read the observe-layer params for a schema. Resolution is most-specific
   * first: "observe:<schema>#<view>" → "observe:<schema>" → "observe:*".
   * Returns the first match, or undefined if none is set.
   */
  getObserve(schemaId: string, view?: string): QObserveParams | undefined {
    const candidates: string[] = [];
    if (view) candidates.push(`observe:${schemaId}#${view}`);
    candidates.push(`observe:${schemaId}`, "observe:*");
    for (const key of candidates) {
      const v = this.store.get(key);
      if (v) return v as QObserveParams;
    }
    return undefined;
  }

  /**
   * Read the comparison declared for a schema's view, resolved like
   * getObserve: "compare:<schema>#<view>" → "compare:<schema>" → "compare:*".
   */
  getCompare(schemaId: string, view?: string): QCompareParams | undefined {
    const candidates: string[] = [];
    if (view) candidates.push(`compare:${schemaId}#${view}`);
    candidates.push(`compare:${schemaId}`, "compare:*");
    for (const key of candidates) {
      const v = this.store.get(key);
      if (v) return v as QCompareParams;
    }
    return undefined;
  }

  /** Read pipeline-layer params (target is typically "*"). */
  getPipeline(target = "*"): QPipelineParams | undefined {
    return this.store.get(`pipeline:${target}`) as QPipelineParams | undefined;
  }

  /** Read schema-layer params for a schema, falling back to "schema:*". */
  getSchema(schemaId: string): QSchemaParams | undefined {
    return (this.store.get(`schema:${schemaId}`)
      ?? this.store.get("schema:*")) as QSchemaParams | undefined;
  }

  /** Every row set so far, in order — the dashboard's swap-history view. */
  rows(): QRow[] {
    return [...this.history];
  }
}

// ── Scope parsing ──────────────────────────────────────────────

const LAYERS: readonly QLayer[] = ["pipeline", "observe", "schema", "compare"];

/**
 * Parse "<layer>:<target>" where target may contain colons (schema ids like
 * "test_result:v1" do) and an optional "#view" suffix. Only the first segment
 * is taken as the layer; everything after the first colon is the target.
 */
export function parseScope(scope: string): QScope {
  const firstColon = scope.indexOf(":");
  if (firstColon === -1) {
    throw new Error(`invalid $Q scope (missing layer): "${scope}"`);
  }
  const layer = scope.slice(0, firstColon);
  if (!LAYERS.includes(layer as QLayer)) {
    throw new Error(`invalid $Q layer "${layer}" in scope "${scope}"`);
  }
  let rest = scope.slice(firstColon + 1);
  let view: string | undefined;
  const hash = rest.indexOf("#");
  if (hash !== -1) {
    view = rest.slice(hash + 1);
    rest = rest.slice(0, hash);
  }
  if (rest.length === 0) {
    throw new Error(`invalid $Q scope (empty target): "${scope}"`);
  }
  return view !== undefined
    ? { layer: layer as QLayer, target: rest, view }
    : { layer: layer as QLayer, target: rest };
}

/** Inverse of parseScope. */
export function formatScope(scope: QScope): string {
  const base = `${scope.layer}:${scope.target}`;
  return scope.view !== undefined ? `${base}#${scope.view}` : base;
}
