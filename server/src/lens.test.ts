/** applyLens unit tests (Phase 0 Step 2). */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyLens,
  floorToWindow,
  resolveAlign,
  MIN_VALID_COUNT,
  UNKEYED_GROUP,
  type LensEvent,
} from "./lens.js";

const ev = (ts: number, value: number): LensEvent => ({ ts, value });
const kev = (ts: number, value: number, keys: Record<string, string>): LensEvent =>
  ({ ts, value, keys });

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

describe("applyLens — window grid (ROADMAP L4 origin/align)", () => {
  it("defaults to first-event anchoring, so the grid follows the segment", () => {
    const r = applyLens([ev(1234, 1), ev(2234, 2)], { window_ms: 1000 });
    assert.equal(resolveAlign({ window_ms: 1000 }), "first_event");
    assert.equal(r.windows[0].windowStart, 1234);
  });

  it("align:epoch pins windows to absolute time regardless of the first event", () => {
    const r = applyLens([ev(1234, 1), ev(2234, 2)], { window_ms: 1000, align: "epoch" });
    assert.deepEqual(r.windows.map((w) => w.windowStart), [1000, 2000]);
  });

  it("setting origin implies the epoch grid it is the phase of", () => {
    assert.equal(resolveAlign({ origin: 0 }), "epoch");
    // origin=500 shifts every boundary by 500ms: 1234 falls in [500,1500).
    const r = applyLens([ev(1234, 1)], { window_ms: 1000, origin: 500 });
    assert.equal(r.windows[0].windowStart, 500);
  });

  it("an explicit align wins over the origin shorthand", () => {
    assert.equal(resolveAlign({ origin: 500, align: "first_event" }), "first_event");
  });

  it("floorToWindow is the same grid applyLens places events on", () => {
    // The two readers of the grid must agree by construction, not by
    // inspection: dashboard.ts picks spans with floorToWindow while applyLens
    // places events. Two independent floor expressions agreeing today is how
    // the anchor-slide bug survived a green suite.
    for (const ts of [0, 999, 1000, 1_234_567, -1]) {
      const r = applyLens([ev(ts, 1)], { window_ms: 1000, align: "epoch" });
      assert.equal(r.windows[0].windowStart, floorToWindow(ts, 1000), `ts=${ts}`);
    }
  });

  it("epoch alignment makes two overlapping segments agree window-for-window", () => {
    // The property the whole stage exists for. Under first-event anchoring the
    // same events land on different grids depending on where the request began,
    // so the two results cannot be compared window-by-window — that mismatch is
    // the "anchor が tick ごとに滑る" flicker (ROADMAP_BRIEF 2026-07-29).
    const stream = Array.from({ length: 40 }, (_, i) => ev(10_000 + i * 100, 1));
    const lateStart = stream.filter((e) => e.ts >= 10_350);

    const epochAll = applyLens(stream, { window_ms: 1000, align: "epoch" });
    const epochLate = applyLens(lateStart, { window_ms: 1000, align: "epoch" });
    const sharedEpoch = epochLate.windows.map((w) => w.windowStart)
      .filter((s) => epochAll.windows.some((w) => w.windowStart === s));
    assert.ok(sharedEpoch.length >= 3, "the two epoch runs must share window starts");

    const firstAll = applyLens(stream, { window_ms: 1000 });
    const firstLate = applyLens(lateStart, { window_ms: 1000 });
    const sharedFirst = firstLate.windows.map((w) => w.windowStart)
      .filter((s) => firstAll.windows.some((w) => w.windowStart === s));
    assert.equal(sharedFirst.length, 0, "first-event anchoring must NOT line up (the bug)");
  });
});

describe("applyLens — group_by (ROADMAP L4)", () => {
  const mixed = (): LensEvent[] => [
    kev(0, 1.0, { agentId: "a" }),
    kev(10, 0.0, { agentId: "b" }),
    kev(20, 1.0, { agentId: "a" }),
    kev(1000, 1.0, { agentId: "a" }),
    kev(1010, 0.0, { agentId: "b" }),
  ];

  it("omits groups entirely when the lens does not ask for them", () => {
    const r = applyLens(mixed(), { window_ms: 1000 });
    assert.equal(r.groups, undefined);
  });

  it("splits by key while keeping the mixed view intact", () => {
    const r = applyLens(mixed(), { window_ms: 1000, group_by: ["agentId"] });
    // The ungrouped windows are still there — grouping is additive.
    assert.equal(r.windows.length, 2);
    assert.equal(r.windows[0].count, 3);
    assert.deepEqual(r.groups?.map((g) => g.label), ["a", "b"]);
    const a = r.groups!.find((g) => g.label === "a")!;
    assert.equal(a.windows[0].mean, 1.0);
    assert.equal(a.windows[0].count, 2);
    const b = r.groups!.find((g) => g.label === "b")!;
    assert.equal(b.windows[0].mean, 0.0);
  });

  it("puts every group on the SAME grid, not on each group's own first event", () => {
    // Group "late" starts at t=700 — under per-group first-event anchoring its
    // windows would begin at 700 and could never be paired with group "early"'s.
    const events = [
      kev(0, 1, { agentId: "early" }),
      kev(700, 1, { agentId: "late" }),
      kev(1200, 1, { agentId: "late" }),
    ];
    const r = applyLens(events, { window_ms: 1000, group_by: ["agentId"] });
    const late = r.groups!.find((g) => g.label === "late")!;
    assert.deepEqual(late.windows.map((w) => w.windowStart), [0, 1000]);
  });

  it("joins a multi-key group_by into one label, in the declared order", () => {
    const r = applyLens(
      [kev(0, 1, { agentId: "a", domain: "auth" }), kev(10, 1, { agentId: "a", domain: "ui" })],
      { window_ms: 1000, group_by: ["agentId", "domain"] },
    );
    assert.deepEqual(r.groups?.map((g) => g.label), ["a|auth", "a|ui"]);
    assert.deepEqual(r.groups?.[0].key, ["a", "auth"]);
  });

  it("files an event missing the requested key under an explicit unkeyed group", () => {
    const r = applyLens([ev(0, 1), kev(10, 1, { agentId: "a" })], {
      window_ms: 1000,
      group_by: ["agentId"],
    });
    assert.deepEqual(r.groups?.map((g) => g.label).sort(), [UNKEYED_GROUP, "a"].sort());
  });

  it("enumerates groups in a stable order across runs", () => {
    // Group labels are how two lens runs get paired; an order that depends on
    // arrival would make the pairing depend on arrival too.
    const forward = applyLens(mixed(), { window_ms: 1000, group_by: ["agentId"] });
    const reversed = applyLens([...mixed()].reverse(), { window_ms: 1000, group_by: ["agentId"] });
    assert.deepEqual(
      forward.groups?.map((g) => g.label),
      reversed.groups?.map((g) => g.label),
    );
  });

  it("treats an empty group_by as no grouping", () => {
    assert.equal(applyLens(mixed(), { window_ms: 1000, group_by: [] }).groups, undefined);
  });
});

describe("applyLens — window validity (ROADMAP L1-2)", () => {
  it("marks a window valid when count meets MIN_VALID_COUNT", () => {
    const events = Array.from({ length: MIN_VALID_COUNT }, (_, i) => ev(i, 1));
    const r = applyLens(events, { window_ms: 1000 });
    assert.equal(r.windows[0].count, MIN_VALID_COUNT);
    assert.equal(r.windows[0].valid, true);
  });

  it("marks a window invalid when count is below MIN_VALID_COUNT", () => {
    const r = applyLens([ev(0, 1)], { window_ms: 1000 });
    assert.equal(r.windows[0].count, 1);
    assert.equal(r.windows[0].valid, false);
  });
});

describe("applyLens — downsample_factor (ROADMAP L4 residual chain stage)", () => {
  it("defaults downsample_factor to 1 (no-op)", () => {
    const r = applyLens([ev(0, 1), ev(1000, 3)], { window_ms: 1000 });
    assert.equal(r.window_ms, 1000);
    assert.equal(r.windows.length, 2);
  });

  it("merges N consecutive grid slots and pools count/sum/sumSq exactly", () => {
    const r = applyLens([ev(0, 1), ev(1000, 3), ev(2000, 5)], {
      window_ms: 1000,
      downsample_factor: 3,
      align: "epoch",
    });
    assert.equal(r.window_ms, 3000);
    assert.equal(r.windows.length, 1);
    const w = r.windows[0];
    assert.deepEqual([w.windowStart, w.windowEnd], [0, 3000]);
    assert.equal(w.count, 3);
    assert.equal(w.mean, 3); // (1+3+5)/3
    assert.equal(w.sumSq, 1 + 9 + 25);
  });

  it("scales the returned window_ms even when there are no windows", () => {
    const r = applyLens([], { window_ms: 500, downsample_factor: 4 });
    assert.deepEqual(r.windows, []);
    assert.equal(r.window_ms, 2000);
  });

  it("omits an empty merged bucket instead of fabricating one (gaps survive downsampling)", () => {
    // window_ms=1000, factor=2 → bucketMs=2000. Events only in [0,1000) and [6000,7000).
    const r = applyLens([ev(0, 1), ev(6000, 9)], { window_ms: 1000, downsample_factor: 2, align: "epoch" });
    assert.equal(r.window_ms, 2000);
    assert.equal(r.windows.length, 2);
    assert.equal(r.windows[0].windowStart, 0);
    assert.equal(r.windows[1].windowStart, 6000);
  });

  it("downsamples every group on the same shared grid", () => {
    const events = [
      kev(0, 1, { agentId: "A" }),
      kev(1000, 2, { agentId: "A" }),
      kev(500, 10, { agentId: "B" }),
      kev(1500, 20, { agentId: "B" }),
    ];
    const r = applyLens(events, { window_ms: 1000, downsample_factor: 2, group_by: ["agentId"], align: "epoch" });
    assert.equal(r.window_ms, 2000);
    const a = r.groups!.find((g) => g.label === "A")!;
    const b = r.groups!.find((g) => g.label === "B")!;
    assert.deepEqual([a.windows[0].windowStart, a.windows[0].windowEnd], [0, 2000]);
    assert.deepEqual([b.windows[0].windowStart, b.windows[0].windowEnd], [0, 2000]);
    assert.equal(a.windows[0].mean, 1.5); // (1+2)/2
    assert.equal(b.windows[0].mean, 15); // (10+20)/2
  });

  it("rejects a non-positive or non-integer downsample_factor", () => {
    assert.throws(() => applyLens([ev(0, 1)], { window_ms: 1000, downsample_factor: 0 }), /downsample_factor/);
    assert.throws(() => applyLens([ev(0, 1)], { window_ms: 1000, downsample_factor: -2 }), /downsample_factor/);
    assert.throws(() => applyLens([ev(0, 1)], { window_ms: 1000, downsample_factor: 1.5 }), /downsample_factor/);
  });
});
