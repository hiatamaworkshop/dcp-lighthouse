/**
 * The volume channel (CurationOptions.volumeChannel, ROADMAP C3): windows whose
 * event count left the reference's ordinary range, judged apart from the rate gate.
 * The rate side must not move at all — that is the first thing these pin.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyLens, MIN_VALID_COUNT, type LensEvent, type LensResult } from "./lens.js";
import { MIN_VOLUME_REFERENCE_WINDOWS, SnapshotCurator, type SnapshotPackage } from "./snapshot-curator.js";

function rng32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal from two uniforms. */
function gauss(r: () => number): number {
  return Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
}

/** Windows with the given counts; means scatter a little so the rate reference has a variance. */
function counts(cs: number[], seed = 1, from = 0, window_ms = 1000): LensResult {
  const r = rng32(seed);
  return {
    window_ms,
    windows: cs.map((count, i) => {
      const mean = 0.5 + 0.05 * (r() - 0.5);
      return {
        windowStart: from + i * window_ms, windowEnd: from + (i + 1) * window_ms,
        mean, count, sumSq: count * mean * mean, valid: count >= MIN_VALID_COUNT,
      };
    }),
  };
}

/** Counts ~ N(mu, sd) rounded — a stand-in for Poisson counts at mu ≳ 30. */
function noisyCounts(n: number, mu: number, seed: number): number[] {
  const r = rng32(seed);
  return Array.from({ length: n }, () => Math.max(1, Math.round(mu + Math.sqrt(mu) * gauss(r))));
}

const strip = (p: SnapshotPackage) => {
  const { generatedAt: _g, volume: _v, ...rest } = p;
  return JSON.stringify(rest);
};

describe("volume channel — opt-in, and the rate side does not move", () => {
  const ref = counts(noisyCounts(60, 100, 7), 11);
  const obs = counts([...noisyCounts(10, 100, 8), 480, ...noisyCounts(9, 100, 9)], 12, 60_000);

  it("is absent by default", () => {
    assert.equal(new SnapshotCurator().curate(obs, ref).volume, undefined);
  });

  it("changes nothing else in the package when switched on", () => {
    for (const nullModel of ["independent", "overdispersed", "variogram"] as const) {
      const off = new SnapshotCurator({ nullModel, recordWindowScores: true }).curate(obs, ref);
      const on = new SnapshotCurator({ nullModel, recordWindowScores: true, volumeChannel: true }).curate(obs, ref);
      assert.equal(strip(on), strip(off), nullModel);
      assert.ok(on.volume !== undefined);
    }
  });
});

describe("volume channel — what it flags", () => {
  const ref = counts(noisyCounts(60, 100, 21), 22);

  it("names a window with a batch's worth of extra events, up, and leaves ordinary windows alone", () => {
    const obs = counts([...noisyCounts(10, 100, 23), 480, ...noisyCounts(9, 100, 24)], 25, 60_000);
    const v = new SnapshotCurator({ volumeChannel: true }).curate(obs, ref).volume!;
    assert.equal(v.tiles.length, 1);
    assert.equal(v.tiles[0].direction, "up");
    assert.equal(v.tiles[0].regionStart, 70_000);
    assert.equal(v.tiles[0].volume, 480);
    assert.ok(v.tiles[0].volumeRatio > 4 && v.tiles[0].volumeRatio < 5.5, String(v.tiles[0].volumeRatio));
    assert.ok(v.tiles[0].z > v.effectiveZThreshold);
  });

  it("names a drop in volume, down", () => {
    const obs = counts([...noisyCounts(5, 100, 26), 15, ...noisyCounts(14, 100, 27)], 28, 60_000);
    const v = new SnapshotCurator({ volumeChannel: true }).curate(obs, ref).volume!;
    assert.deepEqual(v.tiles.map((t) => t.direction), ["down"]);
    assert.equal(v.tiles[0].regionStart, 65_000);
  });

  it("is not fooled by batches inside the reference (the yardstick is robust)", () => {
    // A fifth of the reference windows sit at 5× — a plain SD over them would be so wide that
    // a fresh 5× window passed as ordinary. The reference of a changing stream looks like this.
    const r = rng32(31);
    const polluted = noisyCounts(60, 100, 32).map((c, i) => (i % 5 === 0 && r() < 2 ? c * 5 : c));
    const obs = counts([...noisyCounts(10, 100, 33), 520, ...noisyCounts(9, 100, 34)], 35, 60_000);
    const v = new SnapshotCurator({ volumeChannel: true }).curate(obs, counts(polluted, 36)).volume!;
    assert.deepEqual(v.tiles.map((t) => t.direction), ["up"]);
  });

  it("reads a thinned reference by what its events stand for, not by how many were kept", () => {
    // The same reference twice: whole, and thinned by 2 with the kept events weighted 2.
    const whole = counts(noisyCounts(60, 100, 41), 42);
    const thinned: LensResult = {
      ...whole,
      windows: whole.windows.map((w) => ({
        ...w, count: Math.round(w.count / 2), weights: { sumW: w.count, sumW2: 2 * w.count },
      })),
    };
    const obs = counts([...noisyCounts(10, 100, 43), 480, ...noisyCounts(9, 100, 44)], 45, 60_000);
    const a = new SnapshotCurator({ volumeChannel: true }).curate(obs, whole).volume!;
    const b = new SnapshotCurator({ volumeChannel: true }).curate(obs, thinned).volume!;
    assert.deepEqual(b.tiles.map((t) => [t.regionStart, t.direction]), a.tiles.map((t) => [t.regionStart, t.direction]));
    assert.ok(Math.abs(b.units[0].typicalVolume - a.units[0].typicalVolume) < 1e-9);
  });

  it("declares itself blind, not quiet, when the reference is too short", () => {
    const short = counts(noisyCounts(MIN_VOLUME_REFERENCE_WINDOWS - 1, 100, 51), 52);
    const obs = counts([...noisyCounts(5, 100, 53), 900], 54, 60_000);
    const v = new SnapshotCurator({ volumeChannel: true }).curate(obs, short).volume!;
    assert.equal(v.units[0].blind, true);
    assert.equal(v.tiles.length, 0);
    assert.equal(v.scoredWindowCount, 0);
  });

  it("does not score a window that is not wholly inside the requested span (a partial window reads as a drop)", () => {
    // A replay of [from, from + k·W] leaves a 1 ms tail window holding a single event.
    const full = noisyCounts(10, 100, 71);
    const obs = counts([...full, 1], 72, 60_000);
    const span = { fromTs: 60_000, toTs: 60_000 + 10_000 };
    const naive = new SnapshotCurator({ volumeChannel: true }).curate(obs, ref).volume!;
    assert.ok(naive.tiles.some((t) => t.direction === "down" && t.regionStart === 70_000), "without the span the tail is flagged");
    const spanned = new SnapshotCurator({ volumeChannel: true, recordWindowScores: true }).curate(obs, ref, { span }).volume!;
    assert.equal(spanned.tiles.length, 0);
    assert.equal(spanned.scoredWindowCount, 10);
    assert.equal(spanned.scores!.length, 10);
  });

  it("records every scored window's z only when window scores are asked for", () => {
    const obs = counts(noisyCounts(20, 100, 61), 62, 60_000);
    assert.equal(new SnapshotCurator({ volumeChannel: true }).curate(obs, ref).volume!.scores, undefined);
    const s = new SnapshotCurator({ volumeChannel: true, recordWindowScores: true }).curate(obs, ref).volume!.scores!;
    assert.equal(s.length, 20);
  });
});

describe("volume channel — per group", () => {
  it("scores each group against its own reference volume and labels the tile", () => {
    // Group a holds 25 events a window throughout; group b holds 25 too, except one observed window with 120.
    const events = (from: number, windows: number, bBurstAt = -1): LensEvent[] => {
      const out: LensEvent[] = [];
      const r = rng32(from + 1);
      for (let w = 0; w < windows; w++) {
        const ws = from + w * 1000;
        for (const agentId of ["a", "b"]) {
          const n = agentId === "b" && w === bBurstAt ? 120 : Math.max(10, Math.round(25 + 5 * gauss(r)));
          for (let i = 0; i < n; i++) out.push({ ts: ws + (i * 1000) / n, value: r() < 0.5 ? 1 : 0, keys: { agentId } });
        }
      }
      return out;
    };
    const lens = { window_ms: 1000, align: "epoch" as const, group_by: ["agentId"] };
    const ref = applyLens(events(0, 40), lens);
    const obs = applyLens(events(40_000, 10, 4), lens);
    const v = new SnapshotCurator({ volumeChannel: true }).curate(obs, ref).volume!;
    assert.deepEqual(v.units.map((u) => u.group), ["a", "b"]);
    assert.equal(v.tiles.length, 1);
    assert.equal(v.tiles[0].group, "b");
    assert.equal(v.tiles[0].direction, "up");
    assert.match(v.tiles[0].label, /^\[b\] /);
  });
});

describe("volume channel — calibration on iid counts", () => {
  it("keeps the package-level false alarm near the budget when counts are Poisson-like", () => {
    // One generator through every trial: consecutive seeds of this PRNG are not independent streams.
    const r = rng32(20261102);
    const draw = (n: number) => Array.from({ length: n }, () => Math.max(1, Math.round(100 + 10 * gauss(r))));
    let flagged = 0;
    const trials = 600;
    for (let s = 0; s < trials; s++) {
      const ref = counts(draw(60), 5000 + s);
      const obs = counts(draw(60), 6000 + s, 60_000);
      if (new SnapshotCurator({ volumeChannel: true }).curate(obs, ref).volume!.tiles.length > 0) flagged++;
    }
    // Designed 4.55%; measured 5.5% at this setting (SE ≈ 0.9 pt) — the finite reference gives some slack either way.
    assert.ok(flagged / trials < 0.085, `package false-alarm ${(100 * flagged / trials).toFixed(1)}%`);
  });
});
