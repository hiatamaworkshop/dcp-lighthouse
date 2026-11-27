/**
 * Relative failure-burst detection against dense and sparse streams (ROADMAP C34).
 *
 *   node dist/run-treeherder-c34-report.js --from 2026-10-24 --to 2026-11-06 [--load-from 2026-10-22]
 *                                          [--dir ../data/treeherder] [--prow-dir ../data/prow] [--skip-prow]
 *
 * Compares the fixed C19 burst threshold (`failureCount: 10`) against C34's
 * opt-in `relativeFailureBurst` through the shipped `test-stream` wiring
 * (1 h windows, 3 live windows, 30 preceding reference windows).
 *
 * THE RULE, fixed on 2026-11-28 on spent exploratory data (Treeherder C29
 * 2026-11-09…11-22 and Prow 89d 2026-08-19…11-15) BEFORE the Treeherder
 * confirmation range (2026-10-24…11-06, fed from 2026-10-22) was read for
 * bursts (`C34_RELATIVE_BURST` in snapshot-curator.ts):
 *
 *   - Reference: the `M` judged (unweighted 0/1) windows in `reference.windows`.
 *   - Blindness: if `M < 8`, report `blind: true` and `bursts: []` (never read as quiet).
 *   - Upper trim: sort reference failure counts ascending and keep the bottom
 *     `floor(M * (1 - 0.1))` windows (for M = 30, bottom 27), so 1–2 prior bursts
 *     already in the reference do not inflate spread and mask the next burst.
 *   - Baseline: `refMean` and `refVar` (sample variance) on the trimmed counts;
 *     `refScale = max(1, sqrt(max(refMean, refVar)))`;
 *     `threshold = refMean + 3 * refScale`.
 *   - Burst: an observed window with `failed >= 3` and `failed > threshold`.
 *
 * EXPLORATORY RESULTS (spent data: Treeherder 11-09…11-22 & Prow 89d):
 *   Treeherder C29 (11-09…11-22):
 *     fixed10:  regW 159/171 (93%) · noRegFail 79/139 (56.8%) · intermOnly 35/89 (39.3%)
 *     relative: regW  31/171 (18%) · noRegFail  7/139 ( 5.0%) · intermOnly  2/89 ( 2.2%) · inc 53/156 (34%)
 *   Prow 89d (08-19…11-15):
 *     relative: >=10 bursts 10/10 · 3-9 fails 3/6 · 2 fails 0/39 · 1 fail 0/379
 *
 * PRE-REGISTERED CONFIRMATION CRITERIA, fixed BEFORE reading 2026-10-24…11-06:
 *   The rule passes confirmation if all three hold without re-tuning:
 *     (i)   Treeherder non-regression failing-window fire rate <= 15% AND
 *           lower than `fixed10` by >= 30 percentage points;
 *     (ii)  Treeherder regression-window fire rate minus non-regression
 *           failing-window fire rate >= 8 percentage points;
 *     (iii) Prow 89d preserves 10/10 on >=10-failure windows AND 0/379 on
 *           single-failure windows.
 *   Passes -> keep C34 as an opt-in channel (`relativeFailureBurst`) and record
 *   confirmation in ROADMAP_BRIEF.md. Fails -> keep the channel opt-in and record
 *   where the rule fell short without re-tuning on the confirmation range.
 */

import { resolve } from "node:path";
import { MIN_VALID_COUNT, applyLens, type LensEvent, type LensResult, type WindowStat } from "./lens.js";
import { buildToEvents } from "./prow-events.js";
import { DEFAULT_PROW_JOBS, daysBetween, loadProwRange } from "./prow-import.js";
import { TEST_STREAM_WIRING, replayThroughShippedWiring } from "./prow-replay.js";
import { C34_RELATIVE_BURST, SnapshotCurator, type SnapshotPackage } from "./snapshot-curator.js";
import { loadTreeherderRange } from "./treeherder-import.js";
import { incidentsOf, pushesToStream, thLensEvent } from "./treeherder-stream.js";

const HOUR = 3_600_000;
const DAY = 86_400_000;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}
const pct = (a: number, b: number): string => (b === 0 ? "—" : `${((100 * a) / b).toFixed(1)}%`);

interface ProwC34Summary {
  evaluations: number;
  blindRelative: number;
  b10: { n: number; fixed: number; rel: number };
  f3_9: { n: number; fixed: number; rel: number };
  f2: { n: number; fixed: number; rel: number };
  f1: { n: number; fixed: number; rel: number };
}

/**
 * Streams Prow 89d day-by-day through `applyLens` (epoch-aligned 1h windows)
 * and `SnapshotCurator` (with `test-stream`'s 3 live / 30 preceding reference
 * windows). Because epoch-aligned 1h windows are disjoint across UTC days,
 * per-day `applyLens` yields identical `WindowStat` summaries to a full-buffer
 * replay while finishing 89 days (7.3M events) in seconds under ~100 MB heap.
 */
function runProwStreaming(prowDir: string, fromDay = "2026-08-19", toDay = "2026-11-15"): ProwC34Summary {
  const W = TEST_STREAM_WIRING.windowMs;
  const N = TEST_STREAM_WIRING.liveWindows;
  const R = TEST_STREAM_WIRING.referenceWindows ?? N;
  const fromMs = Date.parse(`${fromDay}T00:00:00Z`);
  const toMs = Date.parse(`${toDay}T00:00:00Z`) + DAY;

  const winByStart = new Map<number, WindowStat>();
  const winFail = new Map<number, number>();
  // Merge windows across days cleanly (a build scheduled on day D can have cases landing on D or D+1)
  const rawByWin = new Map<number, { count: number; pass: number }>();
  for (const day of daysBetween(fromDay, toDay)) {
    for (const job of DEFAULT_PROW_JOBS) {
      const { builds } = loadProwRange(prowDir, job, day, day);
      for (const b of builds) {
        for (const raw of buildToEvents(b).events) {
          const ws = Math.floor(raw.ts / W) * W;
          let acc = rawByWin.get(ws);
          if (!acc) rawByWin.set(ws, (acc = { count: 0, pass: 0 }));
          acc.count++;
          if (raw.result !== "fail") acc.pass++;
          if (raw.ts >= fromMs && raw.ts < toMs && raw.result === "fail") {
            winFail.set(ws, (winFail.get(ws) ?? 0) + 1);
          }
        }
      }
    }
  }
  for (const [ws, acc] of rawByWin) {
    // Exact sufficient stats for unweighted 0/1 events: sum = pass, sumSq = pass, mean = pass / count.
    const mean = acc.pass / acc.count;
    winByStart.set(ws, {
      windowStart: ws,
      windowEnd: ws + W,
      count: acc.count,
      mean,
      sumSq: acc.pass,
      valid: acc.count >= MIN_VALID_COUNT,
      range: { min: acc.pass < acc.count ? 0 : 1, max: acc.pass > 0 ? 1 : 0 },
    });
  }
  // Sanity-check one window against applyLens so summary formulas cannot drift
  const sampleEvs: LensEvent[] = [{ ts: 0, value: 0 }, { ts: 1, value: 1 }, { ts: 2, value: 1 }];
  const sampleWin = applyLens(sampleEvs, { window_ms: W, align: "epoch" }).windows[0]!;
  if (Math.abs(sampleWin.sumSq - 2) > 1e-12 || sampleWin.count !== 3) {
    throw new Error("Unexpected applyLens binary window summary shape");
  }

  const curator = new SnapshotCurator({
    spikeZThreshold: 2.0,
    includeBaseline: false,
    maxTiles: Infinity,
    failureCount: 10,
    relativeFailureBurst: true,
  });

  const fixedFired = new Set<number>();
  const relFired = new Set<number>();
  let evaluations = 0;
  let blindRelative = 0;

  const makeLensResult = (wsList: WindowStat[]): LensResult => ({
    window_ms: W,
    windows: wsList,
  });

  const first = Math.ceil(fromMs / W) * W + N * W;
  for (let t = first; t <= toMs; t += W) {
    const obsWins: WindowStat[] = [];
    for (let w = t - N * W; w < t; w += W) {
      const s = winByStart.get(w);
      if (s !== undefined) obsWins.push(s);
    }
    if (obsWins.length === 0) continue;
    const refWins: WindowStat[] = [];
    for (let w = t - (N + R) * W; w < t - N * W; w += W) {
      const s = winByStart.get(w);
      if (s !== undefined) refWins.push(s);
    }
    evaluations++;
    const pkg = curator.curate(makeLensResult(obsWins), makeLensResult(refWins));
    for (const b of pkg.failures?.bursts ?? []) fixedFired.add(b.windowStart);
    if (pkg.relativeFailures?.blind) blindRelative++;
    for (const b of pkg.relativeFailures?.bursts ?? []) relFired.add(b.windowStart);
  }

  const b10 = { n: 0, fixed: 0, rel: 0 };
  const f3_9 = { n: 0, fixed: 0, rel: 0 };
  const f2 = { n: 0, fixed: 0, rel: 0 };
  const f1 = { n: 0, fixed: 0, rel: 0 };
  for (const [ws, c] of winFail) {
    const bucket = c >= 10 ? b10 : c >= 3 ? f3_9 : c === 2 ? f2 : f1;
    bucket.n++;
    if (fixedFired.has(ws)) bucket.fixed++;
    if (relFired.has(ws)) bucket.rel++;
  }
  return { evaluations, blindRelative, b10, f3_9, f2, f1 };
}

function main(): void {
  const fromDay = arg("--from");
  const toDay = arg("--to");
  if (fromDay === undefined || toDay === undefined) {
    console.error("usage: run-treeherder-c34-report --from YYYY-MM-DD --to YYYY-MM-DD [--load-from YYYY-MM-DD] [--dir DIR] [--prow-dir DIR] [--skip-prow]");
    process.exit(2);
  }
  const fromMs = Date.parse(`${fromDay}T00:00:00Z`);
  const toMs = Date.parse(`${toDay}T00:00:00Z`) + DAY;
  const loadFrom = arg("--load-from") ?? new Date(fromMs - 2 * DAY).toISOString().slice(0, 10);
  const dir = resolve(arg("--dir") ?? "../data/treeherder");
  const prowDir = resolve(arg("--prow-dir") ?? "../data/prow");
  const runProw = !hasFlag("--skip-prow");

  const range = loadTreeherderRange(dir, loadFrom, toDay);
  const { events } = pushesToStream(range.pushes);
  const lensEvents = events.map(thLensEvent);
  const inEval = (ms: number): boolean => ms >= fromMs && ms < toMs;
  const incidents = incidentsOf(events, range.pushes).filter((i) => inEval(i.startMs));
  const days = (toMs - fromMs) / DAY;

  const fixedFired = new Set<number>();
  const relFired = new Set<number>();
  let totalPackages = 0;
  let blindRelative = 0;
  const wiring = { ...TEST_STREAM_WIRING, failureCount: 10, relativeFailureBurst: true as const };

  replayThroughShippedWiring(lensEvents, fromMs, toMs, wiring, undefined, (pkg: SnapshotPackage) => {
    totalPackages++;
    for (const b of pkg.failures?.bursts ?? []) fixedFired.add(b.windowStart);
    if (pkg.relativeFailures?.blind) blindRelative++;
    for (const b of pkg.relativeFailures?.bursts ?? []) relFired.add(b.windowStart);
  });

  // Classify every 1h window in [fromMs, toMs) from Treeherder truth
  const winMeta = new Map<number, { fail: number; hasReg: boolean; onlyInterm: boolean }>();
  for (const e of events) {
    if (!inEval(e.ts)) continue;
    const ws = Math.floor(e.ts / HOUR) * HOUR;
    let m = winMeta.get(ws);
    if (!m) winMeta.set(ws, (m = { fail: 0, hasReg: false, onlyInterm: true }));
    if (e.fail) {
      m.fail++;
      if (e.cls === "regression") m.hasReg = true;
      if (e.cls !== "intermittent") m.onlyInterm = false;
    }
  }

  let regW = 0, regFixed = 0, regRel = 0;
  let noRegFailW = 0, noRegFixed = 0, noRegRel = 0;
  let intermW = 0, intermFixed = 0, intermRel = 0;
  let zeroW = 0;
  for (const [ws, m] of winMeta) {
    const fFix = fixedFired.has(ws);
    const fRel = relFired.has(ws);
    if (m.hasReg) {
      regW++;
      if (fFix) regFixed++;
      if (fRel) regRel++;
    } else if (m.fail > 0) {
      noRegFailW++;
      if (fFix) noRegFixed++;
      if (fRel) noRegRel++;
      if (m.onlyInterm) {
        intermW++;
        if (fFix) intermFixed++;
        if (fRel) intermRel++;
      }
    } else {
      zeroW++;
    }
  }

  let incFixed = 0;
  let incRel = 0;
  for (const inc of incidents) {
    if (inc.events.some((e) => fixedFired.has(Math.floor(e.ts / HOUR) * HOUR))) incFixed++;
    if (inc.events.some((e) => relFired.has(Math.floor(e.ts / HOUR) * HOUR))) incRel++;
  }

  const noRegFixedRate = noRegFailW > 0 ? (100 * noRegFixed) / noRegFailW : 0;
  const noRegRelRate = noRegFailW > 0 ? (100 * noRegRel) / noRegFailW : 0;
  const regRelRate = regW > 0 ? (100 * regRel) / regW : 0;
  const c1 = noRegRelRate <= 15 && noRegFixedRate - noRegRelRate >= 30;
  const c2 = regRelRate - noRegRelRate >= 8;

  console.log(`C34 — Relative failure burst (test-stream 1h wiring). Treeherder ${fromDay}…${toDay} (${days} days); fed from ${loadFrom}.`);
  console.log(`rule (C34_RELATIVE_BURST, fixed 2026-11-28): z=${C34_RELATIVE_BURST.zThreshold} · trimTop=${C34_RELATIVE_BURST.trimTop} · minFailures=${C34_RELATIVE_BURST.minFailures} · minRefWindows=${C34_RELATIVE_BURST.minRefWindows}`);
  console.log(`pushes ${range.pushes.length} (missing ${range.missing.length}) · events ${events.length} · packages ${totalPackages} · blind relative ${blindRelative}`);
  console.log("");
  console.log("Treeherder windows in range:");
  console.log(`  regression windows (${regW}):             fixed10 ${regFixed}/${regW} (${pct(regFixed, regW)}) · relative ${regRel}/${regW} (${pct(regRel, regW)})`);
  console.log(`  non-regression failing (${noRegFailW}):        fixed10 ${noRegFixed}/${noRegFailW} (${pct(noRegFixed, noRegFailW)}) · relative ${noRegRel}/${noRegFailW} (${pct(noRegRel, noRegFailW)})`);
  console.log(`  intermittent-only failing (${intermW}):      fixed10 ${intermFixed}/${intermW} (${pct(intermFixed, intermW)}) · relative ${intermRel}/${intermW} (${pct(intermRel, intermW)})`);
  console.log(`  all-pass windows: ${zeroW}`);
  console.log(`  incidents covered (${incidents.length}):           fixed10 ${incFixed}/${incidents.length} (${pct(incFixed, incidents.length)}) · relative ${incRel}/${incidents.length} (${pct(incRel, incidents.length)})`);
  console.log("");
  console.log(`Criterion (i)  noRegFail <= 15% & drop >= 30pt: ${noRegRelRate.toFixed(1)}% (drop ${(noRegFixedRate - noRegRelRate).toFixed(1)} pt) -> ${c1 ? "PASS" : "FAIL"}`);
  console.log(`Criterion (ii) regW - noRegFail >= 8pt:         ${(regRelRate - noRegRelRate).toFixed(1)} pt (${regRelRate.toFixed(1)}% - ${noRegRelRate.toFixed(1)}%) -> ${c2 ? "PASS" : "FAIL"}`);

  if (runProw) {
    const prow = runProwStreaming(prowDir);
    const c3 = prow.b10.rel === prow.b10.n && prow.f1.rel === 0;
    console.log("");
    console.log(`Prow 89d (2026-08-19…11-15, streamed via test-stream wiring): packages ${prow.evaluations} · blind relative ${prow.blindRelative}`);
    console.log(`  >=10 failures (${prow.b10.n}):   fixed10 ${prow.b10.fixed}/${prow.b10.n} · relative ${prow.b10.rel}/${prow.b10.n}`);
    console.log(`  3–9 failures (${prow.f3_9.n}):     fixed10 ${prow.f3_9.fixed}/${prow.f3_9.n} · relative ${prow.f3_9.rel}/${prow.f3_9.n}`);
    console.log(`  2 failures (${prow.f2.n}):      fixed10 ${prow.f2.fixed}/${prow.f2.n} · relative ${prow.f2.rel}/${prow.f2.n}`);
    console.log(`  1 failure (${prow.f1.n}):      fixed10 ${prow.f1.fixed}/${prow.f1.n} · relative ${prow.f1.rel}/${prow.f1.n}`);
    console.log(`Criterion (iii) Prow >=10 all caught & 0 single-fail: ${prow.b10.rel}/${prow.b10.n}, ${prow.f1.rel}/${prow.f1.n} -> ${c3 ? "PASS" : "FAIL"}`);
    console.log("");
    console.log(`OVERALL: ${c1 && c2 && c3 ? "PASS (3/3)" : "FAIL"}`);
  }
}

main();
