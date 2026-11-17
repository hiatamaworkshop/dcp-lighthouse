/**
 * Planted regressions in a recorded CI stream (ROADMAP C20, plan b;
 * ROADMAP_BRIEF.md 2026-11-17 (7)).
 *
 * The three periodic jobs hold almost no regression (C13: 1 episode in 89
 * days), so whether the layer catches one cannot be read off the record. Here
 * one is put in: the record stays as it was except for the planted cases, so
 * the ground truth is exact and everything around it is the real stream.
 *
 * THE RULES, fixed on 2026-11-17 before any plant was replayed.
 *
 *   plant      one job, one start build, a length of n builds, a set of target
 *              tests. In the job's n consecutive builds from the start (in time
 *              order, every build counted whether or not it ran a target), every
 *              case of a target test that is not skipped becomes "failed".
 *              Skipped and absent cases stay as they are: a broken test that
 *              did not run shows nothing, as in the record.
 *
 *              Amended the same day, after a rehearsal of 2 starts per job and
 *              before the full run: a regression comes in with a commit and
 *              leaves with one. Half the periodic builds rerun the previous
 *              commit, so a plant cut mid-commit had the same code passing
 *              beside it (C13 rightly called 5 in 6 of those "flaky"). So the
 *              start build must be the first build of the job on its commit
 *              (`isCommitStart`), and the plant runs on past its n-th build to
 *              the last consecutive build on that build's commit (`plantExtent`).
 *
 *   targets    drawn (seeded) from the tests that PASSED in the start build:
 *                one    1 test
 *                few    5 tests
 *                area   every such test of one SIG label (the label drawn among
 *                       the labels present), the "a whole area broke" case
 *
 *   detected   at some grid boundary t, a downward tile (dip, step_down) covers
 *              a window holding a planted failure, and the same replay WITHOUT
 *              the plant has no downward tile covering that window at t.
 *              On a grouped lens the tile's group must be a group of a planted
 *              failure in that window. Time to detect = t − the first planted
 *              failure's instant (t is when the live view would show it).
 *
 * What it cannot say: how real regressions look. A real break may fail a test
 * only sometimes, or fail its neighbours too; these plants are clean and
 * total, so the numbers are an upper bound on "a break of this size".
 */

import type { JunitSuite, ProwBuild } from "./prow-import.js";
import { buildToEvents, type ProwEvent } from "./prow-events.js";
import type { ReplayEvaluation } from "./prow-replay.js";
import { deriveEpisodes, type FailureClass } from "./prow-truth.js";

export type PlantSize = "one" | "few" | "area";
export const PLANT_SIZES: readonly PlantSize[] = ["one", "few", "area"];
export const FEW = 5;

export interface Plant {
  job: string;
  /** The build the plant starts at. */
  startBuildId: string;
  /** How many consecutive builds of the job it lasts. */
  builds: number;
  size: PlantSize;
  testIds: string[];
  /** The SIG label, for an "area" plant. */
  area?: string;
}

/** A small seeded generator (mulberry32): the same seed draws the same plants on every machine. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `k` distinct items drawn without replacement (all of them when there are fewer). */
function draw<T>(items: readonly T[], k: number, rand: () => number): T[] {
  const a = [...items];
  const n = Math.min(k, a.length);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rand() * (a.length - i));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a.slice(0, n);
}

/**
 * The targets of a plant starting at `start`, or undefined when the build has
 * too few passing tests (fewer than the size asks; an "area" plant needs one
 * labelled passing test). Tests are taken in sorted order before drawing, so
 * the draw does not depend on junit file order.
 */
export function choosePlant(start: ProwBuild, size: PlantSize, builds: number, rand: () => number): Plant | undefined {
  const failed = new Set<string>();
  const passed = new Map<string, string>();
  for (const e of buildToEvents(start).events) {
    if (e.result === "fail") failed.add(e.testId);
    else passed.set(e.testId, e.area);
  }
  // A test with a failing case in the start build is not a passing test.
  const ids = [...passed.keys()].filter((id) => !failed.has(id)).sort();
  const base = { job: start.job, startBuildId: start.id, builds, size };
  if (size === "one" || size === "few") {
    const k = size === "one" ? 1 : FEW;
    if (ids.length < k) return undefined;
    return { ...base, testIds: draw(ids, k, rand) };
  }
  const areas = [...new Set(ids.map((id) => passed.get(id)!).filter((a) => a !== ""))].sort();
  if (areas.length === 0) return undefined;
  const area = draw(areas, 1, rand)[0]!;
  return { ...base, area, testIds: ids.filter((id) => passed.get(id) === area) };
}

/** Build `i` of a job's builds (time order) is the first one on its stated commit: it differs from the build before. */
export function isCommitStart(ofJob: readonly ProwBuild[], i: number): boolean {
  const c = ofJob[i]?.commit;
  return c !== undefined && (i === 0 || ofJob[i - 1]!.commit !== c);
}

/**
 * The builds a plant of `n` starting at index `at` covers: n builds, then on
 * through every following build on the n-th build's commit (the break is
 * fixed only by a new commit). Fewer than n when the job runs out.
 */
export function plantExtent(ofJob: readonly ProwBuild[], at: number, n: number): ProwBuild[] {
  let end = Math.min(ofJob.length, at + n);
  const last = ofJob[end - 1]?.commit;
  while (last !== undefined && end < ofJob.length && ofJob[end]!.commit === last) end++;
  return ofJob.slice(at, end);
}

/**
 * `builds` with the plant applied. Builds outside the plant are the same
 * objects; a planted build is a copy (the record is never mutated). Returns
 * the planted builds' ids in order (`plantExtent`).
 */
export function applyPlant(builds: readonly ProwBuild[], plant: Plant): { builds: ProwBuild[]; plantedBuildIds: string[] } {
  const ofJob = builds.filter((b) => b.job === plant.job).sort((a, b) => a.scheduledMs - b.scheduledMs);
  const at = ofJob.findIndex((b) => b.id === plant.startBuildId);
  if (at < 0) throw new RangeError(`applyPlant: start build ${plant.startBuildId} of ${plant.job} is not among the builds`);
  const extent = plantExtent(ofJob, at, plant.builds);
  const planted = new Set(extent.map((b) => b.id));
  const targets = new Set(plant.testIds);
  const out = builds.map((b) => {
    if (b.job !== plant.job || !planted.has(b.id)) return b;
    return {
      ...b,
      files: b.files.map((f) => ({
        file: f.file,
        suites: f.suites.map((s): JunitSuite => ({
          ...s,
          cases: s.cases.map((c) => (c.status !== "skipped" && targets.has(`${c.classname}::${c.name}`) ? { ...c, status: "failed" } : c)),
        })),
      })),
    };
  });
  return { builds: out, plantedBuildIds: extent.map((b) => b.id) };
}

/** The planted failures among a planted stream's events: a target test failing in a planted build. */
export function plantedFailures(events: readonly ProwEvent[], plant: Plant, plantedBuildIds: readonly string[]): ProwEvent[] {
  const ids = new Set(plantedBuildIds);
  const targets = new Set(plant.testIds);
  return events.filter((e) => e.result === "fail" && e.agentId === plant.job && ids.has(e.buildId) && targets.has(e.testId));
}

export interface PlantScore {
  detected: boolean;
  /** Boundary at which it was first detected. */
  detectedAt?: number;
  /** detectedAt − first planted failure. */
  delayMs?: number;
  firstFailureMs: number;
  /** Boundaries after the first planted failure, up to the last evaluation, that were blind in the planted replay. */
  blindAfter: number;
  /** Planted failures. */
  failures: number;
}

/** The group label a planted failure falls in under `groupBy` (one key, as the arms use), or undefined ungrouped. */
function groupOf(e: ProwEvent, groupBy: readonly string[] | undefined): string | undefined {
  if (groupBy === undefined) return undefined;
  return groupBy.map((k) => (k === "agentId" ? e.agentId : k === "area" ? e.area : "")).join("|");
}

/**
 * Applies the "detected" rule above to the evaluations of the same slice
 * replayed without (`baseline`) and with (`planted`) the plant.
 */
export function scorePlant(
  baseline: readonly ReplayEvaluation[],
  planted: readonly ReplayEvaluation[],
  failures: readonly ProwEvent[],
  windowMs: number,
  groupBy?: readonly string[],
): PlantScore {
  const firstFailureMs = failures.reduce((m, e) => Math.min(m, e.ts), Infinity);
  // Window start → the groups of the planted failures in it.
  const windows = new Map<number, Set<string | undefined>>();
  for (const e of failures) {
    const w = Math.floor(e.ts / windowMs) * windowMs;
    let g = windows.get(w);
    if (g === undefined) windows.set(w, (g = new Set()));
    g.add(groupOf(e, groupBy));
  }
  const covers = (downs: ReplayEvaluation["downs"], w: number, groups: Set<string | undefined>): boolean =>
    downs.some((d) => d.regionStart <= w && w < d.regionEnd && (d.group === undefined ? groupBy === undefined : groups.has(d.group)));
  const baseAt = new Map(baseline.map((ev) => [ev.t, ev.downs]));
  let blindAfter = 0;
  let detectedAt: number | undefined;
  for (const ev of [...planted].sort((a, b) => a.t - b.t)) {
    if (ev.t <= firstFailureMs) continue;
    if (ev.blind) blindAfter++;
    if (detectedAt !== undefined) continue;
    for (const [w, groups] of windows) {
      if (covers(ev.downs, w, groups) && !covers(baseAt.get(ev.t) ?? [], w, groups)) {
        detectedAt = ev.t;
        break;
      }
    }
  }
  return {
    detected: detectedAt !== undefined,
    ...(detectedAt !== undefined ? { detectedAt, delayMs: detectedAt - firstFailureMs } : {}),
    firstFailureMs,
    blindAfter,
    failures: failures.length,
  };
}

/**
 * How C13's rules classify the planted failures of the start build: the class
 * of each target's episode that holds the start build (targets that did not
 * fail there are left out). Read over `builds` only — a slice can miss a pass
 * of the same commit outside it, so a slice can call "regression" what the
 * whole record would call "flaky", never the reverse.
 */
export function plantClasses(builds: readonly ProwBuild[], plant: Plant): FailureClass[] {
  const out: FailureClass[] = [];
  const targets = new Set(plant.testIds);
  for (const ep of deriveEpisodes(builds.filter((b) => b.job === plant.job))) {
    if (targets.has(ep.testId) && ep.buildIds.includes(plant.startBuildId)) out.push(ep.class);
  }
  return out;
}
