/**
 * Replays a recorded test-result stream through the SHIPPED wiring
 * (ROADMAP C12; ROADMAP_BRIEF.md 2026-11-10 audit items 1 and 5, 2026-11-17 (4)).
 *
 * Every real-data number before this one came from a harness that called the
 * curator directly. What ships is a chain — RetentionBuffer (freshness zone,
 * thinned reference zone) → WindowHistory → Comparator → SnapshotCurator — and
 * the audit's first finding was that the validated configuration was not the
 * shipped one. Here the recorded events enter the same classes index.ts
 * builds, in the same order, with the same options; the only thing replaced is
 * the clock, which is the events' own time.
 *
 * One evaluation is what the live view computes at a grid boundary: the last
 * `liveWindows` whole windows against the span before them (dashboard.ts
 * `liveSpans`). Production asks every second, but between two boundaries the
 * request is the same, so one evaluation per boundary is every distinct
 * package the live view would have produced.
 *
 * What is counted, and what it can and cannot say:
 *
 *   - "blind"  the package has no usable reference. Not quiet — unable to say.
 *   - "alarm"  the package holds a tile that claims a change. The cap on shown
 *              tiles is lifted (a measurement must not read a display limit,
 *              2026-10-14 (9)); nothing else differs from the live Comparator.
 *   - failures in the observed span are counted from the events themselves.
 *     That is NOT ground truth for "a regression happened": most single
 *     failures in a CI stream are flaky tests. It answers a narrower question
 *     honestly — when a test failed, did the layer say anything at all.
 */

import { Comparator } from "./comparison.js";
import { liveSpans } from "./dashboard.js";
import type { LensEvent } from "./lens.js";
import type { QCompareParams, QObserveParams } from "./q-registry.js";
import { RetentionBuffer } from "./retention-buffer.js";
import type { NullModel, ShapeTag } from "./snapshot-curator.js";
import { WindowHistory } from "./window-history.js";

/** The constants index.ts ships (2026-11-17): what "as shipped" means below. */
export const SHIPPED_WIRING = {
  retentionMs: 120_000,
  referenceZoneMs: 1_200_000,
  thinningRatio: 2,
  historyMs: 3_600_000,
  liveWindows: 3,
} as const;

export interface ReplayWiring {
  name: string;
  windowMs: number;
  /** Windows the live view observes at once (shipped: 3). */
  liveWindows: number;
  /** `$Q[compare].reference_windows`; absent = a reference as long as the observation (shipped). */
  referenceWindows?: number;
  /** Freshness zone (shipped: 120 s). */
  retentionMs: number;
  /** Thinned reference zone behind it, with its ratio (shipped: 20 min, 1 in 2). Both or neither. */
  referenceZoneMs?: number;
  thinningRatio?: number;
  /** Window-summary history kept (shipped: 1 h). Read only by a variogram row. */
  historyMs: number;
  groupBy?: string[];
  nullModel?: NullModel;
}

const MIN = 60_000;
const HOUR = 3_600_000;
const S = SHIPPED_WIRING;

/** A freshness zone long enough to hold the observation, the reference and one window of slack, unthinned. */
const fresh = (windowMs: number, liveWindows: number, referenceWindows: number): number => windowMs * (liveWindows + referenceWindows + 1);

/** The configurations the replay reports compare: two as shipped, the rest with the window and the zones lengthened. */
export const REPLAY_ARMS: ReplayWiring[] = [
  // As shipped: nothing changed.
  { name: "shipped-10s", windowMs: 10_000, liveWindows: S.liveWindows, retentionMs: S.retentionMs, referenceZoneMs: S.referenceZoneMs, thinningRatio: S.thinningRatio, historyMs: S.historyMs },
  { name: "shipped-1s", windowMs: 1_000, liveWindows: S.liveWindows, retentionMs: S.retentionMs, referenceZoneMs: S.referenceZoneMs, thinningRatio: S.thinningRatio, historyMs: S.historyMs },
  // Stretched: the window and the zones are lengthened; the classes and their options are the shipped ones.
  { name: "10min-fresh", windowMs: 10 * MIN, liveWindows: 3, referenceWindows: 30, retentionMs: fresh(10 * MIN, 3, 30), historyMs: S.historyMs },
  { name: "1h-equal", windowMs: HOUR, liveWindows: 3, retentionMs: fresh(HOUR, 3, 3), historyMs: S.historyMs },
  { name: "1h-fresh", windowMs: HOUR, liveWindows: 3, referenceWindows: 30, retentionMs: fresh(HOUR, 3, 30), historyMs: S.historyMs },
  { name: "1h-thinned", windowMs: HOUR, liveWindows: 3, referenceWindows: 30, retentionMs: 4 * HOUR, referenceZoneMs: 31 * HOUR, thinningRatio: S.thinningRatio, historyMs: S.historyMs },
  { name: "1h-fresh-by-job", windowMs: HOUR, liveWindows: 3, referenceWindows: 30, retentionMs: fresh(HOUR, 3, 30), historyMs: S.historyMs, groupBy: ["agentId"] },
  { name: "1h-fresh-by-area", windowMs: HOUR, liveWindows: 3, referenceWindows: 30, retentionMs: fresh(HOUR, 3, 30), historyMs: S.historyMs, groupBy: ["area"] },
  { name: "6h-fresh", windowMs: 6 * HOUR, liveWindows: 3, referenceWindows: 30, retentionMs: fresh(6 * HOUR, 3, 30), historyMs: S.historyMs },
];

/** Shape tags that claim something changed (a baseline tile and a gap do not). */
const ALARM_TAGS: ReadonlySet<ShapeTag> = new Set<ShapeTag>(["spike", "dip", "step_up", "step_down", "divergence"]);
const DOWN_TAGS: ReadonlySet<ShapeTag> = new Set<ShapeTag>(["dip", "step_down"]);

export interface ReplayTally {
  wiring: ReplayWiring;
  /** Grid boundaries in the range. */
  evaluations: number;
  /** The observed span held no event: nothing to compare, not asked. */
  empty: number;
  /** Asked, and the package had no usable reference. */
  blind: number;
  /** Asked, with a usable reference. */
  scored: number;
  /** compare() threw (counted, with the first message). */
  errors: number;
  firstError?: string;
  /** Scored packages whose observed span held at least one failure / none, and how many alarmed. */
  withFailure: { n: number; alarmed: number; down: number };
  allPass: { n: number; alarmed: number };
  /** Blind packages whose observed span held at least one failure. */
  blindWithFailure: number;
  /**
   * Distinct grid windows holding a failure, and those a downward tile covered
   * in at least one evaluation (each window is observed `liveWindows` times).
   */
  failingWindows: number;
  failingWindowsFlagged: number;
  /** Of the failing windows, those that were only ever inside blind packages. */
  failingWindowsOnlyBlind: number;
  /** The failing windows by how many failures they hold (1, 2, 3 or more), and how many of each a downward tile covered. */
  failingByCount: Array<{ failures: "1" | "2" | "3+"; n: number; flagged: number }>;
  /** Every failing window by its start: was it ever inside a scored package, did a downward tile ever cover it. */
  failingWindowDetail: Map<number, { scored: boolean; flagged: boolean }>;
}

/** One asked boundary, as an outside reader sees it (C20 reads which windows a downward tile covered). */
export interface ReplayEvaluation {
  /** The grid boundary: when the live view would show this package. */
  t: number;
  blind: boolean;
  /** Downward tiles (dip, step_down) of a scored package; empty when blind. */
  downs: Array<{ regionStart: number; regionEnd: number; group?: string }>;
}

function lowerBound(a: Float64Array, x: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (a[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * `events` in time order (pass 1, fail 0). Evaluates every grid boundary t
 * with fromMs + liveWindows·W ≤ t ≤ toMs, after feeding every event before t.
 * Events before fromMs are fed too — they are the stream's past, which a
 * running process would hold. `onEvaluation`, when given, sees every asked
 * boundary (not the empty or failed ones); it does not change the tally.
 */
export function replayThroughShippedWiring(
  events: readonly LensEvent[],
  fromMs: number,
  toMs: number,
  wiring: ReplayWiring,
  onEvaluation?: (ev: ReplayEvaluation) => void,
): ReplayTally {
  const W = wiring.windowMs;
  const N = wiring.liveWindows;
  const buffer = new RetentionBuffer<LensEvent>((raw) => raw, {
    retentionWindowMs: wiring.retentionMs,
    ...(wiring.referenceZoneMs !== undefined ? { referenceWindowMs: wiring.referenceZoneMs } : {}),
    ...(wiring.thinningRatio !== undefined ? { thinningRatio: wiring.thinningRatio } : {}),
  });
  const lens: QObserveParams = { window_ms: W, align: "epoch", ...(wiring.groupBy !== undefined ? { group_by: wiring.groupBy } : {}) };
  const history = new WindowHistory(buffer, { maxHistoryMs: wiring.historyMs });
  history.track(lens);
  // index.ts's live Comparator, minus the display cap and the volume channel (which no decision reads).
  const comparator = new Comparator({ spikeZThreshold: 2.0, includeBaseline: true, sensitivityPower: 0.8, maxTiles: Infinity }, history);
  const decl: QCompareParams = {
    reference: "preceding",
    null_model: wiring.nullModel ?? "independent",
    ...(wiring.referenceWindows !== undefined ? { reference_windows: wiring.referenceWindows } : {}),
  };

  const ts = new Float64Array(events.length);
  const failsBefore = new Uint32Array(events.length + 1);
  for (let i = 0; i < events.length; i++) {
    ts[i] = events[i]!.ts;
    failsBefore[i + 1] = failsBefore[i]! + (events[i]!.value === 0 ? 1 : 0);
  }
  const failuresIn = (from: number, toExclusive: number): number => failsBefore[lowerBound(ts, toExclusive)]! - failsBefore[lowerBound(ts, from)]!;
  const eventsIn = (from: number, toExclusive: number): number => lowerBound(ts, toExclusive) - lowerBound(ts, from);

  const tally: ReplayTally = {
    wiring,
    evaluations: 0,
    empty: 0,
    blind: 0,
    scored: 0,
    errors: 0,
    withFailure: { n: 0, alarmed: 0, down: 0 },
    allPass: { n: 0, alarmed: 0 },
    blindWithFailure: 0,
    failingWindows: 0,
    failingWindowsFlagged: 0,
    failingWindowsOnlyBlind: 0,
    failingByCount: [
      { failures: "1", n: 0, flagged: 0 },
      { failures: "2", n: 0, flagged: 0 },
      { failures: "3+", n: 0, flagged: 0 },
    ],
    failingWindowDetail: new Map(),
  };
  /** Per failing window (by start): was it ever in a scored package, ever covered by a downward tile. */
  const failing = tally.failingWindowDetail;

  let fed = 0;
  const first = Math.ceil(fromMs / W) * W + N * W;
  for (let t = first; t <= toMs; t += W) {
    while (fed < events.length && events[fed]!.ts < t) {
      buffer.observe(events[fed]!, "test_result:v1");
      fed++;
    }
    tally.evaluations++;
    const { observation } = liveSpans(t, W, N);
    const failingHere: number[] = [];
    for (let w = observation.fromTs; w < t; w += W) {
      if (failuresIn(w, w + W) > 0) {
        failingHere.push(w);
        if (!failing.has(w)) failing.set(w, { scored: false, flagged: false });
      }
    }
    if (eventsIn(observation.fromTs, t) === 0) {
      tally.empty++;
      continue;
    }
    let pkg;
    try {
      pkg = comparator.compare(buffer, lens, decl, observation);
    } catch (e) {
      tally.errors++;
      tally.firstError ??= e instanceof Error ? e.message : String(e);
      continue;
    }
    if (!pkg.referenceUsable) {
      tally.blind++;
      if (failingHere.length > 0) tally.blindWithFailure++;
      onEvaluation?.({ t, blind: true, downs: [] });
      continue;
    }
    tally.scored++;
    const alarms = pkg.tiles.filter((x) => ALARM_TAGS.has(x.shapeTag));
    const downs = alarms.filter((x) => DOWN_TAGS.has(x.shapeTag));
    onEvaluation?.({
      t,
      blind: false,
      downs: downs.map((d) => ({ regionStart: d.regionStart, regionEnd: d.regionEnd, ...(d.group !== undefined ? { group: d.group } : {}) })),
    });
    if (failingHere.length > 0) {
      tally.withFailure.n++;
      if (alarms.length > 0) tally.withFailure.alarmed++;
      if (downs.length > 0) tally.withFailure.down++;
    } else {
      tally.allPass.n++;
      if (alarms.length > 0) tally.allPass.alarmed++;
    }
    for (const w of failingHere) {
      const f = failing.get(w)!;
      f.scored = true;
      if (downs.some((d) => d.regionStart <= w && w < d.regionEnd)) f.flagged = true;
    }
  }
  tally.failingWindows = failing.size;
  for (const [w, f] of failing) {
    if (f.flagged) tally.failingWindowsFlagged++;
    if (!f.scored) tally.failingWindowsOnlyBlind++;
    const bucket = tally.failingByCount[Math.min(3, failuresIn(w, w + W)) - 1]!;
    bucket.n++;
    if (f.flagged) bucket.flagged++;
  }
  return tally;
}
