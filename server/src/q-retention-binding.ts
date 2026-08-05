/**
 * $Q[pipeline] → RetentionBuffer binding.
 *
 * Sibling of q-collector-binding.ts (which wires $Q[observe] → StCollector), for
 * the layer below it: how much raw history the freshness zone keeps.
 *
 * Why this exists at all: `registry.set("pipeline:*", { retention_window_ms })`
 * was written at bootstrap and then never read by anything — `getPipeline()` had
 * no production caller and `RetentionBuffer.setRetentionWindowMs()` was
 * unwired — so 120s lived as a bare literal in index.ts and the $Q row was
 * decoration. That is backwards for a project whose claim is that observation
 * parameters are Brain-writable at runtime: retention is exactly the kind of
 * parameter a Brain wants to widen ("keep more, I am about to re-observe") and
 * narrow again.
 */

import type { QRegistry, QPipelineParams } from "./q-registry.js";

/** The slice of RetentionBuffer this binding touches — keeps it decoupled. */
export interface RetentionControllable {
  getRetentionWindowMs(): number;
  setRetentionWindowMs(ms: number): void;
}

/**
 * Bind a retention buffer's freshness-zone width to $Q[pipeline] for one target.
 *
 * Applies the registry's current retention_window_ms immediately (if set), then
 * keeps the buffer in sync on every subsequent write to that scope. Returns an
 * unbind function (it does not restore the buffer's prior width).
 *
 * Invalid values are rejected with a warning rather than thrown. $Q is a shared
 * bus: set() notifies every listener synchronously inside the writer's call
 * stack, so throwing here would abort the write for *unrelated* listeners
 * registered after this one and surface as an exception in whoever wrote the
 * row — a Brain proposing a bad number would take down the tick loop. Refusing
 * the row loudly and leaving the buffer at its last good width keeps the blast
 * radius at this binding. (Note that this makes $Q an accepted-value store, not
 * a validated one: the bad row still sits in the registry and in the swap
 * history the dashboard renders. That is deliberate — the history is a record
 * of what was *proposed*, and a proposal that was refused is worth seeing.)
 */
export function bindPipelineRetention(
  registry: QRegistry,
  buffer: RetentionControllable,
  target = "*",
): () => void {
  const applyCurrent = (): void => {
    applyRetention(buffer, registry.getPipeline(target));
  };

  applyCurrent();

  return registry.onChange((scope) => {
    if (scope.layer !== "pipeline") return;
    if (scope.target !== target) return;
    applyCurrent();
  });
}

function applyRetention(buffer: RetentionControllable, params: QPipelineParams | undefined): void {
  const ms = params?.retention_window_ms;
  if (ms === undefined) return; // no opinion in $Q → leave the buffer as-is
  if (!Number.isFinite(ms) || ms <= 0) {
    console.warn(
      `[q] refusing $Q[pipeline].retention_window_ms=${ms} (must be a positive number); ` +
        `retention stays at ${buffer.getRetentionWindowMs()}ms`,
    );
    return;
  }
  if (buffer.getRetentionWindowMs() === ms) return; // already there → no eviction pass
  buffer.setRetentionWindowMs(ms);
}
