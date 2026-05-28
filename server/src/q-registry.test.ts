/**
 * $Q registry tests. Mirrors the dcp-wrap convention: node:test, no extra deps,
 * run via `tsc && node --test dist/*.test.js`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  QRegistry,
  parseScope,
  formatScope,
  type QObserveParams,
} from "./q-registry.js";

describe("parseScope", () => {
  it("splits layer off the first colon, keeping colons in the schema-id target", () => {
    const s = parseScope("observe:test_result:v1");
    assert.equal(s.layer, "observe");
    assert.equal(s.target, "test_result:v1");
    assert.equal(s.view, undefined);
  });

  it("extracts a #view suffix", () => {
    const s = parseScope("observe:test_result:v1#agents");
    assert.equal(s.layer, "observe");
    assert.equal(s.target, "test_result:v1");
    assert.equal(s.view, "agents");
  });

  it("round-trips through formatScope", () => {
    for (const raw of ["pipeline:*", "observe:player_move:v1", "observe:a:b#fine", "schema:test_result:v1"]) {
      assert.equal(formatScope(parseScope(raw)), raw);
    }
  });

  it("rejects malformed scopes", () => {
    assert.throws(() => parseScope("noColon"), /missing layer/);
    assert.throws(() => parseScope("bogus:x"), /invalid \$Q layer/);
    assert.throws(() => parseScope("observe:"), /empty target/);
    assert.throws(() => parseScope("observe:#view"), /empty target/);
  });
});

describe("QRegistry.getObserve — most-specific-first resolution", () => {
  const make = () => {
    const q = new QRegistry();
    q.set("observe:*", { window_ms: 60000 });
    q.set("observe:player_move:v1", { window_ms: 1000, group_by: ["sourceId"] });
    q.set("observe:player_move:v1#fine", { window_ms: 250 });
    return q;
  };

  it("prefers schema#view over schema over *", () => {
    const q = make();
    assert.equal(q.getObserve("player_move:v1", "fine")?.window_ms, 250);
  });

  it("falls back to schema when no view is given", () => {
    const q = make();
    const v = q.getObserve("player_move:v1") as QObserveParams;
    assert.equal(v.window_ms, 1000);
    assert.deepEqual(v.group_by, ["sourceId"]);
  });

  it("falls back to schema when the view does not exist", () => {
    const q = make();
    assert.equal(q.getObserve("player_move:v1", "nope")?.window_ms, 1000);
  });

  it("falls back to observe:* for an unknown schema", () => {
    const q = make();
    assert.equal(q.getObserve("combat:v1")?.window_ms, 60000);
  });

  it("returns undefined when nothing matches", () => {
    const q = new QRegistry();
    assert.equal(q.getObserve("anything:v1"), undefined);
  });
});

describe("QRegistry — pipeline and schema layers", () => {
  it("reads pipeline params (defaulting target to *)", () => {
    const q = new QRegistry();
    q.set("pipeline:*", { retention_window_ms: 3_600_000 });
    assert.equal(q.getPipeline()?.retention_window_ms, 3_600_000);
  });

  it("reads schema params with a * fallback", () => {
    const q = new QRegistry();
    q.set("schema:*", { pass_rate_floor: 0.8 });
    q.set("schema:test_result:v1", { pass_rate_floor: 0.95 });
    assert.equal(q.getSchema("test_result:v1")?.pass_rate_floor, 0.95);
    assert.equal(q.getSchema("other:v1")?.pass_rate_floor, 0.8);
  });
});

describe("QRegistry — swap history", () => {
  it("records every set in order, including replacements", () => {
    const q = new QRegistry();
    q.set("observe:*", { window_ms: 60000 });
    q.set("observe:*", { window_ms: 5000 });
    const rows = q.rows();
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], ["$Q", "observe:*", { window_ms: 60000 }]);
    assert.deepEqual(rows[1], ["$Q", "observe:*", { window_ms: 5000 }]);
    // latest write wins for reads
    assert.equal(q.getObserve("x:v1")?.window_ms, 5000);
  });

  it("returns a copy — mutating the result does not affect the registry", () => {
    const q = new QRegistry();
    q.set("observe:*", { window_ms: 1000 });
    q.rows().push(["$Q", "observe:hacked", {}]);
    assert.equal(q.rows().length, 1);
  });

  it("accepts a pre-parsed QScope as well as a string", () => {
    const q = new QRegistry();
    q.set({ layer: "observe", target: "test_result:v1", view: "fine" }, { window_ms: 100 });
    assert.equal(q.getObserve("test_result:v1", "fine")?.window_ms, 100);
  });
});
