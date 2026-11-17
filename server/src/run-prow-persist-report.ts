/**
 * Per-test persistence along the stream (ROADMAP C21): what it announces in the
 * record, and what it catches of the regressions C20 planted.
 *
 *   node dist/run-prow-persist-report.js --from 2026-08-19 --to 2026-11-15 --plant-from 2026-10-26 --plant-to 2026-11-15
 *        [--per-job 20] [--seed 20261117] [--jobs a,b,c] [--dir ../data/prow]
 *
 * The rule is fixed in prow-persist.ts. The plants are C20's: same seed, same
 * start builds, same targets. Counts only.
 */

import { resolve } from "node:path";
import { DEFAULT_PROW_JOBS, daysBetween, loadProwRange, type ProwBuild } from "./prow-import.js";
import { buildsToEvents } from "./prow-events.js";
import { PersistenceDetector, detectPersistence, type Announcement } from "./prow-persist.js";
import { PLANT_LEAD_MS, PLANT_SIZES, PLANT_TAIL_MS, applyPlant, choosePlant, hashString, pickPlantStarts, plantExtent, plantedFailures, seededRandom } from "./prow-plant.js";
import { quantiles } from "./prow-shape.js";
import { EpisodeBuilder, failureClassIndex, failureKey, type Episode, type FailureClass } from "./prow-truth.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const HOUR = 3_600_000;
const CLASSES: FailureClass[] = ["regression", "isolated", "flaky"];
const pct = (a: number, b: number): string => (b === 0 ? "—" : `${((100 * a) / b).toFixed(1)}%`);
const num = (x: number): string => (Number.isInteger(x) ? String(x) : x.toFixed(1));
const key = (a: { job: string; testId: string; buildId: string }): string => `${a.job}\u0000${a.testId}\u0000${a.buildId}`;
/** Plants of 3 builds: the detector announces at the 2nd failing build whatever the length, so 12 would repeat the same numbers. */
const PLANT_BUILDS = 3;

function recordPart(dir: string, jobs: string[], fromDay: string, toDay: string): void {
  const days = daysBetween(fromDay, toDay);
  const detector = new PersistenceDetector();
  const episodes = new EpisodeBuilder();
  const announced: Announcement[] = [];
  let builds = 0;
  for (const job of jobs) {
    for (let i = 0; i < days.length; i += 7) {
      const chunk = days.slice(i, i + 7);
      for (const b of loadProwRange(dir, job, chunk[0]!, chunk[chunk.length - 1]!).builds) {
        builds++;
        announced.push(...detector.add(b));
        episodes.add(b);
      }
    }
  }
  const eps = episodes.finish();
  const index = failureClassIndex(eps);
  console.log(`\n=== the record: ${fromDay}…${toDay}, ${jobs.length} jobs, ${builds} builds, ${days.length} days`);
  console.log(`   failure episodes (C13): ${eps.length} — ${CLASSES.map((c) => `${c} ${eps.filter((e) => e.class === c).length}`).join(", ")}; of length ≥ 2: ${eps.filter((e) => e.buildIds.length >= 2).length}`);
  const classOf = (a: Announcement): Episode | undefined => index.get(failureKey(a.buildId, a.testId));
  const by = (xs: Announcement[], label: string): void => {
    const k = (c: FailureClass): number => xs.filter((a) => classOf(a)?.class === c).length;
    console.log(`   ${label.padEnd(34)} announced ${String(xs.length).padStart(4)} · C13 later calls them: regression ${k("regression")} (right), flaky ${k("flaky")} (wrong), isolated ${k("isolated")} (cannot be: the run lasted 2 builds)`);
  };
  by(announced, "all jobs");
  for (const job of jobs) by(announced.filter((a) => a.job === job), job.replace("ci-kubernetes-", ""));
  const regress = eps.filter((e) => e.class === "regression");
  const got = regress.filter((e) => announced.some((a) => a.job === e.job && a.testId === e.testId && a.firstBuildId === e.buildIds[0]));
  console.log(`   C13 regression episodes announced: ${got.length}/${regress.length}`);
  const flaky2 = eps.filter((e) => e.class === "flaky" && e.buildIds.length >= 2);
  const wrong = announced.filter((a) => classOf(a)?.class === "flaky");
  console.log(`   flaky episodes of length ≥ 2: ${flaky2.length}, of which announced (wrongly): ${new Set(wrong.map((a) => classOf(a))).size}`);
  // Announcements per triggering build: a burst is one environment event, not many regressions.
  const perBuild = new Map<string, Announcement[]>();
  for (const a of announced) {
    let l = perBuild.get(a.buildId);
    if (l === undefined) perBuild.set(a.buildId, (l = []));
    l.push(a);
  }
  const buckets: Array<[string, number, number]> = [["1", 1, 1], ["2-9", 2, 9], ["10+", 10, Infinity]];
  console.log(`   announcements by tests announced at one build: ${buckets.map(([l, lo, hi]) => { const sel = [...perBuild.values()].filter((v) => v.length >= lo && v.length <= hi); return `${l}: ${sel.length} builds, ${sel.reduce((s, v) => s + v.length, 0)} announcements`; }).join(" · ")}`);
  const alone = [...perBuild.values()].filter((v) => v.length === 1).flat();
  by(alone, "builds announcing exactly 1 test");
  const rate = (announced.length / days.length).toFixed(2);
  console.log(`   per day: ${rate} announcements; days with at least one: ${new Set(announced.map((a) => new Date(a.atMs).toISOString().slice(0, 10))).size}/${days.length}`);
}

function plantPart(dir: string, jobs: string[], fromDay: string, toDay: string, perJob: number, seed: number): void {
  const builds: ProwBuild[] = [];
  for (const job of jobs) builds.push(...loadProwRange(dir, job, fromDay, toDay).builds);
  builds.sort((a, b) => a.scheduledMs - b.scheduledMs);
  const fromMs = Date.parse(`${fromDay}T00:00:00Z`);
  const toMs = Date.parse(`${toDay}T00:00:00Z`) + 86_400_000;
  console.log(`\n=== C20's plants: ${fromDay}…${toDay}, ${perJob} starts per job (seed ${seed}), ${PLANT_BUILDS} builds each (run on to the end of the last build's commit)`);
  console.log(`   job / size: plants detected (≥ 1 target announced, inside the plant) · targets announced (median share) · delay from the first planted failure to the announcement (median / p90 / max, hours)`);
  void PLANT_LEAD_MS;
  void PLANT_TAIL_MS;
  for (const job of jobs) {
    const ofJob = builds.filter((b) => b.job === job);
    const starts = pickPlantStarts(ofJob, job, fromMs, toMs, 12, perJob, seed);
    const cells = new Map<string, { n: number; detected: number; shares: number[]; delays: number[]; fresh: number }>();
    for (const start of starts) {
      const at = ofJob.indexOf(start);
      const hi = plantExtent(ofJob, at, 12).at(-1)!.scheduledMs + PLANT_TAIL_MS;
      const slice = builds.filter((b) => b.scheduledMs >= start.scheduledMs - PLANT_LEAD_MS - 2 * HOUR && b.scheduledMs <= hi);
      const base = new Set(detectPersistence(slice).map(key));
      for (const size of PLANT_SIZES) {
        const plant = choosePlant(start, size, PLANT_BUILDS, seededRandom(seed ^ hashString(`${start.id}|${size}`)));
        if (plant === undefined) continue;
        const { builds: planted, plantedBuildIds } = applyPlant(slice, plant);
        const failures = plantedFailures(buildsToEvents(planted).events, plant, plantedBuildIds);
        if (failures.length === 0) continue;
        const firstFailure = failures.reduce((m, e) => Math.min(m, e.ts), Infinity);
        const inPlant = new Set(plantedBuildIds);
        const targets = new Set(plant.testIds);
        const hits = detectPersistence(planted).filter((a) => a.job === job && targets.has(a.testId) && inPlant.has(a.buildId) && !base.has(key(a)));
        let c = cells.get(size);
        if (c === undefined) cells.set(size, (c = { n: 0, detected: 0, shares: [], delays: [], fresh: 0 }));
        c.n++;
        if (hits.length > 0) {
          c.detected++;
          c.delays.push((Math.min(...hits.map((a) => a.atMs)) - firstFailure) / HOUR);
        }
        c.shares.push(new Set(hits.map((a) => a.testId)).size / plant.testIds.length);
      }
    }
    for (const size of PLANT_SIZES) {
      const c = cells.get(size);
      if (c === undefined) continue;
      const d = quantiles(c.delays);
      const sh = quantiles(c.shares);
      console.log(`   ${job.replace("ci-kubernetes-", "").padEnd(22)} / ${size.padEnd(4)}: ${c.detected}/${c.n} · ${sh !== undefined ? `${(100 * sh.median).toFixed(0)}%` : "—"} · ${d !== undefined ? `${num(d.median)} / ${num(d.p90)} / ${num(d.max)}` : "—"}`);
    }
  }
}

function main(): void {
  const fromDay = arg("--from");
  const toDay = arg("--to");
  const plantFrom = arg("--plant-from");
  const plantTo = arg("--plant-to");
  if (fromDay === undefined || toDay === undefined || plantFrom === undefined || plantTo === undefined) {
    console.error("usage: run-prow-persist-report --from D --to D --plant-from D --plant-to D [--per-job N] [--seed S] [--jobs a,b,c] [--dir DIR]");
    process.exit(2);
  }
  const dir = resolve(arg("--dir") ?? "../data/prow");
  const jobs = (arg("--jobs") ?? DEFAULT_PROW_JOBS.join(",")).split(",").filter((j) => j !== "");
  const perJob = Number(arg("--per-job") ?? "20");
  const seed = Number(arg("--seed") ?? "20261117");
  console.log("Per-test persistence along the stream (ROADMAP C21): counts only, no verdict.");
  console.log("rule: prow-persist.ts (fixed 2026-11-17 before the detector was run on any data): announce at the 2nd consecutive failing build of a test when no build so far passed it on either commit and no case of it passed in either build");
  try {
    recordPart(dir, jobs, fromDay, toDay);
    plantPart(dir, jobs, plantFrom, plantTo, perJob, seed);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
}

main();
