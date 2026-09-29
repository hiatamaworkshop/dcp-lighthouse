/**
 * The harness's own check, run on synthetic streams whose truth is known by
 * construction (ROADMAP_BRIEF.md 2026-09-27 (3), stage 0: "合成データでの検算").
 * If the metrics are wrong they must be caught HERE, before a recorded stream is
 * ever put through them — a wrong instrument would otherwise read as a finding.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dispersionProfile,
  loadWikiDir,
  planTrials,
  restrictToKeyValues,
  runInjectionPower,
  runNullCalibration,
  shuffleValues,
  sliceEvents,
  synthesizeStream,
  topKeyValues,
} from "./real-data-harness.js";
import { mulberry32 } from "./calibration.js";

const HOUR = 3_600_000;

describe("dispersion profile on a known stream", () => {
  it("iid values: φ ≈ 1 and lag-1 ≈ its own independence bias", () => {
    const s = synthesizeStream({ durationMs: 3 * HOUR, seed: 11 });
    // lag-1 tolerance = 3× the spread measured over 12 seeds of this generator
    // (sd 0.008 at 1 s, 0.040 at 10 s — only ~3 hours = 18 blocks × 60 windows
    // of 10 s go into the latter); the mean over those seeds was −0.003 / −0.002,
    // i.e. the estimator is unbiased against −1/k and only noisy at 10 s.
    for (const [windowMs, lagTol] of [[1_000, 0.03], [10_000, 0.12]] as const) {
      const d = dispersionProfile(s, { windowMs });
      assert.ok(d.phi > 0.95 && d.phi < 1.05, `φ(${windowMs}ms) = ${d.phi}`);
      assert.ok(Math.abs(d.lag1 - d.lag1ExpectedUnderIndependence) < lagTol, `lag1(${windowMs}ms) = ${d.lag1}`);
    }
  });

  it("per-key measurement pools to ≈ 1 on iid values too", () => {
    const s = synthesizeStream({ durationMs: 3 * HOUR, seed: 12 });
    const d = dispersionProfile(s, { windowMs: 10_000, key: "wiki", minEvents: 100 });
    assert.ok(d.phi > 0.93 && d.phi < 1.07, `φ = ${d.phi}`);
  });

  it("sticky values (s=0.5): φ near (1+s)/(1−s) = 3, far above 1", () => {
    const s = synthesizeStream({ durationMs: 3 * HOUR, seed: 13, stickiness: 0.5 });
    const d = dispersionProfile(s, { windowMs: 10_000 });
    assert.ok(d.phi > 2.4 && d.phi < 3.6, `φ = ${d.phi}`);
  });

  it("a block touching a collection gap is skipped and counted, not measured", () => {
    const s = synthesizeStream({ durationMs: HOUR, seed: 14 });
    const t0 = s.events[0].ts;
    const clean = dispersionProfile(s, { windowMs: 10_000 });
    const holed = dispersionProfile({ ...s, gaps: [{ fromTs: t0 + 700_000, toTs: t0 + 720_000 }] }, { windowMs: 10_000 });
    assert.equal(holed.blindBlocks, 1);
    assert.equal(holed.blocks, clean.blocks - 1);
  });
});

describe("null calibration on a known stream", () => {
  // The design target is familyWiseAlpha(2.0) ≈ 4.55%. 400 trials put the
  // binomial standard error near 1pt, so a 9% ceiling is a real regression
  // fence, not a coin flip (the seed is fixed anyway).
  it("iid: R_real and FA_shuffle both sit at the design rate — the harness adds no alarms of its own", () => {
    const s = synthesizeStream({ durationMs: 2.5 * HOUR, seed: 21 });
    const r = runNullCalibration(s, { seed: 5 });
    assert.ok(r.real.trials > 300, `trials = ${r.real.trials}`);
    assert.ok(r.real.rate < 0.09, `R_real = ${r.real.rate}`);
    assert.ok(r.shuffled.rate < 0.09, `FA_shuffle = ${r.shuffled.rate}`);
    assert.ok(Math.abs(r.real.rate - r.shuffled.rate) < 0.05, `${r.real.rate} vs ${r.shuffled.rate}`);
  });

  it("sticky: R_real far above FA_shuffle, and the shuffle returns to the design rate", () => {
    const s = synthesizeStream({ durationMs: 2.5 * HOUR, seed: 22, stickiness: 0.5 });
    const r = runNullCalibration(s, { seed: 5 });
    assert.ok(r.real.rate > 2 * r.shuffled.rate, `${r.real.rate} vs ${r.shuffled.rate}`);
    assert.ok(r.shuffled.rate < 0.09, `FA_shuffle = ${r.shuffled.rate}`);
  });

  it("grouped lens: the shuffle stays inside each group", () => {
    const s = synthesizeStream({ durationMs: 60_000, seed: 23, wikis: { a: 1, b: 1 } });
    // Make the two groups differ sharply, then confirm a stratified shuffle keeps each group's count of ones.
    const skewed = s.events.map((e) => ({ ...e, value: e.keys!.wiki === "a" ? 1 : 0 }));
    const out = shuffleValues(skewed, mulberry32(1), ["wiki"]);
    assert.deepEqual(out.map((e) => e.value), skewed.map((e) => e.value));
    const mixed = shuffleValues(skewed, mulberry32(1), []);
    assert.notDeepEqual(mixed.map((e) => e.value), skewed.map((e) => e.value));
    assert.equal(mixed.reduce((a, e) => a + e.value, 0), skewed.reduce((a, e) => a + e.value, 0));
  });

  it("trials that touch a gap are blind: counted apart, not scored", () => {
    const s = synthesizeStream({ durationMs: HOUR / 2, seed: 24 });
    const t0 = s.events[0].ts;
    const plan = planTrials(s.events, [{ fromTs: t0 + 100_000, toTs: t0 + 130_000 }], { spanMs: 10_000 });
    assert.ok(plan.blind >= 1);
    const r = runNullCalibration({ ...s, gaps: [{ fromTs: t0 + 100_000, toTs: t0 + 130_000 }] }, { seed: 5 });
    assert.equal(r.blindByGap, plan.blind);
    assert.equal(r.planned, r.blindByGap + plan.trials.length);
  });
});

describe("injection power on a known stream", () => {
  it("a full dip in the target's window is found; the recorded truth matches what was planted", () => {
    const s = synthesizeStream({ durationMs: HOUR, seed: 31, wikis: { enwiki: 1 } });
    const r = runInjectionPower(s, { target: { key: "wiki", value: "enwiki" }, fraction: 1, seed: 3 });
    assert.ok(r.trials > 50);
    assert.ok(r.power > 0.9, `power = ${r.power}`);
    // Every event zeroed: the shift is −(the window's own mean), ≈ −p.
    assert.ok(r.meanShiftTruth < -0.4 && r.meanShiftTruth > -0.6, `shift = ${r.meanShiftTruth}`);
  });

  it("an epoch-aligned lens finds the same dip: the injected window sits inside the span, not at 1970", () => {
    const s = synthesizeStream({ durationMs: HOUR, seed: 31, wikis: { enwiki: 1 } });
    const r = runInjectionPower(s, {
      lens: { window_ms: 1_000, align: "epoch" },
      target: { key: "wiki", value: "enwiki" }, fraction: 1, seed: 3,
    });
    assert.equal(r.targetThin, 0);
    assert.ok(r.trials > 50, `trials = ${r.trials}`);
    assert.ok(r.power > 0.9, `power = ${r.power}`);
  });

  it("fraction 0 plants nothing and detects (almost) nothing", () => {
    const s = synthesizeStream({ durationMs: HOUR, seed: 32, wikis: { enwiki: 1 } });
    const r = runInjectionPower(s, { target: { key: "wiki", value: "enwiki" }, fraction: 0, seed: 3 });
    assert.equal(r.meanShiftTruth, 0);
    assert.ok(r.power < 0.1, `power = ${r.power}`);
  });

  it("a target too thin to score is reported as thin, not as a miss", () => {
    const s = synthesizeStream({ durationMs: HOUR, seed: 33, wikis: { big: 200, tiny: 1 } });
    const r = runInjectionPower(s, { target: { key: "wiki", value: "tiny" }, fraction: 1, seed: 3 });
    assert.ok(r.targetThin > 0);
    assert.equal(r.planned, r.blindByGap + r.targetThin + r.unusableReference + r.trials);
  });

  it("restricting to the top G keys keeps the target and drops the rest", () => {
    const s = synthesizeStream({ durationMs: 10 * 60_000, seed: 34 });
    const top = topKeyValues(s.events, "wiki", 2);
    assert.equal(top[0], "enwiki");
    const kept = restrictToKeyValues(s.events, "wiki", top);
    assert.ok(kept.length < s.events.length);
    assert.ok(kept.every((e) => top.includes(e.keys!.wiki)));
  });
});

describe("loading a collector directory", () => {
  it("reads day files and gaps, keeps only the requested days, drops nothing personal (there is none to keep)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wiki-"));
    const rec = (ts: number, bot: 0 | 1) =>
      JSON.stringify({ ts, value: bot, wiki: "enwiki", type: "edit", namespace: 0, eid: `e${ts}` });
    const d1 = Date.parse("2026-10-01T12:00:00Z");
    const d2 = Date.parse("2026-10-02T12:00:00Z");
    writeFileSync(join(dir, "2026-10-01.jsonl"), [rec(d1, 1), rec(d1 + 1000, 0), "{torn"].join("\n") + "\n");
    writeFileSync(join(dir, "2026-10-02.jsonl"), rec(d2, 1) + "\n");
    writeFileSync(join(dir, "gaps.jsonl"),
      JSON.stringify({ kind: "gap", fromTs: d1, toTs: d1 + 60_000 }) + "\n" +
      JSON.stringify({ kind: "gap", fromTs: d2, toTs: d2 + 60_000 }) + "\n");

    const all = await loadWikiDir(dir);
    assert.equal(all.events.length, 3);
    assert.equal(all.gaps.length, 2);
    assert.deepEqual(all.events[0].keys, { wiki: "enwiki", type: "edit", namespace: "0" });

    const day2 = await loadWikiDir(dir, { fromDay: "2026-10-02", toDay: "2026-10-02" });
    assert.equal(day2.events.length, 1);
    assert.equal(day2.gaps.length, 1);
    assert.equal(sliceEvents(all.events, d1, d1 + 1).length, 1); // half-open
  });

  it("an interrupted rollover (raw file AND a truncated .gz for one day) reads the raw file once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wiki-"));
    const d = Date.parse("2026-10-01T12:00:00Z");
    const rec = (ts: number) => JSON.stringify({ ts, value: 1, wiki: "enwiki", type: "edit", namespace: 0, eid: `e${ts}` });
    writeFileSync(join(dir, "2026-10-01.jsonl"), [rec(d), rec(d + 1000)].join("\n") + "\n");
    writeFileSync(join(dir, "2026-10-01.jsonl.gz"), Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00])); // cut mid-header
    const s = await loadWikiDir(dir);
    assert.equal(s.events.length, 2);
  });

  it("events with the same wiki/type/namespace share one keys object", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wiki-"));
    const d = Date.parse("2026-10-01T12:00:00Z");
    const rec = (ts: number) => JSON.stringify({ ts, value: 0, wiki: "enwiki", type: "edit", namespace: 0, eid: `e${ts}` });
    writeFileSync(join(dir, "2026-10-01.jsonl"), [rec(d), rec(d + 1)].join("\n") + "\n");
    const s = await loadWikiDir(dir);
    assert.equal(s.events[0].keys, s.events[1].keys);
  });
});
