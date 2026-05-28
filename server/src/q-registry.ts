/**
 * $Q registry — observation-parameter store for the lighthouse layer.
 *
 * Lives entirely on the lighthouse side. The dcp-wrap core exposes only neutral
 * extension points (StCollector.setWindowMs, IngestionBus.tap,
 * PipelineControl.onExtraDecision) and never names $Q. This registry is the
 * thing $ST collectors and the ingestion bus read their lens parameters from.
 *
 * Row format (MODEL.md §"Row format"):
 *
 *   ["$Q", "<layer>:<target>", { ...parameters }]
 *
 *     <layer>  ::= "pipeline" | "observe" | "schema"
 *     <target> ::= "*" | "<schema-id>" | "<schema-id>#<view-tag>"
 *
 * It does NOT ride on FieldMapping (path resolution only) — see MODEL.md §148.
 */

// ── Layer + scope ──────────────────────────────────────────────

export type QLayer = "pipeline" | "observe" | "schema";

/** Parsed form of a scope string like "observe:test_result:v1#agents". */
export interface QScope {
  layer: QLayer;
  /** schema-id (may itself contain colons, e.g. "test_result:v1") or "*". */
  target: string;
  /** optional "#view-tag" suffix, without the leading "#". */
  view?: string;
}

// ── Per-layer parameter shapes ─────────────────────────────────

/** $Q[observe] — how one schema's statistics are aggregated. */
export interface QObserveParams {
  window_ms?: number;
  decay?: string;            // e.g. "exp(τ=300s)" | "step(cutoff=now-60s)"
  group_by?: string[];       // e.g. ["agentId", "area"]
  downsample_factor?: number;
  agg_func?: string;
}

/** $Q[pipeline] — retention / replay / rate, pipeline-wide. */
export interface QPipelineParams {
  stream_rate_cap?: number;
  retention_window_ms?: number;
}

/** $Q[schema] — measurement-defining thresholds. */
export interface QSchemaParams {
  pass_rate_floor?: number;
  flaky_threshold?: number;
}

export type QParams = QObserveParams | QPipelineParams | QSchemaParams;

/** Canonical positional row as it appears in the swap-history stream. */
export type QRow = ["$Q", string, QParams];

// ── Registry ───────────────────────────────────────────────────

export class QRegistry {
  /** keyed by canonical "<layer>:<target>[#view]" scope string. */
  private readonly store = new Map<string, QParams>();
  /** append-only swap history, in set() order, for the dashboard. */
  private readonly history: QRow[] = [];

  /**
   * Set (or replace) the parameters at a scope.
   * Accepts either a parsed QScope or a raw "<layer>:<target>" string.
   * Each set is recorded in the swap history, even when it replaces a prior value.
   */
  set(scope: QScope | string, params: QParams): void {
    const parsed = typeof scope === "string" ? parseScope(scope) : scope;
    const key = formatScope(parsed);
    this.store.set(key, params);
    this.history.push(["$Q", key, params]);
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

const LAYERS: readonly QLayer[] = ["pipeline", "observe", "schema"];

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
