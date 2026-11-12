import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkRangeCoverage, describeCoverage, rangeCoverageRefusal, COVERAGE_EDGE_MS } from "./range-coverage.js";

const DAY = 86_400_000;
const T0 = Date.parse("2026-09-03T00:00:00Z"); // range 09-03…09-04 = [T0, T0 + 2 DAY)
const END = T0 + 2 * DAY;
const STEP = 2_000; // 2 s apart: no hole over 5 s

const rec = (ts: number) => JSON.stringify({ ts, value: 1, wiki: "w", type: "edit", namespace: 0, eid: String(ts) });

/** A data dir holding `ts` values filed by ARRIVAL day (`fileDay(ts)`), a state file and gaps. */
function makeDir(opts: { tsList: number[]; fileDay?: (ts: number) => string; state?: object | "missing" | "garbage"; gaps?: object[] }): string {
  const dir = mkdtempSync(join(tmpdir(), "range-coverage-"));
  const byDay = new Map<string, string[]>();
  for (const ts of opts.tsList) {
    const day = (opts.fileDay ?? ((t: number) => new Date(t).toISOString().slice(0, 10)))(ts);
    (byDay.get(day) ?? byDay.set(day, []).get(day)!).push(rec(ts));
  }
  for (const [day, lines] of byDay) writeFileSync(join(dir, `${day}.jsonl`), lines.join("\n") + "\n");
  if (opts.state !== "missing") {
    writeFileSync(join(dir, "collector-state.json"), opts.state === "garbage" ? "{not json" : JSON.stringify(opts.state ?? { openGaps: [] }));
  }
  if (opts.gaps !== undefined) writeFileSync(join(dir, "gaps.jsonl"), opts.gaps.map((g) => JSON.stringify(g)).join("\n") + "\n");
  return dir;
}

const full = (from = T0, to = END): number[] => {
  const out: number[] = [];
  for (let t = from; t < to; t += STEP) out.push(t);
  return out;
};

describe("stage 5's entry check: is the whole range there (C9)", () => {
  const dirs: string[] = [];
  const mk = (o: Parameters<typeof makeDir>[0]) => {
    const d = makeDir(o);
    dirs.push(d);
    return d;
  };
  after(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  const look = async (dir: string) => {
    const c = await checkRangeCoverage(dir, "2026-09-03", "2026-09-04");
    return { c, refusal: rangeCoverageRefusal(c, "2026-09-03", "2026-09-04") };
  };

  it("passes a range that is all there, and lists nothing", async () => {
    const { c, refusal } = await look(mk({ tsList: full() }));
    assert.equal(refusal, undefined);
    assert.equal(c.events, full().length);
    assert.equal(c.unrecordedHoles.length, 0);
    assert.match(describeCoverage(c, "2026-09-03", "2026-09-04").join("\n"), /0 not recorded/);
  });

  it("refuses a range whose end is missing (still catching up, or the collector is down)", async () => {
    const { refusal } = await look(mk({ tsList: full(T0, END - 10 * 60_000) }));
    assert.match(refusal ?? "", /the last event is at .* before the range ends/);
  });

  it("refuses a range whose start is missing", async () => {
    const { refusal } = await look(mk({ tsList: full(T0 + 10 * 60_000, END) }));
    assert.match(refusal ?? "", /the first event is at .* after the range starts/);
  });

  it("accepts an edge within the limit, refuses one past it", async () => {
    const ok = await look(mk({ tsList: full(T0 + COVERAGE_EDGE_MS - STEP, END - COVERAGE_EDGE_MS + STEP) }));
    assert.equal(ok.refusal, undefined);
    const bad = await look(mk({ tsList: full(T0 + COVERAGE_EDGE_MS + STEP, END) }));
    assert.match(bad.refusal ?? "", /first event/);
  });

  it("refuses when the collector state lists an open gap, is missing, or is unreadable", async () => {
    const open = await look(mk({ tsList: full(), state: { openGaps: [{ fromTs: T0 + 1000, toTs: T0 + 2000 }] } }));
    assert.match(open.refusal ?? "", /1 open gap/);
    assert.match((await look(mk({ tsList: full(), state: "missing" }))).refusal ?? "", /missing or unreadable/);
    assert.match((await look(mk({ tsList: full(), state: "garbage" }))).refusal ?? "", /missing or unreadable/);
  });

  it("refuses an empty range", async () => {
    assert.match((await look(mk({ tsList: [] }))).refusal ?? "", /no event/);
  });

  it("counts late arrivals: the range's last minutes filed under the next day's file still stand for it", async () => {
    const late = (t: number) => (t >= END - 10 * 60_000 ? "2026-09-05" : new Date(t).toISOString().slice(0, 10));
    const { c, refusal } = await look(mk({ tsList: full(), fileDay: late }));
    assert.equal(refusal, undefined);
    assert.equal(c.events, full().length);
  });

  it("lists a hole gaps.jsonl does not record, and does not list one it does (neither refuses)", async () => {
    const holey = full().filter((t) => !(t >= T0 + DAY + 3_600_000 && t < T0 + DAY + 3_600_000 + 30_000)); // 30 s hole
    const unrecorded = await look(mk({ tsList: holey }));
    assert.equal(unrecorded.refusal, undefined);
    assert.equal(unrecorded.c.unrecordedHoles.length, 1);
    assert.ok(unrecorded.c.unrecordedHoles[0].toTs - unrecorded.c.unrecordedHoles[0].fromTs >= 30_000);
    assert.match(describeCoverage(unrecorded.c, "2026-09-03", "2026-09-04").join("\n"), /1 not recorded \(listed/);
    const recorded = await look(mk({ tsList: holey, gaps: [{ kind: "gap", fromTs: T0 + DAY + 3_600_000 - STEP, toTs: T0 + DAY + 3_600_000 + 30_000 }] }));
    assert.equal(recorded.refusal, undefined);
    assert.equal(recorded.c.unrecordedHoles.length, 0);
    assert.equal(recorded.c.recordedHoles, 1);
  });

  it("reads times only: a day file's values and keys do not matter", async () => {
    const dir = mk({ tsList: [] });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "2026-09-03.jsonl"), full(T0, T0 + DAY).map((t) => `{"ts":${t},"junk":true}`).join("\n") + "\nnot a record\n");
    writeFileSync(join(dir, "2026-09-04.jsonl"), full(T0 + DAY, END).map((t) => `{"ts":${t}}`).join("\n") + "\n");
    const { refusal, c } = await look(dir);
    assert.equal(refusal, undefined);
    assert.equal(c.events, full().length);
  });
});
