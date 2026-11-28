/**
 * Append-only log of the builds `POST /ingest/build` accepted (ROADMAP C37).
 *
 * `LiveBuildIngestor` keeps everything in memory, and the test-stream profile scores a window against
 * the 30 windows of an hour before it, so every restart used to leave the live view blind for 30 hours.
 * With `LIGHTHOUSE_INGEST_LOG=<path>` each accepted build is written here as one JSON line (the
 * normalized `ProwBuild`) before it reaches the detector, and the next boot feeds the lines back through
 * the same path, in order — the buffer, window history and detector are all anchored to stream time,
 * so they come back as they were.
 *
 * Only accepted builds are written: a refused one (400, 409) never reaches `append`.
 * Each append is fsynced: this machine has ended abnormally several times a day, and an acknowledged
 * build that only lived in the page cache would be gone without a sign.
 *
 * A last line cut off without its newline (the process died mid-write) is dropped and reported at
 * boot; a damaged line anywhere else refuses the boot instead of silently skipping builds.
 *
 * Folding (ROADMAP C38, opt-in `LIGHTHOUSE_INGEST_LOG_KEEP_HOURS=N`): at boot, the builds at the head
 * of the file whose every event is more than N hours older than the newest event are folded into a
 * checkpoint — the ingestor's state right after them (`LiveBuildIngestor.checkpoint`) — written as the
 * file's first line. Only the newer builds stay as builds. Their events would have left the buffer
 * anyway (N is refused below the profile's retention), and the checkpoint carries what they leave
 * behind: a run of failures still going on, the flaky history, the passing commits, the totals and the
 * resend memory. Without it a cut inside a run would announce the same run a second time.
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, truncateSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { ProwBuild } from "./prow-import.js";
import { buildToEvents } from "./prow-events.js";

/** The first line of a folded log (ROADMAP C38). */
export interface IngestLogCheckpoint {
  /** Builds folded into it, over every fold so far. */
  foldedBuilds: number;
  /** The fold's cut: every folded build's events were older than this. */
  foldedBeforeMs: number;
  /** `LiveBuildIngestor.checkpoint()`, checked by `restoreCheckpoint`. */
  state: unknown;
}

export interface IngestLogLoad {
  /** Present only on a folded log. */
  checkpoint?: IngestLogCheckpoint;
  builds: ProwBuild[];
  /** Bytes of an unterminated last line that were cut off the file (0 when none). */
  droppedTailBytes: number;
}

const CHECKPOINT_KEY = "$checkpoint";

function checkCheckpoint(raw: unknown, path: string): IngestLogCheckpoint {
  const c = raw as IngestLogCheckpoint;
  if (typeof c !== "object" || c === null || !Number.isInteger(c.foldedBuilds) || typeof c.foldedBeforeMs !== "number" || typeof c.state !== "object" || c.state === null) {
    throw new Error(`${path}:1: not an ingest log checkpoint`);
  }
  return c;
}

function checkBuild(raw: unknown, lineNo: number, path: string): ProwBuild {
  const fail = (why: string): never => {
    throw new Error(`${path}:${lineNo}: not an ingested build (${why})`);
  };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail("not an object");
  const b = raw as Record<string, unknown>;
  if (typeof b.job !== "string" || b.job === "") fail("job");
  if (typeof b.id !== "string" || b.id === "") fail("id");
  if (typeof b.scheduledMs !== "number" || !Number.isFinite(b.scheduledMs)) fail("scheduledMs");
  if (typeof b.finishedMs !== "number" || !Number.isFinite(b.finishedMs)) fail("finishedMs");
  if (typeof b.result !== "string") fail("result");
  if (!Array.isArray(b.files)) fail("files");
  return raw as ProwBuild;
}

/**
 * Reads `LIGHTHOUSE_INGEST_LOG`. Unset or empty = no log (memory only, as before C37). Set with any
 * source other than `ingest` it would be read by nothing, so the boot refuses it.
 */
export function parseIngestLogPath(raw: string | undefined, source: string): string | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  if (source !== "ingest") {
    throw new Error(`LIGHTHOUSE_INGEST_LOG is read only with LIGHTHOUSE_SOURCE=ingest, got LIGHTHOUSE_SOURCE=${source}`);
  }
  return raw.trim();
}

/**
 * Reads `LIGHTHOUSE_INGEST_LOG_KEEP_HOURS` (ROADMAP C38) into milliseconds. Unset or empty = never
 * fold (the whole log is kept, as in C37). It needs a log to fold, and is refused below the profile's
 * retention: folding builds whose events the buffer still holds would shorten the live view's
 * reference after the next restart, silently.
 */
export function parseIngestLogKeepHours(raw: string | undefined, logPath: string | undefined, retentionMs: number): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  if (logPath === undefined) throw new Error("LIGHTHOUSE_INGEST_LOG_KEEP_HOURS folds LIGHTHOUSE_INGEST_LOG, which is unset");
  const hours = Number(raw.trim());
  if (!Number.isInteger(hours) || hours < 1) throw new Error(`LIGHTHOUSE_INGEST_LOG_KEEP_HOURS must be a positive integer, got "${raw}"`);
  const keepMs = hours * 3_600_000;
  if (keepMs < retentionMs) {
    throw new Error(`LIGHTHOUSE_INGEST_LOG_KEEP_HOURS=${hours} is shorter than the retention the live view scores against (${retentionMs / 3_600_000} h)`);
  }
  return keepMs;
}

/** The newest instant a build puts into the stream: its finish, or a later event. */
function buildLastTs(b: ProwBuild): number {
  let t = b.finishedMs;
  for (const e of buildToEvents(b).events) if (e.ts > t) t = e.ts;
  return t;
}

/**
 * How many builds at the head of `builds` to fold: the leading run whose last instant is more than
 * `keepMs` before the newest one in the log. It stops at the first newer build, so what stays is a
 * suffix in the order the builds were accepted (each job's builds stay in time order after the fold).
 */
export function foldCount(builds: readonly ProwBuild[], keepMs: number): { count: number; beforeMs: number } {
  const last = builds.map(buildLastTs);
  const beforeMs = last.reduce((m, t) => Math.max(m, t), -Infinity) - keepMs;
  let count = 0;
  while (count < builds.length && last[count]! < beforeMs) count++;
  return { count, beforeMs };
}

/** The part of `LiveBuildIngestor` a boot restores through. */
export interface RestorableIngestor {
  restoreCheckpoint(state: unknown): void;
  restore(builds: readonly ProwBuild[]): { builds: number; announcements: number };
  checkpoint(): unknown;
  announcements(): readonly unknown[];
  status(): { builds: number };
}

export interface IngestLogBootResult {
  droppedTailBytes: number;
  /** Builds the loaded checkpoint stood for (0 without one). */
  checkpointBuilds: number;
  /** Builds read from the file and fed again. */
  replayedBuilds: number;
  /** Builds this boot folded into a new checkpoint (0 when none, or the fold was not written). */
  folded: number;
  /** Why the fold was not written; the boot goes on with the file as it was. */
  foldError?: string;
}

/**
 * The boot's path back (ROADMAP C37/C38): load the log, restore its checkpoint, feed its builds again in
 * order and, with `keepMs`, fold the old ones into a new checkpoint. The folded builds are still fed in
 * this boot — the checkpoint is taken right after them — so this boot's buffer is the same as without
 * folding; only the next boot reads them from the checkpoint instead.
 */
export function restoreFromLog(log: IngestLog, ingestor: RestorableIngestor, keepMs?: number): IngestLogBootResult {
  const loaded = log.load();
  if (loaded.checkpoint !== undefined) ingestor.restoreCheckpoint(loaded.checkpoint.state);
  const checkpointBuilds = ingestor.status().builds;
  const fold = keepMs !== undefined && loaded.builds.length > 0 ? foldCount(loaded.builds, keepMs) : { count: 0, beforeMs: 0 };
  ingestor.restore(loaded.builds.slice(0, fold.count));
  const state = fold.count > 0 ? ingestor.checkpoint() : undefined;
  const kept = loaded.builds.slice(fold.count);
  ingestor.restore(kept);
  const out: IngestLogBootResult = { droppedTailBytes: loaded.droppedTailBytes, checkpointBuilds, replayedBuilds: loaded.builds.length, folded: 0 };
  if (state !== undefined) {
    try {
      log.rewrite({ foldedBuilds: (loaded.checkpoint?.foldedBuilds ?? 0) + fold.count, foldedBeforeMs: fold.beforeMs, state }, kept);
      out.folded = fold.count;
    } catch (err) {
      out.foldError = err instanceof Error ? err.message : String(err);
    }
  }
  return out;
}

export class IngestLog {
  constructor(readonly path: string) {}

  /**
   * Reads every logged build in file order. A missing file is an empty log. An unterminated last
   * line is cut off the file, so the next append starts on a clean line.
   */
  load(): IngestLogLoad {
    if (!existsSync(this.path)) return { builds: [], droppedTailBytes: 0 };
    const buf = readFileSync(this.path);
    const lastNl = buf.lastIndexOf(0x0a);
    const keep = lastNl + 1;
    const droppedTailBytes = buf.length - keep;
    if (droppedTailBytes > 0) truncateSync(this.path, keep);
    const lines = buf.subarray(0, keep).toString("utf-8").split("\n");
    const builds: ProwBuild[] = [];
    let checkpoint: IngestLogCheckpoint | undefined;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.trim() === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        throw new Error(`${this.path}:${i + 1}: unreadable line (${err instanceof Error ? err.message : String(err)})`);
      }
      if (typeof parsed === "object" && parsed !== null && CHECKPOINT_KEY in parsed) {
        if (i !== 0) throw new Error(`${this.path}:${i + 1}: a checkpoint is only ever the first line`);
        checkpoint = checkCheckpoint((parsed as Record<string, unknown>)[CHECKPOINT_KEY], this.path);
        continue;
      }
      builds.push(checkBuild(parsed, i + 1, this.path));
    }
    return { ...(checkpoint !== undefined ? { checkpoint } : {}), builds, droppedTailBytes };
  }

  /**
   * Replaces the file with `checkpoint` as its first line and `builds` after it: written to a
   * sibling file, forced to disk, then renamed over the log, so a crash leaves either file whole.
   */
  rewrite(checkpoint: IngestLogCheckpoint, builds: readonly ProwBuild[]): void {
    const tmp = `${this.path}.tmp`;
    const fd = openSync(tmp, "w");
    try {
      writeSync(fd, JSON.stringify({ [CHECKPOINT_KEY]: checkpoint }) + "\n");
      for (const b of builds) writeSync(fd, JSON.stringify(b) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.path);
  }

  /** Writes one build as a line and forces it to disk before returning (a folded log's checkpoint stays first). */
  append(build: ProwBuild): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const fd = openSync(this.path, "a");
    try {
      writeSync(fd, JSON.stringify(build) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}
