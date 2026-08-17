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

describe("QRegistry.set — observe-layer validation (write-time rejection)", () => {
  /**
   * Every lens the rulebook must refuse. Reused below to pin that the registry
   * and applyLens refuse exactly the same set — see the drift test.
   */
  const INVALID: Array<[string, QObserveParams]> = [
    ["zero window", { window_ms: 0 }],
    ["negative window", { window_ms: -1 }],
    ["NaN window", { window_ms: NaN }],
    ["infinite window", { window_ms: Infinity }],
    ["NaN origin", { origin: NaN }],
    ["unknown align", { align: "middle" as never }],
    ["zero downsample", { downsample_factor: 0 }],
    ["fractional downsample", { downsample_factor: 1.5 }],
    ["group_by not an array", { group_by: "agentId" as never }],
    ["group_by of non-strings", { group_by: [1 as never] }],
    ["unknown decay anchor", { decay_anchor: "yesterday" as never }],
    ["malformed decay", { decay: "nonsense" }],
    ["unitless decay duration", { decay: "step(cutoff=300)" }],
    // MODEL.md §183's own example row. Accepting it here is what used to kill
    // the process on the next tick.
    ["exp decay (documented but unimplemented)", { decay: "exp(τ=300s)" }],
  ];

  for (const [name, params] of INVALID) {
    it(`rejects ${name}`, () => {
      const r = new QRegistry();
      assert.throws(() => r.set("observe:test_result:v1", params));
    });
  }

  it("leaves no trace of a rejected write — no store entry, no history, no listener call", () => {
    // A swap history listing rows the registry refused would misdescribe what
    // the observation layer was actually configured with.
    const r = new QRegistry();
    r.set("observe:test_result:v1", { window_ms: 1000 });
    let notifications = 0;
    r.onChange(() => notifications++);

    assert.throws(() => r.set("observe:test_result:v1", { decay: "exp(tau=300s)" }));

    assert.deepEqual(r.getObserve("test_result:v1"), { window_ms: 1000 }, "prior value must survive");
    assert.equal(r.rows().length, 1, "rejected write must not appear in swap history");
    assert.equal(notifications, 0, "rejected write must not notify listeners");
  });

  it("still accepts every valid lens shape", () => {
    const r = new QRegistry();
    const valid: QObserveParams[] = [
      {},
      { window_ms: 1000 },
      { window_ms: 1000, align: "epoch", origin: 250 },
      { window_ms: 1000, downsample_factor: 3 },
      { window_ms: 1000, group_by: ["agentId", "domain"] },
      { window_ms: 1000, decay: "step(cutoff=now-60s)", decay_anchor: "now" },
    ];
    for (const v of valid) r.set("observe:test_result:v1", v);
    assert.equal(r.rows().length, valid.length);
  });

  it("tolerates the extra fields RuleBrain writes alongside the lens", () => {
    // index.ts stores fromTs/toTs in the same row as the lens; applyLens
    // ignores unknown fields, so rejecting them here would break a shipped flow.
    const r = new QRegistry();
    r.set("observe:test_result:v1#fine", {
      window_ms: 1000,
      group_by: ["agentId"],
      fromTs: 1_000,
      toTs: 2_000,
    } as QObserveParams);
    assert.equal(r.rows().length, 1);
  });

  it("does not apply lens rules to the other layers", () => {
    // pipeline/schema rows have their own shapes; window_ms means nothing there.
    const r = new QRegistry();
    r.set("pipeline:*", { retention_window_ms: 120_000 });
    r.set("schema:test_result:v1", { baseline_delta: 0.1 });
    assert.equal(r.rows().length, 2);
  });
});

describe("QRegistry / applyLens — one rulebook, no drift", () => {
  it("the registry rejects exactly what applyLens rejects", async () => {
    // The property that makes write-time validation sound: if the registry
    // accepted a lens applyLens later refused, the crash path would be open
    // again; if it refused one applyLens accepts, a usable lens would be
    // unwritable. Two hand-maintained rule lists is how that gap appears, so
    // pin the equivalence rather than the lists.
    const { applyLens } = await import("./lens.js");
    const events = [{ ts: 0, value: 1 }, { ts: 5, value: 3 }];

    const candidates: QObserveParams[] = [
      {},
      { window_ms: 1000 },
      { window_ms: 0 },
      { window_ms: -1 },
      { window_ms: NaN },
      { window_ms: Infinity },
      { origin: NaN },
      { align: "middle" as never },
      { downsample_factor: 0 },
      { downsample_factor: 1.5 },
      { downsample_factor: 2 },
      { group_by: "agentId" as never },
      { group_by: ["agentId"] },
      { decay_anchor: "yesterday" as never },
      { decay: "nonsense" },
      { decay: "step(cutoff=300)" },
      { decay: "step(cutoff=now-60s)" },
      { decay: "exp(τ=300s)" },
    ];

    for (const lens of candidates) {
      const label = JSON.stringify(lens);
      const registryRejected = (() => {
        try { new QRegistry().set("observe:t:v1", lens); return false; } catch { return true; }
      })();
      const applyRejected = (() => {
        try { applyLens(events, lens); return false; } catch { return true; }
      })();
      assert.equal(
        registryRejected,
        applyRejected,
        `disagreement on ${label}: registry rejected=${registryRejected}, applyLens rejected=${applyRejected}`,
      );
    }
  });
});
