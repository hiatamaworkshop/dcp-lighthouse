/**
 * RetentionBuffer + retroactive re-observation harness (Phase 0 Step 2).
 *
 * The harness records injected ground truth (baseline + burst delta + timing),
 * then checks that re-observing the retained segment under a fine lens recovers
 * the burst the coarse lens averaged away — matching the aggregate the injected
 * truth predicts *for that lens*. This is the §1.5 / CLAUDE.md Step 2 criterion:
 * a new lens on old data, NOT variance shrinking from repetition.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { IngestionBus } from "dcp-wrap";
import { RetentionBuffer, type EventExtractor } from "./retention-buffer.js";
import type { LensEvent } from "./lens.js";

// ── Known-truth stream generator (domain-independent, Phase 0) ──────────────
// Baseline events every stepMs over [0, durationMs). A burst from burstStart for
// burstDurMs raises value to burstValue. Every fact is held so the expected
// per-lens aggregate is computable.

interface InjectedTruth {
  baselineValue: number;
  burstValue: number;
  burstStart: number;
  burstDurMs: number;
  stepMs: number;
  durationMs: number;
}

function generate(truth: InjectedTruth): LensEvent[] {
  const out: LensEvent[] = [];
  for (let ts = 0; ts < truth.durationMs; ts += truth.stepMs) {
    const inBurst = ts >= truth.burstStart && ts < truth.burstStart + truth.burstDurMs;
    out.push({ ts, value: inBurst ? truth.burstValue : truth.baselineValue });
  }
  return out;
}

interface RawRec { ts: number; v: number; $schema: string }
const extractor: EventExtractor<RawRec> = (raw) => ({ ts: raw.ts, value: raw.v });

describe("RetentionBuffer — tap ingestion + eviction", () => {
  it("retains events fed through IngestionBus.tap", () => {
    const bus = new IngestionBus<RawRec>();
    const buf = new RetentionBuffer<RawRec>(extractor, { retentionWindowMs: 10_000 });
    bus.tap(buf.observe);
    bus.push({ ts: 0, v: 1, $schema: "s:v1" }, "s:v1");
    bus.push({ ts: 100, v: 2, $schema: "s:v1" }, "s:v1");
    assert.equal(buf.size(), 2);
  });

  it("evicts events older than the freshness window (anchored to newest ts)", () => {
    const buf = new RetentionBuffer<RawRec>(extractor, { retentionWindowMs: 1000 });
    buf.observe({ ts: 0, v: 1, $schema: "s" }, "s");
    buf.observe({ ts: 500, v: 1, $schema: "s" }, "s");
    buf.observe({ ts: 2000, v: 1, $schema: "s" }, "s"); // newest=2000, cutoff=1000
    assert.equal(buf.size(), 1);
    assert.equal(buf.segment()[0].ts, 2000);
  });

  it("does not extract records the extractor rejects", () => {
    const buf = new RetentionBuffer<RawRec>(() => null, { retentionWindowMs: 1000 });
    buf.observe({ ts: 0, v: 1, $schema: "s" }, "s");
    assert.equal(buf.size(), 0);
  });
});

describe("RetentionBuffer — retroactive re-observation (RC criterion)", () => {
  const truth: InjectedTruth = {
    baselineValue: 0.5,
    burstValue: 3.5,
    burstStart: 10_000,
    burstDurMs: 1000,
    stepMs: 100,        // 10 events/sec
    durationMs: 30_000,
  };

  const load = (): RetentionBuffer<RawRec> => {
    const buf = new RetentionBuffer<RawRec>(extractor, { retentionWindowMs: 60_000 });
    for (const e of generate(truth)) {
      buf.observe({ ts: e.ts, v: e.value, $schema: "s:v1" }, "s:v1");
    }
    return buf;
  };

  it("coarse lens averages the burst into the background", () => {
    const buf = load();
    const r = buf.replay({ window_ms: 30_000 });
    assert.equal(r.windows.length, 1);
    const total = truth.durationMs / truth.stepMs;            // 300 events
    const burstN = truth.burstDurMs / truth.stepMs;           // 10 events
    const expectedMean =
      ((total - burstN) * truth.baselineValue + burstN * truth.burstValue) / total;
    assert.ok(Math.abs(r.windows[0].mean - expectedMean) < 1e-9);
    assert.ok(r.windows[0].mean < 0.65, `coarse mean ${r.windows[0].mean} should hide the burst`);
  });

  it("fine lens recovers the burst at the known window with the known magnitude", () => {
    const buf = load();
    const r = buf.replay({ window_ms: 1000 });
    const burstWin = r.windows.find((w) => w.windowStart === truth.burstStart);
    assert.ok(burstWin, "a window should align to the burst start");
    assert.ok(Math.abs(burstWin!.mean - truth.burstValue) < 1e-9,
      `recovered mean ${burstWin!.mean} should equal injected burstValue ${truth.burstValue}`);
    assert.equal(burstWin!.count, truth.burstDurMs / truth.stepMs);
    const before = r.windows.find((w) => w.windowStart === truth.burstStart - 1000);
    const after = r.windows.find((w) => w.windowStart === truth.burstStart + 1000);
    assert.ok(Math.abs(before!.mean - truth.baselineValue) < 1e-9);
    assert.ok(Math.abs(after!.mean - truth.baselineValue) < 1e-9);
  });

  it("re-observing a bounded segment isolates the burst region", () => {
    const buf = load();
    const r = buf.replay({ window_ms: 1000 }, truth.burstStart, truth.burstStart + truth.burstDurMs - 1);
    assert.equal(r.windows.length, 1);
    assert.ok(Math.abs(r.windows[0].mean - truth.burstValue) < 1e-9);
  });

  it("replay is repeatable and non-destructive (same lens → same result)", () => {
    const buf = load();
    const a = buf.replay({ window_ms: 1000 });
    const b = buf.replay({ window_ms: 1000 });
    assert.deepEqual(a, b);
    assert.equal(buf.size(), truth.durationMs / truth.stepMs);
  });
});
