/**
 * Stage 5's entry check (ROADMAP C9, ROADMAP_BRIEF.md 2026-11-10 audit item 6): before the single
 * look reads the sealed week, is the week actually all there? The `--holdout` gate only looked at the
 * calendar; a collector that was down, or still catching up, leaves the week's tail (or head) missing
 * without a recorded gap — the stage-3 look read 63.7 h of 72 h that way.
 *
 * Reads event TIMES only (a `"ts":` match per line, no value, no key). The pre-registered rule, the
 * verdict and the tolerances are untouched: this only refuses a look that cannot be a look at the week.
 *
 * Refuses when, inside [fromDay, toDay]: there is no event, the first event is later than EDGE_MS after
 * the range starts, the last is earlier than EDGE_MS before it ends, or collector-state.json is missing,
 * unreadable, or lists an open gap (anywhere — stricter than the range, so a look waits for the
 * collector to settle). Not a refusal, but listed first in the output: holes over HOLE_MS in event time
 * that gaps.jsonl does not record (a recorded one is blind to the harness already).
 */
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { createGunzip } from "node:zlib";
import { listDayFiles, type GapSpan } from "./real-data-harness.js";

export const COVERAGE_EDGE_MS = 60_000;
export const COVERAGE_HOLE_MS = 5_000;
const DAY_MS = 86_400_000;

export interface RangeCoverage {
  events: number;
  firstTs?: number;
  lastTs?: number;
  /** Holes over COVERAGE_HOLE_MS in event time that gaps.jsonl / the open gaps do not cover. */
  unrecordedHoles: GapSpan[];
  recordedHoles: number;
  /** undefined = collector-state.json missing or unreadable. */
  openGaps?: GapSpan[];
}

/** Growable Float64Array: a week is ~25 million timestamps, 200 MB packed (a number[] would be no better and slower to sort). */
class TsBuffer {
  private a = new Float64Array(1 << 20);
  n = 0;
  push(x: number): void {
    if (this.n === this.a.length) {
      const b = new Float64Array(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = x;
  }
  sorted(): Float64Array {
    const v = this.a.subarray(0, this.n);
    v.sort();
    return v;
  }
}

/** The text-level `ts` of a record (collector records are written `{"ts":<ms>,...}`); undefined for a torn line. */
const TS_RE = /"ts":(\d{10,})/;

function readGaps(dir: string, lo: number, hi: number): { recorded: GapSpan[]; open?: GapSpan[] } {
  const recorded: GapSpan[] = [];
  const gapPath = join(dir, "gaps.jsonl");
  if (existsSync(gapPath)) {
    for (const line of readFileSync(gapPath, "utf8").split("\n")) {
      if (line === "") continue;
      try {
        const g = JSON.parse(line) as GapSpan & { kind?: string };
        if (g.kind === "gap" && g.toTs > lo && g.fromTs < hi) recorded.push({ fromTs: g.fromTs, toTs: g.toTs });
      } catch {
        // torn line
      }
    }
  }
  let open: GapSpan[] | undefined;
  const statePath = join(dir, "collector-state.json");
  if (existsSync(statePath)) {
    try {
      const s = JSON.parse(readFileSync(statePath, "utf8")) as { openGaps?: GapSpan[] };
      open = (s.openGaps ?? []).map((g) => ({ fromTs: g.fromTs, toTs: g.toTs }));
    } catch {
      open = undefined;
    }
  }
  return { recorded, ...(open !== undefined ? { open } : {}) };
}

/** Event times of [fromDay, toDay] (files chosen exactly as the loaders choose them), their ends and their holes. */
export async function checkRangeCoverage(dir: string, fromDay: string, toDay: string): Promise<RangeCoverage> {
  const lo = Date.parse(`${fromDay}T00:00:00Z`);
  const hi = Date.parse(`${toDay}T00:00:00Z`) + DAY_MS;
  const ts = new TsBuffer();
  for (const { name } of listDayFiles(dir, { fromDay, toDay })) {
    const raw = createReadStream(join(dir, name));
    const input = name.endsWith(".gz") ? raw.pipe(createGunzip()) : raw;
    for await (const line of createInterface({ input, crlfDelay: Infinity })) {
      const m = TS_RE.exec(line);
      if (m === null) continue;
      const t = Number(m[1]);
      if (t >= lo && t < hi) ts.push(t);
    }
  }
  const v = ts.sorted();
  const { recorded, open } = readGaps(dir, lo, hi);
  const covers = [...recorded, ...(open ?? [])];
  const unrecordedHoles: GapSpan[] = [];
  let recordedHoles = 0;
  for (let i = 1; i < v.length; i++) {
    if (v[i] - v[i - 1] <= COVERAGE_HOLE_MS) continue;
    const hole = { fromTs: v[i - 1], toTs: v[i] };
    if (covers.some((g) => g.fromTs <= hole.toTs && g.toTs >= hole.fromTs)) recordedHoles++;
    else unrecordedHoles.push(hole);
  }
  return {
    events: v.length,
    ...(v.length > 0 ? { firstTs: v[0], lastTs: v[v.length - 1] } : {}),
    unrecordedHoles,
    recordedHoles,
    ...(open !== undefined ? { openGaps: open } : {}),
  };
}

const iso = (ms: number) => new Date(ms).toISOString();

/** The refusal message for a look that cannot be a look at the whole range (undefined = the range is there). */
export function rangeCoverageRefusal(c: RangeCoverage, fromDay: string, toDay: string): string | undefined {
  const lo = Date.parse(`${fromDay}T00:00:00Z`);
  const hi = Date.parse(`${toDay}T00:00:00Z`) + DAY_MS;
  const edge = COVERAGE_EDGE_MS / 1000;
  if (c.firstTs === undefined || c.lastTs === undefined) return `refusing: no event in ${fromDay}…${toDay}`;
  if (c.openGaps === undefined) return "refusing: collector-state.json is missing or unreadable, so a still-open gap cannot be ruled out";
  const why: string[] = [];
  if (c.firstTs - lo > COVERAGE_EDGE_MS) why.push(`the first event is at ${iso(c.firstTs)}, ${Math.round((c.firstTs - lo) / 1000)} s after the range starts (limit ${edge} s)`);
  if (hi - c.lastTs > COVERAGE_EDGE_MS) why.push(`the last event is at ${iso(c.lastTs)}, ${Math.round((hi - c.lastTs) / 1000)} s before the range ends (limit ${edge} s) — still catching up, or the collector is down`);
  if (c.openGaps.length > 0) {
    why.push(`collector-state.json lists ${c.openGaps.length} open gap(s), the first ${iso(c.openGaps[0].fromTs)} → ${iso(c.openGaps[0].toTs)} — wait for the collector to settle`);
  }
  return why.length === 0 ? undefined : `refusing: ${fromDay}…${toDay} is not all there: ${why.join("; ")}`;
}

/** Output lines for the head of a look: what was checked and the holes gaps.jsonl does not record. */
export function describeCoverage(c: RangeCoverage, fromDay: string, toDay: string, maxListed = 20): string[] {
  const out = [
    `coverage check (ROADMAP C9) ${fromDay}…${toDay}: ${c.events.toLocaleString("en-US")} events` +
      (c.firstTs !== undefined && c.lastTs !== undefined ? `, first ${iso(c.firstTs)}, last ${iso(c.lastTs)}` : "") +
      `, open gaps ${c.openGaps === undefined ? "unknown" : c.openGaps.length}`,
    `  holes over ${COVERAGE_HOLE_MS / 1000} s in event time: ${c.recordedHoles} recorded (read as blind), ${c.unrecordedHoles.length} not recorded${c.unrecordedHoles.length > 0 ? " (listed; the verdict is not changed by them)" : ""}`,
  ];
  for (const h of c.unrecordedHoles.slice(0, maxListed)) out.push(`    ${iso(h.fromTs)} → ${iso(h.toTs)} (${((h.toTs - h.fromTs) / 1000).toFixed(1)} s)`);
  if (c.unrecordedHoles.length > maxListed) out.push(`    … ${c.unrecordedHoles.length - maxListed} more`);
  return out;
}
