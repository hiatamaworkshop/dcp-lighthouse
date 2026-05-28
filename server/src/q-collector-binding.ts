/**
 * $Q[observe] → StCollector binding (Phase 0 Step 1).
 *
 * The lighthouse side owns all $Q logic; dcp-wrap stays neutral. The core
 * exposes only StCollector.getWindowMs()/setWindowMs() — it never reads $Q.
 * This binding is the wire that connects them: it reads the observe-layer
 * window for a watched schema from the QRegistry and pushes it onto the
 * collector, both once at attach time and again whenever $Q changes.
 *
 * Scope note: a single StCollector holds one flush interval shared across all
 * schemas. Per-schema concurrent lenses (multiple collectors) are Step 3. Here
 * we bind one collector to one schema's observe window — enough to demonstrate
 * the Step 1 goal: changing $Q[observe].window_ms reshapes a live collector.
 */

import type { QRegistry, QObserveParams } from "./q-registry.js";

/** The slice of StCollector this binding touches — keeps it decoupled. */
export interface WindowControllable {
  getWindowMs(): number;
  setWindowMs(windowMs: number): void;
}

export interface BindObserveOptions {
  /** Optional view tag, e.g. "fine", to resolve "observe:<schema>#<view>". */
  view?: string;
}

/**
 * Bind a collector's flush window to $Q[observe] for one schema.
 *
 * Applies the registry's current window_ms immediately (if set), then keeps the
 * collector in sync on every relevant $Q change. A change is "relevant" when it
 * touches the observe layer for this schema, this schema#view, or the "*"
 * wildcard — the same scopes getObserve() would resolve through.
 *
 * Returns an unbind function that stops syncing (it does not restore the
 * collector's prior window).
 */
export function bindObserveWindow(
  registry: QRegistry,
  collector: WindowControllable,
  schemaId: string,
  opts: BindObserveOptions = {},
): () => void {
  const { view } = opts;

  const applyCurrent = (): void => {
    const params = registry.getObserve(schemaId, view);
    applyWindow(collector, params);
  };

  applyCurrent();

  const unsubscribe = registry.onChange((scope) => {
    if (scope.layer !== "observe") return;
    const hits =
      scope.target === "*" ||
      (scope.target === schemaId && (scope.view === undefined || scope.view === view));
    if (hits) applyCurrent();
  });

  return unsubscribe;
}

function applyWindow(collector: WindowControllable, params: QObserveParams | undefined): void {
  const w = params?.window_ms;
  if (w === undefined) return;            // no opinion in $Q → leave collector as-is
  if (collector.getWindowMs() === w) return;  // already there → avoid timer churn
  collector.setWindowMs(w);
}
