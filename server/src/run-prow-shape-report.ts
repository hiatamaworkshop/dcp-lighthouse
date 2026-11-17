/**
 * Shape survey of the imported Prow test results (ROADMAP C17).
 *
 *   node dist/run-prow-shape-report.js --from 2026-10-26 --to 2026-11-15 [--jobs a,b,c] [--dir ../data/prow]
 *
 * Counts only: no gate, no verdict. Refuses a range holding a day that was not
 * imported (prow-import.ts).
 */

import { resolve } from "node:path";
import { DEFAULT_PROW_JOBS, daysBetween, loadProwRange, type MissingBuild, type ProwBuild } from "./prow-import.js";
import { buildsToEvents, prowLensEvent, type Placement, type ProwEvent } from "./prow-events.js";
import { streamShape, windowShape, type Quantiles } from "./prow-shape.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const WINDOWS: Array<[string, number]> = [
  ["1 s", 1_000],
  ["10 s", 10_000],
  ["60 s", 60_000],
  ["10 min", 600_000],
  ["1 h", 3_600_000],
  ["6 h", 21_600_000],
  ["1 d", 86_400_000],
];
const REFERENCES = [6, 30];

const pct = (a: number, b: number): string => (b === 0 ? "   —  " : `${((100 * a) / b).toFixed(a / b < 0.001 && a > 0 ? 3 : 1)}%`.padStart(6));
const num = (x: number): string => (Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(1));
const q = (x: Quantiles | undefined): string => (x === undefined ? "—" : `min ${num(x.min)} · p10 ${num(x.p10)} · median ${num(x.median)} · p90 ${num(x.p90)} · max ${num(x.max)}`);

function report(title: string, builds: ProwBuild[], missing: MissingBuild[], fromDay: string, toDay: string): void {
  const days = daysBetween(fromDay, toDay).length;
  const fromMs = Date.parse(`${fromDay}T00:00:00Z`);
  const toMs = Date.parse(`${toDay}T00:00:00Z`) + 86_400_000;
  const batches = new Map<Placement, { events: ProwEvent[]; skipped: number }>();
  for (const placement of ["suite", "spread"] as const) batches.set(placement, buildsToEvents(builds, { placement }));
  const suite = batches.get("suite")!;
  const s = streamShape(builds, suite.events, suite.skipped, missing, days);

  console.log(`\n=== ${title}: ${fromDay}…${toDay} (${days} days)`);
  console.log(`1. the stream`);
  console.log(`   builds ${s.builds} (${(s.builds / days).toFixed(1)}/day), could not be read ${s.missingBuilds} (blind); results ${Object.entries(s.buildResults).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
  console.log(`   events ${s.events} (${(s.events / days).toFixed(0)}/day): pass ${s.pass} · fail ${s.fail} (${pct(s.fail, s.events).trim()}, 1 in ${s.fail > 0 ? Math.round(s.events / s.fail) : "∞"}); skipped cases (not events) ${s.skipped}`);
  console.log(`   units: tests ${s.tests} · areas (first SIG label) ${s.areas} · jobs ${s.agents}; events without a SIG label ${pct(s.unlabelled, s.events).trim()}`);
  console.log(`   commits ${s.commits} (builds without a stated commit ${s.buildsWithoutCommit}); builds per commit: ${q(s.buildsPerCommit)}`);
  console.log(`   builds holding a failed case ${s.buildsWithFailure} (${pct(s.buildsWithFailure, s.builds).trim()}); failed cases in such a build: ${q(s.failuresPerFailingBuild)}`);
  console.log(`   builds not SUCCESS without any failed case ${s.failedBuildsWithoutFailedCase}; tests that ever failed ${s.testsEverFailed}, in ≥ 2 builds ${s.testsFailedTwice}`);
  console.log(`2. how the runs arrive`);
  console.log(`   events per build: ${q(s.eventsPerBuild)}`);
  console.log(`   build length (min): ${q(s.buildMinutes)}`);
  console.log(`   between build starts (min): ${q(s.startGapMinutes)}`);
  console.log(`   mean events per day by UTC hour (stamped at the suite's time):`);
  console.log(`   ${s.eventsByHour.map((n, h) => `${String(h).padStart(2, "0")}:${Math.round(n)}`).join(" ")}`);

  console.log(`3. what a lens of each width can score (shares of ALL grid windows in the range, empty ones included; reference = the N grid windows just before)`);
  for (const placement of ["suite", "spread"] as const) {
    const lensEvents = batches.get(placement)!.events.map(prowLensEvent);
    console.log(`   placement = ${placement}${placement === "suite" ? " (each case at its suite's timestamp — what the junit states)" : " (cases spread evenly over the build's run — invented spacing)"}`);
    console.log(`   window   grid windows  non-empty  scorable   all-pass*   with fail*  | ref N   usable*   pool thin*  pool all-pass*  | fail windows with usable ref`);
    for (const [label, ms] of WINDOWS) {
      for (const [k, n] of REFERENCES.entries()) {
        const w = windowShape(lensEvents, fromMs, toMs, ms, n);
        const head =
          k === 0
            ? `   ${label.padEnd(7)} ${String(w.gridWindows).padStart(12)}  ${pct(w.nonEmpty, w.gridWindows)}    ${pct(w.scorable, w.gridWindows)}    ${pct(w.scorableAllPass, w.scorable)}      ${pct(w.scorableWithFailure, w.scorable)}     `
            : " ".repeat(73);
        console.log(`${head}| ${String(n).padStart(5)}   ${pct(w.referenceUsable, w.scorable)}    ${pct(w.referenceThin, w.scorable)}      ${pct(w.referenceAllPass, w.scorable)}        | ${w.failureWithUsableReference}/${w.scorableWithFailure}`);
      }
    }
  }
  console.log(`   * share of the scorable windows`);
}

function main(): void {
  const fromDay = arg("--from");
  const toDay = arg("--to");
  if (fromDay === undefined || toDay === undefined) {
    console.error("usage: run-prow-shape-report --from YYYY-MM-DD --to YYYY-MM-DD [--jobs a,b,c] [--dir DIR]");
    process.exit(2);
  }
  const dir = resolve(arg("--dir") ?? "../data/prow");
  const jobs = (arg("--jobs") ?? DEFAULT_PROW_JOBS.join(",")).split(",").filter((j) => j !== "");
  console.log(`Prow shape survey (ROADMAP C17): counts only, no gate and no verdict. Source: bucket kubernetes-ci-logs, jobs ${jobs.join(", ")}`);
  const allBuilds: ProwBuild[] = [];
  const allMissing: MissingBuild[] = [];
  for (const job of jobs) {
    let range;
    try {
      range = loadProwRange(dir, job, fromDay, toDay);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(2);
    }
    report(job, range.builds, range.missing, fromDay, toDay);
    allBuilds.push(...range.builds);
    allMissing.push(...range.missing);
  }
  if (jobs.length > 1) {
    allBuilds.sort((a, b) => a.scheduledMs - b.scheduledMs);
    report(`all ${jobs.length} jobs as one stream`, allBuilds, allMissing, fromDay, toDay);
  }
}

main();
