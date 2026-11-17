/**
 * Per-test persistence, run along the stream (ROADMAP C21;
 * ROADMAP_BRIEF.md 2026-11-17 (7), (8)).
 *
 * C20 found that a regression of ONE test is invisible to a window's pass rate
 * on an hourly job: the window holds one failure, the size of every flaky one.
 * What does tell them apart is C13's rule — the same test failing in
 * consecutive builds, and never passing on that code — which C13 applied to
 * the whole record after the fact. Here the rule is applied the way a running
 * process could: build by build, knowing only what has been seen.
 *
 * THE RULE, fixed on 2026-11-17 before the detector was run on any data.
 *
 *   outcome   As in prow-truth.ts: for one job, a test's outcome in a build is
 *             "fail" if any of its cases failed, "pass" if it has cases and
 *             none failed, absent if it has none (skipped, not run). Absent
 *             builds are stepped over.
 *
 *   announce  At a build B where test T fails, announce T as PERSISTENT when
 *             all of these hold at that moment:
 *               1. T's previous outcome in the job (the last build that had
 *                  it) was "fail" — B is the 2nd build of a failing run;
 *               2. no build of the job so far has passed T on the commit of B
 *                  or on the commit of the previous build;
 *               3. in neither of the two builds did another case of T pass.
 *             Builds without a stated commit cannot show a pass by commit.
 *             Each run announces at most once, at its 2nd build, and only
 *             there: a later pass on the same code (which C13 would read as
 *             "flaky") is the future, and is exactly what this rule cannot
 *             know — that is the price being measured.
 *
 *   when      The announcement is known when B finishes: `finishedMs`.
 *
 * It is C13's "regression" with the future removed, so everything C13 calls
 * regression is announced (a pass on the same code later would make it flaky,
 * and C13 reads the whole record), and what it announces beyond that is the
 * flaky length-2 episodes whose same-commit pass had not yet happened.
 */

import { buildToEvents, type ProwEventOptions } from "./prow-events.js";
import type { ProwBuild } from "./prow-import.js";

export interface Announcement {
  job: string;
  testId: string;
  /** The build that triggered it: the 2nd failing build of the run. */
  buildId: string;
  /** The first failing build of the run. */
  firstBuildId: string;
  /** When it is known: the triggering build's finish. */
  atMs: number;
  /** Scheduling instant of the first failing build. */
  firstMs: number;
}

interface TestState {
  /** Outcome of the last build that had this test. */
  last?: { fail: boolean; buildId: string; scheduledMs: number; commit: string | undefined; mixed: boolean };
  /** Commits on which some build passed the test outright. */
  passedOn: Set<string>;
  /** The run's first failing build, while a run is on. */
  runStart?: { buildId: string; scheduledMs: number };
}

export class PersistenceDetector {
  private readonly perJob = new Map<string, { lastMs: number; tests: Map<string, TestState> }>();

  constructor(private readonly opts: ProwEventOptions = {}) {}

  /** Feeds one build (each job's builds in time order) and returns what it announces. */
  add(b: ProwBuild): Announcement[] {
    let job = this.perJob.get(b.job);
    if (job === undefined) this.perJob.set(b.job, (job = { lastMs: -Infinity, tests: new Map() }));
    if (b.scheduledMs < job.lastMs) throw new RangeError(`PersistenceDetector: ${b.job} build ${b.id} arrived out of time order`);
    job.lastMs = b.scheduledMs;
    const inBuild = new Map<string, { pass: number; fail: number }>();
    for (const e of buildToEvents(b, this.opts).events) {
      let c = inBuild.get(e.testId);
      if (c === undefined) inBuild.set(e.testId, (c = { pass: 0, fail: 0 }));
      if (e.result === "fail") c.fail++;
      else c.pass++;
    }
    const out: Announcement[] = [];
    for (const [testId, c] of inBuild) {
      let st = job.tests.get(testId);
      if (st === undefined) job.tests.set(testId, (st = { passedOn: new Set() }));
      const fail = c.fail > 0;
      const mixed = fail && c.pass > 0;
      if (!fail) {
        if (b.commit !== undefined) st.passedOn.add(b.commit);
        delete st.runStart;
      } else {
        const prev = st.last;
        if (prev !== undefined && prev.fail && st.runStart !== undefined && prev.buildId === st.runStart.buildId) {
          // B is the 2nd build of the run.
          const split = mixed || prev.mixed || (b.commit !== undefined && st.passedOn.has(b.commit)) || (prev.commit !== undefined && st.passedOn.has(prev.commit));
          if (!split) {
            out.push({ job: b.job, testId, buildId: b.id, firstBuildId: st.runStart.buildId, atMs: b.finishedMs, firstMs: st.runStart.scheduledMs });
          }
        } else if (prev === undefined || !prev.fail) {
          st.runStart = { buildId: b.id, scheduledMs: b.scheduledMs };
        }
      }
      st.last = { fail, buildId: b.id, scheduledMs: b.scheduledMs, commit: b.commit, mixed };
    }
    return out;
  }
}

/** Announcements over `builds` (any order; each job is read in time order). */
export function detectPersistence(builds: readonly ProwBuild[], opts: ProwEventOptions = {}): Announcement[] {
  const d = new PersistenceDetector(opts);
  const out: Announcement[] = [];
  for (const b of [...builds].sort((a, b) => a.scheduledMs - b.scheduledMs)) out.push(...d.add(b));
  return out;
}
