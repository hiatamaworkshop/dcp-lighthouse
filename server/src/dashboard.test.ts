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

import {
  LIVE_REFERENCE_WINDOW_COUNT,
  effectiveWindowMs,
  liveLookbackMs,
  liveSpans,
  maxCoarseWindowMs,
} from "./dashboard.js";
import { RetentionBuffer } from "./retention-buffer.js";
import { SnapshotCurator } from "./snapshot-curator.js";
import { applyLens, type LensEvent } from "./lens.js";

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
  // index.ts bootstraps $Q[pipeline].retention_window_ms = 120_000. If the
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

test("liveLookbackMs agrees with what liveSpans actually reaches back for", () => {
  // The budget check warns from liveLookbackMs while the reads come from
  // liveSpans. If the two formulas drift the warning becomes a lie — silent in
  // exactly the case it exists for. Pin them to each other, not to a literal.
  for (const windowMs of [1_000, 10_000, 7_000]) {
    const { observation, reference } = liveSpans(1_234_567, windowMs);
    const actual = observation.toTs - reference.fromTs + 1; // toTs is inclusive
    assert.equal(liveLookbackMs(windowMs), actual, `window_ms=${windowMs}`);
  }
});

test("maxCoarseWindowMs is the largest window whose lookback still fits", () => {
  const RETENTION_MS = 120_000;
  const w = maxCoarseWindowMs(RETENTION_MS);
  assert.ok(liveLookbackMs(w) <= RETENTION_MS, `${w}ms must fit`);
  assert.ok(liveLookbackMs(w + 1) > RETENTION_MS, `${w + 1}ms must not fit`);
  // The shipped coarse window is well inside it — the check should be quiet in
  // the default configuration, or it is noise nobody will read.
  assert.ok(WINDOW_MS < w, `shipped coarse window ${WINDOW_MS}ms must clear the budget`);
});

// ── downsample_factor wiring (ROADMAP L4 residual, 2026-08-17) ─────────────

test("effectiveWindowMs folds downsample_factor into the live span size", () => {
  // Undeclared factor (or no factor at all) must be a no-op: the pre-wiring
  // behavior for every lens that doesn't touch this stage.
  assert.equal(effectiveWindowMs({ window_ms: 10_000 }, 10_000), 10_000);
  assert.equal(effectiveWindowMs({ window_ms: 10_000, downsample_factor: 1 }, 10_000), 10_000);

  // The bug this pins: sizing liveSpans off the raw window_ms while the lens
  // itself merges `factor` slots into one would ask for
  // LIVE_REFERENCE_WINDOW_COUNT windows of the wrong (narrower) width.
  assert.equal(effectiveWindowMs({ window_ms: 10_000, downsample_factor: 3 }, 10_000), 30_000);

  // No window_ms declared at all: the fallback is a LensResult.window_ms that
  // applyLens has already scaled, so it must be returned as-is.
  assert.equal(effectiveWindowMs({}, 10_000), 10_000);
});

test("effectiveWindowMs does not double-apply the factor to an already-scaled fallback", () => {
  // A lens may legally declare downsample_factor without window_ms — a $Q row
  // a Brain can write, and what the registry's `observe:*` fallback can carry.
  // applyLens then uses its own default width and returns width*factor, so the
  // fallback ALREADY includes the factor; multiplying it again sized the live
  // spans 3x too wide (found in review 2026-08-17, pre-fix behavior).
  const lens = { downsample_factor: 3 };
  const derived = applyLens([{ ts: 0, value: 1 }, { ts: 1_000, value: 1 }], lens);
  assert.equal(
    effectiveWindowMs(lens, derived.window_ms),
    derived.window_ms,
    "span sizing must agree with the width applyLens actually produced",
  );
});

test("liveSpans sized via effectiveWindowMs still yields exactly LIVE_REFERENCE_WINDOW_COUNT windows once downsample_factor is set", () => {
  const buf = new RetentionBuffer<LensEvent>((raw) => raw, { retentionWindowMs: 120_000 });
  const T0 = 1_000_000;
  for (let i = 0; i < 140 * RATE; i++) {
    buf.observe({ ts: T0 + Math.floor((i / RATE) * 1000), value: 1 }, "test_result:v1");
  }

  const baseWindowMs = 2_000;
  const factor = 3; // effective window becomes 6_000ms
  const lens = { window_ms: baseWindowMs, downsample_factor: factor, align: "epoch" as const };
  const windowMs = effectiveWindowMs(lens, baseWindowMs);
  assert.equal(windowMs, baseWindowMs * factor);

  const { observation, reference } = liveSpans(T0 + 130_000, windowMs);
  assert.equal(
    buf.replay(lens, observation.fromTs, observation.toTs).windows.length,
    LIVE_REFERENCE_WINDOW_COUNT,
    "observation must still resolve to the expected window count under the downsampled lens",
  );
  assert.equal(
    buf.replay(lens, reference.fromTs, reference.toTs).windows.length,
    LIVE_REFERENCE_WINDOW_COUNT,
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

test("liveSpans: requested spans sit on the same grid the lens builds windows on", () => {
  // The two readers of the grid are liveSpans (choosing what to request) and
  // applyLens (placing events into windows). Before L4 those were independent
  // floor expressions agreeing by inspection; now both go through the lens's
  // declared origin. Pin that they agree, including at a non-zero phase.
  for (const origin of [0, 250, 7_000]) {
    const lens = { window_ms: WINDOW_MS, align: "epoch" as const, origin };
    const { observation } = liveSpans(1_234_567, WINDOW_MS, LIVE_REFERENCE_WINDOW_COUNT, origin);
    // One event placed at the requested start must open a window exactly there.
    const placed = applyLens([{ ts: observation.fromTs, value: 1 }], lens);
    assert.equal(
      placed.windows[0].windowStart,
      observation.fromTs,
      `origin=${origin}: the requested span must begin on a window boundary`,
    );
  }
});

test("liveSpans: a non-zero origin shifts the grid by exactly that phase", () => {
  const zero = liveSpans(1_234_567, WINDOW_MS, LIVE_REFERENCE_WINDOW_COUNT, 0);
  const shifted = liveSpans(1_234_567, WINDOW_MS, LIVE_REFERENCE_WINDOW_COUNT, 250);
  assert.equal(shifted.observation.fromTs - zero.observation.fromTs, 250);
  assert.equal(shifted.reference.fromTs - zero.reference.fromTs, 250);
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

// ── request-path fault isolation ────────────────────────────────────────────

import { DashboardServer } from "./dashboard.js";
import { QRegistry } from "./q-registry.js";
import { ObservationOverlay } from "./lens-view.js";

/**
 * Start a DashboardServer on an OS-assigned port with the collaborators these
 * tests need. Everything not exercised is a null stub: the point is the
 * request path, not the pipeline behind it.
 */
async function startTestServer(
  generator: unknown,
): Promise<{ base: string; close: () => Promise<void> }> {
  const registry = new QRegistry();
  const server = new DashboardServer(
    generator as never,
    null as never,
    null as never,
    registry,
    null as never,
    new ObservationOverlay(registry),
    { replay: () => ({ window_ms: 1000, windows: [] }), getRetentionWindowMs: () => 120_000 },
  ).start({ port: 0 });

  await new Promise<void>((resolve) => server.once("listening", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("a throwing handler answers the request instead of killing the process", async () => {
  // Node routes a synchronous throw inside a request handler to
  // uncaughtException, which with no listener terminates the server — so
  // before the catch in handle(), one bad request took the observation layer
  // down. /status is the shortest route to a throwing collaborator.
  const boom = { getCurrentLoad: () => { throw new Error("collaborator exploded"); } };
  const { base, close } = await startTestServer(boom);
  try {
    const res = await fetch(`${base}/status`);
    assert.equal(res.status, 500, "an internal defect is a 500, not a silent death");
    assert.match((await res.json()).error, /collaborator exploded/);

    // The point of the whole exercise: still serving afterwards.
    const after = await fetch(`${base}/demo/stop`).catch(() => null);
    assert.ok(after, "server must still accept requests after a handler threw");
  } finally {
    await close();
  }
});

test("a rejected lens is a 400 carrying the rulebook's own message", async () => {
  // The endpoint no longer restates the positive-integer rule; it hands the
  // value to registry.set, whose validateObserveParams throws RangeError, and
  // handle() maps that to 400. So this also pins that the caller sees the
  // rulebook's wording rather than a duplicate maintained next to it.
  const { base, close } = await startTestServer({ getCurrentLoad: () => ({}) });
  try {
    for (const bad of ["0", "-2", "1.5"]) {
      const res = await fetch(`${base}/control/coarse-downsample?factor=${bad}`);
      assert.equal(res.status, 400, `factor=${bad} must be refused`);
      assert.match((await res.json()).error, /downsample_factor/, `factor=${bad}`);
    }
    // Not a number at all is a transport error, refused before the rulebook.
    const nan = await fetch(`${base}/control/coarse-downsample?factor=abc`);
    assert.equal(nan.status, 400);
    assert.match((await nan.json()).error, /must be a number/);

    // And a valid one still lands.
    const ok = await fetch(`${base}/control/coarse-downsample?factor=3`);
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).downsample_factor, 3);
  } finally {
    await close();
  }
});
