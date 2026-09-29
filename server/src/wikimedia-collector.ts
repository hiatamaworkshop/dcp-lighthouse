/**
 * Wikimedia EventStreams collector for the real-data calibration period
 * (ROADMAP_BRIEF.md 2026-09-27 (3), stage 0). Lighthouse-side only; touches no
 * dcp-wrap core.
 *
 * What it keeps, fixed as "v1" by the pre-registration: `ts`, `value` (1 = bot
 * edit, 0 = human), and the group keys `wiki` / `type` / `namespace`, plus the
 * event's own `eid` (meta.id, an opaque UUID) so a resubscription overlap can
 * be de-duplicated exactly. Usernames, page titles and comments are dropped
 * here, at the door — nothing that identifies a person is ever written.
 *
 * The collector's one duty beyond writing lines is to be honest about what it
 * did NOT see (pre-registration rule 5: a collection gap is BLINDNESS, never
 * quiet). A gap is recorded whenever consecutive event timestamps are more
 * than `gapToleranceMs` apart. That single rule covers a dropped connection
 * that `since` could not fully refill, a silent stall, and a process that was
 * down — all three look the same to whoever replays the file, which is the
 * point: the replay asks "is there an event-time hole here?", not "why".
 */
import { createReadStream, createWriteStream, mkdirSync, readdirSync, statSync, unlinkSync, openSync, readSync, closeSync, appendFileSync } from "node:fs";
import type { WriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { join } from "node:path";

export const STREAM_URL = "https://stream.wikimedia.org/v2/stream/recentchange";
/** Wikimedia asks for a contact; the repo URL, never a personal address. */
export const USER_AGENT =
  "dcp-lighthouse-calibration/0.1 (https://github.com/hiatamaworkshop/dcp-lighthouse)";

export interface WikiRecord {
  /** Event time, ms since epoch (meta.dt). */
  ts: number;
  /** 1 = bot edit, 0 = human (assignment v1, fixed by the pre-registration). */
  value: 0 | 1;
  wiki: string;
  type: string;
  namespace: number;
  /** meta.id — opaque per-event UUID, kept only for exact de-duplication. */
  eid: string;
}

/** One hole in event time. `kind` lets a replay tell gaps from informational lines. */
export interface GapEntry {
  kind: "gap";
  fromTs: number;
  toTs: number;
}

/** Map a raw recentchange payload to a record; null = unusable (counted, not written). */
export function toRecord(raw: unknown): WikiRecord | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const meta = r.meta as Record<string, unknown> | undefined;
  const dt = typeof meta?.dt === "string" ? Date.parse(meta.dt) : NaN;
  const ts = Number.isFinite(dt) ? dt : typeof r.timestamp === "number" ? r.timestamp * 1000 : NaN;
  if (!Number.isFinite(ts)) return null;
  if (typeof r.bot !== "boolean") return null;
  if (typeof r.wiki !== "string" || typeof r.type !== "string") return null;
  if (typeof meta?.id !== "string") return null;
  const namespace = typeof r.namespace === "number" ? r.namespace : -1;
  return { ts, value: r.bot ? 1 : 0, wiki: r.wiki, type: r.type, namespace, eid: meta.id };
}

/** Incremental SSE parser: feed decoded text, get the `data:` payload of each completed event. */
export class SseParser {
  private buf = "";
  private data: string[] = [];

  push(text: string): string[] {
    this.buf += text;
    const out: string[] = [];
    let nl: number;
    while ((nl = this.buf.search(/\r\n|\n|\r/)) !== -1) {
      const line = this.buf.slice(0, nl);
      const sep = this.buf.startsWith("\r\n", nl) ? 2 : 1;
      // A lone trailing "\r" might be the first half of "\r\n"; wait for more.
      if (this.buf[nl] === "\r" && nl + 1 === this.buf.length) break;
      this.buf = this.buf.slice(nl + sep);
      if (line === "") {
        if (this.data.length > 0) out.push(this.data.join("\n"));
        this.data = [];
      } else if (line.startsWith(":")) {
        // comment / keepalive — liveness is judged on bytes, not here
      } else if (line.startsWith("data:")) {
        this.data.push(line.slice(5).replace(/^ /, ""));
      }
    }
    return out;
  }
}

/**
 * Flags event-time holes. Uses the running MAXIMUM timestamp, not the previous
 * one: recentchange arrives slightly out of order, and an early straggler must
 * not look like a hole (nor reset the reference point).
 */
export class GapTracker {
  private maxTs: number | undefined;
  constructor(private readonly toleranceMs: number) {}

  seed(ts: number): void {
    if (this.maxTs === undefined || ts > this.maxTs) this.maxTs = ts;
  }

  observe(ts: number): GapEntry | null {
    const prev = this.maxTs;
    this.seed(ts);
    if (prev !== undefined && ts - prev > this.toleranceMs) {
      return { kind: "gap", fromTs: prev, toTs: ts };
    }
    return null;
  }
}

/** UTC calendar day, "YYYY-MM-DD". */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Last `maxBytes` of a file as complete lines (the first, possibly cut, line is dropped). */
export function readTailLines(path: string, maxBytes = 512 * 1024): string[] {
  const size = statSync(path).size;
  const start = Math.max(0, size - maxBytes);
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split("\n");
    if (start > 0) lines.shift();
    // The final element is "" for a newline-terminated file, or a torn line.
    lines.pop();
    return lines.filter((l) => l !== "");
  } finally {
    closeSync(fd);
  }
}

export interface CollectorOptions {
  /** Directory the day files and gaps.jsonl live in. Must sit outside the repo or under a gitignored path. */
  dir: string;
  fetchFn?: typeof fetch;
  now?: () => number;
  gapToleranceMs?: number;
  /** On resume, re-request this much before the last seen event and de-duplicate. */
  sinceOverlapMs?: number;
  /** No bytes for this long = the connection is dead; abort and reconnect. */
  watchdogMs?: number;
  idRingSize?: number;
  /** Reconnect backoff bounds. */
  backoffMinMs?: number;
  backoffMaxMs?: number;
  log?: (msg: string) => void;
}

export interface CollectorStats {
  written: number;
  duplicates: number;
  malformed: number;
  gaps: number;
  reconnects: number;
}

export class WikimediaCollector {
  readonly stats: CollectorStats = { written: 0, duplicates: 0, malformed: 0, gaps: 0, reconnects: 0 };
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly gapTracker: GapTracker;
  private readonly sinceOverlapMs: number;
  private readonly watchdogMs: number;
  private readonly idRingSize: number;
  private readonly backoffMinMs: number;
  private readonly backoffMaxMs: number;
  private readonly log: (msg: string) => void;
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];
  private maxTs: number | undefined;
  private out: WriteStream | undefined;
  private outDay: string | undefined;
  private readonly gzipJobs: Promise<void>[] = [];

  constructor(private readonly opts: CollectorOptions) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.now = opts.now ?? Date.now;
    this.gapTracker = new GapTracker(opts.gapToleranceMs ?? 10_000);
    this.sinceOverlapMs = opts.sinceOverlapMs ?? 60_000;
    this.watchdogMs = opts.watchdogMs ?? 90_000;
    this.idRingSize = opts.idRingSize ?? 50_000;
    this.backoffMinMs = opts.backoffMinMs ?? 1_000;
    this.backoffMaxMs = opts.backoffMaxMs ?? 60_000;
    this.log = opts.log ?? ((m) => console.log(`[wiki-collector] ${m}`));
    mkdirSync(opts.dir, { recursive: true });
    this.restoreFromDisk();
  }

  private dayPath(day: string): string {
    return join(this.opts.dir, `${day}.jsonl`);
  }

  /**
   * Recover "what did I last see" from the newest raw day file: seeds the
   * de-dup ring and the gap tracker's reference point, so a restart neither
   * duplicates the resubscription overlap nor hides the downtime as quiet.
   * Leftover raw files from earlier days (a crash before rollover) are gzipped.
   */
  private restoreFromDisk(): void {
    const raws = readdirSync(this.opts.dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
    if (raws.length === 0) return;
    const today = utcDay(this.now());
    for (const f of raws) {
      if (f.slice(0, 10) < today) this.gzipJobs.push(this.gzipAndRemove(join(this.opts.dir, f)));
    }
    const newest = raws[raws.length - 1];
    const tail = readTailLines(join(this.opts.dir, newest));
    for (const line of tail) {
      try {
        const rec = JSON.parse(line) as WikiRecord;
        this.remember(rec.eid);
        this.gapTracker.seed(rec.ts);
        if (this.maxTs === undefined || rec.ts > this.maxTs) this.maxTs = rec.ts;
      } catch {
        // a torn line from a crash — skip it
      }
    }
  }

  private remember(eid: string): void {
    if (this.seen.has(eid)) return;
    this.seen.add(eid);
    this.seenOrder.push(eid);
    if (this.seenOrder.length > this.idRingSize) this.seen.delete(this.seenOrder.shift() as string);
  }

  private async gzipAndRemove(path: string): Promise<void> {
    const gz = `${path}.gz`;
    try {
      await pipeline(createReadStream(path), createGzip(), createWriteStream(gz));
      unlinkSync(path);
    } catch (err) {
      this.log(`gzip of ${path} failed (raw file kept): ${(err as Error).message}`);
    }
  }

  private writerFor(day: string): WriteStream {
    if (this.outDay !== day) {
      const prevDay = this.outDay;
      const prev = this.out;
      this.out = createWriteStream(this.dayPath(day), { flags: "a" });
      this.outDay = day;
      if (prev !== undefined && prevDay !== undefined) {
        this.gzipJobs.push(
          new Promise<void>((resolve) => prev.end(resolve)).then(() =>
            this.gzipAndRemove(this.dayPath(prevDay)),
          ),
        );
      }
    }
    return this.out as WriteStream;
  }

  /** Handle one dispatched SSE payload. Exposed for tests. */
  ingest(payload: string): void {
    let rec: WikiRecord | null;
    try {
      rec = toRecord(JSON.parse(payload));
    } catch {
      rec = null;
    }
    if (rec === null) {
      this.stats.malformed++;
      return;
    }
    if (this.seen.has(rec.eid)) {
      this.stats.duplicates++;
      return;
    }
    this.remember(rec.eid);
    const gap = this.gapTracker.observe(rec.ts);
    if (gap !== null) {
      this.stats.gaps++;
      appendFileSync(join(this.opts.dir, "gaps.jsonl"), JSON.stringify(gap) + "\n");
      this.log(`gap ${new Date(gap.fromTs).toISOString()} → ${new Date(gap.toTs).toISOString()}`);
    }
    if (this.maxTs === undefined || rec.ts > this.maxTs) this.maxTs = rec.ts;
    this.writerFor(utcDay(this.now())).write(JSON.stringify(rec) + "\n");
    this.stats.written++;
  }

  /** One connection attempt: returns when the stream ends or errors. */
  private async connectOnce(signal: AbortSignal): Promise<void> {
    const url =
      this.maxTs === undefined
        ? STREAM_URL
        : `${STREAM_URL}?since=${new Date(this.maxTs - this.sinceOverlapMs).toISOString()}`;
    const conn = new AbortController();
    const onOuterAbort = () => conn.abort();
    signal.addEventListener("abort", onOuterAbort, { once: true });
    let lastByteAt = this.now();
    const dog = setInterval(() => {
      if (this.now() - lastByteAt > this.watchdogMs) {
        this.log(`no bytes for ${this.watchdogMs}ms — dropping the connection`);
        conn.abort();
      }
    }, Math.max(1, Math.min(this.watchdogMs / 3, 10_000)));
    try {
      const res = await this.fetchFn(url, {
        headers: { Accept: "text/event-stream", "User-Agent": USER_AGENT },
        signal: conn.signal,
      });
      if (!res.ok || res.body === null) throw new Error(`HTTP ${res.status}`);
      const parser = new SseParser();
      const decoder = new TextDecoder();
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        lastByteAt = this.now();
        for (const payload of parser.push(decoder.decode(value, { stream: true }))) this.ingest(payload);
      }
    } finally {
      clearInterval(dog);
      signal.removeEventListener("abort", onOuterAbort);
    }
  }

  /** Run until `signal` aborts, reconnecting with exponential backoff. */
  async run(signal: AbortSignal): Promise<void> {
    let backoff = this.backoffMinMs;
    while (!signal.aborted) {
      const before = this.stats.written;
      try {
        await this.connectOnce(signal);
      } catch (err) {
        if (!signal.aborted) this.log(`connection error: ${(err as Error).message}`);
      }
      if (signal.aborted) break;
      this.stats.reconnects++;
      // Progress resets the backoff; a connection that produced nothing doubles it.
      backoff = this.stats.written > before ? this.backoffMinMs : Math.min(backoff * 2, this.backoffMaxMs);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, backoff);
        signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
      });
    }
    await this.close();
  }

  async close(): Promise<void> {
    const out = this.out;
    this.out = undefined;
    this.outDay = undefined;
    if (out !== undefined) await new Promise<void>((resolve) => out.end(resolve));
    await Promise.all(this.gzipJobs);
  }
}
