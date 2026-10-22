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
  flagExclusion,
  fnv1a32,
  h3Verdict,
  h4Verdict,
  loadFlagTruth,
  loadWikiDir,
  planTrials,
  runDiurnalAlarms,
  runFlagDetection,
  restrictToKeyValues,
  runInjectionPower,
  runNullCalibration,
  runPositionProfile,
  shuffleValues,
  stage1RangeRefusal,
  explorationRangeRefusal,
  spentHoldoutNote,
  h3RangeRefusal,
  stage3HoldoutRefusal,
  stage4HoldoutRefusal,
  stage4Verdict,
  otelRangeRefusal,
  stage3Verdict,
  type PositionProfile,
  curatorForNullModel,
  sliceEvents,
  synthesizeStream,
  runContrastDiurnal,
  thinByTrace,
  thinEvents,
  topKeyValues,
  windowedStream,
  runVolumeCalibration,
  runShiftInjection,
  scoringCurator,
  shiftBinaryWindow,
  type DiurnalResult,
  type TracedEvent,
} from "./real-data-harness.js";
import { mulberry32 } from "./calibration.js";
import type { LensEvent } from "./lens.js";

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

  it("obsFromTs plans only trials observing from there on, and does not count the earlier ones blind", () => {
    const s = synthesizeStream({ durationMs: HOUR / 2, seed: 24 });
    const t0 = s.events[0].ts;
    const gaps = [{ fromTs: t0 + 100_000, toTs: t0 + 130_000 }];
    const all = planTrials(s.events, gaps, { spanMs: 10_000 });
    const late = planTrials(s.events, gaps, { spanMs: 10_000, obsFromTs: t0 + 600_000 });
    assert.ok(late.trials.length > 0 && late.trials.length < all.trials.length);
    assert.ok(late.trials.every((t) => t.obsFrom >= t0 + 600_000));
    assert.equal(late.blind, 0);
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

  it("the family counts only scorable windows: thin keys add groups but not family (H2's G is nominal there)", () => {
    // big ≈ 29 evt/s fills every 1 s window; each of 20 tiny keys ≈ 0.15 evt/s never reaches MIN_VALID_COUNT.
    const wikis: Record<string, number> = { big: 200 };
    for (let k = 0; k < 20; k++) wikis[`tiny${k}`] = 1;
    const s = synthesizeStream({ durationMs: HOUR, seed: 35, wikis });
    const r = runInjectionPower(s, {
      lens: { window_ms: 1_000, group_by: ["wiki"] },
      target: { key: "wiki", value: "big" }, fraction: 0, seed: 3,
    });
    assert.ok(r.trials > 50);
    // 21 groups × 10 windows nominally; only big's ~10 windows are scored.
    assert.ok(r.meanFamilySize >= 9 && r.meanFamilySize <= 11, `family = ${r.meanFamilySize}`);
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

describe("thinning a recording to a sampling probability (H4 replay)", () => {
  it("keeps ≈ p of the events, each weighted 1/p, so the weighted count still estimates the original", () => {
    const s = synthesizeStream({ durationMs: HOUR, seed: 41 });
    const out = thinEvents(s.events, 0.1, mulberry32(9));
    assert.ok(Math.abs(out.length / s.events.length - 0.1) < 0.01, `kept = ${out.length / s.events.length}`);
    assert.ok(out.every((e) => e.weight === 10));
    const est = out.reduce((a, e) => a + (e.weight ?? 1), 0);
    assert.ok(Math.abs(est / s.events.length - 1) < 0.05, `estimate ratio = ${est / s.events.length}`);
  });
  it("p = 1 leaves the events and their weights alone; a bad p is refused", () => {
    const s = synthesizeStream({ durationMs: 10_000, seed: 42 });
    const same = thinEvents(s.events, 1, mulberry32(1));
    assert.deepEqual(same, s.events);
    assert.throws(() => thinEvents(s.events, 0, mulberry32(1)), RangeError);
    assert.throws(() => thinEvents(s.events, 1.5, mulberry32(1)), RangeError);
  });
});

describe("thinning by trace (the H4 sampling unit)", () => {
  // 2000 traces × 5 spans; trace ids like the Demo's (32 hex), hashed as loadOtelDir does.
  const events: TracedEvent[] = [];
  for (let t = 0; t < 2000; t++) {
    const traceHash = fnv1a32(t.toString(16).padStart(32, "0"));
    for (let k = 0; k < 5; k++) events.push({ ts: t * 10 + k, value: 1, traceHash });
  }
  const traces = (xs: readonly TracedEvent[]) => new Set(xs.map((e) => e.traceHash));

  it("keeps or drops a trace whole, ≈ p of the traces, each span weighted 1/p", () => {
    const out = thinByTrace(events, 0.1, 7);
    const kept = traces(out);
    assert.ok(Math.abs(kept.size / 2000 - 0.1) < 0.02, `kept traces = ${kept.size / 2000}`);
    assert.equal(out.length, 5 * kept.size); // no trace half-kept
    assert.ok(out.every((e) => e.weight === 10));
  });

  it("consistent: for one seed the p = 0.1 sample is inside the p = 0.5 one; another seed draws another sample", () => {
    const small = traces(thinByTrace(events, 0.1, 7));
    const big = traces(thinByTrace(events, 0.5, 7));
    assert.ok([...small].every((h) => big.has(h)));
    assert.notDeepEqual([...traces(thinByTrace(events, 0.1, 8))].sort(), [...small].sort());
  });

  it("p = 1 keeps everything unweighted; an event without a trace is refused, not thinned alone", () => {
    assert.deepEqual(thinByTrace(events, 1, 7), events);
    assert.throws(() => thinByTrace([{ ts: 0, value: 1 }], 0.5, 7), RangeError);
    assert.throws(() => thinByTrace(events, 0, 7), RangeError);
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

  it("holes the collector has not finalized (collector-state.json) are blind too; an unreadable state is refused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wiki-"));
    const d = Date.parse("2026-10-01T12:00:00Z");
    writeFileSync(join(dir, "2026-10-01.jsonl"),
      JSON.stringify({ ts: d, value: 0, wiki: "enwiki", type: "edit", namespace: 0, eid: "a" }) + "\n");
    writeFileSync(join(dir, "gaps.jsonl"), JSON.stringify({ kind: "gap", fromTs: d, toTs: d + 60_000 }) + "\n");
    writeFileSync(join(dir, "collector-state.json"),
      JSON.stringify({ lastEventId: "[]", openGaps: [{ fromTs: d + 120_000, toTs: d + 180_000 }] }));
    const s = await loadWikiDir(dir);
    assert.deepEqual(s.gaps, [{ fromTs: d, toTs: d + 60_000 }, { fromTs: d + 120_000, toTs: d + 180_000 }]);
    writeFileSync(join(dir, "collector-state.json"), "{torn");
    await assert.rejects(loadWikiDir(dir));
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

  it("events that arrived after midnight sit in the next day's file but belong to their ts day (2026-10-22)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wiki-"));
    const rec = (ts: number) => JSON.stringify({ ts, value: 1, wiki: "enwiki", type: "edit", namespace: 0, eid: `e${ts}` });
    const d1 = Date.parse("2026-10-01T20:00:00Z"); // arrived in time: day 1's file
    const late = Date.parse("2026-10-01T22:00:00Z"); // backfilled after midnight: day 2's file
    const d2 = Date.parse("2026-10-02T03:00:00Z"); // day 2's own
    const d3 = Date.parse("2026-10-03T03:00:00Z");
    writeFileSync(join(dir, "2026-10-01.jsonl"), rec(d1) + "\n");
    writeFileSync(join(dir, "2026-10-02.jsonl"), [rec(late), rec(d2)].join("\n") + "\n");
    writeFileSync(join(dir, "2026-10-03.jsonl"), rec(d3) + "\n");
    const s = await loadWikiDir(dir, { fromDay: "2026-10-01", toDay: "2026-10-01" });
    assert.deepEqual(s.events.map((e) => e.ts), [d1, late]); // the next file's own days stay out
    const both = await loadWikiDir(dir, { fromDay: "2026-10-01", toDay: "2026-10-02" });
    assert.deepEqual(both.events.map((e) => e.ts), [d1, late, d2]);
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

describe("fault-flag truth (H4 / measurement ③)", () => {
  it("builds ON spans from confirmed edges; a variant change extends the span; an open ON runs to endTs", () => {
    const dir = mkdtempSync(join(tmpdir(), "otel-"));
    const l = (o: Record<string, unknown>) => JSON.stringify({ flag: "paymentFailure", ...o });
    writeFileSync(join(dir, "flags.jsonl"), [
      l({ ts: 0, state: "off", confirmedTs: 10 }),
      l({ ts: 100, state: "on", variant: "50%", value: 0.5, confirmedTs: 150 }),
      JSON.stringify({ ts: 120, flag: "kafkaQueueProblems", state: "on" }), // another flag
      l({ ts: 200, state: "on", variant: "90%", value: 0.95, confirmedTs: 210 }),
      l({ ts: 300, state: "off", confirmedTs: null }), // written, never confirmed
      "{torn",
      l({ ts: 500, state: "on" }), // manual line: no confirmation field at all
    ].join("\n") + "\n");
    const spans = loadFlagTruth(dir, "paymentFailure", 9_999);
    assert.deepEqual(spans, [
      { fromTs: 150, toTs: 300, variant: "90%", value: 0.95, confirmed: false },
      { fromTs: 500, toTs: 9_999, variant: undefined, value: undefined, confirmed: false },
    ]);
    assert.deepEqual(flagExclusion(spans, 30), [{ fromTs: 150, toTs: 330 }, { fromTs: 500, toTs: 10_029 }]);
  });

  it("no truth file is refused, not read as 'never ON'", () => {
    assert.throws(() => loadFlagTruth(mkdtempSync(join(tmpdir(), "otel-")), "paymentFailure"));
  });

  // Two services at 16 evt/s each, pass rate 0.95; ON spans of 10 min every 20 min.
  // Edges sit 90 s off the null trials' 120 s grid: an edge ON a trial boundary
  // is never inside any trial, and fault time would leak into nothing to exclude.
  const MIN = 60_000;
  const t0 = 1_800_000_000_000;
  const spans = Array.from({ length: 12 }, (_, i) => {
    const fromTs = t0 + 10 * MIN + 90_000 + i * 20 * MIN;
    return { fromTs, toTs: fromTs + 10 * MIN, confirmed: true };
  });
  const base = synthesizeStream({ startTs: t0, durationMs: 250 * MIN, seed: 51, wikis: { payment: 1, cart: 1 }, p: 0.95 });
  const rng = mulberry32(52);
  const faulted = {
    ...base,
    events: base.events.map((e) =>
      e.keys!.wiki === "payment" && spans.some((s) => e.ts >= s.fromTs && e.ts < s.toTs) && rng() < 0.5 ? { ...e, value: 0 } : e),
  };
  const opts = { lens: { window_ms: 10_000, group_by: ["wiki"] }, target: { key: "wiki", value: "payment" } };

  it("a real fault in the target group is detected in every ON span (the wiring check passes)", () => {
    const r = runFlagDetection(faulted, spans, opts);
    assert.equal(r.trials, spans.length);
    assert.equal(r.detected, spans.length);
  });

  it("the same ON spans over an unperturbed stream mostly stay quiet — the check does not find faults by itself", () => {
    const r = runFlagDetection(base, spans, opts);
    assert.equal(r.trials, spans.length);
    assert.ok(r.detected <= 2, `detected ${r.detected}/${r.trials}`);
  });

  it("excluding ON time keeps fault time out of the null rate, and is counted apart from blindness", () => {
    const exclude = flagExclusion(spans, 30_000);
    const withEx = runNullCalibration(faulted, { lens: opts.lens, spanMs: 60_000, shuffleReps: 0, exclude, seed: 5 });
    const without = runNullCalibration(faulted, { lens: opts.lens, spanMs: 60_000, shuffleReps: 0, seed: 5 });
    assert.ok(withEx.excluded > 0);
    assert.equal(withEx.blindByGap, 0);
    assert.equal(withEx.planned, withEx.real.trials + withEx.real.unusableReference + withEx.excluded);
    assert.ok(withEx.real.rate < 0.09, `OFF rate with exclusion = ${withEx.real.rate}`);
    assert.ok(without.real.rate > 2 * withEx.real.rate, `${without.real.rate} vs ${withEx.real.rate}`);
  });

  it("a target that never fails at rest cannot be detected at all: the zero-variance reference is not scored (why H4 rests at 10%)", () => {
    // The real Demo's payment at flag OFF: every span succeeds. Same ON spans, same 50% fault.
    const clean = synthesizeStream({ startTs: t0, durationMs: 250 * MIN, seed: 51, wikis: { payment: 1, cart: 1 }, p: 1 });
    const r2 = mulberry32(52);
    const hit = {
      ...clean,
      events: clean.events.map((e) =>
        e.keys!.wiki === "payment" && spans.some((s) => e.ts >= s.fromTs && e.ts < s.toTs) && r2() < 0.5 ? { ...e, value: 0 } : e),
    };
    assert.equal(runFlagDetection(hit, spans, opts).detected, 0);
  });

  it("the H4 verdict waits for the wiring check: no scored span or a minority detected gives no verdict", () => {
    const rates = { offRateP1: 0.02, offRateP01: 0.2, design: 0.0455 };
    assert.match(h4Verdict({ ...rates, wiring: { detected: 0, trials: 0 } }), /^NO VERDICT: no ON span/);
    assert.match(h4Verdict({ ...rates, wiring: { detected: 0, trials: 1 } }), /^NO VERDICT: wiring check failed \(p=1 detected 0\/1\)/);
    assert.match(h4Verdict({ ...rates, wiring: { detected: 5, trials: 10 } }), /^NO VERDICT/); // half is not a majority
    assert.match(h4Verdict({ ...rates, wiring: { detected: 6, trials: 10 } }), /^SUPPORTED/);
    assert.match(h4Verdict({ ...rates, offRateP01: 0.03, wiring: { detected: 6, trials: 10 } }), /^REJECTED/);
    assert.match(h4Verdict({ ...rates, offRateP1: 0.06, wiring: { detected: 6, trials: 10 } }), /^outside the rule/);
  });

  it("an ON span too short for settle + span, or whose reference overlaps an earlier span's tail, is not scored", () => {
    const short = [{ fromTs: t0 + 10 * MIN, toTs: t0 + 10 * MIN + 60_000, confirmed: true }];
    assert.equal(runFlagDetection(faulted, short, opts).tooShort, 1);
    const close = [
      { fromTs: t0 + 10 * MIN, toTs: t0 + 15 * MIN, confirmed: true },
      { fromTs: t0 + 15 * MIN + 45_000, toTs: t0 + 25 * MIN, confirmed: true }, // ref starts inside the first's 30 s tail
    ];
    const r = runFlagDetection(faulted, close, opts);
    assert.equal(r.refContaminated, 1);
    assert.equal(r.trials, 1);
  });

  describe("under the variogram null, with history on one grid", () => {
    const variogram = () => curatorForNullModel("variogram", 2.0, { history: true });
    const historyMs = 24 * 60_000;
    it("still detects the fault in every ON span", () => {
      const r = runFlagDetection(faulted, spans, { ...opts, spanMs: 60_000, curator: variogram(), historyMs });
      assert.equal(r.trials, spans.length);
      assert.equal(r.detected, spans.length);
    });
    it("keeps the OFF rate near design with ON time excluded from trials and history", () => {
      const exclude = flagExclusion(spans, 30_000);
      const r = runNullCalibration(faulted, { lens: opts.lens, spanMs: 60_000, shuffleReps: 0, exclude, seed: 5, curator: variogram(), historyMs });
      assert.ok(r.excluded > 0 && r.real.trials > 0);
      assert.equal(r.planned, r.real.trials + r.real.unusableReference + r.excluded);
      assert.ok(r.real.rate < 0.09, `OFF rate under variogram = ${r.real.rate}`);
    });
    it("refuses a shuffle arm, which does not run on the grid", () => {
      assert.throws(() => runNullCalibration(faulted, { lens: opts.lens, spanMs: 60_000, shuffleReps: 1, historyMs }), /shuffle/);
    });
  });
});

describe("run-otel-report's gate", () => {
  it("reads the spent judgment day as exploration with or without the old flag, never with --holdout", () => {
    assert.equal(otelRangeRefusal("2026-10-03", "2026-10-03", false, false), undefined);
    assert.equal(otelRangeRefusal("2026-10-03", "2026-10-03", false, true), undefined);
    assert.equal(otelRangeRefusal("2026-10-02", "2026-10-03", false, true), undefined);
    assert.match(otelRangeRefusal("2026-10-03", "2026-10-03", true, true) ?? "", /--holdout/);
    assert.match(otelRangeRefusal("2026-10-03", "2026-10-03", true, false) ?? "", /spent/);
    assert.equal(otelRangeRefusal("2026-10-22", "2026-10-22", false, false), undefined);
  });
});

describe("H3: alarms against the preceding span, by hour of day", () => {
  const DAY = 24 * HOUR;
  const midnight = 1_800_000_000_000 - (1_800_000_000_000 % DAY);
  const run = (o: { diurnalAmplitude?: number; stickiness?: number; seed: number }) =>
    runDiurnalAlarms(
      synthesizeStream({ startTs: midnight, durationMs: 3 * DAY, rate: 2, ...o }),
      { spanMs: HOUR, lens: { window_ms: 60_000 } },
    );
  const pooled = (r: DiurnalResult) =>
    r.bins.reduce((a, b) => a + b.flagged, 0) / r.bins.reduce((a, b) => a + b.trials, 0);

  it("a known diurnal curve: alarms concentrate where it is steep, and the rule reads SUPPORTED", () => {
    const r = run({ diurnalAmplitude: 0.3, seed: 2 });
    assert.ok(r.correlation >= 0.5, `r = ${r.correlation}`);
    assert.match(h3Verdict(r), /^SUPPORTED/);
    // The curve the measurement reconstructs is the one planted: steepest near 00Z/12Z, flat near 06Z/18Z.
    assert.ok(r.bins[0].slope > 3 * r.bins[6].slope && r.bins[12].slope > 3 * r.bins[18].slope);
  });

  it("a sharp step lands on the o'clock it happens at, not the hour before it", () => {
    // p jumps 0.2 → 0.8 at 12:00Z and back at 00:00Z. A trial starting at 11:50 straddles 12:00;
    // filed under 11 (floored) it would light up an hour whose slope is 0 (seen: 83% there, r 0.74).
    const rng = mulberry32(3);
    const events = [];
    for (let t = midnight; t < midnight + 3 * DAY; t += 500) {
      events.push({ ts: t, value: rng() < (new Date(t).getUTCHours() >= 12 ? 0.8 : 0.2) ? 1 : 0, keys: { wiki: "a" } });
    }
    const r = runDiurnalAlarms({ events, gaps: [] }, { spanMs: HOUR, lens: { window_ms: 60_000 } });
    // A 60-minute span still half-straddles a step 30 min away, so neighbours light partly (≈ 30–50%);
    // what must hold is that the step's own o'clock is the one that lights fully.
    assert.equal(r.bins[0].rate, 1);
    assert.equal(r.bins[12].rate, 1);
    for (const b of r.bins) if (b.hour % 12 !== 0) assert.ok(b.rate < 0.6, `${b.hour}Z at ${b.rate}`);
    assert.ok(r.correlation > 0.8, `r = ${r.correlation}`);
  });

  it("a flat iid stream: near the design rate and never SUPPORTED", () => {
    for (const seed of [2, 3, 5, 6]) {
      const r = run({ seed });
      assert.ok(pooled(r) < 0.12, `seed ${seed}: ${pooled(r)}`);
      assert.doesNotMatch(h3Verdict(r), /^SUPPORTED/);
    }
  });

  it("dependence on top of a diurnal curve saturates the arm: HELD, not read through the residue", () => {
    for (const seed of [1, 2, 4, 5]) {
      const r = run({ diurnalAmplitude: 0.3, stickiness: 0.5, seed });
      assert.ok(pooled(r) >= 0.95, `seed ${seed}: ${pooled(r)}`);
      assert.match(h3Verdict(r), /^HELD: .*saturated/);
    }
  });

  it("verdict edges: silent arm is REJECTED, too few hours gets NO VERDICT, the middle band is HELD", () => {
    const bins = (rates: number[]) => rates.map((rate, hour) => ({
      hour, trials: 10, flagged: Math.round(rate * 10), rate, level: 0.5, slope: hour / 100,
    }));
    const base = { blindByGap: 0, unusableReference: 0, designTarget: 0.0455 };
    assert.match(h3Verdict({ ...base, bins: bins(new Array(24).fill(0)), correlation: NaN }), /^REJECTED \(no hour/);
    assert.match(h3Verdict({ ...base, bins: bins([0.1, 0.2]), correlation: 1 }), /^NO VERDICT/);
    assert.match(h3Verdict({ ...base, bins: bins(new Array(24).fill(0.1)), correlation: 0.3 }), /^HELD: r = 0.30/);
    assert.match(h3Verdict({ ...base, bins: bins(new Array(24).fill(0.1)), correlation: 0.1 }), /^REJECTED \(r/);
  });

  it("the diurnal knob at 0 leaves the synthetic stream byte-identical", () => {
    assert.deepEqual(
      synthesizeStream({ durationMs: HOUR, seed: 9 }),
      synthesizeStream({ durationMs: HOUR, seed: 9, diurnalAmplitude: 0 }),
    );
  });
});

describe("stage 3's single look", () => {
  const profile = (rate: number, trials = 400, blindByGap = 0): PositionProfile => ({
    trials, flagged: Math.round(rate * trials), rate, stepPackages: 0, unusableReference: 0, blindByGap,
    designTarget: 0.0455, perWindowByPosition: [],
  });
  it("--holdout was spent on 2026-10-22: refused for the holdout days at any time, and for any other range", () => {
    const after = Date.parse("2026-10-22T00:00:01Z");
    assert.match(stage3HoldoutRefusal("2026-10-19", "2026-10-21", after) ?? "", /spent/);
    assert.match(stage3HoldoutRefusal("2026-10-19", "2026-10-21", Date.parse("2026-10-23T00:00:00Z")) ?? "", /spent/);
    assert.match(stage3HoldoutRefusal("2026-10-19", "2026-10-20", after) ?? "", /exactly/);
    assert.match(stage3HoldoutRefusal("2026-10-18", "2026-10-21", after) ?? "", /exactly/);
  });
  it("supports at ≤ design + 1.5pt on both arms, rejects above twice design on either, holds between", () => {
    assert.match(stage3Verdict(profile(0.037), profile(0.06)), /^SUPPORTED/);
    assert.match(stage3Verdict(profile(0.037), profile(0.07)), /^HELD/);
    assert.match(stage3Verdict(profile(0.095), profile(0.03)), /^REJECTED/);
  });
  it("gives no verdict when an arm is blind for more than 20% of its trials or scored none", () => {
    assert.match(stage3Verdict(profile(0.03, 300, 100), profile(0.03)), /NO VERDICT: V-a is blind/);
    assert.match(stage3Verdict(profile(0.03, 400, 100), profile(0.03)), /^SUPPORTED/);
    assert.match(stage3Verdict(profile(0.03), profile(0, 0)), /NO VERDICT: V-b scored no trials/);
  });
});

describe("stage 1's reports after their holdout was spent", () => {
  it("read every spent holdout as exploration (2026-10-22) and refuse --holdout outright", () => {
    assert.equal(stage1RangeRefusal("2026-09-29", "2026-10-02", false), undefined);
    assert.equal(stage1RangeRefusal("2026-10-02", "2026-10-03", false), undefined);
    assert.equal(stage1RangeRefusal("2026-10-10", "2026-10-11", false), undefined);
    assert.equal(stage1RangeRefusal("2026-10-18", "2026-10-19", false), undefined);
    assert.equal(stage1RangeRefusal("2026-09-29", "2026-10-22", false), undefined);
    assert.match(stage1RangeRefusal("2026-10-03", "2026-10-05", true) ?? "", /spent/);
  });
});

describe("holdouts: sealed until their single look, exploration after it (revision 2026-10-22)", () => {
  const sealed = [
    { name: "a spent one", from: "2026-10-03", to: "2026-10-05", spentOn: "2026-10-06" },
    { name: "a new one", from: "2026-10-26", to: "2026-11-01" },
  ];
  it("refuses only an unspent holdout's days", () => {
    assert.equal(explorationRangeRefusal("2026-10-03", "2026-10-05", sealed), undefined);
    assert.equal(explorationRangeRefusal("2026-10-20", "2026-10-25", sealed), undefined);
    assert.match(explorationRangeRefusal("2026-10-25", "2026-10-26", sealed) ?? "", /a new one .* sealed/);
    assert.match(explorationRangeRefusal("2026-10-01", "2026-11-05", sealed) ?? "", /a new one/);
  });
  it("labels a read of spent days, naming the verdict that stands", () => {
    assert.match(spentHoldoutNote("2026-10-04", "2026-10-04", sealed) ?? "", /a spent one 2026-10-03…2026-10-05, verdict of 2026-10-06/);
    assert.equal(spentHoldoutNote("2026-10-06", "2026-10-20", sealed), undefined);
    assert.match(spentHoldoutNote("2026-10-18", "2026-10-19") ?? "", /stage 3's holdout/);
    assert.equal(explorationRangeRefusal("2026-09-29", "2026-10-25"), undefined, "every holdout before stage 4 is spent");
  });
  it("seals stage 4's week (2026-10-26…11-01) from every exploration report", () => {
    assert.match(explorationRangeRefusal("2026-10-25", "2026-10-26") ?? "", /stage 4's holdout .* sealed/);
    assert.match(stage1RangeRefusal("2026-10-30", "2026-11-05", false) ?? "", /stage 4's holdout/);
    assert.match(h3RangeRefusal("2026-11-01", "2026-11-01", false) ?? "", /stage 4's holdout/);
    assert.equal(explorationRangeRefusal("2026-11-02", "2026-11-05"), undefined);
  });
});

describe("stage 4's single look (claim C, 2026-10-22 (6))", () => {
  const sums = (n: number, over2: number, over3: number, v: number) => ({
    n, s: 0, ss: v * (n - 1), o1: 0, o2: Math.round(over2 * n), o3: Math.round(over3 * n), og: 0, alpha: 0,
  });
  const arm = (name: string, over2: number, over3: number, v: number, blind = 0) =>
    ({ name, ordinary: sums(100_000, over2, over3, v), trials: 1000, blindByGap: blind });
  it("--holdout takes exactly the week, and only after its Sunday has ended (UTC)", () => {
    const after = Date.parse("2026-11-02T00:00:01Z");
    assert.equal(stage4HoldoutRefusal("2026-10-26", "2026-11-01", after), undefined);
    assert.match(stage4HoldoutRefusal("2026-10-26", "2026-11-01", Date.parse("2026-11-01T23:59:59Z")) ?? "", /not complete/);
    assert.match(stage4HoldoutRefusal("2026-10-27", "2026-11-01", after) ?? "", /exactly/);
  });
  it("supports both arms inside the support lines, rejects a liberal arm, holds the rest with a reason", () => {
    assert.match(stage4Verdict([arm("V-a", 0.036, 0.0024, 0.83), arm("10 s", 0.03, 0.0018, 0.81)]), /^SUPPORTED/);
    assert.match(stage4Verdict([arm("V-a", 0.103, 0.0225, 1.53), arm("10 s", 0.03, 0.0018, 0.81)]), /^REJECTED .*V-a past a reject line/);
    assert.match(stage4Verdict([arm("V-a", 0.07, 0.004, 1.1), arm("10 s", 0.03, 0.0018, 0.81)]), /^HELD: .*V-a between/);
    assert.match(stage4Verdict([arm("V-a", 0.02, 0.0005, 0.5), arm("10 s", 0.03, 0.0018, 0.81)]), /^HELD: .*V-a too conservative/);
    assert.match(stage4Verdict([arm("V-a", 0.036, 0.0024, 0.83, 300), arm("10 s", 0.03, 0.0018, 0.81)]), /^NO VERDICT: V-a is blind/);
  });
});

describe("one grid for observation, reference and history (the variogram null's trials)", () => {
  const stream = synthesizeStream({ durationMs: HOUR, rate: 20, seed: 3 });
  stream.gaps.push({ fromTs: stream.events[0].ts + 600_000, toTs: stream.events[0].ts + 605_000 });

  it("windows the stream once on a grid anchored at its first event, dropping windows that touch a gap", () => {
    const first = stream.events[0].ts;
    const all = windowedStream(stream, { window_ms: 1_000 }).slice(first, first + HOUR);
    assert.ok(all.windows.every((w) => (w.windowStart - first) % 1_000 === 0));
    assert.ok(all.windows.every((w) => w.windowEnd <= first + 600_000 || w.windowStart >= first + 605_000));
    const part = windowedStream(stream, { window_ms: 1_000 }).slice(first + 10_000, first + 20_000);
    assert.equal(part.windows.length, 10);
    assert.deepEqual(part.windows, all.windows.filter((w) => w.windowStart >= first + 10_000 && w.windowEnd <= first + 20_000));
  });

  it("profiles alarms by position, and the variogram null stays near design on an iid stream", () => {
    const r = runPositionProfile(stream, {
      lens: { window_ms: 1_000 }, spanMs: 10_000, strideMs: 20_000,
      curator: curatorForNullModel("variogram", 2.0, { history: true }), historyMs: 240_000,
    });
    assert.ok(r.trials > 150);
    assert.equal(r.blindByGap, 1);
    assert.equal(r.perWindowByPosition.length, 6);
    assert.ok(r.rate < 0.1, `iid rate ${r.rate}`);
  });

  it("refuses the variogram null to a report that passes no history (2026-10-14 (9) review)", () => {
    assert.throws(() => curatorForNullModel("variogram"), /needs history/);
    assert.ok(curatorForNullModel("variogram", 2.0, { history: true }) !== undefined);
    assert.ok(curatorForNullModel("overdispersed") !== undefined);
  });

  it("refuses spans that would cut windows instead of silently re-gridding them", () => {
    assert.throws(
      () => runPositionProfile(stream, { lens: { window_ms: 1_000 }, spanMs: 10_000, strideMs: 15_500 }),
      RangeError,
    );
  });
});

describe("calibration by volume and detection at steady volume (2026-10-22 (5))", () => {
  // 4 h of iid 0/1 at 20 events/s, plus a "bot batch": 10 minutes of extra
  // value-1 events at another 20/s — volume and rate move together.
  const base = synthesizeStream({ durationMs: 4 * HOUR, rate: 20, p: 0.5, seed: 11 });
  const t0 = base.events[0].ts;
  const batch: LensEvent[] = [];
  for (let t = t0 + 2 * HOUR; t < t0 + 2 * HOUR + 600_000; t += 50) batch.push({ ts: t, value: 1, keys: { wiki: "wikidatawiki", type: "edit", namespace: "0" } });
  const withBatch = { events: [...base.events, ...batch].sort((a, b) => a.ts - b.ts), gaps: [] };
  const arm = { lens: { window_ms: 10_000 }, spanMs: 300_000, strideMs: 300_000 };

  it("records every scorable window's gate z and leaves the package otherwise unchanged", () => {
    const grid = windowedStream(base, { window_ms: 10_000 });
    const obs = grid.slice(t0 + HOUR, t0 + HOUR + 300_000);
    const ref = grid.slice(t0 + HOUR - 300_000, t0 + HOUR);
    const context = { history: grid.slice(t0, t0 + HOUR) };
    const recorded = scoringCurator("variogram").curate(obs, ref, context);
    const plain = curatorForNullModel("variogram", 2.0, { history: true })!.curate(obs, ref, context);
    assert.equal(plain.windowScores, undefined);
    assert.deepEqual(recorded.tiles.map((t) => [t.shapeTag, t.regionStart]), plain.tiles.map((t) => [t.shapeTag, t.regionStart]));
    assert.equal(recorded.windowScores?.length, obs.windows.length);
    const gate = recorded.selection.effectiveZThreshold;
    const fired = recorded.windowScores!.filter((s) => Math.abs(s.gateZ) >= gate).map((s) => s.windowStart);
    assert.deepEqual(fired, recorded.tiles.filter((t) => t.shapeTag === "spike" || t.shapeTag === "dip").map((t) => t.regionStart));
    assert.ok(recorded.windowScores!.every((s) => s.volumeRatio > 0.6 && s.volumeRatio < 1.6));
  });

  it("on iid data the gate z is N(0, 1)-like at ordinary volume, and nothing is called composition", () => {
    const r = runVolumeCalibration(base, { ...arm, curator: scoringCurator("independent") });
    const ord = r.bands.find((b) => b.band === "ordinary")!;
    assert.ok(ord.windows > 600, `${ord.windows}`);
    assert.ok(ord.varGateZ > 0.75 && ord.varGateZ < 1.3, `var ${ord.varGateZ}`);
    assert.ok(ord.over2 > 0.015 && ord.over2 < 0.09, `over2 ${ord.over2}`);
    assert.equal(r.compositionEpisodes, 0);
    assert.ok(r.typicalWindowCount > 150 && r.typicalWindowCount < 250, `${r.typicalWindowCount}`);
  });

  it("a bot batch fires off ordinary volume only and is counted as a composition episode", () => {
    const r = runVolumeCalibration(withBatch, { ...arm, curator: scoringCurator("variogram"), historyMs: 2 * HOUR });
    assert.ok(r.compositionEpisodes >= 1, JSON.stringify(r.byDay));
    assert.ok(r.flagged > r.flaggedOrdinary, `${r.flagged} vs ${r.flaggedOrdinary}`);
    const high = r.bands.find((b) => b.band === "high")!;
    assert.ok(high.overGate > 0.1, `high-volume windows past the gate: ${high.overGate}`);
  });

  it("shiftBinaryWindow flips whole events and keeps the count; refuses what it cannot shift", () => {
    const w = { windowStart: 0, windowEnd: 1_000, count: 10, mean: 0.6, sumSq: 6, valid: true, range: { min: 0, max: 1 } };
    const down = shiftBinaryWindow(w, -0.2)!;
    assert.deepEqual([down.window.count, down.window.mean, down.window.sumSq, down.shift], [10, 0.4, 4, -0.2]);
    assert.deepEqual(shiftBinaryWindow(w, -0.6)!.window.range, { min: 0, max: 0 });
    assert.equal(shiftBinaryWindow(w, 0.5), undefined);
    assert.equal(shiftBinaryWindow({ ...w, sumSq: 4.2 }, -0.1), undefined, "not 0/1 data");
  });

  it("a planted steady-volume shift is found where it begins; nothing planted reads as the control", () => {
    const opts = { lens: { window_ms: 1_000 }, spanMs: 10_000, strideMs: 20_000, every: 4 };
    const big = runShiftInjection(base, { ...opts, shift: -0.45, windows: 3 });
    // About half the trials lack 9 value-1 events in some window to flip (20 events, p 0.5): skipped, not missed.
    assert.ok(big.trials > 60 && big.skipped > 0 && big.power > 0.9, `power ${big.power} over ${big.trials}, ${big.skipped} skipped`);
    assert.ok(Math.abs(big.meanShiftTruth + 0.45) < 0.03, `${big.meanShiftTruth}`);
    const none = runShiftInjection(base, { ...opts, shift: -0.0001, windows: 3 });
    assert.equal(none.detected, none.controlDetected);
    assert.ok(none.controlRate < 0.1, `${none.controlRate}`);
    const vg = runShiftInjection(base, { ...opts, shift: -0.45, windows: 3, curator: curatorForNullModel("variogram", 2.0, { history: true }), historyMs: 240_000 });
    assert.ok(vg.power > 0.8, `variogram power ${vg.power}`);
    assert.throws(() => runShiftInjection(base, { ...opts, lens: { window_ms: 1_000, group_by: ["wiki"] }, shift: -0.1, windows: 1 }), /mixed/);
  });
});

describe("run-h3-report after H3's holdout was spent (2026-10-14)", () => {
  it("refuses --holdout outright, even for exactly the holdout days, and explores spent holdouts too", () => {
    assert.match(h3RangeRefusal("2026-10-11", "2026-10-13", true) ?? "", /H3's holdout .* spent/);
    assert.equal(h3RangeRefusal("2026-10-07", "2026-10-10", false), undefined);
    assert.equal(h3RangeRefusal("2026-10-14", "2026-10-14", false), undefined);
    assert.equal(h3RangeRefusal("2026-10-10", "2026-10-11", false), undefined);
    assert.equal(h3RangeRefusal("2026-10-01", "2026-10-03", false), undefined);
  });
});

describe("periodic references as contrasts (F1, 2026-10-14 (11))", () => {
  const DAY = 24 * HOUR;
  const base = { spanMs: HOUR, windowMs: 60_000, historyMs: 48 * HOUR, strideMs: HOUR / 2 };
  const rate = (r: { flagged: number; trials: number }) => r.flagged / r.trials;
  const by = (rs: ReturnType<typeof runContrastDiurnal>) => Object.fromEntries(rs.map((r) => [r.reference, r]));

  it("holds the design rate under every reference on a flat iid stream", () => {
    const s = synthesizeStream({ durationMs: 4 * DAY, rate: 4, seed: 51, startTs: Date.UTC(2030, 0, 1) });
    for (const r of runContrastDiurnal(s, base)) {
      assert.ok(r.trials > 50, `${r.reference}: ${r.trials} trials`);
      assert.ok(rate(r) <= 0.08, `${r.reference}: ${r.flagged}/${r.trials}`);
    }
  });

  it("where a fixed diurnal curve dominates, the previous day keeps the power the preceding span loses to γ̂", () => {
    // The positive control for the real-data reading: with the curve repeating
    // exactly, the variogram's lags absorb its slope as variance and the
    // preceding comparison goes deaf; the same hour a day earlier cancels it.
    const s = synthesizeStream({ durationMs: 4 * DAY, rate: 4, seed: 52, startTs: Date.UTC(2030, 0, 1), diurnalAmplitude: 0.3 });
    const shifted = by(runContrastDiurnal(s, { ...base, injectDelta: 0.08 }));
    assert.ok(rate(shifted["previous-day"]) > 0.6, `previous-day ${shifted["previous-day"].flagged}/${shifted["previous-day"].trials}`);
    assert.ok(rate(shifted.preceding) < 0.2, `preceding ${shifted.preceding.flagged}/${shifted.preceding.trials}`);
  });
});
