/**
 * Calibration monitoring of `$F` (ROADMAP C5): what the state says, that it reads
 * ordinary-volume windows only, and that the monitor scores each origin once.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ForecastMonitor, MONITOR_MIN_TARGETS, calibrationState, readCalibration,
  type ForecastScorer, type MonitorRecord,
} from "./forecast-monitor.js";
import type { ForecastScore } from "./forecast.js";
import type { QForecastParams, QObserveParams } from "./q-registry.js";

function rng32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());

const HOUR = 3_600_000;
const rec = (over: Partial<MonitorRecord>): MonitorRecord => ({
  origin: 0, targetEnd: 0, horizon: 1, z: 0, inside: true, volumeRatio: 1, level: 0.95, ...over,
});

/** `n` records of horizon 1 with z drawn at standard deviation `sd`, one per minute ending at `end`. */
function draws(n: number, sd: number, end: number, seed: number, extra: Partial<MonitorRecord> = {}): MonitorRecord[] {
  const r = rng32(seed);
  return Array.from({ length: n }, (_, i) => {
    const z = sd * gauss(r);
    return rec({ targetEnd: end - i * 60_000, z, inside: Math.abs(z) <= 1.96, ...extra });
  });
}

describe("calibrationState", () => {
  it("is blind, never healthy, with too few windows", () => {
    assert.equal(calibrationState(1, MONITOR_MIN_TARGETS - 1), "blind");
    assert.equal(calibrationState(Number.NaN, 500), "blind");
  });

  it("separates over-claiming, over-cautious and calibrated forecasts at n = 60", () => {
    assert.equal(calibrationState(0.85, 60), "healthy"); // the recorded real-data baseline
    assert.equal(calibrationState(1.0, 60), "healthy");
    assert.equal(calibrationState(2.0, 60), "overconfident");
    assert.equal(calibrationState(0.3, 60), "conservative");
  });

  it("asks for more evidence of a smaller departure", () => {
    assert.equal(calibrationState(1.5, 60), "overconfident"); // 1.5 − 0.37 > 1
    assert.equal(calibrationState(1.3, 60), "healthy");
    assert.equal(calibrationState(1.3, 400), "overconfident"); // the same 1.3 is evidence at n = 400
  });
});

describe("readCalibration", () => {
  const now = 100 * HOUR;

  it("reads a calibrated stream as healthy and an over-claiming one as overconfident", () => {
    const fine = readCalibration(draws(60, 1, now, 1), [HOUR], now)[0];
    assert.equal(fine.state, "healthy");
    assert.equal(fine.readings[0].targets, 60);
    const bad = readCalibration(draws(60, 1.8, now, 2), [HOUR], now)[0];
    assert.equal(bad.state, "overconfident");
    assert.ok(bad.readings[0].coverage < 0.95);
  });

  it("reads ordinary-volume windows only, and reports the rest beside them", () => {
    // 60 calibrated ordinary windows, plus 30 windows at 3× volume where every forecast misses badly.
    const records = [...draws(60, 1, now, 3), ...draws(30, 5, now - HOUR / 2, 4, { volumeRatio: 3 })];
    const r = readCalibration(records, [HOUR], now)[0].readings[0];
    assert.equal(r.targets, 60);
    assert.equal(r.state, "healthy");
    assert.equal(r.all.targets, 90);
    assert.ok(r.all.varZ > 3 * r.varZ, `all-windows variance ${r.all.varZ} should dwarf ordinary ${r.varZ}`);
  });

  it("goes blind when the make-up moved everywhere (no ordinary window to judge)", () => {
    const span = readCalibration(draws(60, 5, now, 5, { volumeRatio: 4 }), [HOUR], now)[0];
    assert.equal(span.state, "blind");
    assert.equal(span.readings[0].all.targets, 60);
  });

  it("windows by the target's end and keeps spans apart", () => {
    // 60 old calibrated targets (23 h ago) and nothing in the last hour.
    const old = draws(60, 1, now - 23 * HOUR, 6);
    const [hour, day] = readCalibration(old, [HOUR, 24 * HOUR], now);
    assert.equal(hour.state, "blind");
    assert.deepEqual(hour.readings, []);
    assert.equal(day.state, "healthy");
  });

  it("names the worst horizon as the span's state", () => {
    const records = [...draws(60, 1, now, 7, { horizon: 1 }), ...draws(60, 2, now, 8, { horizon: 6 })];
    const span = readCalibration(records, [HOUR], now)[0];
    assert.deepEqual(span.readings.map((r) => [r.horizon, r.state]), [[1, "healthy"], [6, "overconfident"]]);
    assert.equal(span.state, "overconfident");
  });
});

describe("ForecastMonitor", () => {
  const lens: QObserveParams = { window_ms: 10_000, align: "epoch" };
  const decl: QForecastParams = { recent_windows: 30, horizons: [1, 6], history_ms: HOUR, level: 0.95, method: "kriging" };
  const view = { view: "coarse", lens, decl };

  /** A scorer that returns one score per horizon at `at`, remembering the origins it was asked for. */
  function stub(sd = 1) {
    const asked: number[] = [];
    const r = rng32(99);
    const scorer: ForecastScorer = {
      score(_lens, d, at, nowTs) {
        asked.push(at);
        return d.horizons.flatMap((h) => {
          const targetEnd = at + h * 10_000; // the h-th window after the origin ends h windows on
          if (targetEnd > nowTs) return [];
          const z = sd * gauss(r);
          return [{
            virtual: true, against: "forecast", z, insideInterval: Math.abs(z) <= 1.96, volumeRatio: 1, error: 0, sd: 1,
            realized: { windowStart: targetEnd - 10_000, windowEnd: targetEnd, count: 100, mean: 0.5 },
            forecast: { origin: at, horizon: h, interval: { level: 0.95, lo: 0, hi: 1 } },
          } as unknown as ForecastScore];
        });
      },
    };
    return { scorer, asked };
  }

  it("scores an origin once, only after its furthest horizon is whole", () => {
    const { scorer, asked } = stub();
    const m = new ForecastMonitor(scorer);
    const t0 = 1_000 * HOUR;
    m.update(t0, [view]);
    const first = asked.length;
    assert.ok(first > 0);
    const newest = Math.max(...asked);
    assert.ok(newest + 6 * 10_000 <= t0, "the furthest horizon (6 windows) of the newest origin has ended");
    m.update(t0 + 1000, [view]);
    assert.equal(asked.length, first, "nothing new is whole a second later");
    m.update(t0 + 60_000, [view]);
    assert.equal(asked.length, first + 1, "one more origin a minute later");
    assert.equal(new Set(asked).size, asked.length, "no origin scored twice");
  });

  it("reaches healthy as evidence accumulates and starts over when the declaration changes", () => {
    const { scorer } = stub();
    const m = new ForecastMonitor(scorer);
    let now = 1_000 * HOUR;
    assert.equal(m.report("coarse", now).spans[0].state, "blind");
    for (let i = 0; i < 90; i++, now += 60_000) m.update(now, [view]);
    const rep = m.report("coarse", now);
    assert.equal(rep.virtual, true);
    assert.equal(rep.spans[0].state, "healthy");
    assert.ok(rep.scoredThrough !== null);
    assert.ok(rep.spans[0].readings.every((r) => r.targets >= MONITOR_MIN_TARGETS));
    // A new declaration starts the record over: the horizons read are the new ones only (the old
    // [1, 6] records are gone), made from a fresh catch-up rather than carried across.
    assert.deepEqual(rep.spans[0].readings.map((r) => r.horizon), [1, 6]);
    m.update(now, [{ ...view, decl: { ...decl, horizons: [1, 2] } }]);
    assert.deepEqual(m.report("coarse", now).spans[0].readings.map((r) => r.horizon), [1, 2]);
  });

  it("calls an over-claiming scorer overconfident", () => {
    const { scorer } = stub(2);
    const m = new ForecastMonitor(scorer);
    let now = 1_000 * HOUR;
    for (let i = 0; i < 90; i++, now += 60_000) m.update(now, [view]);
    assert.equal(m.report("coarse", now).spans[0].state, "overconfident");
  });

  it("forgets targets older than its longest span", () => {
    const { scorer } = stub();
    const m = new ForecastMonitor(scorer, [HOUR]);
    let now = 1_000 * HOUR;
    for (let i = 0; i < 200; i++, now += 60_000) m.update(now, [view]);
    const kept = m.report("coarse", now).spans[0].readings.reduce((n, r) => n + r.all.targets, 0);
    assert.ok(kept <= 2 * 61, `kept ${kept} targets for an hour of 2 horizons a minute`);
  });
});
