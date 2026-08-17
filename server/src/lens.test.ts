/** applyLens unit tests (Phase 0 Step 2). */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyLens,
  effectiveN,
  floorToWindow,
  kishEffectiveN,
  parseDecay,
  resolveAlign,
  resolveDecayAnchor,
  weightSquaredTotal,
  weightTotal,
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

describe("parseDecay — MODEL.md §228 syntax", () => {
  it("parses the step form, with or without the symbolic `now-` prefix", () => {
    assert.deepEqual(parseDecay("step(cutoff=now-60s)"), { kind: "step", cutoffMs: 60_000 });
    // `now` names the anchor, not a literal clock read, so an age on its own
    // means the same thing.
    assert.deepEqual(parseDecay("step(cutoff=60s)"), { kind: "step", cutoffMs: 60_000 });
    assert.deepEqual(parseDecay("step(cutoff=1500ms)"), { kind: "step", cutoffMs: 1_500 });
  });

  it("parses the exp form under either spelling of tau", () => {
    assert.deepEqual(parseDecay("exp(tau=300s)"), { kind: "exp", tauMs: 300_000 });
    assert.deepEqual(parseDecay("exp(τ=300s)"), { kind: "exp", tauMs: 300_000 });
  });

  it("tolerates incidental whitespace", () => {
    assert.deepEqual(parseDecay("  step( cutoff = now-60s )  "), { kind: "step", cutoffMs: 60_000 });
  });

  it("rejects an unlabeled duration rather than guessing the unit", () => {
    // "300" could be 300ms or 300s and the difference is three orders of
    // magnitude — a $Q row must not carry that ambiguity.
    assert.throws(() => parseDecay("step(cutoff=300)"), /expected a number with a unit/);
    assert.throws(() => parseDecay("exp(tau=5m)"), /expected a number with a unit/);
  });

  it("rejects malformed specs and mismatched parameter names", () => {
    assert.throws(() => parseDecay("step"), /invalid decay/);
    assert.throws(() => parseDecay("linear(cutoff=60s)"), /invalid decay/);
    assert.throws(() => parseDecay("step(tau=60s)"), /step takes "cutoff"/);
    assert.throws(() => parseDecay("exp(cutoff=60s)"), /exp takes "tau"/);
  });
});

describe("applyLens — decay (ROADMAP L4 chain stage)", () => {
  it("drops events older than the cutoff, measured back from the segment end", () => {
    // Segment spans 0..10000; cutoff 3s keeps only ts >= 7000.
    const events = [ev(0, 1), ev(5_000, 1), ev(7_000, 9), ev(10_000, 9)];
    const r = applyLens(events, { window_ms: 1_000, decay: "step(cutoff=now-3s)" });
    const total = r.windows.reduce((n, w) => n + w.count, 0);
    assert.equal(total, 2, "only the two events inside the cutoff may survive");
    assert.equal(r.windows[0].windowStart, 7_000, "the grid must anchor to the first SURVIVING event");
  });

  it("is reproducible: the same segment gives the same answer regardless of wall clock", () => {
    // The reason segment_end is the default. Under a wall-clock anchor this
    // fixture — timestamps near the Unix epoch — would decay to nothing, and
    // a replay of old data is the model's whole point (MODEL.md §5).
    const events = [ev(0, 1), ev(5_000, 1), ev(9_000, 7), ev(10_000, 7)];
    const lens = { window_ms: 1_000, decay: "step(cutoff=now-2s)" };
    const a = applyLens(events, lens);
    const b = applyLens(events, lens);
    assert.deepEqual(a, b);
    assert.ok(a.windows.length > 0, "a historical segment must not decay to nothing");
  });

  it("anchors to the wall clock only when asked to", () => {
    assert.equal(resolveDecayAnchor({}), "segment_end");
    assert.equal(resolveDecayAnchor({ decay_anchor: "now" }), "now");

    // Epoch-era timestamps are far older than any real cutoff from now, so a
    // wall-clock anchor drops everything — the behavior segment_end exists to
    // avoid, pinned here so the two anchors cannot quietly become the same.
    const events = [ev(0, 1), ev(10_000, 1)];
    const r = applyLens(events, {
      window_ms: 1_000,
      decay: "step(cutoff=now-60s)",
      decay_anchor: "now",
    });
    assert.deepEqual(r.windows, []);
  });

  it("keeps everything when the cutoff spans the whole segment", () => {
    const events = [ev(0, 1), ev(5_000, 3), ev(10_000, 5)];
    const r = applyLens(events, { window_ms: 1_000, decay: "step(cutoff=now-999s)" });
    assert.equal(r.windows.reduce((n, w) => n + w.count, 0), 3);
  });

  it("builds groups from the survivors only", () => {
    // A group whose events all fall outside the cutoff must disappear, not
    // linger as an empty slice — otherwise the curator would see a group that
    // the lens did not actually observe.
    const events = [
      kev(0, 1, { agentId: "old" }),
      kev(9_000, 5, { agentId: "new" }),
      kev(10_000, 5, { agentId: "new" }),
    ];
    const r = applyLens(events, {
      window_ms: 1_000,
      decay: "step(cutoff=now-2s)",
      group_by: ["agentId"],
    });
    assert.deepEqual(r.groups!.map((g) => g.label), ["new"]);
  });

  it("composes with downsample_factor, and the GRID still decides bucket edges", () => {
    // 7000/8000/9000 survive the 2s cutoff. On the epoch grid with
    // bucketMs = 1000*3, the boundary at 9000 falls between them, so they land
    // in two buckets rather than one. That is the point worth pinning: decay
    // changes which events exist, never where the grid sits — a survivor set
    // that re-anchored the grid would reintroduce the anchor-slide failure the
    // origin/align work removed.
    const events = [ev(0, 1), ev(7_000, 2), ev(8_000, 4), ev(9_000, 6)];
    const r = applyLens(events, {
      window_ms: 1_000,
      decay: "step(cutoff=now-2s)",
      downsample_factor: 3,
      align: "epoch",
    });
    assert.equal(r.window_ms, 3_000);
    assert.deepEqual(r.windows.map((w) => w.windowStart), [6_000, 9_000]);
    assert.equal(r.windows[0].count, 2);
    assert.equal(r.windows[0].mean, 3); // (2+4)/2
    assert.equal(r.windows[1].count, 1);
    assert.equal(r.windows[1].mean, 6);
  });

  it("surfaces a malformed decay spec rather than observing unfiltered", () => {
    assert.throws(() => applyLens([ev(0, 1)], { window_ms: 1_000, decay: "nonsense" }), /invalid decay/);
  });
});

describe("applyLens — decay exp(τ): the weight producer", () => {
  it("drops nothing and weights everything, newest at 1", () => {
    // The difference from the step form stated as an assertion: a 10s-old event
    // under τ=5s survives at exp(-2), it does not disappear.
    const events = [ev(0, 1), ev(5_000, 1), ev(10_000, 1)];
    const r = applyLens(events, { window_ms: 1_000, decay: "exp(tau=5s)" });
    assert.equal(r.windows.reduce((n, w) => n + w.count, 0), 3, "exp must not filter");

    const weights = r.windows.map((w) => w.weights!.sumW);
    assert.ok(Math.abs(weights[2] - 1) < 1e-12, "the anchor event weighs exactly 1");
    assert.ok(Math.abs(weights[1] - Math.exp(-1)) < 1e-12);
    assert.ok(Math.abs(weights[0] - Math.exp(-2)) < 1e-12);
  });

  it("pulls the mean toward the fresh events inside a window", () => {
    // Same three events, same window: unweighted this reads 2/3; under decay
    // the stale 0s are worth less than the fresh 1.
    const events = [ev(0, 0), ev(400, 0), ev(800, 1)];
    const lens = { window_ms: 1_000, align: "epoch" as const };
    assert.ok(Math.abs(applyLens(events, lens).windows[0].mean - 1 / 3) < 1e-12);

    const decayed = applyLens(events, { ...lens, decay: "exp(tau=400ms)" }).windows[0];
    assert.ok(decayed.mean > 1 / 3, `expected the fresh 1 to weigh more, got ${decayed.mean}`);
    assert.equal(decayed.count, 3, "count still reports how many events there were");
  });

  it("costs a window almost no precision of its own — Kish is scale-invariant", () => {
    // The consequence a reader must know before interpreting any σ measured
    // under this lens. Events inside one window are nearly the same age, so
    // their weights are nearly equal, and equal weights lose nothing however
    // small they are. Decay acts on a window's SHARE of a pool, not on its own
    // standard error.
    // 50 events packed into one window, plus a lone anchor event two minutes
    // later so the window is genuinely stale (τ=60s ⇒ everything in it weighs
    // about exp(-2)).
    const events = [...Array.from({ length: 50 }, (_, i) => ev(i * 10, i % 2)), ev(120_000, 1)];
    const r = applyLens(events, { window_ms: 1_000, decay: "exp(tau=60s)", align: "epoch" });
    const win = r.windows[0];
    assert.equal(win.count, 50);
    assert.ok(win.weights!.sumW < 10, `the window as a whole is discounted, got ${win.weights!.sumW}`);
    assert.ok(effectiveN(win) > 49.9, `n_eff should stay ~50, got ${effectiveN(win)}`);
  });

  it("is reproducible: segment_end anchoring keeps a replay answering the same", () => {
    // Asserting that two calls to a pure function agree would prove nothing.
    // The claim is about the ANCHOR, so the contrast is against the wall-clock
    // one: these epoch-era timestamps are ~57 years old, which under any real τ
    // decays past every float and leaves nothing to observe.
    const events = [ev(0, 1), ev(5_000, 0), ev(10_000, 1)];
    const lens = { window_ms: 1_000, decay: "exp(tau=3s)" };

    const reproducible = applyLens(events, lens);
    assert.equal(reproducible.windows.length, 3, "a historical segment must not decay to nothing");
    assert.ok(Math.abs(reproducible.windows[2].weights!.sumW - 1) < 1e-12, "its newest event anchors at weight 1");

    const wallClock = applyLens(events, { ...lens, decay_anchor: "now" });
    assert.deepEqual(wallClock.windows, [], "the wall-clock anchor is what segment_end exists to avoid");
  });

  it("composes with downsample_factor EXACTLY — merged weights equal direct ones", () => {
    // The pooling-is-exact property, now for weighted moments: aggregating at
    // 1s and merging three of them must equal aggregating at 3s outright. If it
    // did not, `downsample` would be silently approximating under this lens.
    const events = Array.from({ length: 30 }, (_, i) => ev(i * 100, (i * 7) % 3));
    const base = { align: "epoch" as const, decay: "exp(tau=1200ms)" };
    const merged = applyLens(events, { ...base, window_ms: 1_000, downsample_factor: 3 });
    const direct = applyLens(events, { ...base, window_ms: 3_000 });

    assert.equal(merged.window_ms, direct.window_ms);
    assert.equal(merged.windows.length, direct.windows.length);
    for (const [i, m] of merged.windows.entries()) {
      const d = direct.windows[i];
      assert.equal(m.windowStart, d.windowStart);
      assert.equal(m.count, d.count);
      assert.ok(Math.abs(m.mean - d.mean) < 1e-12, `mean ${m.mean} vs ${d.mean}`);
      assert.ok(Math.abs(m.sumSq - d.sumSq) < 1e-12);
      assert.ok(Math.abs(m.weights!.sumW - d.weights!.sumW) < 1e-12);
      assert.ok(Math.abs(m.weights!.sumW2 - d.weights!.sumW2) < 1e-12);
    }
  });

  it("groups decay against the SEGMENT's anchor, not their own newest event", () => {
    // The group-level anchor-slide trap. agent-old's events are stale relative
    // to the segment; if each group anchored to its own last event, both groups
    // would come out weighing 1 and the lens would report that the stale group
    // is as current as the fresh one.
    const events = [
      kev(0, 1, { agentId: "old" }),
      kev(100, 1, { agentId: "old" }),
      kev(9_000, 1, { agentId: "new" }),
      kev(10_000, 1, { agentId: "new" }),
    ];
    const r = applyLens(events, {
      window_ms: 1_000,
      decay: "exp(tau=2s)",
      group_by: ["agentId"],
      align: "epoch",
    });
    const sumW = (label: string) =>
      r.groups!.find((g) => g.label === label)!.windows.reduce((s, w) => s + w.weights!.sumW, 0);
    // Under a per-group anchor "old" would come out at ~1.95 — its two events
    // are 100ms apart. Against the segment's anchor they are 10s stale.
    assert.ok(sumW("old") < 0.02, `stale group must be discounted, got ${sumW("old")}`);
    assert.ok(sumW("new") > 1.5, `fresh group must keep its weight, got ${sumW("new")}`);
  });

  it("drops a window whose weights all underflow rather than reporting NaN", () => {
    // Reachable only past ~745τ, but a NaN mean would poison every pool the
    // window enters, so it is handled the way the step form handles a cutoff.
    const events = [ev(0, 1), ev(1, 1), ev(10_000_000, 0)];
    const r = applyLens(events, { window_ms: 1_000, decay: "exp(tau=1ms)", align: "epoch" });
    assert.equal(r.windows.length, 1, "only the anchor's window can survive");
    assert.ok(Number.isFinite(r.windows[0].mean));
    assert.equal(r.windows[0].mean, 0);
  });

  it("with a τ far longer than the segment, reads as an unweighted lens does", () => {
    // Not a tautology: it says the weighting is applied through the same sums
    // rather than through a separate path that could disagree at the limit.
    const events = [ev(0, 1), ev(500, 0), ev(900, 1), ev(1_500, 1)];
    const plain = applyLens(events, { window_ms: 1_000, align: "epoch" });
    const gentle = applyLens(events, { window_ms: 1_000, align: "epoch", decay: "exp(tau=1000000s)" });
    for (const [i, p] of plain.windows.entries()) {
      assert.ok(Math.abs(p.mean - gentle.windows[i].mean) < 1e-6);
      assert.equal(p.count, gentle.windows[i].count);
    }
  });

  it("rejects τ=0 instead of collapsing the segment to one event", () => {
    assert.throws(
      () => applyLens([ev(0, 1), ev(1, 1)], { window_ms: 1_000, decay: "exp(tau=0s)" }),
      /tau must be greater than zero/,
    );
  });
});

describe("weighted sufficient statistics (what decay exp produces)", () => {
  const w = (
    count: number,
    mean: number,
    sumSq: number,
    weights?: { sumW: number; sumW2: number },
  ) => ({ windowStart: 0, windowEnd: 1000, count, mean, sumSq, valid: true, ...(weights ? { weights } : {}) });

  it("an unweighted window's effective n IS its count — the equivalence the refactor rests on", () => {
    for (const n of [1, 3, 10, 500]) {
      const win = w(n, 0.9, n * 0.81);
      assert.equal(weightTotal(win), n);
      assert.equal(weightSquaredTotal(win), n);
      assert.equal(effectiveN(win), n);
    }
  });

  it("equal weights give effective n equal to the observation count", () => {
    // 10 observations each weighing 0.5: ΣW=5, ΣW²=2.5, n_eff = 25/2.5 = 10.
    // Down-weighting everything uniformly loses no precision — it is the
    // SPREAD of weights that costs, which is exactly what Kish measures.
    assert.equal(kishEffectiveN(5, 2.5), 10);
    assert.equal(kishEffectiveN(10, 10), 10);
  });

  it("unequal weights cost precision, and one dominant weight costs nearly all of it", () => {
    // Two observations, weights 1 and 1 → n_eff 2 (nothing lost).
    assert.equal(kishEffectiveN(2, 2), 2);
    // Weights 1 and 0.0001 → barely more than a single observation.
    const lopsided = kishEffectiveN(1.0001, 1 + 1e-8);
    assert.ok(lopsided > 1 && lopsided < 1.001, `expected ~1, got ${lopsided}`);
    // Effective n never exceeds the observation count.
    assert.ok(kishEffectiveN(1.5, 1.25) <= 2);
  });

  it("effective n is NOT additive — the reason sumW/sumW2 are what get carried", () => {
    // Two windows of n_eff=2 each do not pool to n_eff=4 unless their weights
    // match. Pooling per-window n_eff would therefore be wrong; pooling the
    // moments is exact.
    const a = { sumW: 2, sumW2: 2 };      // two weight-1 observations, n_eff 2
    const b = { sumW: 0.2, sumW2: 0.02 }; // two weight-0.1 observations, n_eff 2
    assert.equal(kishEffectiveN(a.sumW, a.sumW2), 2);
    // 0.04/0.02 lands a few ulps off 2 — float, not a modelling error.
    assert.ok(Math.abs(kishEffectiveN(b.sumW, b.sumW2) - 2) < 1e-9);
    const pooled = kishEffectiveN(a.sumW + b.sumW, a.sumW2 + b.sumW2);
    assert.ok(pooled < 4, `naive addition would say 4, correct pooling says ${pooled.toFixed(3)}`);
    assert.ok(pooled > 2, "but pooling two populations must still beat either alone");
  });

  it("pooling weight moments across windows matches computing them from raw events", () => {
    // The exactness property that lets downsample and the reference lens merge
    // windows without revisiting events — now stated for weighted moments.
    const events: Array<{ x: number; w: number }> = [
      { x: 1, w: 1.0 }, { x: 0, w: 0.8 }, { x: 1, w: 0.6 },
      { x: 1, w: 0.4 }, { x: 0, w: 0.2 },
    ];
    const moments = (evs: typeof events) => ({
      sumW: evs.reduce((s, e) => s + e.w, 0),
      sumW2: evs.reduce((s, e) => s + e.w * e.w, 0),
      sumWX: evs.reduce((s, e) => s + e.w * e.x, 0),
      sumWX2: evs.reduce((s, e) => s + e.w * e.x * e.x, 0),
    });

    const whole = moments(events);
    const left = moments(events.slice(0, 3));
    const right = moments(events.slice(3));

    assert.ok(Math.abs(left.sumW + right.sumW - whole.sumW) < 1e-12);
    assert.ok(Math.abs(left.sumW2 + right.sumW2 - whole.sumW2) < 1e-12);
    assert.ok(Math.abs(left.sumWX + right.sumWX - whole.sumWX) < 1e-12);
    assert.ok(Math.abs(left.sumWX2 + right.sumWX2 - whole.sumWX2) < 1e-12);
    // And the derived effective n agrees with the whole-population figure.
    assert.ok(
      Math.abs(
        kishEffectiveN(left.sumW + right.sumW, left.sumW2 + right.sumW2) -
          kishEffectiveN(whole.sumW, whole.sumW2),
      ) < 1e-12,
    );
  });

  it("an unweighted lens still emits windows with no weights field at all", () => {
    // Structural identity, not just numeric: a window built today must compare
    // equal to one built before weighting existed, or every deepEqual in the
    // suite would have needed updating and the equivalence claim would be
    // untestable.
    const plain = applyLens([ev(0, 1), ev(10, 3)], { window_ms: 1000 });
    assert.equal("weights" in plain.windows[0], false);

    const downsampled = applyLens([ev(0, 1), ev(1000, 3)], {
      window_ms: 1000,
      downsample_factor: 2,
      align: "epoch",
    });
    assert.equal("weights" in downsampled.windows[0], false);
  });
});
