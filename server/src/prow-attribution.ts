/**
 * Which job the automatic grouped replay names (ROADMAP C28).
 *
 * C24 wired the two-stage loop: the combined 1-hour coarse view flags a window
 * (downward tile or concurrent-failure burst) and CoarseReplayTrigger replays
 * that window grouped by job. Its first check counted 12/13 windows "attributed"
 * to ci-kubernetes-e2e-gci-gce — but over a range picked for bursts already
 * known (C13) to be that job's, so it could not show the replay telling jobs
 * apart. This module runs the same loop over a recorded stream so that plants
 * (prow-plant.ts) with a known job can be scored.
 *
 * The rules, fixed 2026-11-22 before any plant was replayed through it:
 *  - A fire is a CoarseReplayTrigger decision at a boundary of the replay; the
 *    grouped replay is scored with the coarse row's comparison over exactly the
 *    flagged window, as index.ts does (`compare:#regroup` = the profile's coarse
 *    comparison, C27).
 *  - The groups a fire names: the groups of the replay package's downward tiles
 *    (dip, step_down) that cover the flagged window. A blind replay names none.
 *  - Against a truth set (the jobs with planted failures in that window):
 *    exact = names every true job and nothing else; partial = names only true
 *    jobs, not all of them; extra = names every true job and others too
 *    (or some true jobs and others: any true job named alongside a false one);
 *    wrong = names only jobs that are not true; none = names nothing.
 *
 * Counts only. Nothing here decides.
 */

import { CoarseReplayTrigger } from "./coarse-replay-trigger.js";
import type { LensEvent } from "./lens.js";
import type { QObserveParams } from "./q-registry.js";
import { replayThroughShippedWiring, type ReplayWiring } from "./prow-replay.js";

const DOWN = new Set(["dip", "step_down"]);

export interface RegroupFire {
  /** The flagged coarse window [windowStart, windowEnd). */
  windowStart: number;
  windowEnd: number;
  /** Boundary at which the trigger fired. */
  t: number;
  /** What fired it, as CoarseReplayTrigger words it ("dip (3.1σ)", "burst (12 failed)"). */
  triggers: string[];
  /** The grouped replay had no usable reference (it names nothing). */
  blind: boolean;
  /** Groups named: downward tiles of the grouped replay covering the window. Sorted. */
  groups: string[];
}

/**
 * Replays `events` through the wiring's coarse view, and at every boundary hands
 * the package to a fresh CoarseReplayTrigger; each decision is replayed grouped
 * over its window from the same buffer at that boundary. Time order.
 */
export function replayCoarseThenRegroup(
  events: readonly LensEvent[],
  fromMs: number,
  toMs: number,
  wiring: ReplayWiring,
  groupBy: readonly string[] = ["agentId"],
): RegroupFire[] {
  if (wiring.groupBy !== undefined) throw new RangeError("replayCoarseThenRegroup: the coarse view is combined; the wiring must not group");
  const trigger = new CoarseReplayTrigger({ groupBy });
  const fires: RegroupFire[] = [];
  replayThroughShippedWiring(events, fromMs, toMs, wiring, undefined, (pkg, at) => {
    for (const d of trigger.evaluate(pkg)) {
      const { fromTs, toTs, ...lens } = d.qProposal!.params as unknown as QObserveParams & { fromTs: number; toTs: number };
      const meta = d.meta as { triggerWindowStart: number; triggerWindowEnd: number; triggers: string[] };
      const re = at.comparator.compare(at.buffer, lens, at.compare, { fromTs, toTs });
      const groups = new Set<string>();
      if (re.referenceUsable) {
        for (const tile of re.tiles) {
          if (!DOWN.has(tile.shapeTag) || tile.group === undefined) continue;
          if (tile.regionStart <= meta.triggerWindowStart && meta.triggerWindowStart < tile.regionEnd) groups.add(tile.group);
        }
      }
      fires.push({
        windowStart: meta.triggerWindowStart,
        windowEnd: meta.triggerWindowEnd,
        t: at.t,
        triggers: meta.triggers,
        blind: !re.referenceUsable,
        groups: [...groups].sort(),
      });
    }
  });
  return fires;
}

export type Attribution = "exact" | "partial" | "extra" | "wrong" | "none";
export const ATTRIBUTIONS: readonly Attribution[] = ["exact", "partial", "extra", "wrong", "none"];

/** The rule above: what the named groups say against the true ones. */
export function classifyAttribution(named: readonly string[], truth: ReadonlySet<string>): Attribution {
  if (named.length === 0) return "none";
  const hit = named.filter((g) => truth.has(g)).length;
  const falses = named.length - hit;
  if (hit === 0) return "wrong";
  if (falses > 0) return "extra";
  return hit === truth.size ? "exact" : "partial";
}
