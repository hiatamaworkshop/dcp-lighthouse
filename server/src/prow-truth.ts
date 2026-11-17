/**
 * Ground truth for a CI stream, derived from the stream's own record
 * (ROADMAP C13; ROADMAP_BRIEF.md 2026-11-10 audit item 3, 2026-11-17 (5)).
 *
 * Prow publishes no label saying why a test failed. What it does publish is
 * enough to tell two kinds of failure apart without reading any score: the
 * same job runs again and again, often several times on one commit, so a
 * failure can be followed through the builds around it.
 *
 * THE RULES, fixed on 2026-11-17 before any failure was joined to a tile.
 * (What had been seen by then: the shape survey's totals and C12's counts of
 * flagged windows by number of failures. No per-test sequence had been read.)
 *
 *   outcome   For one job, a test's outcome in a build is "fail" if any of its
 *             cases in that build failed, "pass" if it has cases and none
 *             failed, and absent if it has no case there (skipped, not run, or
 *             the build broke before writing it). Absent builds are stepped
 *             over: they neither extend nor end anything.
 *
 *   episode   A maximal run of consecutive "fail" outcomes of one test in one
 *             job, in build order.
 *
 *   split     An episode is SPLIT if the record shows the same code both
 *             passing and failing this test: some build of the job on one of
 *             the episode's commits where the test passed, or a failing build
 *             of the episode in which another case of the same test passed.
 *             Builds without a stated commit cannot show a split by commit.
 *
 *   class     flaky        the episode is split                       (any length)
 *             regression   not split, and 2 or more builds long
 *             isolated     not split, 1 build long — the record cannot say.
 *                          Its commit never ran again with this test, so it
 *                          may be a flaky test or a break fixed within the hour
 *
 * "regression" here means "failed persistently and never passed on the same
 * code". It is the strongest claim the record supports, not a human verdict:
 * a persistent infrastructure fault looks the same. "isolated" is kept as its
 * own class rather than folded into flaky so that no count below quietly
 * assumes the answer to the open question.
 *
 * An episode still failing at the last build read is marked `open` — its true
 * length is unknown, which matters for the 1-build case only (an open 1-build
 * episode is "isolated" by the rule, and flagged as open).
 */

import type { ProwBuild } from "./prow-import.js";
import { buildToEvents, type ProwEventOptions } from "./prow-events.js";

export type FailureClass = "flaky" | "regression" | "isolated";

export interface Episode {
  job: string;
  testId: string;
  /** The failing builds, in order. */
  buildIds: string[];
  /** Instant of the first and last failing build (their scheduling time). */
  firstMs: number;
  lastMs: number;
  /** Distinct stated commits among the failing builds. */
  commits: string[];
  split: boolean;
  /** Still failing at the last build read. */
  open: boolean;
  /** Already failing at the first build read (its true start is before the range). */
  fromStart: boolean;
  class: FailureClass;
}

interface Outcome {
  buildId: string;
  scheduledMs: number;
  commit: string | undefined;
  fail: boolean;
  /** A case of the same test passed in the same build. */
  mixed: boolean;
}

/**
 * Builds episodes from builds handed over one at a time, so a long range can
 * be read in pieces (89 days of three jobs do not fit in memory at once).
 * Each job's builds must arrive in time order; jobs may be interleaved.
 */
export class EpisodeBuilder {
  private readonly perJob = new Map<string, { lastMs: number; perTest: Map<string, Outcome[]> }>();

  constructor(private readonly opts: ProwEventOptions = {}) {}

  add(b: ProwBuild): void {
    let job = this.perJob.get(b.job);
    if (job === undefined) this.perJob.set(b.job, (job = { lastMs: -Infinity, perTest: new Map() }));
    if (b.scheduledMs < job.lastMs) throw new RangeError(`EpisodeBuilder: ${b.job} build ${b.id} arrived out of time order`);
    job.lastMs = b.scheduledMs;
    const inBuild = new Map<string, { pass: number; fail: number }>();
    for (const e of buildToEvents(b, this.opts).events) {
      let c = inBuild.get(e.testId);
      if (c === undefined) inBuild.set(e.testId, (c = { pass: 0, fail: 0 }));
      if (e.result === "fail") c.fail++;
      else c.pass++;
    }
    for (const [testId, c] of inBuild) {
      let seq = job.perTest.get(testId);
      if (seq === undefined) job.perTest.set(testId, (seq = []));
      seq.push({ buildId: b.id, scheduledMs: b.scheduledMs, commit: b.commit, fail: c.fail > 0, mixed: c.fail > 0 && c.pass > 0 });
    }
  }

  finish(): Episode[] {
    const episodes: Episode[] = [];
    for (const [job, { perTest }] of this.perJob) {
      for (const [testId, seq] of perTest) {
        // Commits on which this test passed outright in some build.
        const passedOn = new Set<string>();
        for (const o of seq) if (!o.fail && o.commit !== undefined) passedOn.add(o.commit);
        let i = 0;
        while (i < seq.length) {
          if (!seq[i]!.fail) {
            i++;
            continue;
          }
          let j = i;
          while (j + 1 < seq.length && seq[j + 1]!.fail) j++;
          const run = seq.slice(i, j + 1);
          const commits = [...new Set(run.map((o) => o.commit).filter((c): c is string => c !== undefined))];
          const split = run.some((o) => o.mixed) || commits.some((c) => passedOn.has(c));
          episodes.push({
            job,
            testId,
            buildIds: run.map((o) => o.buildId),
            firstMs: run[0]!.scheduledMs,
            lastMs: run[run.length - 1]!.scheduledMs,
            commits,
            split,
            open: j === seq.length - 1,
            fromStart: i === 0,
            class: split ? "flaky" : run.length >= 2 ? "regression" : "isolated",
          });
          i = j + 1;
        }
      }
    }
    episodes.sort((a, b) => a.firstMs - b.firstMs || a.job.localeCompare(b.job) || a.testId.localeCompare(b.testId));
    return episodes;
  }
}

/** Episodes of every test of every job among `builds` (any order; each job is read in build order). */
export function deriveEpisodes(builds: readonly ProwBuild[], opts: ProwEventOptions = {}): Episode[] {
  const builder = new EpisodeBuilder(opts);
  for (const b of [...builds].sort((a, b) => a.scheduledMs - b.scheduledMs)) builder.add(b);
  return builder.finish();
}

/** `${buildId}\u0000${testId}` → the class of the episode that failure belongs to. */
export function failureClassIndex(episodes: readonly Episode[]): Map<string, Episode> {
  const out = new Map<string, Episode>();
  for (const ep of episodes) for (const id of ep.buildIds) out.set(`${id}\u0000${ep.testId}`, ep);
  return out;
}

export const failureKey = (buildId: string, testId: string): string => `${buildId}\u0000${testId}`;
