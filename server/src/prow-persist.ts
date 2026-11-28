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
 *
 * FLAKY HISTORY (ROADMAP C35, opt-in; without it every announcement is byte
 * for byte what it was). With `{ runs: N }` each announcement carries
 * `history`: the test's outcomes in the last ≤ N builds that had it BEFORE the
 * run's first failing build — how often it failed while nothing was being
 * announced. It annotates; it never withholds an announcement (a test that
 * fails often can still break for real), and a history shorter than N is
 * stated as such (`runs` < N), not read as a quiet one.
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
  /** Only with the `flakyHistory` option (C35): outcomes of the ≤ N builds before the run's first failing build. */
  history?: FlakyHistory;
}

export interface FlakyHistory {
  /** Builds read (< the option's N when the test has not been seen N times yet). */
  runs: number;
  /** Of those, builds where the test failed. */
  fails: number;
}

export interface FlakyHistoryOptions {
  /** How many of the test's most recent builds to remember. */
  runs: number;
}

/**
 * Default cap on remembered passing commits per (job, testId). Persistence only
 * ever checks the current and previous build's commit, so bounding `passedOn`
 * keeps memory O(1) per test in a long-running server without affecting any
 * realistic rerun window.
 */
export const DEFAULT_MAX_PASSED_COMMITS = 256;

/**
 * C35's reading of a history, chosen on Treeherder autoland's spent C29 range
 * and confirmed on 2026-10-24…11-06 (ROADMAP_BRIEF.md 2026-11-27 (3)). Not
 * measured on any other stream: a reader that shows the tag elsewhere says so.
 */
export const C35_FLAKY_HISTORY = { runs: 10, quietMax: 0.1 } as const;

export type FlakyTag = "quiet" | "flaky" | "short";

/** quiet = a full history (`runs` builds) failing in ≤ `quietMax` of them · flaky = more · short = fewer than `runs` seen. */
export function flakyTag(h: FlakyHistory | undefined, runs: number, quietMax: number): FlakyTag {
  if (h === undefined || h.runs < runs) return "short";
  return h.fails / h.runs <= quietMax ? "quiet" : "flaky";
}

/** What a live reader is told about the history it is shown (ROADMAP C36). */
export interface FlakyHistoryDescription {
  runs: number;
  quietMax: number;
  /** Where these values were chosen and confirmed, and whether this stream was measured. */
  basis: string;
}

export function describeFlakyHistory(runs: number, stream: string): FlakyHistoryDescription {
  const same = runs === C35_FLAKY_HISTORY.runs;
  return {
    runs,
    quietMax: C35_FLAKY_HISTORY.quietMax,
    basis:
      `C35 chose and confirmed N=${C35_FLAKY_HISTORY.runs}, F=${C35_FLAKY_HISTORY.quietMax * 100}% on Treeherder autoland; ` +
      `not measured on ${stream}${same ? "" : `, and N=${runs} was not measured anywhere`}. The tag annotates; no announcement is withheld.`,
  };
}

/**
 * A `PersistenceDetector`'s whole state as plain JSON (ROADMAP C38): what an ingest log folds its old
 * builds into, so a restart reads on exactly as if every build had been fed again. Commits are
 * interned (`commits[i]`), since `passedOn` repeats them across every test of a job.
 */
export interface PersistenceDetectorState {
  /** The options the state was built under; a detector with others refuses it. */
  flakyHistoryRuns: number | null;
  maxPassedCommits: number;
  commits: string[];
  jobs: Array<{ job: string; lastMs: number; tests: Array<[string, TestStateJson]> }>;
}

interface TestStateJson {
  last?: { fail: boolean; buildId: string; scheduledMs: number; commit: number | null; mixed: boolean };
  passedOn: number[];
  runStart?: { buildId: string; scheduledMs: number; history?: FlakyHistory };
  recent?: boolean[];
}

interface TestState {
  /** Outcome of the last build that had this test. */
  last?: { fail: boolean; buildId: string; scheduledMs: number; commit: string | undefined; mixed: boolean };
  /** Commits on which some build passed the test outright. */
  passedOn: Set<string>;
  /** The run's first failing build, while a run is on. */
  runStart?: { buildId: string; scheduledMs: number; history?: FlakyHistory };
  /** With flakyHistory: the last ≤ N outcomes (true = fail), oldest first. */
  recent?: boolean[];
}

export class PersistenceDetector {
  private readonly perJob = new Map<string, { lastMs: number; tests: Map<string, TestState> }>();
  private readonly maxPassedCommits: number;

  constructor(
    private readonly opts: ProwEventOptions = {},
    private readonly flakyHistory?: FlakyHistoryOptions,
    maxPassedCommits: number = DEFAULT_MAX_PASSED_COMMITS,
  ) {
    if (flakyHistory !== undefined && !(Number.isInteger(flakyHistory.runs) && flakyHistory.runs >= 1)) {
      throw new RangeError(`PersistenceDetector: flakyHistory.runs must be a positive integer, got ${flakyHistory.runs}`);
    }
    if (!(Number.isInteger(maxPassedCommits) && maxPassedCommits >= 1)) {
      throw new RangeError(`PersistenceDetector: maxPassedCommits must be a positive integer, got ${maxPassedCommits}`);
    }
    this.maxPassedCommits = maxPassedCommits;
  }

  /**
   * Throws the RangeError `add` would throw for a build out of its job's time order, without
   * touching any state — so a caller can refuse it before writing it anywhere (ROADMAP C37).
   */
  checkOrder(b: ProwBuild): void {
    const lastMs = this.perJob.get(b.job)?.lastMs ?? -Infinity;
    if (b.scheduledMs < lastMs) throw new RangeError(`PersistenceDetector: ${b.job} build ${b.id} arrived out of time order`);
  }

  /** Feeds one build (each job's builds in time order) and returns what it announces. */
  add(b: ProwBuild): Announcement[] {
    this.checkOrder(b);
    let job = this.perJob.get(b.job);
    if (job === undefined) this.perJob.set(b.job, (job = { lastMs: -Infinity, tests: new Map() }));
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
        if (b.commit !== undefined) {
          st.passedOn.delete(b.commit);
          st.passedOn.add(b.commit);
          while (st.passedOn.size > this.maxPassedCommits) {
            const oldest = st.passedOn.values().next().value;
            if (oldest === undefined) break;
            st.passedOn.delete(oldest);
          }
        }
        delete st.runStart;
      } else {
        const prev = st.last;
        if (prev !== undefined && prev.fail && st.runStart !== undefined && prev.buildId === st.runStart.buildId) {
          // B is the 2nd build of the run.
          const split = mixed || prev.mixed || (b.commit !== undefined && st.passedOn.has(b.commit)) || (prev.commit !== undefined && st.passedOn.has(prev.commit));
          if (!split) {
            const a: Announcement = { job: b.job, testId, buildId: b.id, firstBuildId: st.runStart.buildId, atMs: b.finishedMs, firstMs: st.runStart.scheduledMs };
            if (st.runStart.history !== undefined) a.history = st.runStart.history;
            out.push(a);
          }
        } else if (prev === undefined || !prev.fail) {
          st.runStart = { buildId: b.id, scheduledMs: b.scheduledMs };
          if (this.flakyHistory !== undefined) {
            const r = st.recent ?? [];
            st.runStart.history = { runs: r.length, fails: r.filter((x) => x).length };
          }
        }
      }
      if (this.flakyHistory !== undefined) {
        const r = (st.recent ??= []);
        r.push(fail);
        if (r.length > this.flakyHistory.runs) r.shift();
      }
      st.last = { fail, buildId: b.id, scheduledMs: b.scheduledMs, commit: b.commit, mixed };
    }
    return out;
  }

  /** The state as plain JSON, for `importState` on a fresh detector (ROADMAP C38). */
  exportState(): PersistenceDetectorState {
    const commits: string[] = [];
    const index = new Map<string, number>();
    const intern = (c: string): number => {
      let i = index.get(c);
      if (i === undefined) {
        index.set(c, (i = commits.length));
        commits.push(c);
      }
      return i;
    };
    const jobs: PersistenceDetectorState["jobs"] = [];
    for (const [job, j] of this.perJob) {
      const tests: Array<[string, TestStateJson]> = [];
      for (const [testId, st] of j.tests) {
        const t: TestStateJson = { passedOn: [...st.passedOn].map(intern) };
        if (st.last !== undefined) t.last = { ...st.last, commit: st.last.commit === undefined ? null : intern(st.last.commit) };
        if (st.runStart !== undefined) t.runStart = { ...st.runStart, ...(st.runStart.history !== undefined ? { history: { ...st.runStart.history } } : {}) };
        if (st.recent !== undefined) t.recent = [...st.recent];
        tests.push([testId, t]);
      }
      jobs.push({ job, lastMs: j.lastMs, tests });
    }
    return { flakyHistoryRuns: this.flakyHistory?.runs ?? null, maxPassedCommits: this.maxPassedCommits, commits, jobs };
  }

  /**
   * Loads what `exportState` wrote into this detector, which must not have seen a build yet. A state
   * made under other options is refused: reading it on would give histories of the wrong length.
   */
  importState(raw: unknown): void {
    if (this.perJob.size > 0) throw new Error("PersistenceDetector.importState: the detector has already seen builds");
    const bad = (why: string): never => {
      throw new Error(`persistence state: ${why}`);
    };
    const s = raw as PersistenceDetectorState;
    if (typeof s !== "object" || s === null || !Array.isArray(s.commits) || !Array.isArray(s.jobs)) bad("not a detector state");
    const runs = this.flakyHistory?.runs ?? null;
    if (s.flakyHistoryRuns !== runs || s.maxPassedCommits !== this.maxPassedCommits) {
      bad(
        `made with flaky history ${s.flakyHistoryRuns ?? "off"} and ${s.maxPassedCommits} remembered commits, ` +
          `this detector has ${runs ?? "off"} and ${this.maxPassedCommits} (LIGHTHOUSE_PERSIST_HISTORY must match the boot that wrote it)`,
      );
    }
    const commit = (i: unknown): string => {
      if (!Number.isInteger(i) || (i as number) < 0 || (i as number) >= s.commits.length) bad(`commit index ${String(i)}`);
      return s.commits[i as number]!;
    };
    const restored = new Map<string, { lastMs: number; tests: Map<string, TestState> }>();
    for (const j of s.jobs) {
      if (typeof j?.job !== "string" || typeof j.lastMs !== "number" || !Array.isArray(j.tests)) bad("job entry");
      const tests = new Map<string, TestState>();
      for (const entry of j.tests) {
        if (!Array.isArray(entry) || typeof entry[0] !== "string" || typeof entry[1] !== "object" || entry[1] === null) bad(`test entry in ${j.job}`);
        const [testId, t] = entry;
        if (!Array.isArray(t.passedOn)) bad(`passedOn of ${testId}`);
        const st: TestState = { passedOn: new Set(t.passedOn.map(commit)) };
        if (t.last !== undefined) {
          if (typeof t.last.buildId !== "string" || typeof t.last.scheduledMs !== "number") bad(`last of ${testId}`);
          st.last = { fail: t.last.fail === true, buildId: t.last.buildId, scheduledMs: t.last.scheduledMs, commit: t.last.commit === null ? undefined : commit(t.last.commit), mixed: t.last.mixed === true };
        }
        if (t.runStart !== undefined) {
          if (typeof t.runStart.buildId !== "string" || typeof t.runStart.scheduledMs !== "number") bad(`runStart of ${testId}`);
          st.runStart = { buildId: t.runStart.buildId, scheduledMs: t.runStart.scheduledMs };
          if (t.runStart.history !== undefined) st.runStart.history = { runs: t.runStart.history.runs, fails: t.runStart.history.fails };
        }
        if (t.recent !== undefined) {
          if (!Array.isArray(t.recent) || t.recent.some((x) => typeof x !== "boolean")) bad(`recent of ${testId}`);
          st.recent = [...t.recent];
        }
        tests.set(testId, st);
      }
      restored.set(j.job, { lastMs: j.lastMs, tests });
    }
    for (const [k, v] of restored) this.perJob.set(k, v);
  }
}

/** Announcements over `builds` (any order; each job is read in time order). */
export function detectPersistence(builds: readonly ProwBuild[], opts: ProwEventOptions = {}, flakyHistory?: FlakyHistoryOptions): Announcement[] {
  const d = new PersistenceDetector(opts, flakyHistory);
  const out: Announcement[] = [];
  for (const b of [...builds].sort((a, b) => a.scheduledMs - b.scheduledMs)) out.push(...d.add(b));
  return out;
}
