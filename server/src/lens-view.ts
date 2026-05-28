/**
 * LensView + ObservationOverlay — parallel observation overlays (Phase 0 Step 3).
 *
 * MODEL.md §"Parallel observation overlays": multiple $ST views run on the same
 * stream concurrently, each with its own $Q[observe]. All update continuously;
 * Brain does not switch *which* view runs, only *which view it consults*. Adding
 * or removing an angle is one $Q row — no pipeline reconfiguration.
 *
 * A LensView is one such angle: it owns a view tag, reads its lens from the
 * QRegistry (with the same most-specific-first fallback getObserve uses), keeps
 * a rolling set of events, and re-derives its snapshot via applyLens. When $Q
 * changes for its scope, it re-shapes itself in place (tuning interruption,
 * reusing the Step 1 onChange seam). An ObservationOverlay attaches several
 * views to one stream so they all see every event.
 *
 * Re-aggregation is stateless (applyLens over held events), so a freshly added
 * view can be back-filled from a RetentionBuffer segment and immediately shows
 * the same history the older views do — no historical re-aggregation cost beyond
 * one applyLens pass, because the raw events are always available.
 */

import { applyLens, type LensEvent, type LensResult } from "./lens.js";
import type { QRegistry } from "./q-registry.js";

export interface LensViewOptions {
  /** view tag, e.g. "fine" → resolves "observe:<schema>#<view>". */
  view?: string;
  /**
   * Cap on events held for re-derivation. The overlay is a *view* layer, not a
   * store — retention proper lives in RetentionBuffer. This bound keeps a view
   * cheap (fast pipeline, nothing unbounded); 0 means "hold none, snapshot only
   * reflects what applyLens last saw". Default 10000.
   */
  maxEvents?: number;
}

export class LensView {
  readonly schemaId: string;
  readonly view?: string;
  private readonly registry: QRegistry;
  private readonly maxEvents: number;
  private readonly events: LensEvent[] = [];
  private snapshot: LensResult;
  private readonly unsubscribe: () => void;

  constructor(registry: QRegistry, schemaId: string, opts: LensViewOptions = {}) {
    this.registry = registry;
    this.schemaId = schemaId;
    this.view = opts.view;
    this.maxEvents = opts.maxEvents ?? 10_000;
    this.snapshot = this.derive();

    // Tuning interruption: re-shape in place when this view's $Q[observe] changes.
    this.unsubscribe = registry.onChange((scope) => {
      if (scope.layer !== "observe") return;
      const hits =
        scope.target === "*" ||
        (scope.target === schemaId && (scope.view === undefined || scope.view === this.view));
      if (hits) this.snapshot = this.derive();
    });
  }

  /** Feed one event. The snapshot updates to include it. */
  push(ev: LensEvent): void {
    this.events.push(ev);
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
    this.snapshot = this.derive();
  }

  /** Back-fill from a retained segment (e.g. when a view is added late). */
  backfill(segment: readonly LensEvent[]): void {
    for (const ev of segment) this.events.push(ev);
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
    this.snapshot = this.derive();
  }

  /** Current re-derived shape under this view's lens. */
  current(): LensResult {
    return this.snapshot;
  }

  private derive(): LensResult {
    const lens = this.registry.getObserve(this.schemaId, this.view) ?? {};
    return applyLens(this.events, lens);
  }

  /** Stop reacting to $Q changes. Call when removing the view. */
  detach(): void {
    this.unsubscribe();
  }
}

// ── ObservationOverlay ─────────────────────────────────────────

/**
 * Attaches several LensViews to one stream. Every pushed event reaches all
 * views, so each maintains its own continuously-updated shape. Views can be
 * added or removed at runtime — the multi-angle property.
 */
export class ObservationOverlay {
  private readonly views = new Map<string, LensView>();

  constructor(private readonly registry: QRegistry) {}

  /** Add a view under a key (e.g. its view tag). Returns the LensView. */
  add(key: string, schemaId: string, opts?: LensViewOptions): LensView {
    const v = new LensView(this.registry, schemaId, opts);
    this.views.set(key, v);
    return v;
  }

  /** Remove and detach a view. */
  remove(key: string): void {
    const v = this.views.get(key);
    if (!v) return;
    v.detach();
    this.views.delete(key);
  }

  get(key: string): LensView | undefined {
    return this.views.get(key);
  }

  keys(): string[] {
    return [...this.views.keys()];
  }

  /** Feed an event to every view for the given schema. */
  push(schemaId: string, ev: LensEvent): void {
    for (const v of this.views.values()) {
      if (v.schemaId === schemaId) v.push(ev);
    }
  }

  /** Detach all views. */
  detachAll(): void {
    for (const v of this.views.values()) v.detach();
    this.views.clear();
  }
}
