/**
 * LensView + ObservationOverlay tests (Phase 0 Step 3):
 * parallel overlays, tuning interruption, dynamic dataset addition.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { QRegistry } from "./q-registry.js";
import { LensView, ObservationOverlay } from "./lens-view.js";
import type { LensEvent } from "./lens.js";

const ev = (ts: number, value: number): LensEvent => ({ ts, value });

describe("LensView — derives under its own lens", () => {
  it("uses the schema's $Q[observe] window", () => {
    const q = new QRegistry();
    q.set("observe:s:v1", { window_ms: 1000 });
    const v = new LensView(q, "s:v1");
    v.push(ev(0, 2));
    v.push(ev(100, 4));
    v.push(ev(1000, 6));
    const r = v.current();
    assert.equal(r.window_ms, 1000);
    assert.equal(r.windows.length, 2);   // [0,1000) and [1000,2000)
    assert.equal(r.windows[0].mean, 3);  // (2+4)/2
    assert.equal(r.windows[1].mean, 6);
  });

  it("resolves a #view lens", () => {
    const q = new QRegistry();
    q.set("observe:s:v1", { window_ms: 1000 });
    q.set("observe:s:v1#fine", { window_ms: 100 });
    const v = new LensView(q, "s:v1", { view: "fine" });
    v.push(ev(0, 1));
    v.push(ev(100, 9));
    assert.equal(v.current().window_ms, 100);
    assert.equal(v.current().windows.length, 2); // two 100ms windows
  });
});

describe("ObservationOverlay — parallel overlays on one stream", () => {
  const build = () => {
    const q = new QRegistry();
    q.set("observe:s:v1#fine", { window_ms: 1000 });
    q.set("observe:s:v1#coarse", { window_ms: 10_000 });
    const overlay = new ObservationOverlay(q);
    overlay.add("fine", "s:v1", { view: "fine" });
    overlay.add("coarse", "s:v1", { view: "coarse" });
    return { q, overlay };
  };

  it("feeds every event to all views, each aggregating under its own lens", () => {
    const { overlay } = build();
    // a localized spike at t=2000 amid a 0.5 baseline over 10s
    for (let ts = 0; ts < 10_000; ts += 1000) {
      overlay.push("s:v1", ev(ts, ts === 2000 ? 5 : 0.5));
    }
    const fine = overlay.get("fine")!.current();
    const coarse = overlay.get("coarse")!.current();
    // fine (1s) isolates the spike in one window
    const spikeWin = fine.windows.find((w) => w.windowStart === 2000);
    assert.ok(spikeWin && Math.abs(spikeWin.mean - 5) < 1e-9);
    // coarse (10s) averages it into the background — one window, mean near baseline
    assert.equal(coarse.windows.length, 1);
    assert.ok(coarse.windows[0].mean < 1, `coarse mean ${coarse.windows[0].mean} hides the spike`);
  });

  it("does not deliver events of another schema to a view", () => {
    const { overlay } = build();
    overlay.push("other:v1", ev(0, 99));
    assert.equal(overlay.get("fine")!.current().windows.length, 0);
  });
});

describe("LensView — tuning interruption (live re-shape on $Q change)", () => {
  it("re-derives in place when its $Q[observe] changes", () => {
    const q = new QRegistry();
    q.set("observe:s:v1", { window_ms: 10_000 });
    const v = new LensView(q, "s:v1");
    for (let ts = 0; ts < 5000; ts += 1000) v.push(ev(ts, ts === 2000 ? 5 : 0.5));
    // coarse: one window, spike hidden
    assert.equal(v.current().windows.length, 1);
    assert.ok(v.current().windows[0].mean < 1.5);
    // Brain narrows the lens at runtime — same held events, new shape
    q.set("observe:s:v1", { window_ms: 1000 });
    const after = v.current();
    assert.ok(after.windows.length > 1);
    const spikeWin = after.windows.find((w) => w.windowStart === 2000);
    assert.ok(spikeWin && Math.abs(spikeWin.mean - 5) < 1e-9);
  });

  it("stops re-shaping after detach", () => {
    const q = new QRegistry();
    q.set("observe:s:v1", { window_ms: 1000 });
    const v = new LensView(q, "s:v1");
    v.push(ev(0, 1));
    v.detach();
    q.set("observe:s:v1", { window_ms: 100 });
    assert.equal(v.current().window_ms, 1000); // unchanged
  });
});

describe("LensView — derivation is deferred to current()", () => {
  /**
   * derive() is the only caller of getObserve(), so counting those calls counts
   * re-aggregations. The point of the count: push() is on the ingestion path
   * (50 evt/s × 2 views in the pilot) while current() is read once per tick.
   */
  class CountingRegistry extends QRegistry {
    getObserveCalls = 0;
    override getObserve(schemaId: string, view?: string) {
      this.getObserveCalls++;
      return super.getObserve(schemaId, view);
    }
  }

  it("does not re-aggregate per pushed event", () => {
    const q = new CountingRegistry();
    q.set("observe:s:v1", { window_ms: 1000 });
    const v = new LensView(q, "s:v1");
    const atConstruction = q.getObserveCalls;

    for (let i = 0; i < 100; i++) v.push(ev(i * 10, 1));
    assert.equal(q.getObserveCalls, atConstruction, "100 pushes must not derive");

    v.current();
    assert.equal(q.getObserveCalls, atConstruction + 1, "one read derives once");
    v.current();
    assert.equal(q.getObserveCalls, atConstruction + 1, "an unchanged view does not re-derive");
  });

  it("still reflects every push, and a $Q change, at the next read", () => {
    // Deferral is a cost change, not a semantic one: the value read must be
    // identical to what eager derivation on every push would have produced.
    const q = new QRegistry();
    q.set("observe:s:v1", { window_ms: 1000 });
    const v = new LensView(q, "s:v1");
    for (let ts = 0; ts < 5000; ts += 1000) v.push(ev(ts, ts === 2000 ? 5 : 0.5));

    const before = v.current();
    assert.equal(before.windows.length, 5);
    assert.equal(before.windows[2].mean, 5);

    // Both invalidation sources, interleaved, resolved by a single read.
    v.push(ev(5000, 0.5));
    q.set("observe:s:v1", { window_ms: 10_000 });
    const after = v.current();
    assert.equal(after.window_ms, 10_000);
    assert.equal(after.windows.length, 1);
    assert.equal(after.windows[0].count, 6, "the push made after the last read is included");
  });

  it("settles a pending derivation at detach, so a later $Q write cannot reach it", () => {
    // The one place deferral is observable. Read-time derivation reads the lens
    // live, so an unsettled snapshot would pick up a $Q change made *after*
    // unsubscribing — the view reacting to the change it detached from.
    const q = new QRegistry();
    q.set("observe:s:v1", { window_ms: 1000 });
    const v = new LensView(q, "s:v1");
    v.push(ev(0, 1)); // invalidated, not yet read
    v.detach();
    q.set("observe:s:v1", { window_ms: 100 });
    assert.equal(v.current().window_ms, 1000);
  });
});

describe("ObservationOverlay — dynamic dataset addition", () => {
  it("adds a new view at runtime and back-fills it from a retained segment", () => {
    const q = new QRegistry();
    q.set("observe:s:v1#coarse", { window_ms: 10_000 });
    q.set("observe:s:v1#fine", { window_ms: 1000 });
    const overlay = new ObservationOverlay(q);
    overlay.add("coarse", "s:v1", { view: "coarse" });

    const history: LensEvent[] = [];
    for (let ts = 0; ts < 5000; ts += 1000) {
      const e = ev(ts, ts === 2000 ? 5 : 0.5);
      history.push(e);
      overlay.push("s:v1", e);
    }

    // A new angle is added later and immediately sees the same history.
    const fine = overlay.add("fine", "s:v1", { view: "fine" });
    fine.backfill(history);
    const spikeWin = fine.current().windows.find((w) => w.windowStart === 2000);
    assert.ok(spikeWin && Math.abs(spikeWin.mean - 5) < 1e-9,
      "back-filled view recovers history under its own lens");
  });

  it("accepts a new source schema mid-stream", () => {
    const q = new QRegistry();
    q.set("observe:*", { window_ms: 1000 });
    const overlay = new ObservationOverlay(q);
    overlay.add("newsrc", "late:v1", { });
    overlay.push("late:v1", ev(0, 7));
    assert.equal(overlay.get("newsrc")!.current().windows[0].mean, 7);
  });

  it("removes an angle at runtime", () => {
    const q = new QRegistry();
    const overlay = new ObservationOverlay(q);
    overlay.add("a", "s:v1");
    overlay.add("b", "s:v1");
    overlay.remove("a");
    assert.deepEqual(overlay.keys(), ["b"]);
  });
});
