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
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, truncateSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { ProwBuild } from "./prow-import.js";

export interface IngestLogLoad {
  builds: ProwBuild[];
  /** Bytes of an unterminated last line that were cut off the file (0 when none). */
  droppedTailBytes: number;
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
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.trim() === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        throw new Error(`${this.path}:${i + 1}: unreadable line (${err instanceof Error ? err.message : String(err)})`);
      }
      builds.push(checkBuild(parsed, i + 1, this.path));
    }
    return { builds, droppedTailBytes };
  }

  /** Writes one build as a line and forces it to disk before returning. */
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
