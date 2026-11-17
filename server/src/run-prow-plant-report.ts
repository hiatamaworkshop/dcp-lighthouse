/**
 * Planted regressions through the shipped wiring (ROADMAP C20, plan b).
 *
 *   node dist/run-prow-plant-report.js --from 2026-10-26 --to 2026-11-15 [--per-job 20] [--seed 20261117]
 *        [--arms 1h-fresh,1h-fresh-by-job,1h-fresh-by-area,10min-fresh] [--jobs a,b,c] [--dir ../data/prow]
 *
 * The rules (plant, targets, detected) are fixed in prow-plant.ts. Counts only.
 */

import { resolve } from "node:path";
import { DEFAULT_PROW_JOBS, loadProwRange, type ProwBuild } from "./prow-import.js";
import { buildsToEvents, prowLensEvent, type ProwEvent } from "./prow-events.js";
import { REPLAY_ARMS, replayThroughShippedWiring, type ReplayEvaluation, type ReplayWiring } from "./prow-replay.js";
import { PLANT_SIZES, applyPlant, choosePlant, isCommitStart, plantClasses, plantExtent, plantedFailures, scorePlant, seededRandom, type PlantScore, type PlantSize } from "./prow-plant.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const HOUR = 3_600_000;
const DURATIONS = [3, 12];
/** History fed before the first planted build: more than the longest arm's freshness zone (1 h × 34). */
const LEAD_MS = 36 * HOUR;
/** Evaluated after the last planted build: every window holding a planted failure is observed liveWindows times. */
const TAIL_MS = 5 * HOUR;
const DEFAULT_ARMS = ["1h-fresh", "1h-fresh-by-job", "1h-fresh-by-area", "10min-fresh"];

const hashString = (s: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
};
const quant = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
};
const hrs = (ms: number): string => `${+(ms / HOUR).toFixed(1)} h`;

interface Cell {
  n: number;
  detected: number;
  delays: number[];
  /** Detected no later than one window after the last planted failure. */
  inTime: number;
  blindAfter: number;
}

function replayEvals(events: ReturnType<typeof prowLensEvent>[], fromMs: number, toMs: number, arm: ReplayWiring): ReplayEvaluation[] {
  const out: ReplayEvaluation[] = [];
  replayThroughShippedWiring(events, fromMs, toMs, arm, (ev) => out.push(ev));
  return out;
}

function main(): void {
  const fromDay = arg("--from");
  const toDay = arg("--to");
  if (fromDay === undefined || toDay === undefined) {
    console.error("usage: run-prow-plant-report --from YYYY-MM-DD --to YYYY-MM-DD [--per-job N] [--seed S] [--arms a,b] [--jobs a,b,c] [--dir DIR]");
    process.exit(2);
  }
  const dir = resolve(arg("--dir") ?? "../data/prow");
  const jobs = (arg("--jobs") ?? DEFAULT_PROW_JOBS.join(",")).split(",").filter((j) => j !== "");
  const perJob = Number(arg("--per-job") ?? "20");
  const seed = Number(arg("--seed") ?? "20261117");
  const armNames = (arg("--arms") ?? DEFAULT_ARMS.join(",")).split(",");
  const arms = armNames.map((n) => REPLAY_ARMS.find((a) => a.name === n));
  if (arms.some((a) => a === undefined)) {
    console.error(`unknown arm among ${armNames.join(",")} (known: ${REPLAY_ARMS.map((a) => a.name).join(", ")})`);
    process.exit(2);
  }
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
  const maxN = Math.max(...DURATIONS);

  console.log("Planted regressions through the shipped wiring (ROADMAP C20 plan b): counts only, no verdict.");
  console.log(`${fromDay}…${toDay}, jobs ${jobs.join(", ")}: ${builds.length} builds; ${perJob} start builds per job (seed ${seed}); sizes ${PLANT_SIZES.join("/")}; lengths ${DURATIONS.join("/")} builds`);
  console.log("rules: prow-plant.ts (fixed 2026-11-17 before any plant was replayed). Each plant is replayed with its slice unplanted and planted; only windows the unplanted replay did not flag count.");

  // cells[job|size|n|arm]
  const cells = new Map<string, Cell>();
  const classes = new Map<string, Map<string, number>>();
  const areaSizes = new Map<string, number[]>();
  const started = Date.now();

  for (const job of jobs) {
    const ofJob = builds.filter((b) => b.job === job);
    const lastOf = (i: number): ProwBuild => plantExtent(ofJob, i, maxN).at(-1)!;
    const candidates = ofJob.filter(
      (b, i) => isCommitStart(ofJob, i) && b.scheduledMs >= fromMs + LEAD_MS && i + maxN < ofJob.length && lastOf(i).scheduledMs + TAIL_MS <= toMs,
    );
    const rand = seededRandom(seed ^ hashString(job));
    const picks: ProwBuild[] = [];
    const pool = [...candidates];
    while (picks.length < perJob && pool.length > 0) picks.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]!);
    picks.sort((a, b) => a.scheduledMs - b.scheduledMs);

    for (const start of picks) {
      const at = ofJob.indexOf(start);
      const lo = start.scheduledMs - LEAD_MS;
      const hi = lastOf(at).scheduledMs + TAIL_MS;
      const slice = builds.filter((b) => b.scheduledMs >= lo - 2 * HOUR && b.scheduledMs <= hi);
      const toLens = (bs: ProwBuild[]): { prow: ProwEvent[]; lens: ReturnType<typeof prowLensEvent>[] } => {
        const prow = buildsToEvents(bs).events.filter((e) => e.ts >= lo && e.ts <= hi);
        return { prow, lens: prow.map(prowLensEvent) };
      };
      const evalFrom = start.scheduledMs - 3 * HOUR;
      const base = toLens(slice);
      const baseEvals = arms.map((arm) => replayEvals(base.lens, evalFrom, hi, arm!));

      for (const size of PLANT_SIZES) {
        for (const n of DURATIONS) {
          // Same targets for both lengths: the draw is seeded by the start build and the size only.
          const plant = choosePlant(start, size, n, seededRandom(seed ^ hashString(`${start.id}|${size}`)));
          if (plant === undefined) continue;
          if (size === "area" && n === DURATIONS[0]) {
            let a = areaSizes.get(job);
            if (a === undefined) areaSizes.set(job, (a = []));
            a.push(plant.testIds.length);
          }
          const { builds: plantedSlice, plantedBuildIds } = applyPlant(slice, plant);
          const planted = toLens(plantedSlice);
          const failures = plantedFailures(planted.prow, plant, plantedBuildIds);
          if (failures.length === 0) continue;
          const lastFailure = failures.reduce((m, e) => Math.max(m, e.ts), -Infinity);
          const cls = plantClasses(plantedSlice, plant);
          const ck = `${size}|${n}`;
          let cm = classes.get(ck);
          if (cm === undefined) classes.set(ck, (cm = new Map()));
          const verdict = cls.length === 0 ? "none" : cls.every((c) => c === "regression") ? "all regression" : cls.some((c) => c === "regression") ? "some regression" : "no regression";
          cm.set(verdict, (cm.get(verdict) ?? 0) + 1);

          arms.forEach((arm, k) => {
            const s: PlantScore = scorePlant(baseEvals[k]!, replayEvals(planted.lens, evalFrom, hi, arm!), failures, arm!.windowMs, arm!.groupBy);
            const key = `${job}|${size}|${n}|${arm!.name}`;
            let c = cells.get(key);
            if (c === undefined) cells.set(key, (c = { n: 0, detected: 0, delays: [], inTime: 0, blindAfter: 0 }));
            c.n++;
            c.blindAfter += s.blindAfter;
            if (s.detected) {
              c.detected++;
              c.delays.push(s.delayMs!);
              if (s.detectedAt! <= lastFailure + arm!.windowMs) c.inTime++;
            }
          });
        }
      }
    }
    console.error(`${job}: ${picks.length} starts done (${((Date.now() - started) / 1000).toFixed(0)} s)`);
  }

  for (const arm of arms) {
    console.log(`\n--- ${arm!.name}: ${hrs(arm!.windowMs)} windows${arm!.groupBy !== undefined ? `, group_by ${arm!.groupBy.join(",")}` : ""}`);
    console.log("   job / size / length: detected/plants · within the plant (≤ 1 window after the last planted failure) · delay median / p90 · blind boundaries after the first failure (mean)");
    for (const job of jobs) {
      for (const size of PLANT_SIZES as readonly PlantSize[]) {
        for (const n of DURATIONS) {
          const c = cells.get(`${job}|${size}|${n}|${arm!.name}`);
          if (c === undefined) continue;
          const d = c.delays.length > 0 ? `${hrs(quant(c.delays, 0.5))} / ${hrs(quant(c.delays, 0.9))}` : "—";
          console.log(`   ${job} / ${size} / ${n}: ${c.detected}/${c.n} · ${c.inTime} · ${d} · ${(c.blindAfter / c.n).toFixed(1)}`);
        }
      }
    }
  }
  console.log("\nC13's rules on the planted failures of the start build (read over the slice):");
  for (const [k, m] of classes) console.log(`   ${k.replace("|", " / ")} builds: ${[...m].map(([v, c]) => `${v} ${c}`).join(", ")}`);
  console.log("\narea plants: tests per plant (median / max)");
  for (const [job, a] of areaSizes) console.log(`   ${job}: ${quant(a, 0.5)} / ${Math.max(...a)}`);
}

main();
