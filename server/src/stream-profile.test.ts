import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { liveLookbackMs } from "./dashboard.js";
import { REPLAY_ARMS, SHIPPED_WIRING, TEST_STREAM_WIRING, wiringFromProfile } from "./prow-replay.js";
import { MOCK_PROFILE, TEST_STREAM_PROFILE, resolveStreamProfile } from "./stream-profile.js";

const HOUR = 3_600_000;

describe("stream profiles (ROADMAP C19)", () => {
  it("selects nothing by default: an unset or empty name is the mock profile", () => {
    assert.equal(resolveStreamProfile(undefined), MOCK_PROFILE);
    assert.equal(resolveStreamProfile(""), MOCK_PROFILE);
    assert.equal(resolveStreamProfile("mock"), MOCK_PROFILE);
    assert.equal(resolveStreamProfile("test-stream"), TEST_STREAM_PROFILE);
  });

  it("an unknown name throws at boot rather than starting the wrong wiring", () => {
    assert.throws(() => resolveStreamProfile("test_stream"), /LIGHTHOUSE_PROFILE/);
    assert.throws(() => resolveStreamProfile("TEST-STREAM"), RangeError);
  });

  it("the mock profile is exactly what index.ts shipped before profiles: the constants the replay calls SHIPPED_WIRING", () => {
    assert.equal(MOCK_PROFILE.retentionMs, SHIPPED_WIRING.retentionMs);
    assert.equal(MOCK_PROFILE.referenceZoneMs, SHIPPED_WIRING.referenceZoneMs);
    assert.equal(MOCK_PROFILE.thinningRatio, SHIPPED_WIRING.thinningRatio);
    assert.equal(MOCK_PROFILE.historyMs, SHIPPED_WIRING.historyMs);
    assert.equal(MOCK_PROFILE.liveWindows, SHIPPED_WIRING.liveWindows);
    assert.deepEqual(MOCK_PROFILE.coarse, { window_ms: 10_000, align: "epoch" });
    assert.deepEqual(MOCK_PROFILE.fine, { window_ms: 1_000, align: "epoch" });
    assert.deepEqual(MOCK_PROFILE.coarseCompare, { reference: "preceding", null_model: "independent" });
    assert.equal(MOCK_PROFILE.failureBurstAt, undefined, "the mock stream's packages do not count failures");
    assert.equal(MOCK_PROFILE.forecast, true);
  });

  it("the test-stream profile is the configuration C12/C13/C20 measured", () => {
    const p = TEST_STREAM_PROFILE;
    assert.equal(p.coarse.window_ms, HOUR);
    assert.equal(p.coarse.align, "epoch");
    assert.equal(p.coarseCompare.reference_windows, 30);
    assert.equal(p.liveWindows, 3);
    assert.equal(p.retentionMs, 34 * HOUR);
    assert.equal(p.referenceZoneMs, undefined, "no thinned reference zone: it measured worse (blind 7.4% against 1.2%)");
    assert.equal(p.thinningRatio, undefined);
    assert.equal(p.failureBurstAt, 10);
    assert.equal(p.forecast, false);
  });

  it("holds the live view's whole lookback and one window of slack, so the reference is never outside the buffer", () => {
    const p = TEST_STREAM_PROFILE;
    const lookback = liveLookbackMs(p.coarse.window_ms!, p.liveWindows, p.coarseCompare.reference_windows);
    assert.equal(lookback, 33 * HOUR);
    // The newest grid line is up to one window old, so the oldest event asked for is lookback + one window back.
    assert.ok(p.retentionMs >= lookback + p.coarse.window_ms!);
  });

  it("the replay's 1h-fresh arm IS the profile: the arm and the process cannot drift apart", () => {
    const arm = REPLAY_ARMS.find((a) => a.name === "1h-fresh")!;
    assert.deepEqual({ ...arm, name: "x" }, { ...TEST_STREAM_WIRING, name: "x" });
    assert.deepEqual(TEST_STREAM_WIRING, wiringFromProfile(TEST_STREAM_PROFILE));
    assert.equal(TEST_STREAM_WIRING.windowMs, TEST_STREAM_PROFILE.coarse.window_ms);
    assert.equal(TEST_STREAM_WIRING.referenceWindows, TEST_STREAM_PROFILE.coarseCompare.reference_windows);
    assert.equal(TEST_STREAM_WIRING.retentionMs, TEST_STREAM_PROFILE.retentionMs);
    assert.equal(TEST_STREAM_WIRING.failureCount, 10);
  });

  it("no other replay arm counts failures: their output is the one reported before C19", () => {
    for (const a of REPLAY_ARMS) if (a.name !== "1h-fresh") assert.equal(a.failureCount, undefined, a.name);
  });
});
