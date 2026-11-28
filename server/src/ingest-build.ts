/**
 * Real-time build ingestion for local tests and CI runs (ROADMAP C30).
 *
 * Accepts a finished build as either JSON (`parseIngestBuildJson`) or JUnit XML
 * (`parseIngestBuildJunit`, reusing `parseJunit` from `prow-import.ts`, which
 * also parses `node --test --test-reporter=junit` output), normalizes it into a
 * `ProwBuild`, emits `test_result:v1` (`ProwEvent`) events into the observation
 * chain, and feeds `PersistenceDetector` so consecutive per-test failures
 * surface immediately on `/persistence` and SSE.
 *
 * Opt-in (`LIGHTHOUSE_SOURCE=ingest`). Processes running `mock` or `prow` never
 * instantiate `LiveBuildIngestor`, leaving their behavior and payloads untouched.
 */

import { parseJunit, type CaseStatus, type JunitCase, type JunitSuite, type ProwBuild } from "./prow-import.js";
import { buildToEvents, type ProwEvent, type ProwEventOptions } from "./prow-events.js";
import { PersistenceDetector, type Announcement, type FlakyHistoryOptions } from "./prow-persist.js";

/** Maximum request body size accepted by POST /ingest/build (10 MiB). */
export const MAX_INGEST_BODY_BYTES = 10 * 1024 * 1024;
/** Maximum announcements kept in memory by LiveBuildIngestor (FIFO cap). */
export const DEFAULT_MAX_INGEST_ANNOUNCEMENTS = 1000;
/** Maximum (job, buildId) pairs remembered to refuse a resent build (FIFO cap). */
export const DEFAULT_MAX_SEEN_BUILDS = 10_000;

/**
 * A build whose (job, buildId) was already ingested — e.g. a CI retry resending the same results.
 * Counting it again would double the events and could fake a consecutive failure. HTTP maps it to 409.
 */
export class DuplicateBuildError extends Error {
  constructor(readonly job: string, readonly buildId: string) {
    super(`build ${buildId} of job ${job} was already ingested`);
    this.name = "DuplicateBuildError";
  }
}

export interface IngestCaseInput {
  name: string;
  classname?: string;
  status: "passed" | "failed" | "skipped" | "pass" | "fail" | "skip";
  /** Duration in milliseconds (takes precedence over `time` if both are set). */
  durationMs?: number;
  /** Duration in seconds (JUnit convention). */
  time?: number;
}

export interface IngestBuildJson {
  job: string;
  buildId?: string;
  id?: string;
  commit?: string;
  commitHash?: string;
  scheduledMs?: number;
  startedMs?: number;
  finishedMs?: number;
  result?: string;
  cases: IngestCaseInput[];
}

export interface IngestJunitMeta {
  job: string;
  buildId?: string;
  commit?: string;
  scheduledMs?: number;
  startedMs?: number;
  finishedMs?: number;
}

export interface IngestStatus {
  source: "ingest";
  builds: number;
  events: number;
  failed: number;
  skipped: number;
  lastBuildAt: number | null;
  lastJob: string | null;
  lastBuildId: string | null;
}

export interface IngestBuildResult {
  accepted: true;
  job: string;
  buildId: string;
  events: number;
  failed: number;
  skipped: number;
  announcements: Announcement[];
  totalBuilds: number;
}

function normalizeStatus(raw: unknown, idx: number): CaseStatus {
  if (raw === "passed" || raw === "pass") return "passed";
  if (raw === "failed" || raw === "fail") return "failed";
  if (raw === "skipped" || raw === "skip") return "skipped";
  throw new RangeError(`cases[${idx}].status must be passed|failed|skipped (or pass|fail|skip), got ${JSON.stringify(raw)}`);
}

function readOptionalFiniteMs(val: unknown, field: string): number | undefined {
  if (val === undefined || val === null) return undefined;
  if (typeof val !== "number" || !Number.isFinite(val)) {
    throw new RangeError(`${field} must be a finite number of ms, got ${JSON.stringify(val)}`);
  }
  return val;
}

function requireJob(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new RangeError("job must be a non-empty string");
  }
  return raw.trim();
}

function optionalNonEmptyString(raw: unknown, field: string): string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string") {
    throw new RangeError(`${field} must be a string`);
  }
  return raw.trim() || undefined;
}

/**
 * Validates and converts a JSON build payload into a `ProwBuild`.
 * Throws `RangeError` on any invalid shape so HTTP handlers map it to 400.
 */
export function parseIngestBuildJson(body: unknown, nowMs: number = Date.now(), fallbackBuildId?: string): ProwBuild {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new RangeError("build payload must be a JSON object");
  }
  const obj = body as Record<string, unknown>;
  const job = requireJob(obj.job);
  const id =
    optionalNonEmptyString(obj.buildId, "buildId") ??
    optionalNonEmptyString(obj.id, "id") ??
    fallbackBuildId ??
    `ingest-${nowMs}`;
  const commit =
    optionalNonEmptyString(obj.commit, "commit") ??
    optionalNonEmptyString(obj.commitHash, "commitHash");
  const finishedMs = readOptionalFiniteMs(obj.finishedMs, "finishedMs") ?? nowMs;
  const startedMs = readOptionalFiniteMs(obj.startedMs, "startedMs") ?? finishedMs;
  const scheduledMs = readOptionalFiniteMs(obj.scheduledMs, "scheduledMs") ?? startedMs;
  if (finishedMs < startedMs) {
    throw new RangeError(`finishedMs (${finishedMs}) cannot precede startedMs (${startedMs})`);
  }

  if (!Array.isArray(obj.cases)) {
    throw new RangeError("cases must be an array of test case results");
  }
  const cases: JunitCase[] = [];
  let anyFailed = false;
  for (let i = 0; i < obj.cases.length; i++) {
    const raw = obj.cases[i];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new RangeError(`cases[${i}] must be an object`);
    }
    const c = raw as Record<string, unknown>;
    if (typeof c.name !== "string" || c.name.trim() === "") {
      throw new RangeError(`cases[${i}].name must be a non-empty string`);
    }
    const classname =
      c.classname === undefined || c.classname === null
        ? ""
        : typeof c.classname === "string"
          ? c.classname
          : (() => {
              throw new RangeError(`cases[${i}].classname must be a string`);
            })();
    const status = normalizeStatus(c.status, i);
    if (status === "failed") anyFailed = true;
    let time = 0;
    if (c.durationMs !== undefined && c.durationMs !== null) {
      if (typeof c.durationMs !== "number" || !Number.isFinite(c.durationMs) || c.durationMs < 0) {
        throw new RangeError(`cases[${i}].durationMs must be a non-negative finite number`);
      }
      time = c.durationMs / 1000;
    } else if (c.time !== undefined && c.time !== null) {
      if (typeof c.time !== "number" || !Number.isFinite(c.time) || c.time < 0) {
        throw new RangeError(`cases[${i}].time must be a non-negative finite number`);
      }
      time = c.time;
    }
    cases.push({ name: c.name, classname, time, status });
  }

  const result = optionalNonEmptyString(obj.result, "result") ?? (anyFailed ? "FAILURE" : "SUCCESS");
  const suite: JunitSuite = { name: job, ts: startedMs, cases };
  return {
    job,
    id,
    scheduledMs,
    startedMs,
    finishedMs,
    result,
    ...(commit !== undefined ? { commit } : {}),
    files: [{ file: "ingest.json", suites: [suite] }],
  };
}

/**
 * Parses a JUnit XML document (including `node --test --test-reporter=junit`)
 * into a `ProwBuild`. Throws `RangeError` if `meta.job` is missing or if the
 * XML holds no `<testsuite>` / `<testcase>` elements.
 */
export function parseIngestBuildJunit(
  xml: string,
  meta: IngestJunitMeta,
  nowMs: number = Date.now(),
  fallbackBuildId?: string,
): ProwBuild {
  const job = requireJob(meta.job);
  if (typeof xml !== "string" || xml.trim() === "") {
    throw new RangeError("JUnit XML body must be non-empty");
  }
  const suites = parseJunit(xml);
  if (suites.length === 0) {
    throw new RangeError("JUnit XML contains no <testsuite> or <testcase> elements");
  }
  const id =
    optionalNonEmptyString(meta.buildId, "buildId") ??
    fallbackBuildId ??
    `ingest-${nowMs}`;
  const commit = optionalNonEmptyString(meta.commit, "commit");
  const finishedMs = readOptionalFiniteMs(meta.finishedMs, "finishedMs") ?? nowMs;
  const startedMs = readOptionalFiniteMs(meta.startedMs, "startedMs") ?? finishedMs;
  const scheduledMs = readOptionalFiniteMs(meta.scheduledMs, "scheduledMs") ?? startedMs;
  if (finishedMs < startedMs) {
    throw new RangeError(`finishedMs (${finishedMs}) cannot precede startedMs (${startedMs})`);
  }
  const anyFailed = suites.some((s) => s.cases.some((c) => c.status === "failed"));
  return {
    job,
    id,
    scheduledMs,
    startedMs,
    finishedMs,
    result: anyFailed ? "FAILURE" : "SUCCESS",
    ...(commit !== undefined ? { commit } : {}),
    files: [{ file: "ingest.junit.xml", suites }],
  };
}

export interface LiveBuildIngestorOptions {
  eventOpts?: ProwEventOptions;
  flakyHistory?: FlakyHistoryOptions;
  maxPassedCommits?: number;
  maxAnnouncements?: number;
  maxSeenBuilds?: number;
  now?: () => number;
  onAnnouncement?: (a: Announcement) => void;
  /**
   * Where each accepted build is written before it is applied (ROADMAP C37, `ingest-log.ts`).
   * A build it cannot write is refused with nothing applied. Absent = memory only, as before.
   */
  log?: { append(build: ProwBuild): void };
}

/** What `LiveBuildIngestor.restore` fed back from a log. */
export interface IngestRestoreResult {
  builds: number;
  announcements: number;
}

/**
 * Stateful real-time build ingestor (ROADMAP C30).
 *
 * Bridges HTTP build pushes to the observation chain (`onEvent`) and the
 * per-test persistence detector (`PersistenceDetector`). Bounds both
 * `passedOn` (via `PersistenceDetector`) and retained announcements (FIFO) so
 * a long-running process never grows memory unboundedly.
 */
export class LiveBuildIngestor {
  private readonly detector: PersistenceDetector;
  private readonly eventOpts: ProwEventOptions;
  private readonly maxAnnouncements: number;
  private readonly now: () => number;
  private readonly onAnnouncement?: (a: Announcement) => void;
  private readonly log?: { append(build: ProwBuild): void };
  private readonly surfaced: Announcement[] = [];
  private readonly maxSeenBuilds: number;
  /** (job, buildId) keys in arrival order; a Set keeps insertion order, so the oldest is evicted first. */
  private readonly seenBuilds = new Set<string>();
  private seq = 0;
  private lastScheduledMs = -Infinity;
  private builds = 0;
  private totalEvents = 0;
  private totalFailed = 0;
  private totalSkipped = 0;
  private lastBuildAt: number | null = null;
  private lastJob: string | null = null;
  private lastBuildId: string | null = null;

  constructor(
    private readonly onEvent: (ev: ProwEvent) => void,
    opts: LiveBuildIngestorOptions = {},
  ) {
    const maxAnn = opts.maxAnnouncements ?? DEFAULT_MAX_INGEST_ANNOUNCEMENTS;
    if (!(Number.isInteger(maxAnn) && maxAnn >= 1)) {
      throw new RangeError(`maxAnnouncements must be a positive integer, got ${maxAnn}`);
    }
    this.maxAnnouncements = maxAnn;
    const maxSeen = opts.maxSeenBuilds ?? DEFAULT_MAX_SEEN_BUILDS;
    if (!(Number.isInteger(maxSeen) && maxSeen >= 1)) {
      throw new RangeError(`maxSeenBuilds must be a positive integer, got ${maxSeen}`);
    }
    this.maxSeenBuilds = maxSeen;
    this.eventOpts = opts.eventOpts ?? {};
    this.now = opts.now ?? (() => Date.now());
    this.onAnnouncement = opts.onAnnouncement;
    this.log = opts.log;
    this.detector = new PersistenceDetector(this.eventOpts, opts.flakyHistory, opts.maxPassedCommits);
  }

  private nextClockAndId(): { nowMs: number; fallbackId: string } {
    this.seq++;
    const rawNow = this.now();
    const nowMs = Math.max(rawNow, Number.isFinite(this.lastScheduledMs) ? this.lastScheduledMs : rawNow);
    return { nowMs, fallbackId: `ingest-${nowMs}-${this.seq}` };
  }

  ingestJson(body: unknown): IngestBuildResult {
    const { nowMs, fallbackId } = this.nextClockAndId();
    const build = parseIngestBuildJson(body, nowMs, fallbackId);
    return this.ingestBuild(build);
  }

  ingestJunit(xml: string, meta: IngestJunitMeta): IngestBuildResult {
    const { nowMs, fallbackId } = this.nextClockAndId();
    const build = parseIngestBuildJunit(xml, meta, nowMs, fallbackId);
    return this.ingestBuild(build);
  }

  ingestBuild(build: ProwBuild): IngestBuildResult {
    return this.apply(build, true);
  }

  /**
   * Feeds builds read back from the log (ROADMAP C37) through the same path as a POST, in order,
   * without writing them again and without `onAnnouncement` (they were announced before the restart).
   * Their announcements return to `announcements()`, so `/persistence` reads as it did.
   */
  restore(builds: readonly ProwBuild[]): IngestRestoreResult {
    let announcements = 0;
    for (const b of builds) announcements += this.apply(b, false).announcements.length;
    return { builds: builds.length, announcements };
  }

  private apply(build: ProwBuild, live: boolean): IngestBuildResult {
    // A resent build is refused before anything is touched: the detector would take an equal
    // scheduledMs as in order and count its failures a second time.
    const key = `${build.job}\u0000${build.id}`;
    if (this.seenBuilds.has(key)) throw new DuplicateBuildError(build.job, build.id);

    // Refuse an out-of-order build before it is written or reaches any buffer or counter, then write
    // it: a build the log cannot hold is refused whole, so memory never holds what a restart would lose.
    this.detector.checkOrder(build);
    if (live) this.log?.append(build);
    const announcements = this.detector.add(build);
    this.lastScheduledMs = Math.max(this.lastScheduledMs, build.scheduledMs);
    this.seenBuilds.add(key);
    if (this.seenBuilds.size > this.maxSeenBuilds) {
      this.seenBuilds.delete(this.seenBuilds.values().next().value!);
    }

    const batch = buildToEvents(build, this.eventOpts);
    let failed = 0;
    for (const ev of batch.events) {
      if (ev.result === "fail") failed++;
      this.onEvent(ev);
    }

    for (const a of announcements) {
      this.surfaced.push(a);
      if (this.surfaced.length > this.maxAnnouncements) {
        this.surfaced.splice(0, this.surfaced.length - this.maxAnnouncements);
      }
      if (live) this.onAnnouncement?.(a);
    }

    this.builds++;
    this.totalEvents += batch.events.length;
    this.totalFailed += failed;
    this.totalSkipped += batch.skipped;
    this.lastBuildAt = build.finishedMs;
    this.lastJob = build.job;
    this.lastBuildId = build.id;

    return {
      accepted: true,
      job: build.job,
      buildId: build.id,
      events: batch.events.length,
      failed,
      skipped: batch.skipped,
      announcements,
      totalBuilds: this.builds,
    };
  }

  announcements(): Announcement[] {
    return [...this.surfaced];
  }

  status(): IngestStatus {
    return {
      source: "ingest",
      builds: this.builds,
      events: this.totalEvents,
      failed: this.totalFailed,
      skipped: this.totalSkipped,
      lastBuildAt: this.lastBuildAt,
      lastJob: this.lastJob,
      lastBuildId: this.lastBuildId,
    };
  }
}
