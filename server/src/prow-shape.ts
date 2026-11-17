/**
 * The shape of a real test-result stream (ROADMAP C17).
 *
 * Not a verdict and not a calibration: a count of what is there, taken before
 * any claim is made about it. Six weeks of Wikimedia taught the statistical
 * layer about a dense stream whose rate sits near the middle; a CI stream is
 * expected to be the opposite on both counts — it arrives in runs with nothing
 * in between, and nearly every result is a pass. Two questions decide whether
 * the layer as built can say anything about it at all, and both are asked with
 * the layer's OWN predicates rather than a restatement of them:
 *
 *   - which windows can be scored (`isScorable`)
 *   - which of those have a reference to be scored against (`isReferenceUsable`
 *     on the pooled windows just before — a reference whose every result is a
 *     pass has zero variance and is refused)
 *
 * A reader of these shares should hold one thing in mind: a share is taken
 * over the windows of the lens's grid inside the range, INCLUDING the empty
 * ones. Counting only windows that hold events would report how the stream
 * looks while a run is in progress and hide that most of the time none is.
 */

import { applyLens, MIN_VALID_COUNT, type LensEvent, type WindowStat } from "./lens.js";
import { isReferenceUsable, isScorable, poolStats } from "./snapshot-curator.js";
import type { MissingBuild, ProwBuild } from "./prow-import.js";
import { buildStartMs, type ProwEvent } from "./prow-events.js";

export interface Quantiles {
  n: number;
  min: number;
  p10: number;
  median: number;
  p90: number;
  max: number;
}

export function quantiles(values: readonly number[]): Quantiles | undefined {
  if (values.length === 0) return undefined;
  const v = [...values].sort((a, b) => a - b);
  const at = (p: number): number => v[Math.min(v.length - 1, Math.max(0, Math.round(p * (v.length - 1))))]!;
  return { n: v.length, min: v[0]!, p10: at(0.1), median: at(0.5), p90: at(0.9), max: v[v.length - 1]! };
}

export interface StreamShape {
  builds: number;
  /** Builds scheduled in the range that could not be read (blind). */
  missingBuilds: number;
  buildResults: Record<string, number>;
  events: number;
  pass: number;
  fail: number;
  skipped: number;
  /** Distinct testId / area (first SIG label, "" = none) / agentId. */
  tests: number;
  areas: number;
  agents: number;
  /** Events whose test carries no SIG label. */
  unlabelled: number;
  commits: number;
  buildsWithoutCommit: number;
  /** Builds holding at least one failed case, and the failed cases per such build. */
  buildsWithFailure: number;
  failuresPerFailingBuild?: Quantiles;
  /** Builds whose own result is not SUCCESS but hold no failed case (the failure is not in the junit). */
  failedBuildsWithoutFailedCase: number;
  eventsPerBuild?: Quantiles;
  buildMinutes?: Quantiles;
  /** Minutes between consecutive build starts. */
  startGapMinutes?: Quantiles;
  buildsPerCommit?: Quantiles;
  /** Mean events per day in each UTC hour (24 entries), by the event's stamped time. */
  eventsByHour: number[];
  /** Distinct tests that failed at least once, and those that failed in ≥ 2 builds. */
  testsEverFailed: number;
  testsFailedTwice: number;
}

/** Counts over the builds and their events (events as produced by prow-events, any placement). */
export function streamShape(builds: readonly ProwBuild[], events: readonly ProwEvent[], skipped: number, missing: readonly MissingBuild[], days: number): StreamShape {
  const results: Record<string, number> = {};
  for (const b of builds) results[b.result] = (results[b.result] ?? 0) + 1;
  const tests = new Set<string>();
  const areas = new Set<string>();
  const agents = new Set<string>();
  const perBuild = new Map<string, { n: number; fail: number }>();
  const failBuilds = new Map<string, Set<string>>();
  const byHour = new Array<number>(24).fill(0);
  let pass = 0;
  let fail = 0;
  let unlabelled = 0;
  for (const e of events) {
    tests.add(e.testId);
    areas.add(e.area);
    agents.add(e.agentId);
    if (e.area === "") unlabelled++;
    let pb = perBuild.get(e.buildId);
    if (pb === undefined) perBuild.set(e.buildId, (pb = { n: 0, fail: 0 }));
    pb.n++;
    if (e.result === "fail") {
      fail++;
      pb.fail++;
      let s = failBuilds.get(e.testId);
      if (s === undefined) failBuilds.set(e.testId, (s = new Set()));
      s.add(e.buildId);
    } else {
      pass++;
    }
    byHour[new Date(e.ts).getUTCHours()]!++;
  }
  const commits = new Map<string, number>();
  let withoutCommit = 0;
  for (const b of builds) {
    if (b.commit === undefined) withoutCommit++;
    else commits.set(b.commit, (commits.get(b.commit) ?? 0) + 1);
  }
  const failing = [...perBuild.values()].filter((p) => p.fail > 0);
  const starts = builds.map(buildStartMs).sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < starts.length; i++) gaps.push((starts[i]! - starts[i - 1]!) / 60_000);
  const shape: StreamShape = {
    builds: builds.length,
    missingBuilds: missing.length,
    buildResults: results,
    events: events.length,
    pass,
    fail,
    skipped,
    tests: tests.size,
    areas: areas.size,
    agents: agents.size,
    unlabelled,
    commits: commits.size,
    buildsWithoutCommit: withoutCommit,
    buildsWithFailure: failing.length,
    failedBuildsWithoutFailedCase: builds.filter((b) => b.result !== "SUCCESS" && (perBuild.get(b.id)?.fail ?? 0) === 0).length,
    eventsByHour: byHour.map((n) => n / Math.max(1, days)),
    testsEverFailed: failBuilds.size,
    testsFailedTwice: [...failBuilds.values()].filter((s) => s.size >= 2).length,
  };
  const set = <K extends keyof StreamShape>(k: K, q: StreamShape[K] | undefined): void => {
    if (q !== undefined) shape[k] = q;
  };
  set("failuresPerFailingBuild", quantiles(failing.map((p) => p.fail)));
  set("eventsPerBuild", quantiles(builds.map((b) => perBuild.get(b.id)?.n ?? 0)));
  set("buildMinutes", quantiles(builds.map((b) => (b.finishedMs - buildStartMs(b)) / 60_000)));
  set("startGapMinutes", quantiles(gaps));
  set("buildsPerCommit", quantiles([...commits.values()]));
  return shape;
}

export interface WindowShape {
  windowMs: number;
  referenceWindows: number;
  /** Windows of the grid inside the range (empty ones included). */
  gridWindows: number;
  nonEmpty: number;
  scorable: number;
  /** Scorable windows whose every event passed (the window itself has no variance). */
  scorableAllPass: number;
  /** Scorable windows whose preceding `referenceWindows` grid windows pool to a usable reference. */
  referenceUsable: number;
  /** Why the others are not: the pool holds too few events / holds enough but every one passed. */
  referenceThin: number;
  referenceAllPass: number;
  /** Scorable windows holding at least one failure, and those among them with a usable reference. */
  scorableWithFailure: number;
  failureWithUsableReference: number;
}

/**
 * How much of the range a lens of this width can score, and against what.
 *
 * `events` must be in time order. The grid is the epoch grid (`align:"epoch"`,
 * as both production views declare), so the windows are the ones production
 * would form. The reference of a window is the `referenceWindows` grid windows
 * immediately before it — the "preceding" reference of `$Q[compare]`, for an
 * observation of one window.
 */
export function windowShape(events: readonly LensEvent[], fromMs: number, toMs: number, windowMs: number, referenceWindows: number): WindowShape {
  const every = applyLens(events, { window_ms: windowMs, align: "epoch" }).windows;
  // The reference may reach back before the range; the windows counted may not.
  const byIndex = new Map<number, WindowStat>();
  for (const w of every) byIndex.set(Math.round(w.windowStart / windowMs), w);
  const windows = every.filter((w) => w.windowStart >= fromMs && w.windowEnd <= toMs);
  const first = Math.ceil(fromMs / windowMs);
  const last = Math.floor(toMs / windowMs); // exclusive
  const out: WindowShape = {
    windowMs,
    referenceWindows,
    gridWindows: Math.max(0, last - first),
    nonEmpty: windows.length,
    scorable: 0,
    scorableAllPass: 0,
    referenceUsable: 0,
    referenceThin: 0,
    referenceAllPass: 0,
    scorableWithFailure: 0,
    failureWithUsableReference: 0,
  };
  for (const w of windows) {
    if (!isScorable(w)) continue;
    out.scorable++;
    const allPass = w.mean === 1;
    if (allPass) out.scorableAllPass++;
    else out.scorableWithFailure++;
    const i = Math.round(w.windowStart / windowMs);
    const ref: WindowStat[] = [];
    for (let k = i - referenceWindows; k < i; k++) {
      const r = byIndex.get(k);
      if (r !== undefined) ref.push(r);
    }
    const pooled = poolStats(ref);
    if (isReferenceUsable(pooled)) {
      out.referenceUsable++;
      if (!allPass) out.failureWithUsableReference++;
    } else if (pooled.effectiveN >= MIN_VALID_COUNT && pooled.variance === 0) {
      out.referenceAllPass++;
    } else {
      out.referenceThin++;
    }
  }
  return out;
}
