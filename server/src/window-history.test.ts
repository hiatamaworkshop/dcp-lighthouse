import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RetentionBuffer } from "./retention-buffer.js";
import { WindowHistory } from "./window-history.js";
import { applyLens, type LensEvent } from "./lens.js";
import { mulberry32 } from "./calibration.js";
import type { QObserveParams } from "./q-registry.js";

/** A pass/fail stream over [0, durationMs), `perSec` events a second, agents A–D. */
function stream(durationMs: number, perSec: number, seed = 1): LensEvent[] {
  const rng = mulberry32(seed);
  const out: LensEvent[] = [];
  const step = 1_000 / perSec;
  for (let ts = 0; ts < durationMs; ts += step) {
    const agentId = `agent-${"ABCD"[Math.floor(rng() * 4)]}`;
    out.push({ ts: Math.floor(ts), value: rng() < 0.9 ? 1 : 0, keys: { agentId } });
  }
  return out;
}

function thinnedBuffer(): RetentionBuffer<LensEvent> {
  return new RetentionBuffer<LensEvent>((raw) => raw, {
    retentionWindowMs: 20_000,
    referenceWindowMs: 200_000,
    thinningRatio: 2,
  });
}

const fine: QObserveParams = { window_ms: 1_000, align: "epoch", group_by: ["agentId"] };

describe("WindowHistory", () => {
  it("answers with exactly the windows a full-resolution replay cuts, though the buffer thinned what aged out", () => {
    const events = stream(120_000, 50);
    const buffer = thinnedBuffer();
    const history = new WindowHistory(buffer, { maxHistoryMs: 3_600_000 });
    history.track(fine);
    for (const e of events) buffer.observe(e, "s");

    const got = history.history(fine, 10_000, 115_999);
    const want = applyLens(events.filter((e) => e.ts >= 10_000 && e.ts <= 115_999), fine);
    assert.deepEqual(got, want);
    // The buffer itself cannot: its older part is thinned and weighted.
    assert.notDeepEqual(buffer.replay(fine, 10_000, 115_999), want);
    assert.ok(got.windows.every((w) => w.weights === undefined));
  });

  it("keeps a downsampled lens on its output grid", () => {
    const events = stream(90_000, 50, 2);
    const buffer = thinnedBuffer();
    const history = new WindowHistory(buffer, { maxHistoryMs: 3_600_000 });
    const lens: QObserveParams = { window_ms: 1_000, align: "epoch", downsample_factor: 5 };
    history.track(lens);
    for (const e of events) buffer.observe(e, "s");
    assert.deepEqual(history.history(lens, 0, 84_999), applyLens(events.filter((e) => e.ts < 85_000), lens));
  });

  it("starts a lens tracked late at the freshness zone's first whole window", () => {
    const events = stream(60_000, 50, 3);
    const buffer = thinnedBuffer();
    const history = new WindowHistory(buffer, { maxHistoryMs: 3_600_000 });
    for (const e of events.slice(0, 2_000)) buffer.observe(e, "s"); // to ts ≈ 40 s; cutoff ≈ 20 s
    history.track(fine);
    for (const e of events.slice(2_000)) buffer.observe(e, "s");

    const got = history.history(fine, 0, 59_999);
    assert.equal(got.windows[0].windowStart, 20_000);
    assert.deepEqual(got, applyLens(events.filter((e) => e.ts >= 20_000), fine));
  });

  it("drops stored windows older than maxHistoryMs", () => {
    const events = stream(120_000, 20, 4);
    const buffer = thinnedBuffer();
    const history = new WindowHistory(buffer, { maxHistoryMs: 30_000 });
    const lens: QObserveParams = { window_ms: 1_000, align: "epoch" };
    history.track(lens);
    for (const e of events) buffer.observe(e, "s");
    // Last event 119.95 s → cutoff 99.95 s → summarized up to 99 s, kept from 30 s before that.
    const got = history.history(lens, 0, 119_999);
    assert.equal(got.windows[0].windowStart, 69_000);
  });

  it("counts an aged event that fell behind a window already summarized, and leaves the summary alone", () => {
    const buffer = thinnedBuffer();
    const history = new WindowHistory(buffer, { maxHistoryMs: 3_600_000 });
    const lens: QObserveParams = { window_ms: 1_000, align: "epoch" };
    history.track(lens);
    for (let ts = 0; ts < 40_000; ts += 100) buffer.observe({ ts, value: 1 }, "s");
    const before = history.history(lens, 0, 9_999);
    // Older than the cutoff. Eviction walks from the front in arrival order, so
    // it ages out once everything that arrived before it has.
    buffer.observe({ ts: 5_050, value: 0 }, "s");
    for (let ts = 40_000; ts <= 60_000; ts += 100) buffer.observe({ ts, value: 1 }, "s");
    assert.deepEqual(history.history(lens, 0, 9_999), before);
    assert.equal(history.getStats().lateDropped, 1);
  });

  it("refuses a lens whose windows cannot be summarized once and reused", () => {
    const history = new WindowHistory(thinnedBuffer(), { maxHistoryMs: 60_000 });
    assert.throws(() => history.track({ window_ms: 1_000 }), /align:"epoch"/);
    assert.throws(() => history.track({ window_ms: 1_000, align: "epoch", decay: "step(60s)" }), /decay/);
    assert.throws(() => history.track({ window_ms: 1_000, align: "epoch", agg_func: "median" }), /median/);
  });

  it("shares one history between rows naming the same lens differently, and drops the least recently used past maxLenses", () => {
    const history = new WindowHistory(thinnedBuffer(), { maxHistoryMs: 60_000, maxLenses: 2 });
    history.track({ window_ms: 1_000, origin: 0 });
    history.track({ window_ms: 1_000, align: "epoch", fromTs: 5, toTs: 9 } as QObserveParams);
    assert.equal(history.getStats().lenses, 1);
    history.track({ window_ms: 2_000, align: "epoch" });
    history.track({ window_ms: 1_000, align: "epoch" }); // touch: the 2 s lens is now the oldest
    history.track({ window_ms: 5_000, align: "epoch" });
    assert.equal(history.getStats().lenses, 2);
  });
});
