/**
 * Live coarse-view span selection (dashboard.ts `liveSpans`).
 *
 * These tests exist because the two bugs they pin were both found by staring
 * at a 40-second SSE capture, and the first attempted fix for one of them was
 * itself wrong and shipped before a second capture caught it. Neither bug
 * needs an HTTP server, a browser, or a running generator to reproduce — they
 * are properties of which interval gets handed to the lens, which is why
 * `liveSpans` is a separate exported function rather than four lines inlined
 * in broadcast().
 */

import test from "node:test";
import assert from "node:assert/strict";

import { LIVE_REFERENCE_WINDOW_COUNT, liveSpans } from "./dashboard.js";
import { RetentionBuffer } from "./retention-buffer.js";
import { SnapshotCurator } from "./snapshot-curator.js";
import type { LensEvent } from "./lens.js";

const WINDOW_MS = 10_000;
const RATE = 50; // events/sec — index.ts's generator rate

// ── span geometry ───────────────────────────────────────────────────────────

test("liveSpans: reference is the equal-length span immediately before, no overlap", () => {
  const { observation, reference } = liveSpans(1_234_567, WINDOW_MS);
  const obsLen = observation.toTs - observation.fromTs;
  const refLen = reference.toTs - reference.fromTs;

  assert.equal(obsLen, refLen, "observation and reference must be equal length");
  assert.equal(
    reference.toTs + 1,
    observation.fromTs,
    "reference must end exactly where observation begins (adjacent, disjoint)",
  );
});

test("liveSpans: both spans fit inside the shipped retention budget", () => {
  // index.ts builds RetentionBuffer with retentionWindowMs = 120_000. If the
  // total lookback exceeds it the reference falls outside what is retained and
  // referenceUsable silently goes false — the failure mode the first fix
  // attempt shipped with (count=10 → 200s of lookback against a 120s buffer).
  const RETENTION_MS = 120_000;
  const { observation, reference } = liveSpans(1_234_567, WINDOW_MS);
  const lookback = observation.toTs - reference.fromTs;
  assert.ok(
    lookback < RETENTION_MS,
    `total lookback ${lookback}ms must fit in retention ${RETENTION_MS}ms`,
  );
});

test("liveSpans: spans are pinned to an absolute grid, not to the tick clock", () => {
  // The bug this pins: asking for [now-span, now] on every tick re-anchors the
  // window grid one tick further along each time (applyLens anchors to the
  // first event of the segment it is given), so a fixed past burst slides
  // across window boundaries and its tile flickers.
  const base = 1_000_000;
  const withinOneWindow = [0, 1_000, 2_000, 5_000, 9_999].map((d) =>
    liveSpans(base + d, WINDOW_MS),
  );
  for (const s of withinOneWindow) {
    assert.deepEqual(s, withinOneWindow[0], "spans must not move within a window");
  }

  // Crossing a boundary advances by exactly one whole window, never a partial.
  const next = liveSpans(base + WINDOW_MS, WINDOW_MS);
  assert.equal(next.observation.fromTs - withinOneWindow[0].observation.fromTs, WINDOW_MS);
});

// ── window count determinism ────────────────────────────────────────────────

test("liveSpans: observation yields exactly LIVE_REFERENCE_WINDOW_COUNT windows", () => {
  // RetentionBuffer.segment() filters `ts <= toTs` (closed) while lens windows
  // are half-open. Passing the raw grid boundary as toTs admits one event from
  // the next window and produces a degenerate count=1 trailing window, which
  // is unscorable but still inflates the Šidák family size — so the effective
  // threshold jitters with clock luck. Events are placed on an exact grid here
  // precisely to hit that boundary.
  const buf = new RetentionBuffer<LensEvent>((raw) => raw, { retentionWindowMs: 120_000 });
  const T0 = 1_000_000;
  for (let i = 0; i < 140 * RATE; i++) {
    buf.observe({ ts: T0 + Math.floor((i / RATE) * 1000), value: 1 }, "test_result:v1");
  }

  const { observation, reference } = liveSpans(T0 + 130_000, WINDOW_MS);
  assert.equal(
    buf.replay({ window_ms: WINDOW_MS }, observation.fromTs, observation.toTs).windows.length,
    LIVE_REFERENCE_WINDOW_COUNT,
  );
  assert.equal(
    buf.replay({ window_ms: WINDOW_MS }, reference.fromTs, reference.toTs).windows.length,
    LIVE_REFERENCE_WINDOW_COUNT,
  );
});

// ── the regression proper: a fixed past burst must not flicker ──────────────

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The RC shape at the scale index.ts actually runs: 50 evt/s over 4 agents,
 * pass rate 0.95, one agent dropping to `burstPassRate` for 2 seconds.
 */
function buildBurstBuffer(burstPassRate: number, seed = 42): { buf: RetentionBuffer<LensEvent>; T0: number; burstStart: number } {
  const T0 = 1_000_000;
  const burstStart = T0 + 90_000;
  const burstEnd = burstStart + 2_000;
  const rng = mulberry32(seed);
  const buf = new RetentionBuffer<LensEvent>((raw) => raw, { retentionWindowMs: 120_000 });
  for (let i = 0; i < 140 * RATE; i++) {
    const ts = T0 + Math.floor((i / RATE) * 1000);
    const isTargetAgent = i % 4 === 2;
    const inBurst = ts >= burstStart && ts < burstEnd;
    const p = isTargetAgent && inBurst ? burstPassRate : 0.95;
    buf.observe({ ts, value: rng() < p ? 1 : 0 }, "test_result:v1");
  }
  return { buf, T0, burstStart };
}

/**
 * Every tick (1/s, index.ts's TICK_MS) at which the burst's window is fully
 * inside the observation span — i.e. every tick that *should* report it.
 *
 * Ticks before the burst window has fully closed are excluded on purpose:
 * liveSpans deliberately observes only whole windows below the grid line, so
 * an in-progress burst is not yet visible to the coarse view. That is a
 * detection-latency trade (up to one window_ms) taken in exchange for the
 * boundary stability these tests pin, and it is not what "flicker" means.
 */
function* sweepTicks(
  buf: RetentionBuffer<LensEvent>,
  curator: SnapshotCurator,
  burstStart: number,
): Generator<{ nowTs: number; pkg: ReturnType<SnapshotCurator["curate"]> }> {
  const burstWindowStart = Math.floor(burstStart / WINDOW_MS) * WINDOW_MS;
  const burstWindowEnd = burstWindowStart + WINDOW_MS - 1;
  for (let nowTs = burstStart; nowTs <= burstStart + 60_000; nowTs += 1_000) {
    const { observation, reference } = liveSpans(nowTs, WINDOW_MS);
    if (observation.fromTs > burstWindowStart) break; // aged out of the span
    if (observation.toTs < burstWindowEnd) continue; // not yet a closed window
    yield {
      nowTs,
      pkg: curator.curate(
        buf.replay({ window_ms: WINDOW_MS }, observation.fromTs, observation.toTs),
        buf.replay({ window_ms: WINDOW_MS }, reference.fromTs, reference.toTs),
      ),
    };
  }
}

test("live coarse view: an unchanging past burst does not flicker across ticks", () => {
  // Reproduces the 2026-07-29 finding. Before grid quantization this exact
  // fixture produced, for a burst that had already finished and could not
  // change: dip tiles toggling no/no/no/no/no/YES×6/no×3/YES×5/no×6/YES with
  // magnitudes swinging 2.5σ–3.6σ. Nothing in the data moved; only the window
  // boundaries did.
  const { buf, burstStart } = buildBurstBuffer(0.55);
  const curator = new SnapshotCurator({ spikeZThreshold: 2.0, includeBaseline: true });

  const fired: boolean[] = [];
  const regionStarts = new Set<number>();
  for (const { pkg } of sweepTicks(buf, curator, burstStart)) {
    const dip = pkg.tiles.find((t) => t.shapeTag === "dip");
    fired.push(dip !== undefined);
    if (dip) regionStarts.add(dip.regionStart);
  }

  assert.ok(fired.length >= 10, `expected a meaningful sweep, got ${fired.length} ticks`);
  assert.ok(
    fired.every((f) => f === fired[0]),
    `dip tile toggled across ticks for an unchanging burst: ${fired.map((f) => (f ? "Y" : "n")).join("")}`,
  );
  assert.equal(
    regionStarts.size <= 1,
    true,
    `the same burst was reported at ${regionStarts.size} different regionStarts: ${[...regionStarts]}`,
  );
});

test("live coarse view: a strong burst is reported at a stable magnitude", () => {
  // Same fixture, unambiguous effect size. Pre-fix this fired on every tick
  // but reported 2.60σ–5.28σ for the identical historical burst, because the
  // burst was alternately whole-in-one-window and split across two.
  const { buf, burstStart } = buildBurstBuffer(0.20);
  const curator = new SnapshotCurator({ spikeZThreshold: 2.0, includeBaseline: true });

  const magnitudes: number[] = [];
  for (const { pkg } of sweepTicks(buf, curator, burstStart)) {
    const dip = pkg.tiles.find((t) => t.shapeTag === "dip");
    assert.ok(dip, "a 0.20 burst must be visible in the coarse view");
    magnitudes.push(dip.magnitude ?? 0);
  }

  const min = Math.min(...magnitudes);
  const max = Math.max(...magnitudes);
  // Residual spread is the reference span sliding to a different quiet stretch
  // (real sampling noise in the yardstick), not the burst moving under the
  // grid. That is bounded; the anchor-slide artefact was not.
  assert.ok(
    max - min < 1.0,
    `magnitude for an unchanging burst spanned ${min.toFixed(2)}σ–${max.toFixed(2)}σ across ticks`,
  );
});
