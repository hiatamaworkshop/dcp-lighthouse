import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWikiDir } from "./real-data-harness.js";
import {
  RETENTION_LOW_FREE_BYTES,
  RETENTION_TARGET_FREE_BYTES,
  planRetention,
  prunedRangeRefusal,
  readPrunedDays,
  recordPruned,
  retentionDayOf,
} from "./wiki-retention.js";

const GIB = 1024 ** 3;
const gz = (day: string, gib = 5) => ({ name: `${day}.jsonl.gz`, bytes: gib * GIB });
const days = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `2026-10-${String(from + i).padStart(2, "0")}`);

describe("retention of the daily gz files (C6)", () => {
  const plan = (freeGiB: number, over: Partial<Parameters<typeof planRetention>[0]> = {}) =>
    planRetention({ files: days(1, 31).map((d) => gz(d)), freeBytes: freeGiB * GIB, todayDay: "2026-11-06", holdouts: [], ...over });

  it("deletes nothing while there is room", () => {
    assert.equal(plan(100).action, "none");
    assert.equal(plan(223).victims.length, 0);
    assert.equal(RETENTION_LOW_FREE_BYTES, 100 * GIB);
  });

  it("under the low line, deletes the oldest days, just enough to reach the target", () => {
    const p = plan(99); // needs 21 GiB → 5 files of 5 GiB
    assert.equal(p.action, "delete");
    assert.deepEqual(p.victims.map((v) => v.name), days(1, 5).map((d) => `${d}.jsonl.gz`));
    assert.ok(p.freeAfterBytes >= RETENTION_TARGET_FREE_BYTES);
    assert.ok(p.freeAfterBytes < RETENTION_TARGET_FREE_BYTES + 5 * GIB);
  });

  it("spares the last 14 days, whatever the shortfall (and says so)", () => {
    const p = plan(1);
    assert.equal(p.action, "short");
    // today 11-06: 10-24…11-06 are kept, so the October files before the 24th are all there is
    assert.deepEqual(p.victims.map((v) => v.name), days(1, 23).map((d) => `${d}.jsonl.gz`));
    assert.equal(p.protectedCount, 8); // 10-24…10-31
  });

  it("spares every holdout week with the reports' reach around it, spent or not", () => {
    const p = plan(1, { holdouts: [{ from: "2026-10-10", to: "2026-10-12" }] });
    const gone = new Set(p.victims.map((v) => retentionDayOf(v.name)));
    for (const d of days(8, 14)) assert.ok(!gone.has(d), `${d} (10-10…12 with 2 days before, 2 after) must stay`);
    assert.ok(gone.has("2026-10-07") && gone.has("2026-10-15"));
  });

  it("touches only finished day files", () => {
    const p = planRetention({
      files: [{ name: "gaps.jsonl", bytes: GIB }, { name: "collector-state.json", bytes: 1 }, { name: "2026-09-01.jsonl", bytes: GIB }, gz("2026-09-02")],
      freeBytes: 1 * GIB,
      todayDay: "2026-11-06",
      holdouts: [],
    });
    assert.deepEqual(p.victims.map((v) => v.name), ["2026-09-02.jsonl.gz"]);
  });
});

describe("a deleted day is not a quiet day", () => {
  it("refuses a range that touches a pruned day, including the late-arrival days after it", () => {
    const pruned = ["2026-09-02"];
    assert.equal(prunedRangeRefusal(pruned, { fromDay: "2026-09-03", toDay: "2026-09-10" }), undefined);
    assert.match(prunedRangeRefusal(pruned, { fromDay: "2026-09-01", toDay: "2026-09-02" }) ?? "", /2026-09-02 was deleted/);
    assert.match(prunedRangeRefusal(pruned, { fromDay: "2026-08-28", toDay: "2026-08-31" }) ?? "", /deleted/, "its day is within the 2 late days after toDay");
    assert.equal(prunedRangeRefusal(pruned, { fromDay: "2026-08-20", toDay: "2026-08-25" }), undefined);
    assert.equal(prunedRangeRefusal(pruned, {}), undefined, "no bounds = everything present");
  });

  it("is enforced by loadWikiDir through pruned.jsonl", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wiki-retention-"));
    try {
      const line = (ts: number) => JSON.stringify({ ts, value: 1, wiki: "w", type: "edit", namespace: 0 }) + "\n";
      writeFileSync(join(dir, "2026-09-03.jsonl"), line(Date.parse("2026-09-03T00:00:01Z")));
      assert.equal((await loadWikiDir(dir, { fromDay: "2026-09-03", toDay: "2026-09-03" })).events.length, 1);
      recordPruned(dir, ["2026-09-02"], Date.parse("2026-11-06T00:00:00Z"));
      assert.deepEqual(readPrunedDays(dir), ["2026-09-02"]);
      await assert.rejects(loadWikiDir(dir, { fromDay: "2026-09-01", toDay: "2026-09-03" }), /2026-09-02 was deleted by the retention rule/);
      assert.equal((await loadWikiDir(dir, { fromDay: "2026-09-03", toDay: "2026-09-03" })).events.length, 1, "days after it read as before");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
