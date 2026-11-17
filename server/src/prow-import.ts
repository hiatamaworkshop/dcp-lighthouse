/**
 * Importer for public CI test results: Kubernetes Prow (ROADMAP C17,
 * ROADMAP_BRIEF.md 2026-11-17 (2)(3)).
 *
 * The first real stream from the lighthouse's own domain. Prow keeps every
 * build's artifacts in a public bucket for about 90 days; a build of a test
 * job carries junit files whose `testcase` elements are the test results.
 *
 * Two rules carried over from the Wikimedia period:
 *
 *   - WHAT COULD NOT BE FETCHED IS BLIND, NOT QUIET. A day is readable only
 *     once its line is in `days.jsonl`, and that line names every build that
 *     was listed but could not be read. A reader that skipped a missing day
 *     would see "no test ran", which in this stream is the ordinary state and
 *     so would never be noticed.
 *   - STORE WHAT WAS PUBLISHED, DECIDE THE MAPPING LATER. A stored build keeps
 *     the junit's own fields (suite timestamp, case name, time, status). How a
 *     case becomes a `test_result:v1` event — which instant it is stamped
 *     with, what an "area" is — is prow-events.ts's decision and can change
 *     without fetching again. The bucket's 90 days roll; the mapping must not
 *     be what decides whether a day can still be studied.
 *
 * Nothing about the user or this machine goes out: the requests carry a
 * generic client name only.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

export const PROW_BUCKET = "kubernetes-ci-logs";
export const PROW_USER_AGENT = "ci-data-survey/0.1";
/** The jobs the shape survey starts from (ROADMAP_BRIEF.md 2026-11-17 (3)). */
export const DEFAULT_PROW_JOBS = ["ci-kubernetes-unit", "ci-kubernetes-integration-master", "ci-kubernetes-e2e-gci-gce"];
export const PROW_DAYS_FILE = "days.jsonl";
/** A build may still be running (and its artifacts unwritten) this long after its day ended. */
export const PROW_SETTLE_MS = 12 * 3_600_000;

const DAY_MS = 86_400_000;

/** Prow build ids are snowflakes: the high bits are milliseconds since this epoch (checked against started.json, 2026-11-17). */
const SNOWFLAKE_EPOCH_MS = 1_288_834_974_657;

/** The instant a build was scheduled, read from its id. */
export function prowBuildTimeMs(id: string): number {
  return Number(BigInt(id) >> 22n) + SNOWFLAKE_EPOCH_MS;
}

export function utcDayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export type CaseStatus = "passed" | "failed" | "skipped";

export interface JunitCase {
  name: string;
  classname: string;
  /** Seconds, as the junit states it (0 when absent). */
  time: number;
  status: CaseStatus;
}

export interface JunitSuite {
  name: string;
  /** The suite's own timestamp in ms, when it states one. A testcase has none. */
  ts?: number;
  cases: JunitCase[];
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body] ?? whole;
  });
}

function attrs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/([\w.:-]+)\s*=\s*"([^"]*)"/g)) out[m[1]!] = decodeXml(m[2]!);
  return out;
}

/** A junit timestamp without a zone is read as UTC (the e2e suites write none). */
function parseJunitTime(s: string | undefined): number | undefined {
  if (s === undefined || s === "") return undefined;
  const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * The suites and cases of one junit file.
 *
 * A tag scan, not an XML parser: the files are machine-written and the only
 * free text (failure messages, captured output) is either escaped or CDATA,
 * which is cut out first so a log line that quotes a tag cannot open a case.
 * A case is failed if it holds a `failure` or `error`, skipped if it holds a
 * `skipped`, passed otherwise — failure wins over skipped.
 */
export function parseJunit(xml: string): JunitSuite[] {
  const text = xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "").replace(/<!--[\s\S]*?-->/g, "");
  const suites: JunitSuite[] = [];
  let suite: JunitSuite | undefined;
  let current: JunitCase | undefined;
  const tag = /<(\/?)(testsuite|testcase|failure|error|skipped)\b([^>]*?)(\/?)>/g;
  for (const m of text.matchAll(tag)) {
    const closing = m[1] === "/";
    const name = m[2]!;
    const selfClosed = m[4] === "/";
    if (name === "testsuite") {
      if (closing) {
        suite = undefined;
      } else {
        const a = attrs(m[3]!);
        suite = { name: a.name ?? "", cases: [] };
        const ts = parseJunitTime(a.timestamp);
        if (ts !== undefined) suite.ts = ts;
        suites.push(suite);
        if (selfClosed) suite = undefined;
      }
      current = undefined;
    } else if (name === "testcase") {
      if (closing) {
        current = undefined;
        continue;
      }
      if (suite === undefined) {
        // A case outside any suite (a bare <testsuites> of cases): keep it under an unnamed suite.
        suite = { name: "", cases: [] };
        suites.push(suite);
      }
      const a = attrs(m[3]!);
      const time = Number(a.time);
      current = { name: a.name ?? "", classname: a.classname ?? "", time: Number.isFinite(time) ? time : 0, status: a.status === "skipped" ? "skipped" : "passed" };
      suite.cases.push(current);
      if (selfClosed) current = undefined;
    } else if (!closing && current !== undefined) {
      if (name === "skipped") {
        if (current.status !== "failed") current.status = "skipped";
      } else {
        current.status = "failed";
      }
    }
  }
  return suites;
}

/**
 * The commit inside a version string such as "v1.38.0-beta.0.504+04d3cc7a37391a"
 * (the e2e jobs state the build under test this way, in finished.json, and
 * have no repo-commit in started.json). An abbreviated hash, kept as stated.
 */
export function commitOfVersion(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const m = /\+([0-9a-f]{7,40})$/.exec(v);
  return m?.[1];
}

/** One build as stored: the published facts, before any mapping to events. */
export interface ProwBuild {
  job: string;
  id: string;
  /** From the id. */
  scheduledMs: number;
  /** started.json's timestamp (older builds have no started.json). */
  startedMs?: number;
  finishedMs: number;
  /** finished.json's result ("SUCCESS", "FAILURE", "ABORTED", …). */
  result: string;
  /** The commit under test, when started.json states it. */
  commit?: string;
  /** One entry per junit file, in the order listed. */
  files: Array<{ file: string; suites: JunitSuite[] }>;
}

export interface MissingBuild {
  id: string;
  scheduledMs: number;
  reason: string;
}

/** One line of days.jsonl: a day is readable only when its line exists. */
export interface ProwDayEntry {
  job: string;
  day: string;
  builds: number;
  missing: MissingBuild[];
  importedAt: string;
}

/** The slice of `fetch` the importer uses, so tests can stand in for the bucket. */
export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface ProwImporterOptions {
  dir: string;
  fetch?: FetchLike;
  now?: () => number;
  bucket?: string;
  /** Builds fetched at once. */
  concurrency?: number;
  retries?: number;
}

function dayFile(dir: string, job: string, day: string): string {
  return join(dir, job, `${day}.jsonl.gz`);
}

/** Refuses a day that cannot be complete yet. */
export function prowDayRefusal(day: string, nowMs: number): string | undefined {
  const start = Date.parse(`${day}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(start)) return `refusing: "${day}" is not a UTC day (YYYY-MM-DD)`;
  if (nowMs < start + DAY_MS + PROW_SETTLE_MS) {
    return `refusing: ${day} is not settled yet — a build scheduled late in the day may still be writing its artifacts (wait until ${new Date(start + DAY_MS + PROW_SETTLE_MS).toISOString()})`;
  }
  return undefined;
}

export class ProwImporter {
  private readonly dir: string;
  private readonly fetchFn: FetchLike;
  private readonly now: () => number;
  private readonly bucket: string;
  private readonly concurrency: number;
  private readonly retries: number;
  private readonly idCache = new Map<string, string[]>();

  constructor(opts: ProwImporterOptions) {
    this.dir = opts.dir;
    this.fetchFn = opts.fetch ?? ((url, init) => fetch(url, init));
    this.now = opts.now ?? Date.now;
    this.bucket = opts.bucket ?? PROW_BUCKET;
    this.concurrency = opts.concurrency ?? 8;
    this.retries = opts.retries ?? 3;
  }

  /** GET with retries; a 404 is an answer (null), anything else that fails after the retries throws. */
  private async get(url: string): Promise<string | null> {
    let last = "";
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const r = await this.fetchFn(url, { headers: { "User-Agent": PROW_USER_AGENT } });
        if (r.ok) return await r.text();
        if (r.status === 404) return null;
        last = `HTTP ${r.status}`;
      } catch (e) {
        last = e instanceof Error ? e.message : String(e);
      }
      if (attempt < this.retries) await new Promise((res) => setTimeout(res, 500 * 2 ** attempt));
    }
    throw new Error(`${url}: ${last}`);
  }

  private async list(prefix: string, delimiter: boolean): Promise<{ prefixes: string[]; names: string[] }> {
    const prefixes: string[] = [];
    const names: string[] = [];
    let token: string | undefined;
    do {
      const url =
        `https://storage.googleapis.com/storage/v1/b/${this.bucket}/o?prefix=${encodeURIComponent(prefix)}` +
        (delimiter ? "&delimiter=/" : "") +
        "&maxResults=1000&fields=prefixes,items(name),nextPageToken" +
        (token !== undefined ? `&pageToken=${encodeURIComponent(token)}` : "");
      const body = await this.get(url);
      if (body === null) throw new Error(`listing ${prefix}: not found`);
      const j = JSON.parse(body) as { prefixes?: string[]; items?: Array<{ name: string }>; nextPageToken?: string };
      for (const p of j.prefixes ?? []) prefixes.push(p);
      for (const i of j.items ?? []) names.push(i.name);
      token = j.nextPageToken;
    } while (token !== undefined);
    return { prefixes, names };
  }

  private object(name: string): Promise<string | null> {
    return this.get(`https://storage.googleapis.com/${this.bucket}/${name}`);
  }

  /** Every build id the bucket lists for a job, oldest first (listed once per importer). */
  async buildIds(job: string): Promise<string[]> {
    const cached = this.idCache.get(job);
    if (cached !== undefined) return cached;
    const { prefixes } = await this.list(`logs/${job}/`, true);
    const ids = prefixes.map((p) => p.split("/")[2] ?? "").filter((x) => /^\d+$/.test(x));
    ids.sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
    if (ids.length === 0) throw new Error(`job ${job}: the bucket lists no builds (wrong name?)`);
    this.idCache.set(job, ids);
    return ids;
  }

  private async readBuild(job: string, id: string): Promise<ProwBuild | MissingBuild> {
    const scheduledMs = prowBuildTimeMs(id);
    const base = `logs/${job}/${id}`;
    try {
      const finRaw = await this.object(`${base}/finished.json`);
      if (finRaw === null) return { id, scheduledMs, reason: "no finished.json (not finished, or its record was never written)" };
      const fin = JSON.parse(finRaw) as { timestamp?: number; result?: string; metadata?: Record<string, unknown> };
      if (typeof fin.timestamp !== "number") return { id, scheduledMs, reason: "finished.json without a timestamp" };
      const build: ProwBuild = { job, id, scheduledMs, finishedMs: fin.timestamp * 1000, result: fin.result ?? "", files: [] };
      const fromVersion = commitOfVersion(fin.metadata?.revision) ?? commitOfVersion(fin.metadata?.["job-version"]);
      if (fromVersion !== undefined) build.commit = fromVersion;
      const startRaw = await this.object(`${base}/started.json`);
      if (startRaw !== null) {
        const st = JSON.parse(startRaw) as { timestamp?: number; "repo-commit"?: string };
        if (typeof st.timestamp === "number") build.startedMs = st.timestamp * 1000;
        if (typeof st["repo-commit"] === "string" && st["repo-commit"] !== "") build.commit = st["repo-commit"];
      }
      const { names } = await this.list(`${base}/artifacts/`, false);
      const junit = names.filter((n) => /(^|\/)junit[^/]*\.xml$/.test(n)).sort();
      for (const name of junit) {
        const xml = await this.object(name);
        if (xml === null) return { id, scheduledMs, reason: `junit file listed but not found: ${name.slice(base.length + 1)}` };
        build.files.push({ file: name.slice(base.length + 1), suites: parseJunit(xml) });
      }
      return build;
    } catch (e) {
      return { id, scheduledMs, reason: `fetch failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  /**
   * Imports one UTC day of one job (builds are filed by the day they were
   * scheduled). Writes the day's builds and then its days.jsonl line; a day
   * already in days.jsonl is left alone unless `force`.
   */
  async importDay(job: string, day: string, force = false): Promise<ProwDayEntry & { skipped?: true }> {
    const refusal = prowDayRefusal(day, this.now());
    if (refusal !== undefined) throw new Error(refusal);
    const existing = readProwDays(this.dir, job).get(day);
    if (existing !== undefined && !force) return { ...existing, skipped: true };
    const ids = await this.buildIds(job);
    const from = Date.parse(`${day}T00:00:00Z`);
    const oldest = prowBuildTimeMs(ids[0]!);
    if (oldest > from) {
      throw new Error(`refusing: ${job} ${day} starts before the oldest build the bucket still lists (${new Date(oldest).toISOString()}) — the day can no longer be read whole`);
    }
    const todays = ids.filter((id) => {
      const t = prowBuildTimeMs(id);
      return t >= from && t < from + DAY_MS;
    });
    const results: Array<ProwBuild | MissingBuild> = new Array(todays.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const i = next++;
        if (i >= todays.length) return;
        results[i] = await this.readBuild(job, todays[i]!);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, Math.max(1, todays.length)) }, worker));
    const builds = results.filter((r): r is ProwBuild => "files" in r);
    const missing = results.filter((r): r is MissingBuild => !("files" in r));
    mkdirSync(join(this.dir, job), { recursive: true });
    writeFileSync(dayFile(this.dir, job, day), gzipSync(builds.map((b) => JSON.stringify(b)).join("\n") + (builds.length > 0 ? "\n" : "")));
    const entry: ProwDayEntry = { job, day, builds: builds.length, missing, importedAt: new Date(this.now()).toISOString() };
    appendFileSync(join(this.dir, job, PROW_DAYS_FILE), JSON.stringify(entry) + "\n");
    return entry;
  }
}

/** days.jsonl as a map; a day imported twice reads as its last line. */
export function readProwDays(dir: string, job: string): Map<string, ProwDayEntry> {
  const out = new Map<string, ProwDayEntry>();
  const path = join(dir, job, PROW_DAYS_FILE);
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    const e = JSON.parse(line) as ProwDayEntry;
    out.set(e.day, e);
  }
  return out;
}

export function daysBetween(fromDay: string, toDay: string): string[] {
  const from = Date.parse(`${fromDay}T00:00:00Z`);
  const to = Date.parse(`${toDay}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) throw new RangeError(`bad day range ${fromDay}…${toDay}`);
  const out: string[] = [];
  for (let t = from; t <= to; t += DAY_MS) out.push(utcDayOf(t));
  return out;
}

export interface ProwRange {
  job: string;
  fromDay: string;
  toDay: string;
  /** Oldest first. */
  builds: ProwBuild[];
  /** Builds that were scheduled in the range but could not be read: blind, not quiet. */
  missing: MissingBuild[];
}

/**
 * The stored builds of a job over whole UTC days. Refuses a range holding a
 * day that was never imported — such a day would otherwise read as a day on
 * which no test ran.
 */
export function loadProwRange(dir: string, job: string, fromDay: string, toDay: string): ProwRange {
  const days = readProwDays(dir, job);
  const wanted = daysBetween(fromDay, toDay);
  const absent = wanted.filter((d) => !days.has(d));
  if (absent.length > 0) {
    throw new Error(`refusing: ${job} has no import record for ${absent.length} day(s) in ${fromDay}…${toDay} (${absent.slice(0, 5).join(", ")}${absent.length > 5 ? ", …" : ""}) — an unimported day would read as a day without tests`);
  }
  const builds: ProwBuild[] = [];
  const missing: MissingBuild[] = [];
  for (const day of wanted) {
    const entry = days.get(day)!;
    missing.push(...entry.missing);
    const path = dayFile(dir, job, day);
    if (!existsSync(path)) throw new Error(`refusing: ${job} ${day} is in ${PROW_DAYS_FILE} but its file is gone (${path})`);
    const lines = gunzipSync(readFileSync(path)).toString("utf8").split("\n").filter((l) => l !== "");
    if (lines.length !== entry.builds) throw new Error(`refusing: ${job} ${day} holds ${lines.length} builds but ${PROW_DAYS_FILE} says ${entry.builds}`);
    for (const l of lines) builds.push(JSON.parse(l) as ProwBuild);
  }
  builds.sort((a, b) => a.scheduledMs - b.scheduledMs);
  return { job, fromDay, toDay, builds, missing };
}
