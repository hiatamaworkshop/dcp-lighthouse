/**
 * What the shipped wiring announces against real regressions (ROADMAP C29).
 *
 *   node dist/run-treeherder-c29-report.js --from 2026-11-09 --to 2026-11-22 [--load-from 2026-11-07] [--dir ../data/treeherder]
 *
 * The stream, the truth and the group key are treeherder-stream.ts's rules,
 * fixed before the range was read. Days from --load-from to --from are fed as
 * the stream's past (the 30-window reference) and not scored; an incident that
 * started before --from is left out. Three readers, one output:
 *
 *   A  the coarse 1-hour view of the test-stream profile (C19): downward tiles
 *      and concurrent-failure bursts, combined over every job
 *   B  per-job-type persistence (C21/C22's detector, amendment (b))
 *   C  the automatic grouped replay of a coarse fire (C24/C28), by OS family
 *
 * Counts only, no verdict.
 */

import { resolve } from "node:path";
import { classifyAttribution, replayCoarseThenRegroup, ATTRIBUTIONS, type Attribution } from "./prow-attribution.js";
import { PersistenceDetector, type Announcement } from "./prow-persist.js";
import { TEST_STREAM_WIRING, replayThroughShippedWiring } from "./prow-replay.js";
import { loadTreeherderRange } from "./treeherder-import.js";
import { TH_CLASSES, eventAsBuild, incidentsOf, pushesBetween, pushesToStream, thLensEvent, type Incident, type THEvent } from "./treeherder-stream.js";

const HOUR = 3_600_000;
const DAY = 86_400_000;

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
  return `median ${f(at(0.5))} · p25 ${f(at(0.25))} · p75 ${f(at(0.75))} · p90 ${f(at(0.9))} · max ${f(s[s.length - 1]!)}`;
}
const tally = <T>(xs: readonly T[], f: (x: T) => string): Map<string, number> => {
  const m = new Map<string, number>();
  for (const x of xs) m.set(f(x), (m.get(f(x)) ?? 0) + 1);
  return m;
};
const fmt = (m: Map<string, number>): string => [...m].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(" · ");
const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 16) + "Z";

function main(): void {
  const fromDay = arg("--from");
  const toDay = arg("--to");
  if (fromDay === undefined || toDay === undefined) {
    console.error("usage: run-treeherder-c29-report --from YYYY-MM-DD --to YYYY-MM-DD [--load-from YYYY-MM-DD] [--dir DIR]");
    process.exit(2);
  }
  const fromMs = Date.parse(`${fromDay}T00:00:00Z`);
  const toMs = Date.parse(`${toDay}T00:00:00Z`) + DAY;
  const loadFrom = arg("--load-from") ?? new Date(fromMs - 2 * DAY).toISOString().slice(0, 10);
  const dir = resolve(arg("--dir") ?? "../data/treeherder");
  const range = loadTreeherderRange(dir, loadFrom, toDay);
  const { events, excluded } = pushesToStream(range.pushes);
  const inEval = (ms: number): boolean => ms >= fromMs && ms < toMs;
  const evalEvents = events.filter((e) => inEval(e.ts));
  const pushMs = Float64Array.from(range.pushes.map((p) => p.push_timestamp * 1000)).sort();
  const allIncidents = incidentsOf(events, range.pushes);
  const incidents = allIncidents.filter((i) => inEval(i.startMs));
  const W = TEST_STREAM_WIRING.windowMs;

  console.log(`C29 — Treeherder autoland, tier 1. Scored ${fromDay}…${toDay} (${(toMs - fromMs) / DAY} days); fed from ${loadFrom}. Rules: treeherder-stream.ts (fixed 2026-11-27 before the range was read).`);
  console.log(`pushes read ${range.pushes.length} · pushes whose jobs could not be read ${range.missing.length}${range.missing.length > 0 ? ` (blind: ${range.missing.slice(0, 5).map((m) => m.id).join(", ")}${range.missing.length > 5 ? ", …" : ""})` : ""}`);
  console.log(`events (whole load) ${events.length} · scored range ${evalEvents.length}: pass ${evalEvents.filter((e) => !e.fail).length}, fail ${evalEvents.filter((e) => e.fail).length} (${pct(evalEvents.filter((e) => e.fail).length, evalEvents.length)})`);
  console.log(`jobs that are not events (whole load): ${fmt(excluded)}`);
  const failed = evalEvents.filter((e) => e.fail);
  console.log(`failed events by class: ${TH_CLASSES.map((c) => `${c} ${failed.filter((e) => e.cls === c).length}`).join(" · ")}`);
  console.log(`\nregression incidents starting in the range: ${incidents.length} (fixing revision named ${incidents.filter((i) => !i.key.startsWith("unnamed@")).length}, unnamed ${incidents.filter((i) => i.key.startsWith("unnamed@")).length}; started before the range and left out ${allIncidents.filter((i) => i.startMs < fromMs).length})`);
  console.log(`   failing jobs per incident: ${q(incidents.map((i) => i.events.length), 0)} · job types: ${q(incidents.map((i) => i.jobTypes), 0)}`);
  console.log(`   OS families per incident: ${fmt(tally(incidents, (i) => String(i.families.length)))} · touching: ${["linux", "windows", "macos", "android", "other"].map((f) => `${f} ${incidents.filter((i) => i.families.includes(f as never)).length}`).join(" · ")}`);
  const fixed = incidents.filter((i) => i.fixedMs !== undefined);
  console.log(`   the human baseline — fixing push landed after the first failure (h), ${fixed.length} incidents whose fixing push was read: ${q(fixed.map((i) => (i.fixedMs! - i.startMs) / HOUR))}`);
  console.log(`   … in pushes landed between the culprit's push and the fix: ${q(fixed.map((i) => pushesBetween(pushMs, i.firstPushMs, i.fixedMs!)), 0)}`);

  // ---------- A: the coarse view ----------
  const lens = events.map(thLensEvent);
  const downAt = new Map<number, number>();
  const burstAt = new Map<number, number>();
  const tallyA = replayThroughShippedWiring(
    lens,
    fromMs,
    toMs,
    TEST_STREAM_WIRING,
    (ev) => {
      for (const d of ev.downs) for (let w = Math.floor(d.regionStart / W) * W; w < d.regionEnd; w += W) if (!downAt.has(w)) downAt.set(w, ev.t);
    },
    (pkg, at) => {
      for (const b of pkg.failures?.bursts ?? []) if (!burstAt.has(b.windowStart)) burstAt.set(b.windowStart, at.t);
    },
  );
  console.log(`\n=== A. coarse view (${TEST_STREAM_WIRING.name}: 1-hour windows, 30-window reference, burst at ${TEST_STREAM_WIRING.failureCount} failed) ===`);
  console.log(`boundaries ${tallyA.evaluations} · empty ${tallyA.empty} · blind ${tallyA.blind} (${pct(tallyA.blind, tallyA.evaluations)}) · scored ${tallyA.scored}`);
  const windows = new Map<number, THEvent[]>();
  for (const e of evalEvents) {
    const w = Math.floor(e.ts / W) * W;
    let a = windows.get(w);
    if (a === undefined) windows.set(w, (a = []));
    a.push(e);
  }
  const failsPerWindow = [...windows.values()].map((a) => a.filter((e) => e.fail).length);
  console.log(`windows with events ${windows.size} · failed events per window ${q(failsPerWindow, 0)} · events per window ${q([...windows.values()].map((a) => a.length), 0)}`);
  const cats: Array<[string, (a: THEvent[]) => boolean]> = [
    ["holding a regression failure", (a) => a.some((e) => e.cls === "regression")],
    ["failures, none a regression", (a) => a.some((e) => e.fail) && !a.some((e) => e.cls === "regression")],
    ["  … only intermittent ones", (a) => a.some((e) => e.fail) && a.filter((e) => e.fail).every((e) => e.cls === "intermittent")],
    ["no failure", (a) => !a.some((e) => e.fail)],
  ];
  for (const [label, pred] of cats) {
    const ws = [...windows].filter(([, a]) => pred(a)).map(([w]) => w);
    console.log(`   windows ${label.padEnd(30)} ${String(ws.length).padStart(4)} · downward tile ${String(ws.filter((w) => downAt.has(w)).length).padStart(4)} (${pct(ws.filter((w) => downAt.has(w)).length, ws.length)}) · burst ${String(ws.filter((w) => burstAt.has(w)).length).padStart(4)} (${pct(ws.filter((w) => burstAt.has(w)).length, ws.length)})`);
  }

  const firstFlag = (inc: Incident, m: Map<number, number>): number | undefined => {
    let best: number | undefined;
    for (const e of inc.events) {
      const t = m.get(Math.floor(e.ts / W) * W);
      if (t !== undefined && (best === undefined || t < best)) best = t;
    }
    return best;
  };
  const detection = (label: string, at: (i: Incident) => number | undefined): void => {
    const hit = incidents.map((i) => ({ i, t: at(i) })).filter((x) => x.t !== undefined) as Array<{ i: Incident; t: number }>;
    const beforeFix = hit.filter((x) => x.i.fixedMs !== undefined && x.t < x.i.fixedMs);
    console.log(`   incidents caught by ${label.padEnd(22)} ${hit.length}/${incidents.length} (${pct(hit.length, incidents.length)}) · delay from first failure (h): ${q(hit.map((x) => (x.t - x.i.startMs) / HOUR))}`);
    console.log(`      pushes landed between the culprit's push and the catch: ${q(hit.map((x) => pushesBetween(pushMs, x.i.firstPushMs, x.t)), 0)} · before the fixing push landed ${beforeFix.length}/${hit.filter((x) => x.i.fixedMs !== undefined).length}`);
    const bySize = [[1, 1], [2, 4], [5, 19], [20, Infinity]] as const;
    console.log(`      by failing jobs in the incident: ${bySize.map(([a, b]) => `${a}${b === Infinity ? "+" : b === a ? "" : `-${b}`}: ${hit.filter((x) => x.i.events.length >= a && x.i.events.length <= b).length}/${incidents.filter((i) => i.events.length >= a && i.events.length <= b).length}`).join(" · ")}`);
  };
  detection("a downward tile", (i) => firstFlag(i, downAt));
  detection("a burst", (i) => firstFlag(i, burstAt));
  detection("either", (i) => {
    const a = firstFlag(i, downAt);
    const b = firstFlag(i, burstAt);
    return a === undefined ? b : b === undefined ? a : Math.min(a, b);
  });

  // ---------- B: persistence by job type ----------
  const det = new PersistenceDetector();
  const byJob = new Map<number, THEvent>();
  const anns: Announcement[] = [];
  for (const e of events) {
    byJob.set(e.jobId, e);
    for (const a of det.add(eventAsBuild(e))) if (inEval(a.atMs)) anns.push(a);
  }
  const trig = (a: Announcement): THEvent => byJob.get(Number(a.buildId))!;
  const first = (a: Announcement): THEvent => byJob.get(Number(a.firstBuildId))!;
  console.log(`\n=== B. persistence by job type (C21's detector; a job type's two consecutive completed runs fail, no pass on either push) ===`);
  console.log(`announcements ${anns.length} (${(anns.length / ((toMs - fromMs) / DAY)).toFixed(1)}/day) · job types ${new Set(anns.map((a) => a.job)).size}`);
  const pairCls = (a: Announcement): string => `${first(a).cls}→${trig(a).cls}`;
  console.log(`   by the classes of the two failing runs: ${fmt(tally(anns, pairCls))}`);
  const trueAnn = anns.filter((a) => trig(a).cls === "regression" || first(a).cls === "regression");
  console.log(`   naming a regression (either run) ${trueAnn.length} (${pct(trueAnn.length, anns.length)}) · neither run a regression ${anns.length - trueAnn.length}: ${fmt(tally(anns.filter((a) => !trueAnn.includes(a)), (a) => `${trig(a).cls}`))}`);
  console.log(`   runs between the two failing runs, hours: ${q(anns.map((a) => (a.atMs - first(a).ts) / HOUR))}`);
  const annOf = new Map<string, number>();
  for (const a of trueAnn) {
    for (const e of [first(a), trig(a)]) {
      if (e.incident === undefined) continue;
      const prev = annOf.get(e.incident);
      if (prev === undefined || a.atMs < prev) annOf.set(e.incident, a.atMs);
    }
  }
  detection("persistence", (i) => annOf.get(i.key));
  const tooFew = incidents.filter((i) => {
    const perType = tally(i.events, (e) => e.testId);
    return ![...perType.values()].some((n) => n >= 2);
  });
  console.log(`   incidents with no job type failing twice (persistence cannot see them by its rule): ${tooFew.length}/${incidents.length}`);

  // ---------- C: automatic grouped replay ----------
  const fires = replayCoarseThenRegroup(lens, fromMs, toMs, TEST_STREAM_WIRING, ["agentId"]);
  console.log(`\n=== C. automatic grouped replay of coarse fires, by OS family (C24/C28 wiring) ===`);
  console.log(`fires ${fires.length} · by trigger: ${fmt(tally(fires, (f) => f.triggers.map((x) => x.split(" ")[0]).sort().join("+")))} · grouped replay blind ${fires.filter((f) => f.blind).length}`);
  const truthOf = (ws: number, we: number): Set<string> => new Set(evalEvents.filter((e) => e.cls === "regression" && e.ts >= ws && e.ts < we).map((e) => e.agentId));
  const withTruth = fires.filter((f) => truthOf(f.windowStart, f.windowEnd).size > 0);
  const without = fires.filter((f) => truthOf(f.windowStart, f.windowEnd).size === 0);
  const at = new Map<Attribution, number>(ATTRIBUTIONS.map((a) => [a, 0]));
  for (const f of withTruth) {
    const c = classifyAttribution(f.groups, truthOf(f.windowStart, f.windowEnd));
    at.set(c, at.get(c)! + 1);
  }
  console.log(`   fires on a window holding a regression ${withTruth.length}: ${ATTRIBUTIONS.map((a) => `${a} ${at.get(a)}`).join(" · ")}`);
  console.log(`      true families per such window: ${fmt(tally(withTruth, (f) => String(truthOf(f.windowStart, f.windowEnd).size)))}`);
  console.log(`   fires on a window without a regression ${without.length} (control): named nothing ${without.filter((f) => f.groups.length === 0).length} · named a family ${without.filter((f) => f.groups.length > 0).length} (${fmt(tally(without.filter((f) => f.groups.length > 0), (f) => f.groups.join("+")))})`);
  console.log(`   families named across all fires: ${fmt(tally(fires.flatMap((f) => f.groups), (g) => g))}`);

  // ---------- per incident ----------
  console.log(`\n=== incidents (start · failing jobs · job types · families · fix after h · caught by tile / burst / persistence, h after start) ===`);
  for (const i of incidents) {
    const d = firstFlag(i, downAt);
    const b = firstFlag(i, burstAt);
    const p = annOf.get(i.key);
    const h = (t: number | undefined): string => (t === undefined ? "—" : ((t - i.startMs) / HOUR).toFixed(1));
    console.log(
      `   ${iso(i.startMs)} ${i.key.slice(0, 14).padEnd(14)} ${String(i.events.length).padStart(3)} jobs ${String(i.jobTypes).padStart(3)} types ${i.families.join("+").padEnd(22)} fix ${i.fixedMs === undefined ? "  —" : ((i.fixedMs - i.startMs) / HOUR).toFixed(1).padStart(5)} · ${h(d).padStart(5)} / ${h(b).padStart(5)} / ${h(p).padStart(5)}`,
    );
  }
}

main();
