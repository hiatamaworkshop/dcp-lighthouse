/**
 * Per-job-type persistence with a flaky history attached (ROADMAP C35).
 *
 *   node dist/run-treeherder-c35-report.js --from 2026-10-24 --to 2026-11-06 [--load-from 2026-10-22] [--dir ../data/treeherder]
 *                                          [--history-runs N] [--quiet-max F]
 *
 * The stream and the truth are treeherder-stream.ts's (C29), the detector is
 * C21's with the C35 option. Every announcement is kept; each carries the job
 * type's outcomes in its last ≤ N completed runs before the failing run began.
 *
 * THE READING, fixed on 2026-11-27 before the confirmation range (2026-10-22…
 * 11-06) was read. N and F were chosen on the C29 range (2026-11-07…11-22),
 * which is spent exploratory data; the defaults below are the fixed values.
 *
 *   quiet     the history is full (N runs) and failed in at most F of them:
 *             the job type was not failing before this run.
 *   flaky     the history is full and failed in more than F of them.
 *   short     fewer than N runs seen: no history to speak of. Stated, not
 *             read as quiet.
 *   correct   an announcement whose either failing run is a regression
 *             (C29's truth: classified "fixed by commit").
 *
 * The control is the line for all announcements: a tag that carries no
 * information gives every group that precision.
 *
 * CHOICE on the C29 range (N ∈ {10, 20, 40} × F ∈ {5, 10, 20}%): N = 10,
 * F = 10%. Longer histories separate no better and leave more announcements
 * short (43 → 107 → 246 of 1,817). At N = 10, F = 10% the C29 range gave:
 * announcements naming no regression tagged flaky 310/729 (42.5%), naming one
 * 149/1,088 (13.7%); precision quiet 70.6% · flaky 32.5% · all 59.9%;
 * incidents caught by a quiet or short announcement 134 of the 140 any
 * announcement catches.
 *
 * WHAT THE CONFIRMATION RANGE DECIDES, written before reading it:
 *   the tag carries information here if both hold —
 *     (i)  share of the no-regression announcements tagged flaky minus share
 *          of the regression-naming ones tagged flaky ≥ 15 points
 *          (C29 range: 28.8);
 *     (ii) incidents caught by a quiet or short announcement ≥ 90% of those
 *          caught by any announcement (C29 range: 95.7%).
 *   Holds → propose carrying `history` on the live /persistence (opt-in, the
 *   test-stream default unchanged) as a new ledger item. Fails → the option
 *   stays in the harness, and the record says a job type's own failure rate
 *   does not separate regressions from flaky runs in this stream.
 *   Either way no announcement is withheld, and N, F are not re-chosen on
 *   this range.
 *
 * Counts only; the two lines above are the only reading.
 */

import { resolve } from "node:path";
import { C35_FLAKY_HISTORY, PersistenceDetector, flakyTag, type Announcement, type FlakyTag } from "./prow-persist.js";
import { loadTreeherderRange } from "./treeherder-import.js";
import { eventAsBuild, incidentsOf, pushesBetween, pushesToStream, type Incident, type THEvent } from "./treeherder-stream.js";

const HOUR = 3_600_000;
const DAY = 86_400_000;
/** Fixed 2026-11-27 on the C29 range (see the header); shared with prow-persist.ts. */
const C35_HISTORY_RUNS = C35_FLAKY_HISTORY.runs;
const C35_QUIET_MAX = C35_FLAKY_HISTORY.quietMax;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const pct = (a: number, b: number): string => (b === 0 ? "—" : `${((100 * a) / b).toFixed(1)}%`);
function q(xs: number[], digits = 1): string {
  if (xs.length === 0) return "—";
  const s = [...xs].sort((a, b) => a - b);
  const at = (p: number): number => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  const f = (x: number): string => x.toFixed(digits);
  return `median ${f(at(0.5))} · p25 ${f(at(0.25))} · p75 ${f(at(0.75))} · p90 ${f(at(0.9))}`;
}
const tally = <T>(xs: readonly T[], f: (x: T) => string): Map<string, number> => {
  const m = new Map<string, number>();
  for (const x of xs) m.set(f(x), (m.get(f(x)) ?? 0) + 1);
  return m;
};
const fmt = (m: Map<string, number>): string => [...m].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(" · ");

const tagOf = (a: Announcement, runs: number, quietMax: number): FlakyTag => flakyTag(a.history, runs, quietMax);

function main(): void {
  const fromDay = arg("--from");
  const toDay = arg("--to");
  if (fromDay === undefined || toDay === undefined) {
    console.error("usage: run-treeherder-c35-report --from YYYY-MM-DD --to YYYY-MM-DD [--load-from YYYY-MM-DD] [--dir DIR] [--history-runs N] [--quiet-max F]");
    process.exit(2);
  }
  const N = Number(arg("--history-runs") ?? C35_HISTORY_RUNS);
  const F = Number(arg("--quiet-max") ?? C35_QUIET_MAX);
  if (!(Number.isInteger(N) && N >= 1) || !(F >= 0 && F < 1)) {
    console.error("--history-runs must be a positive integer and --quiet-max in [0, 1)");
    process.exit(2);
  }
  const fromMs = Date.parse(`${fromDay}T00:00:00Z`);
  const toMs = Date.parse(`${toDay}T00:00:00Z`) + DAY;
  const loadFrom = arg("--load-from") ?? new Date(fromMs - 2 * DAY).toISOString().slice(0, 10);
  const dir = resolve(arg("--dir") ?? "../data/treeherder");
  const range = loadTreeherderRange(dir, loadFrom, toDay);
  const { events } = pushesToStream(range.pushes);
  const inEval = (ms: number): boolean => ms >= fromMs && ms < toMs;
  const pushMs = Float64Array.from(range.pushes.map((p) => p.push_timestamp * 1000)).sort();
  const allIncidents = incidentsOf(events, range.pushes);
  const incidents = allIncidents.filter((i) => inEval(i.startMs));
  const days = (toMs - fromMs) / DAY;
  const fixedDefaults = N === C35_HISTORY_RUNS && F === C35_QUIET_MAX;

  console.log(`C35 — Treeherder autoland, tier 1. Scored ${fromDay}…${toDay} (${days} days); fed from ${loadFrom}. Stream and truth: treeherder-stream.ts (C29).`);
  console.log(`history: last ${N} completed runs of the job type before the failing run · quiet = full history failing in ≤ ${(F * 100).toFixed(0)}% of runs${fixedDefaults ? " (the values fixed on 2026-11-27)" : " (NOT the fixed values: exploration)"}`);
  console.log(`pushes read ${range.pushes.length} · pushes whose jobs could not be read ${range.missing.length} · events (whole load) ${events.length} · regression incidents starting in the range ${incidents.length}`);

  const det = new PersistenceDetector({}, { runs: N });
  const byJob = new Map<number, THEvent>();
  const anns: Announcement[] = [];
  for (const e of events) {
    byJob.set(e.jobId, e);
    for (const a of det.add(eventAsBuild(e))) if (inEval(a.atMs)) anns.push(a);
  }
  const trig = (a: Announcement): THEvent => byJob.get(Number(a.buildId))!;
  const first = (a: Announcement): THEvent => byJob.get(Number(a.firstBuildId))!;
  const correct = (a: Announcement): boolean => trig(a).cls === "regression" || first(a).cls === "regression";
  const tag = (a: Announcement): FlakyTag => tagOf(a, N, F);

  console.log(`\n=== announcements by the job type's history (control: the "all" line — a tag without information gives every group its precision) ===`);
  const row = (label: string, xs: Announcement[]): void => {
    const c = xs.filter(correct).length;
    console.log(`   ${label.padEnd(26)} ${String(xs.length).padStart(5)} (${(xs.length / days).toFixed(1).padStart(5)}/day) · naming a regression ${String(c).padStart(5)} (${pct(c, xs.length).padStart(6)}) · neither run a regression ${String(xs.length - c).padStart(5)}`);
  };
  row("all", anns);
  for (const t of ["quiet", "flaky", "short"] as const) row(t, anns.filter((a) => tag(a) === t));
  const wrong = anns.filter((a) => !correct(a));
  const right = anns.filter(correct);
  console.log(`   of the announcements naming no regression, tagged flaky ${wrong.filter((a) => tag(a) === "flaky").length}/${wrong.length} (${pct(wrong.filter((a) => tag(a) === "flaky").length, wrong.length)}) · of those naming one, tagged flaky ${right.filter((a) => tag(a) === "flaky").length}/${right.length} (${pct(right.filter((a) => tag(a) === "flaky").length, right.length)})`);

  console.log(`\n   by the failed share of a full history:`);
  const full = anns.filter((a) => a.history !== undefined && a.history.runs >= N);
  const bands: Array<[string, (r: number) => boolean]> = [
    ["0", (r) => r === 0],
    ["(0, 5%]", (r) => r > 0 && r <= 0.05],
    ["(5%, 10%]", (r) => r > 0.05 && r <= 0.1],
    ["(10%, 20%]", (r) => r > 0.1 && r <= 0.2],
    ["(20%, 40%]", (r) => r > 0.2 && r <= 0.4],
    ["> 40%", (r) => r > 0.4],
  ];
  for (const [label, pred] of bands) row(`   ${label}`, full.filter((a) => pred(a.history!.fails / a.history!.runs)));
  const short = anns.filter((a) => tag(a) === "short");
  console.log(`   short histories: runs seen ${q(short.map((a) => a.history?.runs ?? 0), 0)}`);
  console.log(`   by the classes of the two failing runs: quiet ${fmt(tally(anns.filter((a) => tag(a) === "quiet"), (a) => `${first(a).cls}→${trig(a).cls}`))}`);
  console.log(`                                           flaky ${fmt(tally(anns.filter((a) => tag(a) === "flaky"), (a) => `${first(a).cls}→${trig(a).cls}`))}`);

  console.log(`\n=== regression incidents (C29's truth) caught — first announcement naming one of its failing runs ===`);
  const detection = (label: string, pick: (a: Announcement) => boolean): number => {
    const at = new Map<string, number>();
    for (const a of anns) {
      if (!correct(a) || !pick(a)) continue;
      for (const e of [first(a), trig(a)]) {
        if (e.incident === undefined) continue;
        const prev = at.get(e.incident);
        if (prev === undefined || a.atMs < prev) at.set(e.incident, a.atMs);
      }
    }
    const hit = incidents.map((i) => ({ i, t: at.get(i.key) })).filter((x) => x.t !== undefined) as Array<{ i: Incident; t: number }>;
    const withFix = hit.filter((x) => x.i.fixedMs !== undefined);
    console.log(`   ${label.padEnd(30)} ${String(hit.length).padStart(4)}/${incidents.length} (${pct(hit.length, incidents.length)}) · delay from first failure (h) ${q(hit.map((x) => (x.t - x.i.startMs) / HOUR))} · pushes ${q(hit.map((x) => pushesBetween(pushMs, x.i.firstPushMs, x.t)), 0)} · before the fixing push ${withFix.filter((x) => x.t < x.i.fixedMs!).length}/${withFix.length}`);
    return hit.length;
  };
  const caughtAny = detection("any announcement", () => true);
  detection("a quiet one", (a) => tag(a) === "quiet");
  const caughtQuietOrShort = detection("a quiet or short one", (a) => tag(a) !== "flaky");
  detection("a flaky one", (a) => tag(a) === "flaky");

  // The reading fixed in the header (only meaningful at the fixed N, F).
  const share = (xs: Announcement[]): number => (xs.length === 0 ? NaN : (100 * xs.filter((a) => tag(a) === "flaky").length) / xs.length);
  const gap = share(wrong) - share(right);
  const kept = caughtAny === 0 ? NaN : (100 * caughtQuietOrShort) / caughtAny;
  console.log(`\n=== the reading fixed before the confirmation range${fixedDefaults ? "" : " (NOT at the fixed N, F: not a reading)"} ===`);
  console.log(`   (i)  flaky-tag share, no-regression − regression-naming: ${gap.toFixed(1)} points (needs ≥ 15) → ${gap >= 15 ? "holds" : "fails"}`);
  console.log(`   (ii) incidents caught by a quiet or short announcement, of those caught by any: ${caughtQuietOrShort}/${caughtAny} = ${kept.toFixed(1)}% (needs ≥ 90%) → ${kept >= 90 ? "holds" : "fails"}`);
}

main();
