/**
 * Stored Prow builds → `test_result:v1` events (ROADMAP C17; the mapping is the
 * one written down in ROADMAP_BRIEF.md 2026-11-17 (3)).
 *
 *   ts          the instant the case is stamped with — see `Placement`
 *   testId      classname + name
 *   agentId     the job (the unit that produces a stream of runs)
 *   areas       the test's `[sig-…]` labels, each hashed to one of the 256 bits
 *   result      passed → pass, failed → fail. A skipped case is NOT an event
 *   duration    the case's time, in ms
 *   weight      1
 *   commitHash  the build's commit ("" when the build states none)
 *
 * What the mapping cannot give, said here so no reader assumes otherwise:
 *
 *   - A testcase has no timestamp. Only the suite does (and an e2e build is
 *     one suite), so the instant of a case is a choice, not a fact.
 *   - `flaky` is never produced. Nothing in a single junit says a failure is
 *     intermittent; deriving it (same commit, different outcome) needs several
 *     builds and is a later item's question (C13).
 *   - The four pilot domains (auth/payment/ui/utils) do not exist here. A SIG
 *     label is hashed to a bit so the 256-bit space is still exercised, but
 *     the readable area is the label itself — carried as the `area` key.
 */

import type { TestEvent } from "./mock-stream-generator.js";
import type { LensEvent } from "./lens.js";
import type { ProwBuild } from "./prow-import.js";

/**
 * Where in time a case is put.
 *
 *   "suite"   at its suite's timestamp (the build's start when the suite has
 *             none). What the junit states, nothing invented: an e2e build's
 *             thousands of cases all land on one instant.
 *   "spread"  evenly over the build's run, in file order. Invents a spacing
 *             the data does not have; offered because a stream that arrives in
 *             one instant per hour leaves most windows of any lens empty, and
 *             the survey should show how much of that is the stamping.
 */
export type Placement = "suite" | "spread";

export interface ProwEventOptions {
  placement?: Placement;
  /** Junit files to leave out. Default: the e2e runner's own steps (junit_runner.xml), which are not tests. */
  excludeFile?: (file: string) => boolean;
}

export const isRunnerFile = (file: string): boolean => /(^|\/)junit_runner\.xml$/.test(file);

/** The `[sig-…]` labels of a test name, lower-cased, in order of appearance, without repeats. */
export function sigLabels(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\[(sig-[a-z0-9-]+)\]/gi)) {
    const s = m[1]!.toLowerCase();
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

/** A label's bit in the 256-bit area space (FNV-1a: stable across runs and machines). */
export function areaBit(label: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 256;
}

export interface ProwEvent extends TestEvent {
  /** The first SIG label, or "" — the readable area (the bits are its hash). */
  area: string;
  buildId: string;
}

export interface ProwEventBatch {
  events: ProwEvent[];
  skipped: number;
}

/** The start of a build's run: started.json's time, else the instant it was scheduled. */
export function buildStartMs(b: ProwBuild): number {
  return b.startedMs ?? b.scheduledMs;
}

/** The events of one build. Skipped cases are counted, not emitted. */
export function buildToEvents(build: ProwBuild, opts: ProwEventOptions = {}): ProwEventBatch {
  const placement = opts.placement ?? "suite";
  const exclude = opts.excludeFile ?? isRunnerFile;
  const start = buildStartMs(build);
  const end = Math.max(start, build.finishedMs);
  const events: ProwEvent[] = [];
  let skipped = 0;
  for (const f of build.files) {
    if (exclude(f.file)) continue;
    for (const s of f.suites) {
      for (const c of s.cases) {
        if (c.status === "skipped") {
          skipped++;
          continue;
        }
        const labels = sigLabels(`${c.classname} ${c.name}`);
        events.push({
          $schema: "test_result:v1",
          ts: s.ts ?? start,
          testId: `${c.classname}::${c.name}`,
          agentId: build.job,
          areas: labels.map(areaBit),
          result: c.status === "failed" ? "fail" : "pass",
          duration: Math.round(c.time * 1000),
          weight: 1,
          commitHash: build.commit ?? "",
          area: labels[0] ?? "",
          buildId: build.id,
        });
      }
    }
  }
  if (placement === "spread" && events.length > 0) {
    const step = (end - start) / events.length;
    for (let i = 0; i < events.length; i++) events[i]!.ts = Math.floor(start + step * (i + 0.5));
  }
  return { events, skipped };
}

/** Every build's events, in time order (stable, so equal instants keep build and file order). */
export function buildsToEvents(builds: readonly ProwBuild[], opts: ProwEventOptions = {}): ProwEventBatch {
  const events: ProwEvent[] = [];
  let skipped = 0;
  for (const b of builds) {
    const r = buildToEvents(b, opts);
    skipped += r.skipped;
    for (const e of r.events) events.push(e);
  }
  events.sort((a, b) => a.ts - b.ts);
  return { events, skipped };
}

/** The lens's view of an event: pass 1 / fail 0, groupable by job (`agentId`) and by SIG (`area`). */
export function prowLensEvent(e: ProwEvent): LensEvent {
  return { ts: e.ts, value: e.result === "pass" ? 1 : e.result === "fail" ? 0 : 0.5, keys: { agentId: e.agentId, area: e.area } };
}
