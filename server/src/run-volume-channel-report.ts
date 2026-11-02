/**
 * The volume channel on recorded data (ROADMAP C3, ROADMAP_BRIEF.md 2026-11-02 (4)):
 * what it flags, how its z sits against N(0, 1), and how it relates to the rate
 * gate's alarms — the stream's make-up changes that the rate gate could only
 * describe (`volumeRatio`) now have a finding of their own.
 *
 *   cd server && npm run build && node dist/run-volume-channel-report.js --from 2026-10-01 --to 2026-10-21
 *
 * Same trials as run-volume-report (the preceding span as reference, the variogram
 * null with a 24-span history for the rate side); the volume channel itself reads
 * only the reference's window counts. Exploration only: spent holdout days are
 * labelled, an unspent holdout (none now) is refused, and there is no `--holdout`.
 * The z is calibrated where nothing is labelled, so the alarm rate counts real
 * make-up changes as well as the yardstick's error (the stage-3 lesson): read the
 * bulk of z (|z|≥2, |z|≥3 against N(0, 1)) for the scale and the episodes for what
 * the channel is for.
 */
import { join } from "node:path";
import {
  bandFigures,
  emptyGateZSums,
  loadWikiDir,
  addGateZSums,
  runVolumeCalibration,
  scoringCurator,
  spentHoldoutNote,
  stage1RangeRefusal,
  type GateZSums,
  type VolumeChannelFigures,
} from "./real-data-harness.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const DAY = 86_400_000;
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const fromDay = arg("from");
const toDay = arg("to");
if (fromDay === undefined || toDay === undefined) {
  console.error("usage: run-volume-channel-report --from YYYY-MM-DD --to YYYY-MM-DD");
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
  { key: "V-b", label: "1 s windows, 10 s span", window: 1_000, span: 10_000, stride: 20_000 },
  { key: "H1-10s", label: "10 s windows, 300 s span", window: 10_000, span: 300_000, stride: 600_000 },
  { key: "V-a", label: "60 s windows, 60 min span", window: 60_000, span: 3_600_000, stride: 600_000 },
];

interface Tot {
  trials: number;
  rateAlarm: number;
  fig: VolumeChannelFigures;
  days: Array<{ day: string; trials: number; flagged: number; z: GateZSums; composition: number; caught: number }>;
}
const fresh = (): Tot => ({
  trials: 0, rateAlarm: 0, days: [],
  fig: {
    blindTrials: 0, flagged: 0, z: emptyGateZSums(), up: 0, down: 0, episodes: 0,
    compositionEpisodes: 0, compositionEpisodesCaught: 0, ordinaryEpisodes: 0, ordinaryEpisodesCaught: 0, ordinaryRateWithVolume: 0,
  },
});
const totals = new Map<string, Tot>();

console.log(`volume channel, observation days ${fromDay}…${toDay} (loaded from ${loadFirst}); rate side: variogram null, history 24 spans; volume channel: baseZ 2.0, Šidák over the windows scored`);
const spentNote = spentHoldoutNote(loadFirst, toDay);
if (spentNote !== undefined) console.log(spentNote);

for (let c = Date.parse(`${fromDay}T00:00:00Z`); c <= Date.parse(`${toDay}T00:00:00Z`); c += 3 * DAY) {
  const chunkTo = dayOf(Math.min(c + 2 * DAY, Date.parse(`${toDay}T00:00:00Z`)));
  const stream = await loadWikiDir(dir, { fromDay: dayOf(c - 2 * DAY), toDay: chunkTo });
  console.error(`[volume-channel-report] ${dayOf(c)}…${chunkTo}: ${stream.events.length} events, ${stream.gaps.length} gaps`);
  for (const arm of ARMS) {
    const r = runVolumeCalibration(stream, {
      lens: { window_ms: arm.window }, spanMs: arm.span, strideMs: arm.stride, obsFromTs: c,
      curator: scoringCurator("variogram", 2.0, undefined, true), historyMs: 24 * arm.span,
    });
    const t = totals.get(arm.key) ?? fresh();
    t.trials += r.trials;
    t.rateAlarm += r.flagged;
    if (r.volume !== undefined) {
      const f = t.fig;
      f.blindTrials += r.volume.blindTrials;
      f.flagged += r.volume.flagged;
      addGateZSums(f.z, r.volume.z);
      f.up += r.volume.up;
      f.down += r.volume.down;
      f.episodes += r.volume.episodes;
      f.compositionEpisodes += r.volume.compositionEpisodes;
      f.compositionEpisodesCaught += r.volume.compositionEpisodesCaught;
      f.ordinaryEpisodes += r.volume.ordinaryEpisodes;
      f.ordinaryEpisodesCaught += r.volume.ordinaryEpisodesCaught;
      f.ordinaryRateWithVolume += r.volume.ordinaryRateWithVolume;
    }
    for (const d of r.byDay) t.days.push({ day: d.day, trials: d.trials, flagged: d.volumeFlagged ?? 0, z: d.volumeZ ?? emptyGateZSums(), composition: d.compositionEpisodes, caught: d.compositionCaught ?? 0 });
    totals.set(arm.key, t);
  }
}

const pct = (x: number, d = 1) => `${(100 * x).toFixed(d)}%`;
const weekday = (d: string) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(`${d}T00:00:00Z`).getUTCDay()];

console.log("\n1. The channel's z over every (trial, window) pair — the scale of the yardstick (N(0, 1): var 1, |z|≥2 4.55%, |z|≥3 0.27%)");
console.log("arm      windows   mean z   var z   |z|≥2   |z|≥3   ≥gate (nominal)   up/down fired");
for (const arm of ARMS) {
  const t = totals.get(arm.key)!;
  const f = bandFigures("ordinary", t.fig.z);
  console.log(
    `${arm.key.padEnd(8)} ${String(f.windows).padStart(8)}  ${f.meanGateZ.toFixed(3).padStart(7)}  ${f.varGateZ.toFixed(3).padStart(6)}  ${pct(f.over2, 2).padStart(6)}  ${pct(f.over3, 2).padStart(6)}  ` +
      `${(100 * f.overGate).toFixed(3)}% (${(100 * f.nominalOverGate).toFixed(3)}%)   ${t.fig.up}/${t.fig.down}`,
  );
}

console.log("\n2. Packages and episodes");
console.log("arm      trials   volume-flagged   rate-alarm   volume episodes   blind trials");
for (const arm of ARMS) {
  const t = totals.get(arm.key)!;
  console.log(
    `${arm.key.padEnd(8)} ${String(t.trials).padStart(6)}   ${pct(t.fig.flagged / Math.max(1, t.trials), 2).padStart(13)}   ${pct(t.rateAlarm / Math.max(1, t.trials), 2).padStart(9)}   ` +
      `${String(t.fig.episodes).padStart(14)}   ${String(t.fig.blindTrials).padStart(11)}`,
  );
}

console.log("\n3. Against the rate gate's alarm episodes (runs of rate-alarming trials one stride apart)");
console.log("arm      composition-only episodes   caught by volume     ordinary-volume episodes   also volume      rate-at-ordinary packages with volume fired");
for (const arm of ARMS) {
  const f = totals.get(arm.key)!.fig;
  console.log(
    `${arm.key.padEnd(8)} ${String(f.compositionEpisodes).padStart(10)}   ${`${f.compositionEpisodesCaught} (${pct(f.compositionEpisodesCaught / Math.max(1, f.compositionEpisodes), 0)})`.padStart(22)}   ` +
      `${String(f.ordinaryEpisodes).padStart(14)}   ${`${f.ordinaryEpisodesCaught} (${pct(f.ordinaryEpisodesCaught / Math.max(1, f.ordinaryEpisodes), 0)})`.padStart(14)}   ${String(f.ordinaryRateWithVolume).padStart(10)}`,
  );
}

for (const arm of ARMS) {
  console.log(`\n4. Per observation day (${arm.key}): volume-flagged packages and the channel's z`);
  console.log("day         wd    trials  volume-flagged   windows   var z   |z|≥2   |z|≥3   composition episodes (caught by volume)");
  for (const d of totals.get(arm.key)!.days) {
    const f = bandFigures("ordinary", d.z);
    console.log(
      `${d.day}  ${weekday(d.day)}  ${String(d.trials).padStart(6)}  ${pct(d.flagged / Math.max(1, d.trials)).padStart(13)}   ${String(f.windows).padStart(7)}  ` +
        `${f.varGateZ.toFixed(3).padStart(6)}  ${pct(f.over2, 2).padStart(6)}  ${pct(f.over3, 2).padStart(6)}   ${d.composition} (${d.caught})`,
    );
  }
}
