/**
 * C34's Prow count, streamed (ROADMAP C34; shared with C39's check).
 *
 * Streams recorded Prow days through window summaries built directly from the
 * events (epoch-aligned windows of the test-stream wiring) and SnapshotCurator
 * with the test-stream profile's 3 live / 30 preceding reference windows, with
 * the fixed 10 (`failureCount: 10`) and C34's `relativeFailureBurst`. Because
 * epoch-aligned 1 h windows are disjoint, the summaries equal those a
 * full-buffer replay would cut, while 89 days (7.3M events) finish in seconds
 * under ~100 MB heap. run-prow-c39-report checks that claim against the
 * shipped wiring itself (replayThroughShippedWiring).
 *
 * Moved out of run-treeherder-c34-report.ts unchanged, except that it also
 * returns which windows each channel named.
 */

import { MIN_VALID_COUNT, applyLens, type LensEvent, type LensResult, type WindowStat } from "./lens.js";
import { buildToEvents } from "./prow-events.js";
import { DEFAULT_PROW_JOBS, daysBetween, loadProwRange } from "./prow-import.js";
import { TEST_STREAM_WIRING } from "./prow-replay.js";
import { SnapshotCurator } from "./snapshot-curator.js";

const DAY = 86_400_000;

export interface ProwC34Summary {
  evaluations: number;
  blindRelative: number;
  b10: { n: number; fixed: number; rel: number };
  f3_9: { n: number; fixed: number; rel: number };
  f2: { n: number; fixed: number; rel: number };
  f1: { n: number; fixed: number; rel: number };
  /** Windows the relative channel named in any package: start → failures it named. */
  relFired: Map<number, number>;
  /** Windows the fixed 10 named in any package: start → failures it named. */
  fixedFired: Map<number, number>;
  /** Failures per window counted from the events, for windows in [from, to + 1 day). */
  winFail: Map<number, number>;
}

export function runProwC34Streaming(prowDir: string, fromDay = "2026-08-19", toDay = "2026-11-15"): ProwC34Summary {
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

  const fixedFired = new Map<number, number>();
  const relFired = new Map<number, number>();
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
    for (const b of pkg.failures?.bursts ?? []) fixedFired.set(b.windowStart, b.failed);
    if (pkg.relativeFailures?.blind) blindRelative++;
    for (const b of pkg.relativeFailures?.bursts ?? []) relFired.set(b.windowStart, b.failed);
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
  return { evaluations, blindRelative, b10, f3_9, f2, f1, relFired, fixedFired, winFail };
}
