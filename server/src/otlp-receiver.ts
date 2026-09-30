/**
 * Minimal OTLP/HTTP (JSON) trace receiver for the real-data calibration
 * period's H4 (ROADMAP_BRIEF.md 2026-09-27 (3), source B: OpenTelemetry Demo).
 * Lighthouse-side only; touches no dcp-wrap core.
 *
 * What one span becomes, fixed by the pre-registration:
 *   ts     = the span's END time (the moment its status is known)
 *   value  = 0 if status is ERROR, else 1
 *   keys   = service.name + operation (span name)
 *   weight = the sampling adjusted count (1 / sampling probability)
 *
 * The adjusted count is read from the W3C tracestate the OTel probability
 * samplers write (`ot=th:<hex>`, OTEP 235: th is the REJECTION threshold in
 * 56 bits, so p = 1 − th/2^56) and, failing that, from a
 * `sampling.probability` span attribute; with neither, the span is taken as
 * unsampled-away nothing (weight 1). A malformed value is counted and read as
 * weight 1 rather than dropped: the span happened either way.
 *
 * Deliberately NOT decided here: which span kinds count. Every span is kept
 * and its `kind` is recorded on the line (not as a group key), so the replay
 * can filter later without a re-collection. Usernames or payloads never
 * appear: only the fields above are written.
 *
 * Only OTLP/JSON is accepted (configure the collector's otlphttp exporter with
 * `encoding: json`); protobuf gets 415. gzip request bodies are accepted.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { GapTracker, utcDay } from "./wikimedia-collector.js";

export interface OtelRecord {
  ts: number;
  /** 0 = ERROR span, 1 = anything else. */
  value: 0 | 1;
  service: string;
  op: string;
  kind: number;
  /** Sampling adjusted count (≥ 1). */
  weight: number;
  /** traceId:spanId — exact de-duplication if an exporter retries a batch. */
  eid: string;
}

const TWO_56 = 2n ** 56n;

/** Sampling probability from a tracestate's `ot=th:<hex>`; undefined = absent or unparseable. */
export function probabilityFromTraceState(traceState: unknown): number | undefined {
  if (typeof traceState !== "string") return undefined;
  for (const member of traceState.split(",")) {
    const eq = member.indexOf("=");
    if (eq < 0 || member.slice(0, eq).trim() !== "ot") continue;
    for (const sub of member.slice(eq + 1).split(";")) {
      if (!sub.startsWith("th:")) continue;
      const hex = sub.slice(3);
      if (!/^[0-9a-f]{1,14}$/.test(hex)) return undefined;
      const threshold = BigInt("0x" + hex.padEnd(14, "0"));
      if (threshold >= TWO_56) return undefined;
      return Number(TWO_56 - threshold) / Number(TWO_56);
    }
  }
  return undefined;
}

type AnyObj = Record<string, unknown>;

function attrString(attrs: unknown, key: string): string | undefined {
  if (!Array.isArray(attrs)) return undefined;
  for (const a of attrs as AnyObj[]) {
    if (a.key !== key) continue;
    const v = a.value as AnyObj | undefined;
    if (typeof v?.stringValue === "string") return v.stringValue;
  }
  return undefined;
}

function attrNumber(attrs: unknown, key: string): number | undefined {
  if (!Array.isArray(attrs)) return undefined;
  for (const a of attrs as AnyObj[]) {
    if (a.key !== key) continue;
    const v = a.value as AnyObj | undefined;
    const raw = v?.doubleValue ?? v?.intValue;
    const n = typeof raw === "string" ? Number(raw) : raw;
    if (typeof n === "number" && Number.isFinite(n)) return n;
  }
  return undefined;
}

/** OTLP/JSON writes status.code as an int or as its enum name. */
function isErrorStatus(status: unknown): boolean {
  const code = (status as AnyObj | undefined)?.code;
  return code === 2 || code === "STATUS_CODE_ERROR";
}

const KIND_NAMES: Record<string, number> = {
  SPAN_KIND_UNSPECIFIED: 0, SPAN_KIND_INTERNAL: 1, SPAN_KIND_SERVER: 2,
  SPAN_KIND_CLIENT: 3, SPAN_KIND_PRODUCER: 4, SPAN_KIND_CONSUMER: 5,
};

export interface ParseResult {
  records: OtelRecord[];
  /** Spans that could not be read at all. */
  malformed: number;
  /** Spans whose sampling weight was present but unusable (kept at weight 1). */
  badWeight: number;
}

/** Flatten an OTLP/JSON ExportTraceServiceRequest into records. */
export function parseTraces(body: unknown): ParseResult {
  const out: ParseResult = { records: [], malformed: 0, badWeight: 0 };
  const resourceSpans = (body as AnyObj | null)?.resourceSpans;
  if (!Array.isArray(resourceSpans)) return out;
  for (const rs of resourceSpans as AnyObj[]) {
    const service = attrString((rs.resource as AnyObj | undefined)?.attributes, "service.name") ?? "(unknown)";
    for (const scope of (Array.isArray(rs.scopeSpans) ? rs.scopeSpans : []) as AnyObj[]) {
      for (const span of (Array.isArray(scope.spans) ? scope.spans : []) as AnyObj[]) {
        const endNs = typeof span.endTimeUnixNano === "string" || typeof span.endTimeUnixNano === "number"
          ? Number(span.endTimeUnixNano) : NaN;
        if (!Number.isFinite(endNs) || endNs <= 0 || typeof span.name !== "string" ||
            typeof span.traceId !== "string" || typeof span.spanId !== "string") {
          out.malformed++;
          continue;
        }
        const fromState = probabilityFromTraceState(span.traceState);
        const p = fromState ?? attrNumber(span.attributes, "sampling.probability");
        let weight = 1;
        if (p !== undefined) {
          if (p > 0 && p <= 1) weight = 1 / p;
          else out.badWeight++;
        } else if (typeof span.traceState === "string" && /(^|[,;])\s*ot=[^,]*th:/.test(span.traceState)) {
          out.badWeight++; // a th: was there but unreadable
        }
        const kind = typeof span.kind === "number" ? span.kind : (KIND_NAMES[String(span.kind)] ?? 0);
        out.records.push({
          ts: Math.floor(endNs / 1e6),
          value: isErrorStatus(span.status) ? 0 : 1,
          service,
          op: span.name,
          kind,
          weight,
          eid: `${span.traceId}:${span.spanId}`,
        });
      }
    }
  }
  return out;
}

export interface OtlpReceiverOptions {
  dir: string;
  now?: () => number;
  /** An event-time hole longer than this is recorded as blindness. The Demo's load generator is continuous, so 30 s is a real outage. */
  gapToleranceMs?: number;
  idRingSize?: number;
  maxBodyBytes?: number;
}

export interface OtlpStats {
  written: number;
  duplicates: number;
  malformed: number;
  badWeight: number;
  gaps: number;
  rejectedRequests: number;
}

export class OtlpReceiver {
  readonly stats: OtlpStats = { written: 0, duplicates: 0, malformed: 0, badWeight: 0, gaps: 0, rejectedRequests: 0 };
  private readonly now: () => number;
  private readonly gapTracker: GapTracker;
  private readonly idRingSize: number;
  private readonly maxBodyBytes: number;
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];

  constructor(private readonly opts: OtlpReceiverOptions) {
    this.now = opts.now ?? Date.now;
    this.gapTracker = new GapTracker(opts.gapToleranceMs ?? 30_000);
    this.idRingSize = opts.idRingSize ?? 200_000;
    this.maxBodyBytes = opts.maxBodyBytes ?? 16 * 1024 * 1024;
    mkdirSync(opts.dir, { recursive: true });
  }

  /** Write one parsed batch. Exposed for tests; the HTTP handler is a thin shell around it. */
  ingest(body: unknown): ParseResult {
    const parsed = parseTraces(body);
    this.stats.malformed += parsed.malformed;
    this.stats.badWeight += parsed.badWeight;
    // A batch arrives in arbitrary span order; the gap rule needs event order.
    const fresh = parsed.records.filter((r) => {
      if (this.seen.has(r.eid)) { this.stats.duplicates++; return false; }
      this.seen.add(r.eid);
      this.seenOrder.push(r.eid);
      if (this.seenOrder.length > this.idRingSize) this.seen.delete(this.seenOrder.shift() as string);
      return true;
    }).sort((a, b) => a.ts - b.ts);
    if (fresh.length === 0) return parsed;
    const lines: string[] = [];
    for (const r of fresh) {
      for (const gap of this.gapTracker.observe(r.ts, this.now())) {
        this.stats.gaps++;
        appendFileSync(join(this.opts.dir, "gaps.jsonl"), JSON.stringify(gap) + "\n");
      }
      lines.push(JSON.stringify(r));
    }
    appendFileSync(join(this.opts.dir, `${utcDay(this.now())}.jsonl`), lines.join("\n") + "\n");
    this.stats.written += fresh.length;
    return parsed;
  }

  private async readBody(req: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > this.maxBodyBytes) throw new RangeError("body too large");
      chunks.push(c as Buffer);
    }
    return Buffer.concat(chunks);
  }

  /** POST /v1/traces on the returned server (caller listens). */
  createServer(): Server {
    return createServer((req, res) => {
      void (async () => {
        if (req.method !== "POST" || req.url?.split("?")[0] !== "/v1/traces") {
          res.writeHead(404).end();
          return;
        }
        if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) {
          this.stats.rejectedRequests++;
          res.writeHead(415).end("only OTLP/JSON (application/json) is accepted");
          return;
        }
        try {
          let raw = await this.readBody(req);
          if (req.headers["content-encoding"] === "gzip") raw = gunzipSync(raw);
          this.ingest(JSON.parse(raw.toString("utf8")));
          res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
        } catch (err) {
          this.stats.rejectedRequests++;
          res.writeHead(err instanceof RangeError ? 413 : 400).end((err as Error).message);
        }
      })();
    });
  }
}
