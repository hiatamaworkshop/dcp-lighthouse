/**
 * Treeherder `autoland` → the lighthouse's stream, and its ground truth
 * (ROADMAP C29; amendments (a)–(c) of 2026-11-27).
 *
 * THE RULES, fixed on 2026-11-27 before any job of the C29 range
 * (2026-11-07…11-22) was read. What had been read by then: the C25 sample
 * (2026-11-24…25, outside the range) — its totals, classification counts and
 * fixed-by-commit clusters (ROADMAP_BRIEF.md 2026-11-27).
 *
 *   event       One tier-1 job whose state is "completed" and whose result is
 *               success (→ pass), testfailed or busted (→ fail). Every other
 *               result (retry, exception, usercancel, unknown, superseded …) is
 *               NOT an event and is counted: an automatic retry or an
 *               infrastructure exception says nothing about the code.
 *                 ts         the job's end (when its result became known)
 *                 testId     the job type (`job_type_name`: platform, build
 *                            type, suite and chunk) — amendment (a)
 *                 agentId    the platform's OS family: linux · windows ·
 *                            macos · android · other — the replay's group key,
 *                            amendment (c). Few groups on purpose: C28 found
 *                            that splitting by key thins every family's
 *                            reference, and the three Prow jobs were three.
 *                 area       the job group symbol (M, W, R, X, …)
 *                 commitHash the push's revision
 *
 *   persistence C21's detector unchanged, with a job type as the "job" and
 *               the job's one result as its one case (amendment (b)): a job
 *               type is announced when two of its consecutive completed runs
 *               fail and neither run's push has a pass of that job type. Runs
 *               are read in the order their results became known (end time),
 *               which is what a running process would see; a backfill of an
 *               older push is just a later run.
 *
 *   truth       A failed event's class is its failure classification:
 *                 regression    "fixed by commit" (2)
 *                 intermittent  intermittent (4), autoclassified (7), needs bugid (8)
 *                 infra (5) · expected fail (3) · unclassified (1, 6)
 *               A REGRESSION INCIDENT is the set of regression events whose
 *               note names the same fixing revision; events whose note names
 *               none form one incident per push ("unnamed"). An incident
 *               starts at the end of its first failing job (the first moment
 *               anything could have seen it) and is fixed when the push whose
 *               revision is the fixing revision landed, if that push is read.
 *
 * Counts only; nothing here decides.
 */

import type { LensEvent } from "./lens.js";
import type { ProwBuild } from "./prow-import.js";
import { FIXED_BY_COMMIT, type THJob, type THPush } from "./treeherder-import.js";

export type OsFamily = "linux" | "windows" | "macos" | "android" | "other";
export const OS_FAMILIES: readonly OsFamily[] = ["linux", "windows", "macos", "android", "other"];

export function osFamily(platform: string): OsFamily {
  const p = platform.toLowerCase();
  if (p.startsWith("android")) return "android";
  if (p.startsWith("linux") || p.startsWith("ubuntu")) return "linux";
  if (p.startsWith("win")) return "windows";
  if (p.startsWith("macos") || p.startsWith("osx")) return "macos";
  return "other";
}

export type THClass = "regression" | "intermittent" | "infra" | "expected" | "unclassified";
export const TH_CLASSES: readonly THClass[] = ["regression", "intermittent", "infra", "expected", "unclassified"];

export function classOf(failureClassificationId: number): THClass {
  switch (failureClassificationId) {
    case FIXED_BY_COMMIT:
      return "regression";
    case 4:
    case 7:
    case 8:
      return "intermittent";
    case 5:
      return "infra";
    case 3:
      return "expected";
    default:
      return "unclassified";
  }
}

export interface THEvent {
  ts: number;
  jobId: number;
  pushId: number;
  /** Push time, ms. */
  pushMs: number;
  testId: string;
  agentId: OsFamily;
  area: string;
  commitHash: string;
  fail: boolean;
  /** For a failed event: its class; for a pass: undefined. */
  cls?: THClass;
  /** The incident key of a regression event. */
  incident?: string;
}

/** What a job is: an event, or the reason it is not. */
export function jobOutcome(j: THJob): "pass" | "fail" | string {
  if (j.tier !== 1) return "not tier 1";
  if (j.state !== "completed") return `state ${j.state}`;
  if (j.result === "success") return "pass";
  if (j.result === "testfailed" || j.result === "busted") return "fail";
  return j.result || "no result";
}

export interface THStream {
  /** End-time order. */
  events: THEvent[];
  /** Jobs that are not events, by reason. */
  excluded: Map<string, number>;
}

export function incidentKey(j: THJob, pushId: number): string {
  return j.fixedBy !== undefined && j.fixedBy !== "" ? j.fixedBy : `unnamed@push${pushId}`;
}

export function pushesToStream(pushes: readonly THPush[]): THStream {
  const events: THEvent[] = [];
  const excluded = new Map<string, number>();
  for (const p of pushes) {
    for (const j of p.jobs) {
      const o = jobOutcome(j);
      if (o !== "pass" && o !== "fail") {
        excluded.set(o, (excluded.get(o) ?? 0) + 1);
        continue;
      }
      const fail = o === "fail";
      const e: THEvent = {
        ts: j.end_timestamp * 1000,
        jobId: j.id,
        pushId: p.id,
        pushMs: p.push_timestamp * 1000,
        testId: j.job_type_name,
        agentId: osFamily(j.platform),
        area: j.job_group_symbol,
        commitHash: p.revision,
        fail,
      };
      if (fail) {
        e.cls = classOf(j.failure_classification_id);
        if (e.cls === "regression") e.incident = incidentKey(j, p.id);
      }
      events.push(e);
    }
  }
  events.sort((a, b) => a.ts - b.ts || a.jobId - b.jobId);
  return { events, excluded };
}

/** The lens's view: pass 1 / fail 0, groupable by OS family (`agentId`) and job group (`area`). */
export function thLensEvent(e: THEvent): LensEvent {
  return { ts: e.ts, value: e.fail ? 0 : 1, keys: { agentId: e.agentId, area: e.area } };
}

/**
 * One event as a one-case "build" of its job type, for C21's PersistenceDetector
 * (prow-persist.ts) unchanged. Scheduled = finished = the job's end, so the
 * detector reads each job type's runs in the order their results became known.
 */
export function eventAsBuild(e: THEvent): ProwBuild {
  return {
    job: e.testId,
    id: String(e.jobId),
    scheduledMs: e.ts,
    finishedMs: e.ts,
    result: e.fail ? "FAILURE" : "SUCCESS",
    commit: e.commitHash,
    files: [{ file: "job", suites: [{ name: "", cases: [{ name: "", classname: e.testId, time: 0, status: e.fail ? "failed" : "passed" }] }] }],
  };
}

export interface Incident {
  key: string;
  /** Regression events, end-time order. */
  events: THEvent[];
  /** End of the first failing job. */
  startMs: number;
  /** Earliest push among its failing jobs. */
  firstPushMs: number;
  families: OsFamily[];
  jobTypes: number;
  /** When the fixing push landed, if it is among the pushes read. */
  fixedMs?: number;
}

export function incidentsOf(events: readonly THEvent[], pushes: readonly THPush[]): Incident[] {
  const byRev = new Map<string, number>();
  for (const p of pushes) byRev.set(p.revision.toLowerCase(), p.push_timestamp * 1000);
  const groups = new Map<string, THEvent[]>();
  for (const e of events) {
    if (e.incident === undefined) continue;
    let g = groups.get(e.incident);
    if (g === undefined) groups.set(e.incident, (g = []));
    g.push(e);
  }
  const out: Incident[] = [];
  for (const [key, evs] of groups) {
    // A note may name an abbreviated revision: match it as a prefix of a read push's revision.
    let fixedMs: number | undefined = byRev.get(key);
    if (fixedMs === undefined && !key.startsWith("unnamed@")) {
      for (const [rev, ms] of byRev) if (rev.startsWith(key)) { fixedMs = ms; break; }
    }
    out.push({
      key,
      events: evs,
      startMs: evs[0]!.ts,
      firstPushMs: Math.min(...evs.map((e) => e.pushMs)),
      families: [...new Set(evs.map((e) => e.agentId))].sort() as OsFamily[],
      jobTypes: new Set(evs.map((e) => e.testId)).size,
      ...(fixedMs !== undefined ? { fixedMs } : {}),
    });
  }
  out.sort((a, b) => a.startMs - b.startMs || a.key.localeCompare(b.key));
  return out;
}

/** Pushes that landed in (fromMs, toMs]: how much code piled on before something was known. */
export function pushesBetween(pushMsSorted: Float64Array, fromMs: number, toMs: number): number {
  const ub = (x: number): number => {
    let lo = 0;
    let hi = pushMsSorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (pushMsSorted[mid]! <= x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return Math.max(0, ub(toMs) - ub(fromMs));
}
