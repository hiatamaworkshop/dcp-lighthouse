/**
 * Comparator — the declared comparison ($Q[compare]) run in one place
 * (ROADMAP_BRIEF.md 2026-10-14 (8)).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Comparator, assertComparable } from "./comparison.js";
import { RetentionBuffer } from "./retention-buffer.js";
import { SnapshotCurator } from "./snapshot-curator.js";
import { WindowHistory } from "./window-history.js";
import type { LensEvent } from "./lens.js";

const T0 = 1_000_000;
const EPOCH = { window_ms: 1_000, align: "epoch" as const };

/** 50 events/s over [from, to), value 0 on every 7th ms tick, else 1. */
function bufferWith(from: number, to: number): RetentionBuffer<LensEvent> {
  const buf = new RetentionBuffer<LensEvent>((raw) => raw, { retentionWindowMs: 10_000_000 });
  for (let ts = from; ts < to; ts += 20) buf.observe({ ts, value: ts % 7 === 0 ? 0 : 1 }, "test_result:v1");
  return buf;
}

const strip = <T extends { generatedAt: number }>(p: T) => {
  const { generatedAt: _g, ...rest } = p as T & { referenceCoverage?: number; comparison?: unknown };
  delete rest.referenceCoverage;
  delete rest.comparison;
  return rest;
};

describe("Comparator.compare — the preceding reference", () => {
  it("reproduces the live view's spans and scores exactly as the curator did before", () => {
    // The live view's request: 3 windows ending one ms before a grid boundary.
    const buf = bufferWith(T0, T0 + 20_000);
    const obs = { fromTs: T0 + 10_000, toTs: T0 + 12_999 };
    const pkg = new Comparator({ spikeZThreshold: 2.0 }).compare(buf, EPOCH, {}, obs);
    assert.deepEqual(pkg.comparison, {
      reference: { kind: "preceding", fromTs: T0 + 7_000, toTs: T0 + 9_999 },
      nullModel: "independent",
    });
    const direct = new SnapshotCurator({ spikeZThreshold: 2.0 }).curate(
      buf.replay(EPOCH, obs.fromTs, obs.toTs),
      buf.replay(EPOCH, T0 + 7_000, T0 + 9_999),
    );
    assert.deepEqual(strip(pkg), strip(direct));
  });

  it("never lets the reference and the observation share a ms", () => {
    // A replay of [fromTs, toTs] used to take [fromTs − L, fromTs] as reference,
    // so the event at fromTs was counted on both sides.
    const pkg = new Comparator().compare(bufferWith(T0, T0 + 40_000), EPOCH, {}, { fromTs: T0 + 20_000, toTs: T0 + 30_000 });
    assert.deepEqual(pkg.comparison!.reference, { kind: "preceding", fromTs: T0 + 9_999, toTs: T0 + 19_999 });
  });

  it("takes reference_windows windows of the observation lens when declared", () => {
    const lens = { ...EPOCH, downsample_factor: 2 }; // 2 s windows
    const pkg = new Comparator().compare(bufferWith(T0, T0 + 40_000), lens, { reference_windows: 4 }, { fromTs: T0 + 30_000, toTs: T0 + 35_999 });
    assert.deepEqual(pkg.comparison!.reference, { kind: "preceding", fromTs: T0 + 22_000, toTs: T0 + 29_999 });
    assert.equal(pkg.globalStats.windowCount, 4);
    assert.equal(pkg.referenceCoverage, 1);
  });

  it("declares how much of the reference span held events (2026-09-27 review, finding 3d)", () => {
    // The RC-after-/demo/stop shape: the stream restarted a second before the
    // replay's fromTs, so the reference is empty except for its last window —
    // "usable", but barely there.
    const SPAN = 16_000;
    const comparator = new Comparator({ spikeZThreshold: 2.0 });
    const thin = comparator.compare(bufferWith(T0 + SPAN - 1_000, T0 + 2 * SPAN), EPOCH, {}, { fromTs: T0 + SPAN, toTs: T0 + 2 * SPAN });
    assert.equal(thin.referenceUsable, true, "the old flag alone calls this usable");
    assert.equal(thin.referenceCoverage, 1 / 16, "…while only 1 of 16 reference windows held events");
    const full = comparator.compare(bufferWith(T0, T0 + 2 * SPAN), EPOCH, {}, { fromTs: T0 + SPAN, toTs: T0 + 2 * SPAN });
    assert.equal(full.referenceCoverage, 1);
  });
});

describe("Comparator.compare — the declared null", () => {
  const buf = bufferWith(T0, T0 + 60_000);
  const obs = { fromTs: T0 + 50_000, toTs: T0 + 59_999 };

  it("scores under the null the row names, and says which", () => {
    const comparator = new Comparator();
    const indep = comparator.compare(buf, EPOCH, {}, obs);
    assert.equal(indep.comparison!.nullModel, "independent");
    assert.equal(indep.overdispersion, undefined);
    const od = comparator.compare(buf, EPOCH, { null_model: "overdispersed" }, obs);
    assert.equal(od.comparison!.nullModel, "overdispersed");
    assert.ok(od.overdispersion !== undefined);
    assert.equal(comparator.curatorFor("overdispersed"), comparator.curatorFor("overdispersed"), "one curator per null");
  });

  it("hands the variogram null its history, ending where the reference ends", () => {
    const pkg = new Comparator().compare(buf, EPOCH, { null_model: "variogram", history_ms: 30_000 }, obs);
    assert.deepEqual(pkg.comparison!.history, { fromTs: T0 + 10_000, toTs: T0 + 49_999, windowCount: 40, source: "replay" });
    assert.equal(pkg.variogram![0].historyWindows, 40);
    // Without history the reference stands in, and the package says so.
    const bare = new Comparator().compare(buf, EPOCH, { null_model: "variogram" }, obs);
    assert.equal(bare.comparison!.history, undefined);
    assert.equal(bare.variogram![0].historyWindows, 10);
  });

  it("reads the history from window summaries when given a source, unthinned where the buffer's own replay is not", () => {
    // Freshness zone 20 s: reference and observation stay fresh, while the 30 s
    // of history behind them have aged into the thinned zone.
    const thinned = new RetentionBuffer<LensEvent>((raw) => raw, {
      retentionWindowMs: 20_000, referenceWindowMs: 100_000, thinningRatio: 2,
    });
    const history = new WindowHistory(thinned, { maxHistoryMs: 3_600_000 });
    history.track(EPOCH);
    for (let ts = T0; ts < T0 + 60_000; ts += 20) thinned.observe({ ts, value: ts % 7 === 0 ? 0 : 1 }, "test_result:v1");

    const decl = { null_model: "variogram" as const, history_ms: 30_000 };
    const fromSummaries = new Comparator({}, history).compare(thinned, EPOCH, decl, obs);
    assert.deepEqual(fromSummaries.comparison!.history, { fromTs: T0 + 10_000, toTs: T0 + 49_999, windowCount: 40, source: "window-summaries" });
    // The same history the unthinned buffer replays, so the same package.
    const unthinned = new Comparator().compare(buf, EPOCH, decl, obs);
    assert.deepEqual(strip(fromSummaries), strip(unthinned));
    // What the buffer's own replay would have handed over instead: weighted windows.
    assert.ok(thinned.replay(EPOCH, T0 + 10_000, T0 + 39_999).windows.every((w) => w.weights !== undefined));
  });

  it("refuses the variogram null on a lens whose grid is not absolute, history or not", () => {
    // Separate replays anchored at their own first events put the windows off
    // phase; the lags would be rounded and γ read at the wrong one.
    for (const decl of [{ null_model: "variogram" as const, history_ms: 30_000 }, { null_model: "variogram" as const }]) {
      assert.throws(() => new Comparator().compare(buf, { window_ms: 1_000 }, decl, obs), /align:"epoch"/, JSON.stringify(decl));
    }
    // The other nulls read no lags.
    assert.doesNotThrow(() => new Comparator().compare(buf, { window_ms: 1_000 }, { null_model: "overdispersed" }, obs));
  });
});

describe("assertComparable — the rule a proposal gate and compare() share", () => {
  const vario = { null_model: "variogram" as const, history_ms: 60_000 };

  it("asks nothing of a lens under the nulls that read no lags", () => {
    for (const decl of [{}, { null_model: "overdispersed" as const }]) {
      assert.doesNotThrow(() => assertComparable({ window_ms: 1_000, decay: "step(cutoff=now-60s)" }, decl, true));
    }
  });

  it("under the variogram null, refuses an off-grid lens, and with summaries an unsummarizable one", () => {
    // ClaudeBrain's replay proposals: the lens it names is judged before it runs.
    assert.throws(() => assertComparable({ window_ms: 1_000, group_by: ["agentId"] }, vario, true), /align:"epoch"/);
    assert.throws(() => assertComparable({ window_ms: 1_000, align: "epoch", agg_func: "median" }, vario, true), /mean summaries/);
    assert.doesNotThrow(() => assertComparable({ window_ms: 1_000, align: "epoch", agg_func: "median" }, vario, false));
    assert.doesNotThrow(() => assertComparable({ window_ms: 1_000, align: "epoch", group_by: ["agentId"] }, vario, true));
  });

  it("is what compare() throws, before reading a window", () => {
    const comparator = new Comparator({}, new WindowHistory(bufferWith(T0, T0 + 1_000), { maxHistoryMs: 60_000 }));
    assert.throws(
      () => comparator.compare(bufferWith(T0, T0 + 1_000), { window_ms: 1_000, align: "epoch", decay: "step(cutoff=now-60s)" }, vario, { fromTs: T0, toTs: T0 + 999 }),
      /decayed lens/,
    );
  });
});
