/** applyLens unit tests (Phase 0 Step 2). */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyLens, type LensEvent } from "./lens.js";

const ev = (ts: number, value: number): LensEvent => ({ ts, value });

describe("applyLens — windowing", () => {
  it("returns no windows for an empty segment", () => {
    const r = applyLens([], { window_ms: 1000 });
    assert.deepEqual(r.windows, []);
    assert.equal(r.window_ms, 1000);
  });

  it("aggregates a single window's mean and count", () => {
    const r = applyLens([ev(0, 1), ev(100, 3), ev(200, 5)], { window_ms: 1000 });
    assert.equal(r.windows.length, 1);
    assert.equal(r.windows[0].count, 3);
    assert.equal(r.windows[0].mean, 3); // (1+3+5)/3
  });

  it("splits events into half-open windows aligned to the first ts", () => {
    const r = applyLens([ev(0, 1), ev(999, 1), ev(1000, 10)], { window_ms: 1000 });
    assert.equal(r.windows.length, 2);
    assert.deepEqual([r.windows[0].windowStart, r.windows[0].windowEnd], [0, 1000]);
    assert.equal(r.windows[0].count, 2);
    assert.deepEqual([r.windows[1].windowStart, r.windows[1].windowEnd], [1000, 2000]);
    assert.equal(r.windows[1].mean, 10);
  });

  it("omits empty windows (a gap shows as a time jump between windows)", () => {
    // events at t=0 and t=5000 with window 1000 → windows at [0,1000) and [5000,6000)
    const r = applyLens([ev(0, 1), ev(5000, 1)], { window_ms: 1000 });
    assert.equal(r.windows.length, 2);
    assert.equal(r.windows[0].windowStart, 0);
    assert.equal(r.windows[1].windowStart, 5000);
  });

  it("is order-independent: ts-driven aggregation matches in-order", () => {
    const inOrder = applyLens([ev(0, 2), ev(100, 4), ev(1000, 6)], { window_ms: 1000 });
    const shuffled = applyLens([ev(1000, 6), ev(0, 2), ev(100, 4)], { window_ms: 1000 });
    assert.deepEqual(shuffled, inOrder);
  });

  it("defaults window_ms when the lens omits it", () => {
    const r = applyLens([ev(0, 1)]);
    assert.equal(r.window_ms, 1000);
  });

  it("rejects a non-positive window", () => {
    assert.throws(() => applyLens([ev(0, 1)], { window_ms: 0 }), /positive/);
  });
});
