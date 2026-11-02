/**
 * Step 1a (ROADMAP_BRIEF.md 2026-11-02 (2)): what the gate can see, on the
 * recorded Wikimedia stream.
 *
 * A package now quotes, beside its false-alarm budget, the smallest shift of
 * one window's rate its gate would catch with probability 0.8
 * (CurationOptions.sensitivityPower → SnapshotPackage.sensitivity). This
 * report reads those quotes for each arm and checks them: in each trial one
 * observation window has its latent rate moved by exactly the quoted shift
 * (flipBinaryWindow: events flipped at random, volume kept) and the detection
 * rate is compared with the quoted 80% (runSensitivityCheck). A quote that is
 * right is what lets a reader pick a lens by what it can see rather than by
 * trial and error (H4's 10 s payment windows, stage 4's 60 s windows).
 *
 *   cd server && npm run build && node dist/run-sensitivity-report.js --from 2026-10-26 --to 2026-11-01
 *
 * Exploration only (every holdout is spent; an unspent one would be refused).
 * Options: `--nulls` (default variogram; independent,overdispersed,variogram),
 * `--power` (default 0.8). Each chunk of up to three observation days is
 * loaded with the two days before it, for references and history.
 */
import { join } from "node:path";
import { loadWikiDir, runSensitivityCheck, spentHoldoutNote, stage1RangeRefusal, type SensitivityCheckResult } from "./real-data-harness.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const DAY = 86_400_000;
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const fromDay = arg("from");
const toDay = arg("to");
const power = Number(arg("power") ?? "0.8");
const nulls = (arg("nulls") ?? "variogram").split(",") as Array<"independent" | "overdispersed" | "variogram">;
if (fromDay === undefined || toDay === undefined || !(power > 0 && power < 1) ||
  nulls.some((n) => !["independent", "overdispersed", "variogram"].includes(n))) {
  console.error("usage: run-sensitivity-report --from YYYY-MM-DD --to YYYY-MM-DD [--nulls variogram,...] [--power 0.8]");
  process.exit(2);
}
if (process.argv.includes("--holdout")) {
  console.error("refusing: every holdout is spent (exploration only); this report has no single look");
  process.exit(2);
}
const loadFirst = dayOf(Date.parse(`${fromDay}T00:00:00Z`) - 2 * DAY);
const refusal = stage1RangeRefusal(loadFirst, toDay, false);
if (refusal !== undefined) {
  console.error(refusal);
  process.exit(2);
}
const dir = process.env.WIKI_DATA_DIR ?? join(process.cwd(), "..", "data", "wikimedia");

const ARMS = [
  { key: "V-b", label: "1 s windows, 10 s span", window: 1_000, span: 10_000, stride: 20_000, every: 20 },
  { key: "H1-10s", label: "10 s windows, 300 s span", window: 10_000, span: 300_000, stride: 600_000, every: 1 },
  { key: "V-a", label: "60 s windows, 60 min span", window: 60_000, span: 3_600_000, stride: 600_000, every: 1 },
] as const;

type Acc = Omit<SensitivityCheckResult, "detectionRate" | "controlRate" | "meanMde" | "meanPlanted" | "direction" | "power"> & { mdeSum: number; plantedSum: number };
const acc = new Map<string, Acc>();

console.log(`step 1a: quoted sensitivity (power ${power}) against planted latent-rate shifts, observation days ${fromDay}…${toDay} ` +
  `(loaded from ${loadFirst}); history 24 spans for the variogram null; nulls ${nulls.join(", ")}`);
const spentNote = spentHoldoutNote(loadFirst, toDay);
if (spentNote !== undefined) console.log(spentNote);

for (let c = Date.parse(`${fromDay}T00:00:00Z`); c <= Date.parse(`${toDay}T00:00:00Z`); c += 3 * DAY) {
  const chunkTo = dayOf(Math.min(c + 2 * DAY, Date.parse(`${toDay}T00:00:00Z`)));
  const stream = await loadWikiDir(dir, { fromDay: dayOf(c - 2 * DAY), toDay: chunkTo });
  console.error(`[sensitivity-report] ${dayOf(c)}…${chunkTo}: ${stream.events.length} events, ${stream.gaps.length} gaps`);
  for (const arm of ARMS) {
    for (const nm of nulls) {
      for (const direction of ["dip", "spike"] as const) {
        const r = runSensitivityCheck(stream, {
          lens: { window_ms: arm.window }, spanMs: arm.span, strideMs: arm.stride, obsFromTs: c, every: arm.every,
          direction, nullModel: nm, power, historyMs: nm === "variogram" ? 24 * arm.span : 0, seed: c / DAY,
        });
        const key = `${arm.key}|${nm}|${direction}`;
        const a = acc.get(key) ?? {
          trials: 0, detected: 0, controlDetected: 0, unreachable: 0, skipped: 0, unusableReference: 0, blindByGap: 0, mdeSum: 0, plantedSum: 0,
          byPlantedRatio: r.byPlantedRatio.map((b) => ({ ...b, trials: 0, detected: 0 })),
        };
        a.trials += r.trials;
        a.detected += r.detected;
        a.controlDetected += r.controlDetected;
        a.unreachable += r.unreachable;
        a.skipped += r.skipped;
        a.unusableReference += r.unusableReference;
        a.blindByGap += r.blindByGap;
        a.mdeSum += r.meanMde * r.trials;
        a.plantedSum += r.meanPlanted * r.trials;
        r.byPlantedRatio.forEach((b, i) => {
          a.byPlantedRatio[i].trials += b.trials;
          a.byPlantedRatio[i].detected += b.detected;
        });
        acc.set(key, a);
      }
    }
  }
}

const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
console.log(`\nquoted shift = the one-window MDE the package states; detected = a tile on that window after planting it (should be ≈ ${pct(power)})`);
console.log("arm      null           dir    trials  quoted shift (mean)  planted  detected (±2 SE)       control  unreachable  skipped");
for (const arm of ARMS) {
  for (const nm of nulls) {
    for (const direction of ["dip", "spike"] as const) {
      const a = acc.get(`${arm.key}|${nm}|${direction}`)!;
      const rate = a.trials > 0 ? a.detected / a.trials : 0;
      const se = a.trials > 0 ? Math.sqrt((power * (1 - power)) / a.trials) : 0;
      console.log(
        `${arm.key.padEnd(8)} ${nm.padEnd(14)} ${direction.padEnd(5)} ${String(a.trials).padStart(7)}  ` +
          `${(a.trials > 0 ? a.mdeSum / a.trials : 0).toFixed(4).padStart(19)}  ${(a.trials > 0 ? a.plantedSum / a.trials : 0).toFixed(4).padStart(7)}  ` +
          `${pct(rate).padStart(6)} (${pct(power - 2 * se)}…${pct(power + 2 * se)})  ${pct(a.trials > 0 ? a.controlDetected / a.trials : 0).padStart(6)}  ` +
          `${String(a.unreachable).padStart(11)}  ${String(a.skipped).padStart(7)}`,
      );
    }
  }
}
console.log("\ndetection by the realized shift ÷ the quoted one (random flips scatter it): should rise through the quoted power near 1.0");
for (const arm of ARMS) {
  for (const nm of nulls) {
    const a = acc.get(`${arm.key}|${nm}|dip`)!;
    console.log(`${arm.key.padEnd(8)} ${nm.padEnd(14)} dip   ` +
      a.byPlantedRatio.map((b) => `[${b.lo},${b.hi === Infinity ? "∞" : b.hi}) ${b.trials > 0 ? pct(b.detected / b.trials) : "—"} of ${b.trials}`).join("   "));
  }
}
