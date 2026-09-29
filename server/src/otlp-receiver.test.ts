import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { OtlpReceiver, parseTraces, probabilityFromTraceState } from "./otlp-receiver.js";
import { loadOtelDir } from "./real-data-harness.js";

const NS = 1_000_000n;
const span = (over: Record<string, unknown> = {}) => ({
  traceId: "t1", spanId: "s1", name: "POST /pay", kind: 2,
  startTimeUnixNano: String(BigInt(1_800_000_000_000) * NS),
  endTimeUnixNano: String(BigInt(1_800_000_000_500) * NS),
  status: { code: 1 },
  ...over,
});
const request = (spans: unknown[], service = "payment") => ({
  resourceSpans: [{
    resource: { attributes: [{ key: "service.name", value: { stringValue: service } }] },
    scopeSpans: [{ spans }],
  }],
});

describe("tracestate sampling probability", () => {
  it("reads the OTEP 235 rejection threshold as p = 1 − th/2^56", () => {
    assert.equal(probabilityFromTraceState("ot=th:8"), 0.5);
    assert.equal(probabilityFromTraceState("ot=th:0"), 1);
    const p = probabilityFromTraceState("vendor=x,ot=rv:abc;th:e6666666666666") as number;
    assert.ok(Math.abs(p - 0.1) < 1e-9, `p = ${p}`);
  });
  it("returns undefined for absent or unparseable values rather than guessing", () => {
    assert.equal(probabilityFromTraceState(undefined), undefined);
    assert.equal(probabilityFromTraceState("vendor=x"), undefined);
    assert.equal(probabilityFromTraceState("ot=th:zz"), undefined);
    assert.equal(probabilityFromTraceState("ot=th:123456789012345"), undefined); // 15 digits
  });
});

describe("parseTraces", () => {
  it("maps ERROR → value 0 (int or enum name), else 1; ts is the span END; service and op come along", () => {
    const r = parseTraces(request([
      span({ spanId: "a", status: { code: 2 } }),
      span({ spanId: "b", status: { code: "STATUS_CODE_ERROR" } }),
      span({ spanId: "c", status: { code: 0 } }),
      span({ spanId: "d", status: { code: 1 }, kind: "SPAN_KIND_CLIENT" }),
    ]));
    assert.deepEqual(r.records.map((x) => x.value), [0, 0, 1, 1]);
    assert.equal(r.records[0].ts, 1_800_000_000_500);
    assert.equal(r.records[0].service, "payment");
    assert.equal(r.records[0].op, "POST /pay");
    assert.equal(r.records[3].kind, 3);
  });
  it("weight = 1/p from tracestate, else from sampling.probability, else 1; a broken th is counted", () => {
    const r = parseTraces(request([
      span({ spanId: "a", traceState: "ot=th:8" }),
      span({ spanId: "b", attributes: [{ key: "sampling.probability", value: { doubleValue: 0.1 } }] }),
      span({ spanId: "c" }),
      span({ spanId: "d", traceState: "ot=th:zz" }),
    ]));
    assert.deepEqual(r.records.map((x) => x.weight), [2, 10, 1, 1]);
    assert.equal(r.badWeight, 1);
  });
  it("counts spans it cannot read instead of inventing a value", () => {
    const r = parseTraces(request([span({ endTimeUnixNano: "0" }), span({ name: 5 }), span({ spanId: "ok" })]));
    assert.equal(r.records.length, 1);
    assert.equal(r.malformed, 2);
  });
});

describe("OtlpReceiver", () => {
  it("writes a day file, drops a retried batch by span id, and records an event-time hole as a gap", () => {
    const dir = mkdtempSync(join(tmpdir(), "otel-"));
    const rx = new OtlpReceiver({ dir, now: () => Date.UTC(2026, 9, 1, 12), gapToleranceMs: 30_000 });
    const t = (ms: number) => String(BigInt(1_800_000_000_000 + ms) * NS);
    rx.ingest(request([span({ spanId: "a", endTimeUnixNano: t(0) }), span({ spanId: "b", endTimeUnixNano: t(1000) })]));
    rx.ingest(request([span({ spanId: "b", endTimeUnixNano: t(1000) })])); // exporter retry
    rx.ingest(request([span({ spanId: "c", endTimeUnixNano: t(120_000) })])); // 2 min later
    assert.equal(rx.stats.written, 3);
    assert.equal(rx.stats.duplicates, 1);
    assert.equal(rx.stats.gaps, 1);
    const lines = readFileSync(join(dir, "2026-10-01.jsonl"), "utf8").trim().split("\n");
    assert.equal(lines.length, 3);
    const gap = JSON.parse(readFileSync(join(dir, "gaps.jsonl"), "utf8").trim());
    assert.deepEqual([gap.kind, gap.fromTs, gap.toTs], ["gap", 1_800_000_001_000, 1_800_000_120_000]);
  });

  it("HTTP: JSON (plain or gzip) is taken; protobuf gets 415; other paths 404", async () => {
    const dir = mkdtempSync(join(tmpdir(), "otel-"));
    const rx = new OtlpReceiver({ dir });
    const server = rx.createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const body = JSON.stringify(request([span({ spanId: "a" })]));
      const ok = await fetch(`${base}/v1/traces`, { method: "POST", headers: { "content-type": "application/json" }, body });
      assert.equal(ok.status, 200);
      const gz = await fetch(`${base}/v1/traces`, {
        method: "POST",
        headers: { "content-type": "application/json", "content-encoding": "gzip" },
        body: gzipSync(JSON.stringify(request([span({ spanId: "b" })]))),
      });
      assert.equal(gz.status, 200);
      const proto = await fetch(`${base}/v1/traces`, { method: "POST", headers: { "content-type": "application/x-protobuf" }, body: "x" });
      assert.equal(proto.status, 415);
      assert.equal((await fetch(`${base}/nope`, { method: "POST" })).status, 404);
      assert.equal(rx.stats.written, 2);
      assert.equal(rx.stats.rejectedRequests, 1);
    } finally {
      server.close();
    }
  });

  it("the replay loader reads what the receiver wrote, with weights and gaps", async () => {
    const dir = mkdtempSync(join(tmpdir(), "otel-"));
    const rx = new OtlpReceiver({ dir, now: () => Date.UTC(2026, 9, 1, 12) });
    rx.ingest(request([
      span({ spanId: "a", traceState: "ot=th:8" }),
      span({ spanId: "b", status: { code: 2 } }),
    ]));
    assert.ok(existsSync(join(dir, "2026-10-01.jsonl")));
    const s = await loadOtelDir(dir);
    assert.equal(s.events.length, 2);
    assert.deepEqual(s.events.map((e) => e.value).sort(), [0, 1]);
    assert.deepEqual(s.events[0].keys, { service: "payment", op: "POST /pay" });
    assert.equal(s.events.find((e) => e.value === 1)?.weight, 2);
    assert.equal(s.events.find((e) => e.value === 0)?.weight, undefined);
  });
});
