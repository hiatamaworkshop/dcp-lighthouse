/**
 * Tests for the $Q[observe] → StCollector window binding (Phase 0 Step 1).
 * Logic is exercised against a minimal WindowControllable stub; one case binds
 * a real StCollector to prove the wire works end-to-end against the core API.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { StCollector, SimpleMonitor } from "dcp-wrap";
import { QRegistry } from "./q-registry.js";
import { bindObserveWindow, type WindowControllable } from "./q-collector-binding.js";

class FakeCollector implements WindowControllable {
  constructor(public window = 1000) {}
  getWindowMs(): number { return this.window; }
  setWindowMs(w: number): void { this.window = w; }
}

describe("bindObserveWindow — initial apply", () => {
  it("applies the current $Q[observe] window at bind time", () => {
    const q = new QRegistry();
    q.set("observe:player_move:v1", { window_ms: 250 });
    const c = new FakeCollector(1000);
    bindObserveWindow(q, c, "player_move:v1");
    assert.equal(c.window, 250);
  });

  it("leaves the collector untouched when $Q has no window for the schema", () => {
    const q = new QRegistry();
    const c = new FakeCollector(1000);
    bindObserveWindow(q, c, "player_move:v1");
    assert.equal(c.window, 1000);
  });

  it("resolves through the observe:* wildcard", () => {
    const q = new QRegistry();
    q.set("observe:*", { window_ms: 500 });
    const c = new FakeCollector(1000);
    bindObserveWindow(q, c, "combat:v1");
    assert.equal(c.window, 500);
  });
});

describe("bindObserveWindow — live updates", () => {
  it("reshapes the window when $Q[observe] changes after binding", () => {
    const q = new QRegistry();
    const c = new FakeCollector(1000);
    bindObserveWindow(q, c, "player_move:v1");
    q.set("observe:player_move:v1", { window_ms: 100 });
    assert.equal(c.window, 100);
  });

  it("reacts to a wildcard change for a schema with no specific row", () => {
    const q = new QRegistry();
    const c = new FakeCollector(1000);
    bindObserveWindow(q, c, "combat:v1");
    q.set("observe:*", { window_ms: 750 });
    assert.equal(c.window, 750);
  });

  it("ignores changes to other schemas", () => {
    const q = new QRegistry();
    const c = new FakeCollector(1000);
    bindObserveWindow(q, c, "player_move:v1");
    q.set("observe:combat:v1", { window_ms: 50 });
    assert.equal(c.window, 1000);
  });

  it("ignores non-observe layers", () => {
    const q = new QRegistry();
    const c = new FakeCollector(1000);
    bindObserveWindow(q, c, "player_move:v1");
    q.set("pipeline:*", { retention_window_ms: 99 });
    q.set("schema:player_move:v1", { pass_rate_floor: 0.9 });
    assert.equal(c.window, 1000);
  });

  it("stops syncing after unbind", () => {
    const q = new QRegistry();
    const c = new FakeCollector(1000);
    const unbind = bindObserveWindow(q, c, "player_move:v1");
    q.set("observe:player_move:v1", { window_ms: 200 });
    assert.equal(c.window, 200);
    unbind();
    q.set("observe:player_move:v1", { window_ms: 30 });
    assert.equal(c.window, 200);
  });
});

describe("bindObserveWindow — view tags", () => {
  it("prefers a #view row and updates on view-scoped changes", () => {
    const q = new QRegistry();
    q.set("observe:player_move:v1", { window_ms: 1000 });
    q.set("observe:player_move:v1#fine", { window_ms: 100 });
    const c = new FakeCollector(5000);
    bindObserveWindow(q, c, "player_move:v1", { view: "fine" });
    assert.equal(c.window, 100);
    q.set("observe:player_move:v1#fine", { window_ms: 25 });
    assert.equal(c.window, 25);
  });
});

describe("bindObserveWindow — real StCollector", () => {
  it("reshapes a live StCollector's flush window through $Q", () => {
    const q = new QRegistry();
    const collector = new StCollector(new SimpleMonitor(), { windowMs: 1000 });
    collector.start();
    try {
      assert.equal(collector.getWindowMs(), 1000);
      bindObserveWindow(q, collector, "player_move:v1");
      q.set("observe:player_move:v1", { window_ms: 250 });
      assert.equal(collector.getWindowMs(), 250);
    } finally {
      collector.stop();
    }
  });
});
