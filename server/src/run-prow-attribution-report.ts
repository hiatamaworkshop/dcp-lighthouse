/**
 * Which job the automatic grouped replay names, measured with plants (ROADMAP C28).
 *
 *   node dist/run-prow-attribution-report.js --from 2026-10-26 --to 2026-11-15 [--per-job 20] [--seed 20261122]
 *        [--builds 3] [--jobs a,b,c] [--dir ../data/prow]
 *
 * Rules: prow-attribution.ts (named groups → exact / partial / extra / wrong / none) and prow-plant.ts
 * (plants, start builds). Every grid boundary is evaluated, as a playback at or under C26's speed cap is.
 * The wiring is the test-stream profile ("1h-fresh"). Counts only.
 */

import { resolve } from "node:path";
import { DEFAULT_PROW_JOBS, loadProwRange, type ProwBuild } from "./prow-import.js";
import { buildsToEvents, prowLensEvent, type ProwEvent } from "./prow-events.js";
import { TEST_STREAM_WIRING } from "./prow-replay.js";
import { ATTRIBUTIONS, classifyAttribution, replayCoarseThenRegroup, type Attribution, type RegroupFire } from "./prow-attribution.js";
import {
  FEW, PLANT_LEAD_MS, PLANT_TAIL_MS, applyPlant, choosePlant, hashString, isCommitStart, pickPlantStarts, plantExtent, plantedFailures,
  seededRandom, type Plant, type PlantSize,
} from "./prow-plant.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const HOUR = 3_600_000;
const W = TEST_STREAM_WIRING.windowMs;
const SIZES: readonly PlantSize[] = ["one", "few"];

type Outcome = Attribution | "not fired" | "coincided";
const OUTCOMES: readonly Outcome[] = [...ATTRIBUTIONS, "not fired", "coincided"];

const short = (job: string): string => job.replace(/^ci-kubernetes-/, "").replace(/^ci-/, "");

function main(): void {
  const fromDay = arg("--from");
  const toDay = arg("--to");
  if (fromDay === undefined || toDay === undefined) {
    console.error("usage: run-prow-attribution-report --from YYYY-MM-DD --to YYYY-MM-DD [--per-job N] [--seed S] [--builds N] [--jobs a,b,c] [--dir DIR]");
    process.exit(2);
  }
  const dir = resolve(arg("--dir") ?? "../data/prow");
  const jobs = (arg("--jobs") ?? DEFAULT_PROW_JOBS.join(",")).split(",").filter((j) => j !== "");
  const perJob = Number(arg("--per-job") ?? "20");
  const seed = Number(arg("--seed") ?? "20261122");
  const nBuilds = Number(arg("--builds") ?? "3");
  const builds: ProwBuild[] = [];
  for (const job of jobs) {
    try {
      builds.push(...loadProwRange(dir, job, fromDay, toDay).builds);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(2);
    }
  }
  builds.sort((a, b) => a.scheduledMs - b.scheduledMs);
  const fromMs = Date.parse(`${fromDay}T00:00:00Z`);
  const toMs = Date.parse(`${toDay}T00:00:00Z`) + 86_400_000;
  const ofJob = new Map(jobs.map((j) => [j, builds.filter((b) => b.job === j)]));
  const started = Date.now();

  console.log("Automatic grouped replay attribution through the test-stream wiring (ROADMAP C28): counts only, no verdict.");
  console.log(`${fromDay}…${toDay}, jobs ${jobs.join(", ")}: ${builds.length} builds; ${perJob} start builds per job (seed ${seed}); sizes one/few (${FEW} tests); ${nBuilds} builds per plant`);
  console.log(`wiring ${TEST_STREAM_WIRING.name}: ${W / HOUR} h windows, ${TEST_STREAM_WIRING.referenceWindows} reference windows, every boundary evaluated (a playback at or under the C26 cap)`);
  console.log("rules: prow-attribution.ts (fixed 2026-11-22 before any plant was replayed). Only windows the unplanted slice did not fire on count; a planted window the unplanted slice already fired on is 'coincided'.");

  // ── Control: the record as it is ───────────────────────────────────────────
  const allEvents = buildsToEvents(builds).events.map(prowLensEvent);
  const control = replayCoarseThenRegroup(allEvents, fromMs, toMs, TEST_STREAM_WIRING);
  const byNamed = new Map<string, number>();
  let controlBursts = 0;
  for (const f of control) {
    const k = f.blind ? "(blind replay)" : f.groups.length === 0 ? "(none)" : f.groups.map(short).join(" + ");
    byNamed.set(k, (byNamed.get(k) ?? 0) + 1);
    if (f.triggers.some((t) => t.startsWith("burst"))) controlBursts++;
  }
  console.log(`\n--- control: the unplanted record, ${control.length} fires (${controlBursts} with a burst)`);
  for (const [k, n] of [...byNamed].sort((a, b) => b[1] - a[1])) console.log(`   ${k}: ${n}`);
  console.error(`control done (${((Date.now() - started) / 1000).toFixed(0)} s)`);

  // ── Plants ─────────────────────────────────────────────────────────────────
  const maxN = nBuilds;
  const lastOf = (job: string, i: number): ProwBuild => plantExtent(ofJob.get(job)!, i, maxN).at(-1)!;

  /** Replays a slice unplanted and with `plants`, and scores the first newly fired planted window. */
  function scorePlants(plants: Array<{ plant: Plant; start: ProwBuild }>): { outcome: Outcome; delayMs?: number } {
    const lo = Math.min(...plants.map((p) => p.start.scheduledMs)) - PLANT_LEAD_MS;
    const hi = Math.max(...plants.map((p) => lastOf(p.plant.job, ofJob.get(p.plant.job)!.indexOf(p.start)).scheduledMs)) + PLANT_TAIL_MS;
    const slice = builds.filter((b) => b.scheduledMs >= lo - 2 * HOUR && b.scheduledMs <= hi);
    const toEvents = (bs: ProwBuild[]): ProwEvent[] => buildsToEvents(bs).events.filter((e) => e.ts >= lo && e.ts <= hi);
    const evalFrom = Math.min(...plants.map((p) => p.start.scheduledMs)) - 3 * HOUR;

    let planted = slice;
    const failures: ProwEvent[] = [];
    const plantedIds: Array<{ plant: Plant; ids: string[] }> = [];
    for (const { plant } of plants) {
      const r = applyPlant(planted, plant);
      planted = r.builds;
      plantedIds.push({ plant, ids: r.plantedBuildIds });
    }
    const plantedEvents = toEvents(planted);
    for (const { plant, ids } of plantedIds) failures.push(...plantedFailures(plantedEvents, plant, ids));
    if (failures.length === 0) return { outcome: "not fired" };
    const truthOf = new Map<number, Set<string>>();
    for (const e of failures) {
      const w = Math.floor(e.ts / W) * W;
      let s = truthOf.get(w);
      if (s === undefined) truthOf.set(w, (s = new Set()));
      s.add(e.agentId);
    }
    const first = failures.reduce((m, e) => Math.min(m, e.ts), Infinity);

    const base = replayCoarseThenRegroup(toEvents(slice).map(prowLensEvent), evalFrom, hi, TEST_STREAM_WIRING);
    const baseWindows = new Set(base.map((f) => f.windowStart));
    const fires: RegroupFire[] = replayCoarseThenRegroup(plantedEvents.map(prowLensEvent), evalFrom, hi, TEST_STREAM_WIRING);
    const fresh = fires.filter((f) => truthOf.has(f.windowStart) && !baseWindows.has(f.windowStart)).sort((a, b) => a.t - b.t);
    if (fresh.length === 0) {
      return { outcome: [...truthOf.keys()].some((w) => baseWindows.has(w)) ? "coincided" : "not fired" };
    }
    const f = fresh[0]!;
    return { outcome: classifyAttribution(f.groups, truthOf.get(f.windowStart)!), delayMs: f.t - first };
  }

  type Cell = Map<Outcome, number> & { delays?: number[] };
  const cells = new Map<string, Cell>();
  const tally = (key: string, r: { outcome: Outcome; delayMs?: number }): void => {
    let c = cells.get(key);
    if (c === undefined) cells.set(key, (c = new Map() as Cell));
    c.set(r.outcome, (c.get(r.outcome) ?? 0) + 1);
    if (r.delayMs !== undefined) (c.delays ??= []).push(r.delayMs);
  };

  const picks = new Map<string, ProwBuild[]>();
  for (const job of jobs) picks.set(job, pickPlantStarts(ofJob.get(job)!, job, fromMs, toMs, maxN, perJob, seed));

  // One job at a time.
  for (const job of jobs) {
    for (const start of picks.get(job)!) {
      for (const size of SIZES) {
        const plant = choosePlant(start, size, nBuilds, seededRandom(seed ^ hashString(`${start.id}|${size}`)));
        if (plant === undefined) continue;
        tally(`single|${short(job)}|${size}`, scorePlants([{ plant, start }]));
      }
    }
    console.error(`${job}: single plants done (${((Date.now() - started) / 1000).toFixed(0)} s)`);
  }

  // Two jobs at once: job A's start, and job B's first commit-start build at or after it.
  for (let a = 0; a < jobs.length; a++) {
    for (let b = a + 1; b < jobs.length; b++) {
      const A = jobs[a]!;
      const B = jobs[b]!;
      const bs = ofJob.get(B)!;
      for (const startA of picks.get(A)!) {
        const iB = bs.findIndex((x, i) => x.scheduledMs >= startA.scheduledMs && isCommitStart(bs, i) && i + maxN < bs.length);
        if (iB < 0) continue;
        const startB = bs[iB]!;
        if (lastOf(B, iB).scheduledMs + PLANT_TAIL_MS > toMs) continue;
        for (const size of SIZES) {
          const pA = choosePlant(startA, size, nBuilds, seededRandom(seed ^ hashString(`${startA.id}|${size}`)));
          const pB = choosePlant(startB, size, nBuilds, seededRandom(seed ^ hashString(`${startB.id}|${size}`)));
          if (pA === undefined || pB === undefined) continue;
          tally(`pair|${short(A)} + ${short(B)}|${size}`, scorePlants([{ plant: pA, start: startA }, { plant: pB, start: startB }]));
        }
      }
      console.error(`${A} + ${B}: pairs done (${((Date.now() - started) / 1000).toFixed(0)} s)`);
    }
  }

  const quant = (xs: number[], p: number): number => [...xs].sort((x, y) => x - y)[Math.min(xs.length - 1, Math.floor(p * xs.length))]!;
  for (const kind of ["single", "pair"]) {
    console.log(`\n--- ${kind === "single" ? "one job planted (truth: that job)" : "two jobs planted at once (truth: the jobs with planted failures in the window)"}`);
    console.log(`   planted / size: ${OUTCOMES.join(" · ")} · delay of the first fresh fire, median`);
    for (const [key, c] of cells) {
      const [k, who, size] = key.split("|");
      if (k !== kind) continue;
      const n = [...c.values()].reduce((s, x) => s + x, 0);
      const d = c.delays !== undefined && c.delays.length > 0 ? `${+(quant(c.delays, 0.5) / HOUR).toFixed(1)} h` : "—";
      console.log(`   ${who} / ${size} (${n}): ${OUTCOMES.map((o) => c.get(o) ?? 0).join(" · ")} · ${d}`);
    }
  }
}

main();
