/**
 * Coarse-to-grouped retroactive re-observation trigger (ROADMAP C24).
 *
 * C20 showed that splitting a CI test stream by job (`agentId`) or area upfront
 * widens the Šidák family and thins each group's reference, hurting detection
 * power — keeping the stream combined in a 1-hour coarse window gave the best
 * power (60/60 planted 5-test regressions, 10/10 concurrent-failure bursts).
 * A combined coarse window, however, cannot say which job or area failed.
 *
 * This trigger closes the two-stage Lighthouse loop (LIGHTHOUSE_MODEL.md §5):
 * watch combined in the coarse window, and whenever the coarse SnapshotPackage
 * raises a downward tile (`dip` / `step_down`) or a concurrent-failure burst
 * (`failures.bursts`), emit a `replayRequest` over that exact window with
 * `group_by` (e.g. `["agentId"]`) so Comparator re-observes the retained events
 * and attributes the failure to the responsible group.
 *
 * Deduplicates by window span so the same window is never replayed twice across
 * ticks or overlapping multi-window observations. Opt-in (wired under
 * LIGHTHOUSE_PROFILE=test-stream); the default `mock` profile's RuleBrain is
 * untouched.
 *
 * With LIGHTHOUSE_RELATIVE_BURST=1 (ROADMAP C39) the coarse package also carries
 * C34's `relativeFailures`, and its bursts (4–9 failures against an all-pass
 * reference, which the fixed 10 never names) trigger the same replay. A blind
 * relative channel names no burst, so it triggers nothing.
 */

import type { BrainDecision } from "./brain-adapter.js";
import { C34_RELATIVE_BURST, type SnapshotPackage, type ShapeTag } from "./snapshot-curator.js";

/**
 * LIGHTHOUSE_RELATIVE_BURST (ROADMAP C39, opt-in): `"1"` turns on C34's relative failure-burst channel in
 * the live coarse view with its fixed defaults (`C34_RELATIVE_BURST`). Unset or empty: off, and nothing
 * changes. Any other value, or a profile other than test-stream (whose coarse view is the only one that
 * counts failures and replays grouped), is refused at boot — the same as an unknown profile.
 */
export function parseRelativeBurst(raw: string | undefined, profileName: string): boolean {
  if (raw === undefined || raw === "") return false;
  if (raw !== "1") {
    throw new Error(`LIGHTHOUSE_RELATIVE_BURST must be "1" (C34's fixed defaults) or unset, got "${raw}"`);
  }
  if (profileName !== "test-stream") {
    throw new Error(`LIGHTHOUSE_RELATIVE_BURST needs LIGHTHOUSE_PROFILE=test-stream (the "${profileName}" coarse view counts no failures and replays nothing grouped)`);
  }
  return true;
}

/** How the live relative-burst channel is to be read (SSE `relativeBurst`, GET /status), ROADMAP C39. */
export interface RelativeBurstDescription {
  zThreshold: number;
  trimTop: number;
  minFailures: number;
  minRefWindows: number;
  /** Where these values were chosen and confirmed, and that this stream was not measured. */
  basis: string;
}

export function describeRelativeBurst(stream: string): RelativeBurstDescription {
  return {
    zThreshold: C34_RELATIVE_BURST.zThreshold,
    trimTop: C34_RELATIVE_BURST.trimTop,
    minFailures: C34_RELATIVE_BURST.minFailures,
    minRefWindows: C34_RELATIVE_BURST.minRefWindows,
    basis:
      "C34 fixed these on Treeherder autoland 2026-11-09…11-22 and Prow 2026-08-19…11-15, and confirmed them on " +
      `Treeherder 2026-10-24…11-06 and the same Prow days; not measured on ${stream}. ` +
      "A burst is a count against the reference, not a cause; a blind channel names none and is not quiet.",
  };
}

/**
 * The `$Q` view the automatic replays write (ROADMAP C27). Its own view, not the live `#fine` one: a
 * replay re-observes retained events through another lens, and writing that lens over the fine view's
 * row would leave the live view switched to it after the replay. index.ts declares the matching
 * `compare:test_result:v1#regroup` row (the 30-window reference a 1-hour grouped replay needs).
 */
export const COARSE_REPLAY_VIEW = "regroup";

const DOWNWARD_TAGS: ReadonlySet<ShapeTag> = new Set<ShapeTag>(["dip", "step_down"]);

export interface CoarseReplayTriggerOptions {
  /** Grouping keys for the automatic replay lens. Default: `["agentId"]`. */
  groupBy?: readonly string[];
  /** $Q scope written by the emitted replayRequest. Default: `"observe:test_result:v1#regroup"` (COARSE_REPLAY_VIEW). */
  scope?: string;
  /** Maximum distinct window spans remembered for deduplication. Default: 1024. */
  maxRemembered?: number;
}

export class CoarseReplayTrigger {
  private readonly groupBy: readonly string[];
  private readonly scope: string;
  private readonly maxRemembered: number;
  private readonly seen = new Set<string>();

  constructor(opts: CoarseReplayTriggerOptions = {}) {
    const groupBy = opts.groupBy ?? ["agentId"];
    if (groupBy.length === 0) throw new RangeError("CoarseReplayTrigger: groupBy must be non-empty");
    this.groupBy = [...groupBy];
    this.scope = opts.scope ?? `observe:test_result:v1#${COARSE_REPLAY_VIEW}`;
    this.maxRemembered = opts.maxRemembered ?? 1024;
  }

  /**
   * Inspects one coarse SnapshotPackage and returns `replayRequest` decisions for
   * any newly triggered window (downward tile or concurrent-failure burst).
   */
  evaluate(pkg: SnapshotPackage): BrainDecision[] {
    const bySpan = new Map<string, { start: number; end: number; reasons: string[] }>();
    const add = (start: number, end: number, reason: string): void => {
      if (!(end > start)) return;
      const key = `${start}:${end}`;
      let entry = bySpan.get(key);
      if (entry === undefined) {
        entry = { start, end, reasons: [] };
        bySpan.set(key, entry);
      }
      entry.reasons.push(reason);
    };

    if (pkg.referenceUsable) {
      for (const t of pkg.tiles) {
        if (!DOWNWARD_TAGS.has(t.shapeTag)) continue;
        const mag = t.magnitude !== undefined ? `${t.magnitude.toFixed(1)}σ` : "flagged";
        add(t.regionStart, t.regionEnd, `${t.shapeTag} (${mag})`);
      }
    }

    for (const b of pkg.failures?.bursts ?? []) {
      add(b.windowStart, b.windowEnd, `burst (${b.failed} failed)`);
    }

    // C39: only when the package carries C34's channel, and only from a reference it could read.
    const rel = pkg.relativeFailures;
    if (rel !== undefined && !rel.blind) {
      for (const b of rel.bursts) {
        add(b.windowStart, b.windowEnd, `relative burst (${b.failed} failed > ${rel.threshold.toFixed(1)})`);
      }
    }

    const decisions: BrainDecision[] = [];
    const ordered = [...bySpan.entries()].sort((a, b) => a[1].start - b[1].start);
    for (const [key, { start, end, reasons }] of ordered) {
      if (this.seen.has(key)) continue;
      this.remember(key);
      const fromIso = new Date(start).toISOString();
      const toIso = new Date(end).toISOString();
      decisions.push({
        type: "replayRequest",
        reason: `coarse ${reasons.join(" + ")} in [${fromIso}, ${toIso}): re-observing by ${this.groupBy.join(",")}`,
        qProposal: {
          scope: this.scope,
          params: {
            window_ms: pkg.window_ms,
            align: "epoch",
            group_by: [...this.groupBy],
            fromTs: start,
            // Inclusive-exclusive correction: RetentionBuffer.segment filters `ts <= toTs`,
            // while lens windows are half-open [start, end).
            toTs: end - 1,
          },
        },
        meta: {
          triggerWindowStart: start,
          triggerWindowEnd: end,
          triggers: reasons,
          groupBy: [...this.groupBy],
        },
      });
    }
    return decisions;
  }

  reset(): void {
    this.seen.clear();
  }

  private remember(key: string): void {
    this.seen.add(key);
    while (this.seen.size > this.maxRemembered) {
      const oldest = this.seen.values().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
  }
}
