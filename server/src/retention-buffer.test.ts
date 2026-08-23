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

describe("RetentionBuffer — reference zone (ROADMAP L5 thinning, 2026-08-22)", () => {
  it("is off by default: an aged-out event is simply gone, not retained anywhere", () => {
    const buf = new RetentionBuffer<RawRec>(extractor, { retentionWindowMs: 1000 });
    buf.observe({ ts: 0, v: 1, $schema: "s" }, "s");
    buf.observe({ ts: 2000, v: 1, $schema: "s" }, "s"); // evicts ts=0
    assert.equal(buf.referenceSize(), 0);
    assert.equal(buf.segment(-Infinity, 500).length, 0, "the aged event must not reappear from anywhere");
  });

  it("rejects configuring one of the pair without the other", () => {
    assert.throws(
      () => new RetentionBuffer<RawRec>(extractor, { retentionWindowMs: 1000, referenceWindowMs: 5000 }),
      /must be set together/,
    );
    assert.throws(
      () => new RetentionBuffer<RawRec>(extractor, { retentionWindowMs: 1000, thinningRatio: 5 }),
      /must be set together/,
    );
  });

  it("rejects a thinningRatio below 2", () => {
    assert.throws(
      () => new RetentionBuffer<RawRec>(extractor, {
        retentionWindowMs: 1000, referenceWindowMs: 5000, thinningRatio: 1,
      }),
      /thinningRatio must be an integer/,
    );
  });

  it("keeps 1 in N aged-out events, weighted at N, count never inflated", () => {
    const buf = new RetentionBuffer<RawRec>(extractor, {
      retentionWindowMs: 100, referenceWindowMs: 1_000_000, thinningRatio: 5,
    });
    // 20 events 100ms apart; each new one evicts the ones that fell 100ms behind it.
    for (let i = 0; i < 20; i++) buf.observe({ ts: i * 100, v: i, $schema: "s" }, "s");
    // 19 events aged out (all but the newest survive in the freshness zone... but
    // retentionWindowMs=100 keeps only the last two on the boundary); assert the
    // reference zone reflects exactly floor(agedCount / 5) kept, each weight 5.
    const agedCount = 20 - buf.size();
    assert.equal(buf.referenceSize(), Math.floor(agedCount / 5));
    for (const e of buf.segment(-Infinity, Infinity)) {
      if (e.weight !== undefined) assert.equal(e.weight, 5, `reference event weight must be exactly the ratio`);
    }
  });

  it("segment() reaches into the reference zone for a span before the freshness zone", () => {
    const buf = new RetentionBuffer<RawRec>(extractor, {
      retentionWindowMs: 1000, referenceWindowMs: 1_000_000, thinningRatio: 2,
    });
    for (let i = 0; i < 40; i++) buf.observe({ ts: i * 100, v: i, $schema: "s" }, "s");
    // ts=0..2900 has long since aged out of a 1000ms freshness window at ts=3900.
    const old = buf.segment(0, 500);
    assert.ok(old.length > 0, "the reference zone must answer for a span the freshness zone no longer covers");
    assert.ok(old.every((e) => e.weight === 2), "every event recovered from the reference zone is thinned");
  });

  it("the reference zone is itself bounded — it does not accumulate forever", () => {
    const buf = new RetentionBuffer<RawRec>(extractor, {
      retentionWindowMs: 100, referenceWindowMs: 500, thinningRatio: 2,
    });
    for (let i = 0; i < 200; i++) buf.observe({ ts: i * 10, v: i, $schema: "s" }, "s");
    // referenceWindowMs=500 over ts steps of 10ms, thinned 1-in-2 ⇒ retained
    // reference span covers ~500ms of THINNED ts, i.e. ~25 kept events, not 100.
    assert.ok(buf.referenceSize() < 40, `reference zone grew unbounded: ${buf.referenceSize()} events`);
  });

  it("replaying a reference-zone-only span through applyLens produces real, weighted WindowStats", () => {
    // Ties the retention-buffer plumbing to lens.ts's weighted aggregate end to end:
    // a window built entirely from thinned events must report its true (small)
    // count alongside a weights field, not a plain unweighted window.
    const buf = new RetentionBuffer<RawRec>(extractor, {
      retentionWindowMs: 200, referenceWindowMs: 1_000_000, thinningRatio: 4,
    });
    for (let i = 0; i < 100; i++) buf.observe({ ts: i * 50, v: 1, $schema: "s" }, "s");
    const r = buf.replay({ window_ms: 1_000_000 }, -Infinity, 500); // well before the freshness zone
    assert.equal(r.windows.length, 1);
    const win = r.windows[0];
    assert.ok(win.count > 0 && win.count < 3, `count must reflect actually-retained events, got ${win.count}`);
    assert.ok(win.weights !== undefined, "a reference-zone-only window must carry weights");
    assert.ok(Math.abs(win.mean - 1) < 1e-9, "thinning must not bias the mean for a constant-value stream");
  });
});

describe("RetentionBuffer — reference zone dynamic config (ROADMAP L5, 2026-08-23)", () => {
  it("getters report undefined when the reference zone was never configured", () => {
    const buf = new RetentionBuffer<RawRec>(extractor, { retentionWindowMs: 1000 });
    assert.equal(buf.getReferenceWindowMs(), undefined);
    assert.equal(buf.getThinningRatio(), undefined);
  });

  it("setReferenceWindowMs/setThinningRatio throw on a buffer that never opted in", () => {
    const buf = new RetentionBuffer<RawRec>(extractor, { retentionWindowMs: 1000 });
    assert.throws(() => buf.setReferenceWindowMs(5000), /not configured at construction/);
    assert.throws(() => buf.setThinningRatio(3), /not configured at construction/);
  });

  it("setReferenceWindowMs resizes an existing zone and evicts what no longer fits", () => {
    const buf = new RetentionBuffer<RawRec>(extractor, {
      retentionWindowMs: 100, referenceWindowMs: 1_000_000, thinningRatio: 2,
    });
    for (let i = 0; i < 200; i++) buf.observe({ ts: i * 10, v: i, $schema: "s" }, "s");
    const before = buf.referenceSize();
    assert.ok(before > 0);

    buf.setReferenceWindowMs(500);
    assert.equal(buf.getReferenceWindowMs(), 500);
    assert.ok(buf.referenceSize() < before, "narrowing must evict what no longer fits the new width");
  });

  it("setReferenceWindowMs rejects a non-positive width", () => {
    const buf = new RetentionBuffer<RawRec>(extractor, {
      retentionWindowMs: 100, referenceWindowMs: 1000, thinningRatio: 2,
    });
    assert.throws(() => buf.setReferenceWindowMs(0), /must be positive/);
  });

  it("setThinningRatio changes the ratio for events that age out AFTER the call, not retroactively", () => {
    const buf = new RetentionBuffer<RawRec>(extractor, {
      retentionWindowMs: 100, referenceWindowMs: 1_000_000, thinningRatio: 5,
    });
    for (let i = 0; i < 30; i++) buf.observe({ ts: i * 10, v: i, $schema: "s" }, "s");
    // Everything thinned so far was kept under ratio 5.
    for (const e of buf.segment(-Infinity, Infinity)) {
      if (e.weight !== undefined) assert.equal(e.weight, 5);
    }

    buf.setThinningRatio(2);
    assert.equal(buf.getThinningRatio(), 2);
    for (let i = 30; i < 60; i++) buf.observe({ ts: i * 10, v: i, $schema: "s" }, "s");

    const weights = new Set(buf.segment(-Infinity, Infinity).map((e) => e.weight).filter((w) => w !== undefined));
    assert.ok(weights.has(5), "events thinned before the change keep their old weight");
    assert.ok(weights.has(2), "events thinned after the change use the new ratio");
  });

  it("setThinningRatio rejects a ratio below 2 or a non-integer", () => {
    const buf = new RetentionBuffer<RawRec>(extractor, {
      retentionWindowMs: 100, referenceWindowMs: 1000, thinningRatio: 2,
    });
    assert.throws(() => buf.setThinningRatio(1), /integer >= 2/);
    assert.throws(() => buf.setThinningRatio(2.5), /integer >= 2/);
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
