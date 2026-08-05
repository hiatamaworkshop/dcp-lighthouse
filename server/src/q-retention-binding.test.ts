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
