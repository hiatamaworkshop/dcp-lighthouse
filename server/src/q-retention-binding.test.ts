/**
 * Tests for the $Q[pipeline] → RetentionBuffer binding.
 *
 * Mirrors q-collector-binding.test.ts: mostly against a stub, with one case
 * binding a real RetentionBuffer to prove the wire works against the actual
 * class (the failure this guards is a method-name drift between the narrow
 * RetentionControllable interface and RetentionBuffer itself).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { QRegistry } from "./q-registry.js";
import { RetentionBuffer } from "./retention-buffer.js";
import { bindPipelineRetention, type RetentionControllable } from "./q-retention-binding.js";
import type { LensEvent } from "./lens.js";

class FakeBuffer implements RetentionControllable {
  setCalls = 0;
  constructor(public width = 60_000) {}
  getRetentionWindowMs(): number { return this.width; }
  setRetentionWindowMs(ms: number): void { this.setCalls++; this.width = ms; }
}

/**
 * A FakeBuffer whose reference zone IS configured (referenceWidth/ratio start
 * defined, mirroring a RetentionBuffer constructed with
 * referenceWindowMs/thinningRatio). Kept separate from FakeBuffer above,
 * which has no reference-zone methods at all — exercising both the "target
 * lacks the optional methods" and "target has them but never opted in" paths
 * needs two different shapes, not one flag.
 */
class FakeReferenceBuffer extends FakeBuffer {
  refSetCalls = 0;
  ratioSetCalls = 0;
  // No default parameter values: passing `undefined` explicitly must mean
  // "not configured", and a default value would silently substitute for it
  // (JS applies a parameter default on an explicit `undefined` argument the
  // same as on an omitted one).
  constructor(width: number, public referenceWidth: number | undefined, public ratio: number | undefined) {
    super(width);
  }
  getReferenceWindowMs(): number | undefined { return this.referenceWidth; }
  setReferenceWindowMs(ms: number): void { this.refSetCalls++; this.referenceWidth = ms; }
  getThinningRatio(): number | undefined { return this.ratio; }
  setThinningRatio(ratio: number): void { this.ratioSetCalls++; this.ratio = ratio; }
}

/** Silence the binding's console.warn for the duration of `fn`, returning it. */
function captureWarn(fn: () => void): string[] {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { lines.push(args.join(" ")); };
  try { fn(); } finally { console.warn = original; }
  return lines;
}

describe("bindPipelineRetention — initial apply", () => {
  it("applies the current $Q[pipeline] retention at bind time", () => {
    const q = new QRegistry();
    q.set("pipeline:*", { retention_window_ms: 30_000 });
    const b = new FakeBuffer(60_000);
    bindPipelineRetention(q, b);
    assert.equal(b.width, 30_000);
  });

  it("leaves the buffer untouched when $Q has no opinion", () => {
    const q = new QRegistry();
    q.set("pipeline:*", { stream_rate_cap: 100 });
    const b = new FakeBuffer(60_000);
    bindPipelineRetention(q, b);
    assert.equal(b.width, 60_000);
    assert.equal(b.setCalls, 0);
  });
});

describe("bindPipelineRetention — live re-sizing", () => {
  it("follows a later $Q write", () => {
    const q = new QRegistry();
    q.set("pipeline:*", { retention_window_ms: 30_000 });
    const b = new FakeBuffer();
    bindPipelineRetention(q, b);
    q.set("pipeline:*", { retention_window_ms: 90_000 });
    assert.equal(b.width, 90_000);
  });

  it("ignores writes to another layer or another target", () => {
    const q = new QRegistry();
    q.set("pipeline:*", { retention_window_ms: 30_000 });
    const b = new FakeBuffer();
    bindPipelineRetention(q, b);
    const after = b.setCalls;
    q.set("observe:s:v1", { window_ms: 500 });
    q.set("pipeline:other:v1", { retention_window_ms: 1_000 });
    assert.equal(b.setCalls, after);
    assert.equal(b.width, 30_000);
  });

  it("does not re-set (and so does not re-evict) on an unchanged value", () => {
    const q = new QRegistry();
    q.set("pipeline:*", { retention_window_ms: 30_000 });
    const b = new FakeBuffer();
    bindPipelineRetention(q, b);
    const after = b.setCalls;
    q.set("pipeline:*", { retention_window_ms: 30_000 });
    assert.equal(b.setCalls, after);
  });

  it("stops following after unbind", () => {
    const q = new QRegistry();
    q.set("pipeline:*", { retention_window_ms: 30_000 });
    const b = new FakeBuffer();
    const unbind = bindPipelineRetention(q, b);
    unbind();
    q.set("pipeline:*", { retention_window_ms: 90_000 });
    assert.equal(b.width, 30_000);
  });
});

describe("bindPipelineRetention — invalid values", () => {
  it("refuses a non-positive width without throwing at the writer", () => {
    // RetentionBuffer.setRetentionWindowMs throws RangeError on <= 0. $Q's
    // listeners run synchronously inside set(), so letting that escape would
    // abort the write for every listener registered after this one and surface
    // in whoever proposed the row — a Brain could take down the tick loop with
    // one bad number.
    const q = new QRegistry();
    q.set("pipeline:*", { retention_window_ms: 30_000 });
    const b = new FakeBuffer();
    bindPipelineRetention(q, b);

    let laterListenerRan = false;
    q.onChange(() => { laterListenerRan = true; });

    const warnings = captureWarn(() => {
      assert.doesNotThrow(() => q.set("pipeline:*", { retention_window_ms: 0 }));
    });

    assert.equal(b.width, 30_000, "buffer keeps its last good width");
    assert.equal(warnings.length, 1, "the refusal is said out loud");
    assert.ok(laterListenerRan, "listeners after this one still ran");
  });
});

describe("bindPipelineRetention — against the real RetentionBuffer", () => {
  it("resizes a live buffer and evicts what no longer fits", () => {
    const q = new QRegistry();
    const buf = new RetentionBuffer<LensEvent>((raw) => raw, { retentionWindowMs: 10_000 });
    for (let ts = 0; ts <= 10_000; ts += 1_000) buf.observe({ ts, value: 1 }, "s:v1");
    assert.equal(buf.size(), 11);

    q.set("pipeline:*", { retention_window_ms: 3_000 });
    bindPipelineRetention(q, buf);

    assert.equal(buf.getRetentionWindowMs(), 3_000);
    // Eviction is anchored to the newest event's ts (ts=10_000), keeping
    // [7_000, 10_000] — the resize takes effect immediately, not at next push.
    assert.equal(buf.size(), 4);
  });
});

// ── reference zone dynamic config (ROADMAP L5, 2026-08-23) ──────────────────

describe("bindPipelineRetention — reference zone: initial apply", () => {
  it("applies reference_window_ms and reference_thinning_ratio at bind time", () => {
    const q = new QRegistry();
    q.set("pipeline:*", { reference_window_ms: 900_000, reference_thinning_ratio: 5 });
    const b = new FakeReferenceBuffer(60_000, 600_000, 2);
    bindPipelineRetention(q, b);
    assert.equal(b.referenceWidth, 900_000);
    assert.equal(b.ratio, 5);
  });

  it("leaves an unconfigured-reference-zone buffer alone (no method on the target)", () => {
    const q = new QRegistry();
    q.set("pipeline:*", { reference_window_ms: 900_000, reference_thinning_ratio: 5 });
    const b = new FakeBuffer(60_000); // no reference-zone methods at all
    assert.doesNotThrow(() => bindPipelineRetention(q, b));
  });

  it("refuses to turn a reference zone on from cold, without throwing", () => {
    const q = new QRegistry();
    q.set("pipeline:*", { reference_window_ms: 900_000, reference_thinning_ratio: 5 });
    // Methods exist but the zone was never configured (undefined start state) —
    // the buffer this models is a real RetentionBuffer built without
    // referenceWindowMs/thinningRatio.
    const b = new FakeReferenceBuffer(60_000, undefined, undefined);
    const warnings = captureWarn(() => bindPipelineRetention(q, b));
    assert.equal(b.referenceWidth, undefined);
    assert.equal(b.ratio, undefined);
    assert.equal(b.refSetCalls, 0);
    assert.equal(b.ratioSetCalls, 0);
    assert.equal(warnings.length, 2, "one refusal each for width and ratio");
  });
});

describe("bindPipelineRetention — reference zone: live re-sizing and invalid values", () => {
  it("follows a later $Q write", () => {
    const q = new QRegistry();
    const b = new FakeReferenceBuffer(60_000, 600_000, 2);
    bindPipelineRetention(q, b);
    q.set("pipeline:*", { reference_window_ms: 1_200_000, reference_thinning_ratio: 10 });
    assert.equal(b.referenceWidth, 1_200_000);
    assert.equal(b.ratio, 10);
  });

  it("does not re-set on an unchanged value", () => {
    const q = new QRegistry();
    q.set("pipeline:*", { reference_window_ms: 600_000, reference_thinning_ratio: 2 });
    const b = new FakeReferenceBuffer(60_000, 600_000, 2);
    bindPipelineRetention(q, b);
    const refAfter = b.refSetCalls;
    const ratioAfter = b.ratioSetCalls;
    q.set("pipeline:*", { reference_window_ms: 600_000, reference_thinning_ratio: 2 });
    assert.equal(b.refSetCalls, refAfter);
    assert.equal(b.ratioSetCalls, ratioAfter);
  });

  it("refuses a non-positive reference_window_ms without throwing", () => {
    const q = new QRegistry();
    const b = new FakeReferenceBuffer(60_000, 600_000, 2);
    bindPipelineRetention(q, b);
    const warnings = captureWarn(() => q.set("pipeline:*", { reference_window_ms: 0 }));
    assert.equal(b.referenceWidth, 600_000, "zone keeps its last good width");
    assert.equal(warnings.length, 1);
  });

  it("refuses a thinning ratio below 2 or non-integer without throwing", () => {
    const q = new QRegistry();
    const b = new FakeReferenceBuffer(60_000, 600_000, 2);
    bindPipelineRetention(q, b);
    const warnings = captureWarn(() => {
      q.set("pipeline:*", { reference_thinning_ratio: 1 });
      q.set("pipeline:*", { reference_thinning_ratio: 2.5 });
    });
    assert.equal(b.ratio, 2, "ratio keeps its last good value");
    assert.equal(warnings.length, 2);
  });
});

describe("bindPipelineRetention — reference zone: against the real RetentionBuffer", () => {
  it("resizes a live reference zone and evicts what no longer fits it", () => {
    const q = new QRegistry();
    const buf = new RetentionBuffer<LensEvent>((raw) => raw, {
      retentionWindowMs: 1_000,
      referenceWindowMs: 100_000,
      thinningRatio: 2,
    });
    // Push enough events, spaced 100ms apart, that plenty age out of the 1s
    // freshness zone and thin into the reference zone.
    for (let ts = 0; ts <= 50_000; ts += 100) buf.observe({ ts, value: 1 }, "s:v1");
    const before = buf.referenceSize();
    assert.ok(before > 0, "reference zone must hold something before the resize");

    q.set("pipeline:*", { reference_window_ms: 5_000 });
    bindPipelineRetention(q, buf);

    assert.equal(buf.getReferenceWindowMs(), 5_000);
    assert.ok(buf.referenceSize() < before, "narrowing the window must evict what no longer fits");
  });

  it("refuses to turn a real buffer's reference zone on from cold", () => {
    // RetentionBuffer always exposes the reference-zone methods, but a
    // buffer built without referenceWindowMs/thinningRatio reports
    // getReferenceWindowMs()/getThinningRatio() as undefined — the same
    // "not configured at construction" signal the stub tests above check,
    // now against the real class.
    const q = new QRegistry();
    const buf = new RetentionBuffer<LensEvent>((raw) => raw, { retentionWindowMs: 10_000 });
    q.set("pipeline:*", { reference_window_ms: 5_000, reference_thinning_ratio: 3 });
    const warnings = captureWarn(() => bindPipelineRetention(q, buf));
    assert.equal(buf.getReferenceWindowMs(), undefined);
    assert.equal(warnings.length, 2);
  });
});
