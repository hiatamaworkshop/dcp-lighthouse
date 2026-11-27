/**
 * Importer for Mozilla Treeherder's `autoland` (ROADMAP C29; the choice and its
 * limits are ROADMAP_BRIEF.md 2026-11-27).
 *
 * autoland is one integration branch: pushes land in order, a sheriff backs out
 * the ones that break something, and every failed job is classified by a
 * person (or the auto-classifier). A failure classified "fixed by commit"
 * carries a note naming the revision that fixed it — usually the backout. That
 * revision is what makes a regression an identifiable incident here.
 *
 * Rules carried over from the Prow importer (prow-import.ts):
 *
 *   - WHAT COULD NOT BE FETCHED IS BLIND, NOT QUIET. A day is readable only
 *     once its line is in `days.jsonl`, and that line names every push that
 *     was listed but whose jobs could not be read.
 *   - STORE WHAT WAS PUBLISHED, DECIDE THE MAPPING LATER. A push keeps its jobs'
 *     own fields; what becomes an event is treeherder-stream.ts's decision.
 *
 * Specific to this source:
 *
 *   - PERSONAL DATA IS DROPPED BEFORE ANYTHING IS WRITTEN. A push's and a
 *     revision's `author`, a job's and a note's `who` (all e-mail addresses)
 *     and commit messages are never stored. A push keeps only whether one of
 *     its commits is a backout.
 *   - A DAY IS IMPORTED ONLY ONCE ITS CLASSIFICATIONS HAVE SETTLED. Sheriffs
 *     classify over days (2026-11-27: a tenth of the failures of a push two days
 *     old were still unclassified), and an unclassified failure has no truth.
 *   - ONLY TIER 1 IS KEPT. Tier 2/3 jobs are not sheriffed the same way
 *     (C29 amendment (d), 2026-11-27).
 *
 * The requests carry a generic client name only.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { daysBetween, type FetchLike } from "./prow-import.js";

export const TREEHERDER_API = "https://treeherder.mozilla.org/api";
export const TREEHERDER_PROJECT = "autoland";
export const TREEHERDER_USER_AGENT = "ci-data-survey/0.1";
export const TREEHERDER_DAYS_FILE = "days.jsonl";
/** Days after a UTC day ends before it is imported: the sheriffs' classifications must have settled. */
export const TREEHERDER_SETTLE_MS = 3 * 86_400_000;
/** The push list refuses `count` above 1000 (HTTP 400 for 2000, 2026-11-27). */
export const PUSH_LIST_CAP = 1000;
const JOB_PAGE = 2000;
const DAY_MS = 86_400_000;

export const FAILURE_CLASSIFICATIONS: Readonly<Record<number, string>> = {
  1: "not classified",
  2: "fixed by commit",
  3: "expected fail",
  4: "intermittent",
  5: "infra",
  6: "new failure not classified",
  7: "autoclassified intermittent",
  8: "intermittent needs bugid",
};
export const FIXED_BY_COMMIT = 2;

/**
 * A commit message that backs something out. Since the move to git, sheriffs
 * write `Revert "Bug …" for causing …` (2026-11-27: 13 of 331 revisions of
 * the latest 200 pushes; none read "Backed out"). Both spellings are accepted.
 */
export const BACKOUT_MESSAGE = /^\s*(backed out|back out|backout|revert\b)/i;

export interface THJob {
  id: number;
  job_type_name: string;
  job_group_symbol: string;
  platform: string;
  platform_option: string;
  tier: number;
  result: string;
  state: string;
  failure_classification_id: number;
  /** Seconds since the epoch, as Treeherder states them. */
  submit_timestamp: number;
  start_timestamp: number;
  end_timestamp: number;
  /** For a "fixed by commit" job: the revision its classification note names, or "" when the note names none. */
  fixedBy?: string;
}

export interface THPush {
  id: number;
  revision: string;
  /** Seconds since the epoch. */
  push_timestamp: number;
  revision_count: number;
  backout: boolean;
  /** Tier-1 jobs only. */
  jobs: THJob[];
}

export interface MissingPush {
  id: number;
  push_timestamp: number;
  reason: string;
}

export interface THDayEntry {
  day: string;
  pushes: number;
  jobs: number;
  missing: MissingPush[];
  importedAt: string;
}

/** The kept fields of a job as the API returns it: no `who`, no machine. */
export function jobRow(raw: Record<string, unknown>): THJob {
  const n = (k: string): number => (typeof raw[k] === "number" ? (raw[k] as number) : 0);
  const s = (k: string): string => (typeof raw[k] === "string" ? (raw[k] as string) : "");
  return {
    id: n("id"),
    job_type_name: s("job_type_name"),
    job_group_symbol: s("job_group_symbol"),
    platform: s("platform"),
    platform_option: s("platform_option"),
    tier: n("tier"),
    result: s("result"),
    state: s("state"),
    failure_classification_id: n("failure_classification_id"),
    submit_timestamp: n("submit_timestamp"),
    start_timestamp: n("start_timestamp"),
    end_timestamp: n("end_timestamp"),
  };
}

/** A push as listed, reduced to what is kept (the jobs are added later). */
export function pushRow(raw: { id: number; revision: string; push_timestamp: number; revision_count: number; revisions?: Array<{ comments?: string }> }): Omit<THPush, "jobs"> {
  return {
    id: raw.id,
    revision: raw.revision,
    push_timestamp: raw.push_timestamp,
    revision_count: raw.revision_count,
    backout: (raw.revisions ?? []).some((r) => BACKOUT_MESSAGE.test(r.comments ?? "")),
  };
}

/**
 * The fixing revision a job's notes name: the text of the latest
 * "fixed by commit" note, when it is a revision (12–40 hex). "" otherwise.
 */
export function fixedByOfNotes(notes: ReadonlyArray<{ id?: number; failure_classification_id?: number; text?: string }>): string {
  const fbc = notes.filter((n) => n.failure_classification_id === FIXED_BY_COMMIT).sort((a, b) => (b.id ?? 0) - (a.id ?? 0));
  for (const n of fbc) {
    const t = (n.text ?? "").trim();
    const m = /^([0-9a-f]{12,40})\b/i.exec(t) ?? /\/rev\/([0-9a-f]{12,40})/i.exec(t) ?? /\/commit\/([0-9a-f]{12,40})/i.exec(t);
    if (m) return m[1]!.toLowerCase();
  }
  return "";
}

export function treeherderDayRefusal(day: string, nowMs: number): string | undefined {
  const start = Date.parse(`${day}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(start)) return `refusing: "${day}" is not a UTC day (YYYY-MM-DD)`;
  if (nowMs < start + DAY_MS + TREEHERDER_SETTLE_MS) {
    return `refusing: ${day} is not settled yet — its failures may still be unclassified (wait until ${new Date(start + DAY_MS + TREEHERDER_SETTLE_MS).toISOString()})`;
  }
  return undefined;
}

export interface TreeherderImporterOptions {
  dir: string;
  fetch?: FetchLike;
  now?: () => number;
  api?: string;
  project?: string;
  concurrency?: number;
  retries?: number;
  /** Wait between retries, ms (doubled each time). */
  backoffMs?: number;
}

const dayFile = (dir: string, day: string): string => join(dir, `${day}.jsonl.gz`);

export class TreeherderImporter {
  private readonly dir: string;
  private readonly fetchFn: FetchLike;
  private readonly now: () => number;
  private readonly api: string;
  private readonly project: string;
  private readonly concurrency: number;
  private readonly retries: number;
  private readonly backoffMs: number;

  constructor(opts: TreeherderImporterOptions) {
    this.dir = opts.dir;
    this.fetchFn = opts.fetch ?? ((url, init) => fetch(url, init));
    this.now = opts.now ?? Date.now;
    this.api = opts.api ?? TREEHERDER_API;
    this.project = opts.project ?? TREEHERDER_PROJECT;
    this.concurrency = opts.concurrency ?? 4;
    this.retries = opts.retries ?? 3;
    this.backoffMs = opts.backoffMs ?? 1000;
  }

  private async get<T>(path: string): Promise<T> {
    let last = "";
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const r = await this.fetchFn(this.api + path, { headers: { "User-Agent": TREEHERDER_USER_AGENT } });
        if (r.ok) return JSON.parse(await r.text()) as T;
        last = `HTTP ${r.status}`;
        if (r.status === 400 || r.status === 404) break;
      } catch (e) {
        last = e instanceof Error ? e.message : String(e);
      }
      if (attempt < this.retries) await new Promise((res) => setTimeout(res, this.backoffMs * 2 ** attempt));
    }
    throw new Error(`${path}: ${last}`);
  }

  private async readPush(p: Omit<THPush, "jobs">): Promise<THPush | MissingPush> {
    try {
      const jobs: THJob[] = [];
      for (let off = 0; ; off += JOB_PAGE) {
        const page = await this.get<{ results: Array<Record<string, unknown>> }>(`/project/${this.project}/jobs/?push_id=${p.id}&count=${JOB_PAGE}&offset=${off}`);
        for (const raw of page.results) if (raw.tier === 1) jobs.push(jobRow(raw));
        if (page.results.length < JOB_PAGE) break;
      }
      for (const j of jobs) {
        if (j.failure_classification_id !== FIXED_BY_COMMIT) continue;
        const notes = await this.get<Array<{ id?: number; failure_classification_id?: number; text?: string }>>(`/project/${this.project}/note/?job_id=${j.id}`);
        j.fixedBy = fixedByOfNotes(notes);
      }
      jobs.sort((a, b) => a.id - b.id);
      return { ...p, jobs };
    } catch (e) {
      return { id: p.id, push_timestamp: p.push_timestamp, reason: `fetch failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  /** Imports one UTC day (pushes filed by their push time). A day already in days.jsonl is left alone unless `force`. */
  async importDay(day: string, force = false): Promise<THDayEntry & { skipped?: true }> {
    const refusal = treeherderDayRefusal(day, this.now());
    if (refusal !== undefined) throw new Error(refusal);
    const existing = readTreeherderDays(this.dir).get(day);
    if (existing !== undefined && !force) return { ...existing, skipped: true };
    const from = Date.parse(`${day}T00:00:00Z`) / 1000;
    const listed = await this.get<{ results: Parameters<typeof pushRow>[0][] }>(
      `/project/${this.project}/push/?count=${PUSH_LIST_CAP}&push_timestamp__gte=${from}&push_timestamp__lt=${from + DAY_MS / 1000}`,
    );
    if (listed.results.length >= PUSH_LIST_CAP) throw new Error(`refusing: ${day} lists ${listed.results.length} pushes, the list's cap — the day may be truncated`);
    const pushes = listed.results.map(pushRow).sort((a, b) => a.push_timestamp - b.push_timestamp || a.id - b.id);
    const results: Array<THPush | MissingPush> = new Array(pushes.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const i = next++;
        if (i >= pushes.length) return;
        results[i] = await this.readPush(pushes[i]!);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, Math.max(1, pushes.length)) }, worker));
    const read = results.filter((r): r is THPush => "jobs" in r);
    const missing = results.filter((r): r is MissingPush => !("jobs" in r));
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(dayFile(this.dir, day), gzipSync(read.map((p) => JSON.stringify(p)).join("\n") + (read.length > 0 ? "\n" : "")));
    const entry: THDayEntry = { day, pushes: read.length, jobs: read.reduce((s, p) => s + p.jobs.length, 0), missing, importedAt: new Date(this.now()).toISOString() };
    appendFileSync(join(this.dir, TREEHERDER_DAYS_FILE), JSON.stringify(entry) + "\n");
    return entry;
  }
}

/** days.jsonl as a map; a day imported twice reads as its last line. */
export function readTreeherderDays(dir: string): Map<string, THDayEntry> {
  const out = new Map<string, THDayEntry>();
  const path = join(dir, TREEHERDER_DAYS_FILE);
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    const e = JSON.parse(line) as THDayEntry;
    out.set(e.day, e);
  }
  return out;
}

export interface THRange {
  fromDay: string;
  toDay: string;
  /** Push order. */
  pushes: THPush[];
  /** Pushes listed in the range whose jobs could not be read: blind, not quiet. */
  missing: MissingPush[];
}

/** The stored pushes over whole UTC days. Refuses a range holding a day never imported. */
export function loadTreeherderRange(dir: string, fromDay: string, toDay: string): THRange {
  const days = readTreeherderDays(dir);
  const wanted = daysBetween(fromDay, toDay);
  const absent = wanted.filter((d) => !days.has(d));
  if (absent.length > 0) {
    throw new Error(`refusing: no import record for ${absent.length} day(s) in ${fromDay}…${toDay} (${absent.slice(0, 5).join(", ")}${absent.length > 5 ? ", …" : ""}) — an unimported day would read as a day without failures`);
  }
  const pushes: THPush[] = [];
  const missing: MissingPush[] = [];
  for (const day of wanted) {
    const entry = days.get(day)!;
    missing.push(...entry.missing);
    const path = dayFile(dir, day);
    if (!existsSync(path)) throw new Error(`refusing: ${day} is in ${TREEHERDER_DAYS_FILE} but its file is gone (${path})`);
    const lines = gunzipSync(readFileSync(path)).toString("utf8").split("\n").filter((l) => l !== "");
    if (lines.length !== entry.pushes) throw new Error(`refusing: ${day} holds ${lines.length} pushes but ${TREEHERDER_DAYS_FILE} says ${entry.pushes}`);
    for (const l of lines) pushes.push(JSON.parse(l) as THPush);
  }
  pushes.sort((a, b) => a.push_timestamp - b.push_timestamp || a.id - b.id);
  return { fromDay, toDay, pushes, missing };
}
