/**
 * C39's check: C34's relative bursts through the shipped wiring itself (ROADMAP C39).
 *
 *   node --max-old-space-size=4096 dist/run-prow-c39-report.js [--from 2026-08-19] [--to 2026-11-15] [--dir ../data/prow]
 *
 * run-treeherder-c34-report counted the Prow side by streaming window summaries
 * straight into SnapshotCurator (prow-c34-stream.ts), claiming they equal what
 * a full-buffer replay would cut. This plays the same days through
 * replayThroughShippedWiring — RetentionBuffer → WindowHistory → Comparator,
 * the chain index.ts runs under LIGHTHOUSE_PROFILE=test-stream with
 * LIGHTHOUSE_RELATIVE_BURST=1 — and compares, window by window, which windows
 * each named as a relative burst (and as a fixed-10 burst) and with how many
 * failures. Exit code 1 on any difference.
 *
 * Counts only, on spent exploratory data (C34 fixed its rule on these days);
 * no threshold is read or moved here.
 */

import { resolve } from "node:path";
import type { LensEvent } from "./lens.js";
import { buildToEvents } from "./prow-events.js";
import { DEFAULT_PROW_JOBS, daysBetween, loadProwRange } from "./prow-import.js";
import { runProwC34Streaming } from "./prow-c34-stream.js";
import { TEST_STREAM_WIRING, replayThroughShippedWiring } from "./prow-replay.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const DAY = 86_400_000;

function diff(name: string, shipped: Map<number, number>, streamed: Map<number, number>): number {
  const onlyShipped = [...shipped.keys()].filter((w) => !streamed.has(w));
  const onlyStreamed = [...streamed.keys()].filter((w) => !shipped.has(w));
  const otherCount = [...shipped.entries()].filter(([w, n]) => streamed.has(w) && streamed.get(w) !== n);
  const iso = (w: number): string => new Date(w).toISOString().slice(0, 13) + "Z";
  console.log(`${name}: shipped ${shipped.size} window(s) · streamed ${streamed.size} · only shipped ${onlyShipped.length} · only streamed ${onlyStreamed.length} · same window, other count ${otherCount.length}`);
  for (const w of onlyShipped) console.log(`  only shipped:  ${iso(w)} ×${shipped.get(w)}`);
  for (const w of onlyStreamed) console.log(`  only streamed: ${iso(w)} ×${streamed.get(w)}`);
  for (const [w, n] of otherCount) console.log(`  other count:   ${iso(w)} shipped ×${n} · streamed ×${streamed.get(w)}`);
  return onlyShipped.length + onlyStreamed.length + otherCount.length;
}

function main(): void {
  const fromDay = arg("--from") ?? "2026-08-19";
  const toDay = arg("--to") ?? "2026-11-15";
  const dir = resolve(arg("--dir") ?? "../data/prow");
  const fromMs = Date.parse(`${fromDay}T00:00:00Z`);
  const toMs = Date.parse(`${toDay}T00:00:00Z`) + DAY;

  // The same events the streamed count reads (buildToEvents, `fail` = 0, anything else = 1), kept small:
  // the ungrouped wiring reads no keys.
  const events: LensEvent[] = [];
  let missing = 0;
  for (const day of daysBetween(fromDay, toDay)) {
    for (const job of DEFAULT_PROW_JOBS) {
      const r = loadProwRange(dir, job, day, day);
      missing += r.missing.length;
      for (const b of r.builds) for (const e of buildToEvents(b).events) events.push({ ts: e.ts, value: e.result === "fail" ? 0 : 1 });
    }
  }
  events.sort((a, b) => a.ts - b.ts);

  const wiring = { ...TEST_STREAM_WIRING, failureCount: 10, relativeFailureBurst: true as const };
  const shippedRel = new Map<number, number>();
  const shippedFixed = new Map<number, number>();
  let packages = 0;
  let blindRelative = 0;
  const started = Date.now();
  const tally = replayThroughShippedWiring(events, fromMs, toMs, wiring, undefined, (pkg) => {
    packages++;
    if (pkg.relativeFailures?.blind) blindRelative++;
    for (const b of pkg.relativeFailures?.bursts ?? []) shippedRel.set(b.windowStart, b.failed);
    for (const b of pkg.failures?.bursts ?? []) shippedFixed.set(b.windowStart, b.failed);
  });
  const shippedSec = (Date.now() - started) / 1000;
  const streamed = runProwC34Streaming(dir, fromDay, toDay);

  console.log(`C39 — C34's relative bursts through the shipped test-stream wiring vs the streamed C34 count. Prow ${fromDay}…${toDay}, jobs ${DEFAULT_PROW_JOBS.join(", ")}.`);
  console.log(`events ${events.length} (${missing} build file(s) could not be read) · shipped: packages ${packages}, blind relative ${blindRelative}, threw ${tally.errors}${tally.firstError ? ` (${tally.firstError})` : ""}, ${shippedSec.toFixed(1)} s · streamed: packages ${streamed.evaluations}, blind relative ${streamed.blindRelative}`);

  // The same buckets run-treeherder-c34-report prints, from the shipped wiring's windows.
  const buckets = { b10: { n: 0, rel: 0 }, f3_9: { n: 0, rel: 0 }, f2: { n: 0, rel: 0 }, f1: { n: 0, rel: 0 } };
  for (const [ws, c] of streamed.winFail) {
    const b = c >= 10 ? buckets.b10 : c >= 3 ? buckets.f3_9 : c === 2 ? buckets.f2 : buckets.f1;
    b.n++;
    if (shippedRel.has(ws)) b.rel++;
  }
  console.log(`shipped relative by failures in the window: >=10 ${buckets.b10.rel}/${buckets.b10.n} · 3–9 ${buckets.f3_9.rel}/${buckets.f3_9.n} · 2 ${buckets.f2.rel}/${buckets.f2.n} · 1 ${buckets.f1.rel}/${buckets.f1.n}`);
  console.log(`streamed relative (C34 report):             >=10 ${streamed.b10.rel}/${streamed.b10.n} · 3–9 ${streamed.f3_9.rel}/${streamed.f3_9.n} · 2 ${streamed.f2.rel}/${streamed.f2.n} · 1 ${streamed.f1.rel}/${streamed.f1.n}`);
  console.log("");
  const differences =
    diff("relative bursts", shippedRel, streamed.relFired) +
    diff("fixed-10 bursts", shippedFixed, streamed.fixedFired) +
    (packages === streamed.evaluations && blindRelative === streamed.blindRelative ? 0 : 1);
  if (packages !== streamed.evaluations || blindRelative !== streamed.blindRelative) {
    console.log(`packages or blind relative differ: shipped ${packages}/${blindRelative} · streamed ${streamed.evaluations}/${streamed.blindRelative}`);
  }
  console.log("");
  console.log(differences === 0 ? "MATCH: the shipped wiring names the same windows with the same counts." : `MISMATCH: ${differences} difference(s).`);
  if (differences !== 0) process.exitCode = 1;
}

main();
