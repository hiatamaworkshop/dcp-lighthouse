/**
 * Recorded Prow test results through the shipped wiring (ROADMAP C12).
 *
 *   node dist/run-prow-replay-report.js --from 2026-10-26 --to 2026-11-15 [--jobs a,b,c] [--dir ../data/prow] [--arms shipped-10s,1h-fresh]
 *
 * Counts only. No verdict, no pre-registered claim: this is the first look at
 * what the shipped chain says about a real test stream.
 */

import { resolve } from "node:path";
import { DEFAULT_PROW_JOBS, loadProwRange, type ProwBuild } from "./prow-import.js";
import { buildsToEvents, prowLensEvent } from "./prow-events.js";
import { REPLAY_ARMS, SHIPPED_WIRING, replayThroughShippedWiring, type ReplayTally, type ReplayWiring } from "./prow-replay.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const MIN = 60_000;
const HOUR = 3_600_000;
const S = SHIPPED_WIRING;
const ARMS = REPLAY_ARMS;

const dur = (ms: number): string => (ms >= HOUR ? `${+(ms / HOUR).toFixed(1)} h` : ms >= MIN ? `${+(ms / MIN).toFixed(1)} min` : `${ms / 1000} s`);
const pct = (a: number, b: number): string => (b === 0 ? "—" : `${((100 * a) / b).toFixed(1)}%`);

function describe(w: ReplayWiring): string {
  const changed: string[] = [];
  if (w.retentionMs !== S.retentionMs) changed.push(`freshness zone ${dur(w.retentionMs)} (shipped ${dur(S.retentionMs)})`);
  if (w.referenceZoneMs !== S.referenceZoneMs) changed.push(w.referenceZoneMs === undefined ? `no thinned reference zone (shipped ${dur(S.referenceZoneMs)}, 1 in ${S.thinningRatio})` : `reference zone ${dur(w.referenceZoneMs)} (shipped ${dur(S.referenceZoneMs)})`);
  if (w.windowMs !== 10_000 && w.windowMs !== 1_000) changed.push(`window ${dur(w.windowMs)} (shipped views: 10 s, 1 s)`);
  if (w.referenceWindows !== undefined) changed.push(`reference_windows ${w.referenceWindows} (shipped: as long as the observation)`);
  if (w.groupBy !== undefined) changed.push(`group_by ${w.groupBy.join(",")}`);
  return changed.length === 0 ? "nothing changed from index.ts" : `changed: ${changed.join("; ")}`;
}

function print(t: ReplayTally): void {
  const w = t.wiring;
  const asked = t.blind + t.scored + t.errors;
  console.log(`\n--- ${w.name}: ${dur(w.windowMs)} windows, observes ${w.liveWindows} at a time, reference ${w.referenceWindows ?? w.liveWindows} windows — ${describe(w)}`);
  console.log(`   boundaries ${t.evaluations}: observed span empty ${t.empty} (${pct(t.empty, t.evaluations)}), asked ${asked} → blind ${t.blind} (${pct(t.blind, asked)}), scored ${t.scored} (${pct(t.scored, asked)})${t.errors > 0 ? `, threw ${t.errors} (${t.firstError})` : ""}`);
  console.log(`   scored, no failure in the observed span: ${t.allPass.n}, alarmed ${t.allPass.alarmed} (${pct(t.allPass.alarmed, t.allPass.n)})`);
  console.log(`   scored, a failure in the observed span:  ${t.withFailure.n}, alarmed ${t.withFailure.alarmed} (${pct(t.withFailure.alarmed, t.withFailure.n)}), with a downward tile ${t.withFailure.down}`);
  console.log(`   blind with a failure in the observed span: ${t.blindWithFailure}`);
  console.log(`   by failures in the window (covered/windows): ${t.failingByCount.map((b) => `${b.failures}: ${b.flagged}/${b.n}`).join(" · ")}`);
  if (t.bursts !== undefined) {
    const b = t.bursts;
    console.log(`   bursts (>= ${b.burstAt} failures in one window, named by the package even when blind): named ${b.claimed.size}, in the events ${b.inEvents.size}, in the events but never named ${b.missed}, named with another number ${b.disagreed}`);
  }
  console.log(`   windows holding a failure: ${t.failingWindows} → a downward tile covered ${t.failingWindowsFlagged} (${pct(t.failingWindowsFlagged, t.failingWindows)}); only ever inside blind packages ${t.failingWindowsOnlyBlind} (${pct(t.failingWindowsOnlyBlind, t.failingWindows)})`);
}

function main(): void {
  const fromDay = arg("--from");
  const toDay = arg("--to");
  if (fromDay === undefined || toDay === undefined) {
    console.error(`usage: run-prow-replay-report --from YYYY-MM-DD --to YYYY-MM-DD [--jobs a,b,c] [--dir DIR] [--arms ${ARMS.map((a) => a.name).join(",")}]`);
    process.exit(2);
  }
  const dir = resolve(arg("--dir") ?? "../data/prow");
  const jobs = (arg("--jobs") ?? DEFAULT_PROW_JOBS.join(",")).split(",").filter((j) => j !== "");
  const wanted = arg("--arms")?.split(",");
  const arms = wanted === undefined ? ARMS : ARMS.filter((a) => wanted.includes(a.name));
  if (wanted !== undefined && arms.length !== wanted.length) {
    console.error(`unknown arm among ${wanted.join(",")} (known: ${ARMS.map((a) => a.name).join(", ")})`);
    process.exit(2);
  }
  const builds: ProwBuild[] = [];
  let missing = 0;
  for (const job of jobs) {
    try {
      const r = loadProwRange(dir, job, fromDay, toDay);
      builds.push(...r.builds);
      missing += r.missing.length;
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(2);
    }
  }
  const { events, skipped } = buildsToEvents(builds);
  const lensEvents = events.map(prowLensEvent);
  const fails = lensEvents.filter((e) => e.value === 0).length;
  const fromMs = Date.parse(`${fromDay}T00:00:00Z`);
  const toMs = Date.parse(`${toDay}T00:00:00Z`) + 86_400_000;
  console.log(`Prow test results through the shipped wiring (ROADMAP C12): counts only, no verdict.`);
  console.log(`${fromDay}…${toDay}, jobs ${jobs.join(", ")}: ${builds.length} builds (${missing} could not be read), ${events.length} events, ${fails} failures, ${skipped} skipped cases left out`);
  console.log(`chain: RetentionBuffer → WindowHistory → Comparator (independent null, spikeZThreshold 2.0, sensitivityPower 0.8, no tile cap) → SnapshotCurator; one evaluation per grid boundary, as the live view`);
  console.log(`a failure is counted from the events; it is not ground truth for a regression (most single failures are flaky tests)`);
  for (const arm of arms) print(replayThroughShippedWiring(lensEvents, fromMs, toMs, arm));
}

main();
