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
  loadFlagTruth,
  loadWikiDir,
  planTrials,
  runFlagDetection,
  restrictToKeyValues,
  runInjectionPower,
  runNullCalibration,
  shuffleValues,
  sliceEvents,
  synthesizeStream,
  thinByTrace,
  thinEvents,
  topKeyValues,
  type TracedEvent,
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
});
