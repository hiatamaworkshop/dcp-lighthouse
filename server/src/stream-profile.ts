/**
 * The constants a process is wired with, chosen by name (ROADMAP C19).
 *
 * Two profiles:
 *
 *   "mock"         what index.ts has always shipped, for the 50 events/s mock
 *                  stream: a 10 s coarse and a 1 s fine view, a 2-minute freshness
 *                  zone, a thinned 20-minute reference zone behind it. The demo and
 *                  the tests depend on it, so it is the default and does not move.
 *   "test-stream"  for a stream of CI test results (ROADMAP_BRIEF.md 2026-11-17
 *                  (4)–(7)): one failure in ~13,000 events, no daily cycle, results
 *                  that arrive in builds hours apart. The shipped views are blind to
 *                  it (99.8–100% of the questions asked had no usable reference); a
 *                  1-hour window against 30 windows of reference, held whole for 34
 *                  hours, is not (blind 1.2%, no alarm in 213 quiet spans).
 *
 * One place, read by both index.ts and the Prow replay (prow-replay.ts): the
 * replay's "test-stream" arm is built from this profile, so what was measured
 * and what a process runs cannot drift apart the way the first shipped
 * configuration and the validated one did (2026-11-10 audit).
 *
 * Nothing here is measured to be best. The numbers are those C12/C13/C20 ran:
 * a window wide enough to hold ~1 failure when one is expected, a reference long
 * enough to contain the ordinary failures, retention that holds both. Splitting
 * the stream by job or by area was measured too and detected less (C20), so the
 * profile keeps the three jobs as one stream.
 */

import type { QCompareParams, QObserveParams } from "./q-registry.js";

const HOUR = 3_600_000;

export type StreamProfileName = "mock" | "test-stream";

export interface StreamProfile {
  name: StreamProfileName;
  /** The live view's lens, and the one a replay request is made through. */
  coarse: QObserveParams;
  fine: QObserveParams;
  /** `$Q[compare]` for the coarse view (the live view). A view without its own row uses the process-wide row. */
  coarseCompare: QCompareParams;
  /** Windows the live view observes at once (dashboard.ts LIVE_REFERENCE_WINDOW_COUNT). */
  liveWindows: number;
  /** Freshness zone: events held whole. */
  retentionMs: number;
  /** Thinned reference zone behind it, with its ratio. Both or neither. */
  referenceZoneMs?: number;
  thinningRatio?: number;
  /** Window-summary history kept (window-history.ts). */
  historyMs: number;
  /** Failures in one window that the package calls a burst (CurationOptions.failureCount); absent = not counted. */
  failureBurstAt?: number;
  /** Whether the profile declares the `$F` rows. The "test-stream" profile does not: no forecast was measured at 1-hour windows. */
  forecast: boolean;
}

/** What index.ts has shipped. Identical to the literals it held before this file. */
export const MOCK_PROFILE: StreamProfile = {
  name: "mock",
  coarse: { window_ms: 10_000, align: "epoch" },
  fine: { window_ms: 1_000, align: "epoch" },
  coarseCompare: { reference: "preceding", null_model: "independent" },
  liveWindows: 3,
  retentionMs: 120_000,
  referenceZoneMs: 120_000 * 10,
  thinningRatio: 2,
  historyMs: HOUR,
  forecast: true,
};

const TEST_STREAM_WINDOW_MS = HOUR;
const TEST_STREAM_LIVE_WINDOWS = 3;
const TEST_STREAM_REFERENCE_WINDOWS = 30;

/**
 * Tests that fail at once in one window for the package to call it a burst.
 * 10 is where the 89-day Prow record's 31% of failures sat: ten builds that each
 * dropped ten or more tests (ROADMAP_BRIEF.md 2026-11-17 (6)). A reading of that
 * record, not a statistic — it names a size, not a cause.
 */
export const TEST_STREAM_BURST_AT = 10;

export const TEST_STREAM_PROFILE: StreamProfile = {
  name: "test-stream",
  coarse: { window_ms: TEST_STREAM_WINDOW_MS, align: "epoch" },
  // The replay lens is left as shipped: the profile is about the live view, and a Brain's
  // replay request brings its own lens. 10-minute windows were measured too (C12: blind 25.9%).
  fine: { window_ms: 1_000, align: "epoch" },
  coarseCompare: { reference: "preceding", null_model: "independent", reference_windows: TEST_STREAM_REFERENCE_WINDOWS },
  liveWindows: TEST_STREAM_LIVE_WINDOWS,
  // The observation, the reference and one window of slack, held whole. The thinned reference zone measured
  // worse (blind 7.4% against 1.2%), so there is none.
  retentionMs: TEST_STREAM_WINDOW_MS * (TEST_STREAM_LIVE_WINDOWS + TEST_STREAM_REFERENCE_WINDOWS + 1),
  historyMs: HOUR,
  failureBurstAt: TEST_STREAM_BURST_AT,
  forecast: false,
};

export const STREAM_PROFILES: Record<StreamProfileName, StreamProfile> = {
  mock: MOCK_PROFILE,
  "test-stream": TEST_STREAM_PROFILE,
};

/** The profile a name selects. An unset name is "mock"; an unknown one throws, so a typo cannot start the wrong wiring. */
export function resolveStreamProfile(name: string | undefined): StreamProfile {
  if (name === undefined || name === "") return MOCK_PROFILE;
  if (name === "mock" || name === "test-stream") return STREAM_PROFILES[name];
  throw new RangeError(`LIGHTHOUSE_PROFILE must be "mock" or "test-stream", got "${name}"`);
}
