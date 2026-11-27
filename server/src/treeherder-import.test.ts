import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { FetchLike } from "./prow-import.js";
import {
  BACKOUT_MESSAGE,
  TreeherderImporter,
  fixedByOfNotes,
  jobRow,
  loadTreeherderRange,
  pushRow,
  readTreeherderDays,
  treeherderDayRefusal,
} from "./treeherder-import.js";

const DAY = "2026-11-10";
const T0 = Date.parse(`${DAY}T00:00:00Z`) / 1000;
const SETTLED = Date.parse("2026-11-20T00:00:00Z");
const EMAIL = "someone@example.org";

function rawJob(id: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, job_type_name: `test-linux2404-64/opt-mochitest-${id}`, job_group_symbol: "M", platform: "linux2404-64", platform_option: "opt",
    tier: 1, result: "success", state: "completed", failure_classification_id: 1,
    submit_timestamp: T0 + 100, start_timestamp: T0 + 200, end_timestamp: T0 + 900,
    who: EMAIL, machine_name: "m-1", task_id: "t", ...over,
  };
}

/** A fake API: pushes, jobs per push, notes per job; `failJobsOf` makes a push's job list fail. */
function fakeApi(opts: { pushes: Array<Record<string, unknown>>; jobs: Record<number, Array<Record<string, unknown>>>; notes?: Record<number, unknown[]>; failJobsOf?: number }): { fetch: FetchLike; urls: string[] } {
  const urls: string[] = [];
  const ok = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
  const fetch: FetchLike = async (url) => {
    urls.push(url);
    const u = new URL(url);
    if (u.pathname.endsWith("/push/")) return ok({ results: opts.pushes });
    if (u.pathname.endsWith("/jobs/")) {
      const pid = Number(u.searchParams.get("push_id"));
      if (pid === opts.failJobsOf) return { ok: false, status: 503, text: async () => "" };
      return ok({ results: opts.jobs[pid] ?? [] });
    }
    if (u.pathname.endsWith("/note/")) return ok(opts.notes?.[Number(u.searchParams.get("job_id"))] ?? []);
    return { ok: false, status: 404, text: async () => "" };
  };
  return { fetch, urls };
}

describe("treeherder-import: what is kept", () => {
  it("drops the e-mail fields and the machine from a job", () => {
    const j = jobRow(rawJob(7));
    assert.equal(JSON.stringify(j).includes("@"), false);
    assert.equal("who" in j, false);
    assert.equal(j.job_type_name, "test-linux2404-64/opt-mochitest-7");
  });

  it("keeps only a backout flag from a push's commits (both the old and the git-era spelling)", () => {
    const p = pushRow({ id: 1, revision: "abc", push_timestamp: T0, revision_count: 2, revisions: [{ comments: "Bug 1 - thing r=x" }, { comments: 'Revert "Bug 2 - y" for causing failures' }] } as never);
    assert.deepEqual(p, { id: 1, revision: "abc", push_timestamp: T0, revision_count: 2, backout: true });
    assert.ok(BACKOUT_MESSAGE.test("Backed out changeset 1234 (bug 5) for bustage"));
    assert.equal(BACKOUT_MESSAGE.test("Bug 9 - Reverting the frobnicator is not a backout"), false);
  });

  it("reads the fixing revision from the latest fixed-by-commit note, and nothing from other notes", () => {
    assert.equal(fixedByOfNotes([{ id: 1, failure_classification_id: 2, text: "D71FD29F5E9F6918D6F0A0B42A736A795BDBAE8C" }]), "d71fd29f5e9f6918d6f0a0b42a736a795bdbae8c");
    assert.equal(fixedByOfNotes([{ id: 1, failure_classification_id: 2, text: "aaaaaaaaaaaa" }, { id: 2, failure_classification_id: 2, text: "https://hg.mozilla.org/integration/autoland/rev/bbbbbbbbbbbb" }]), "bbbbbbbbbbbb");
    assert.equal(fixedByOfNotes([{ id: 1, failure_classification_id: 4, text: "cccccccccccc" }]), "");
    assert.equal(fixedByOfNotes([{ id: 1, failure_classification_id: 2, text: "backed out, see bug" }]), "");
  });

  it("refuses a day until its classifications have settled (3 days after it ends)", () => {
    assert.match(treeherderDayRefusal(DAY, Date.parse("2026-11-13T23:59:59Z"))!, /not settled/);
    assert.equal(treeherderDayRefusal(DAY, Date.parse("2026-11-14T00:00:00Z")), undefined);
    assert.match(treeherderDayRefusal("2026-13-01", SETTLED)!, /not a UTC day/);
  });
});

describe("TreeherderImporter", () => {
  it("stores tier-1 jobs with fixing revisions, records an unreadable push as missing, and reads the day back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "th-"));
    try {
      const pushes = [
        { id: 11, revision: "r11", push_timestamp: T0 + 60, revision_count: 1, author: EMAIL, revisions: [{ author: EMAIL, comments: "Bug 1" }] },
        { id: 12, revision: "r12", push_timestamp: T0 + 120, revision_count: 1, author: EMAIL, revisions: [{ author: EMAIL, comments: "Bug 2" }] },
        { id: 13, revision: "r13", push_timestamp: T0 + 180, revision_count: 1, author: EMAIL, revisions: [{ author: EMAIL, comments: 'Revert "Bug 1"' }] },
      ];
      const { fetch } = fakeApi({
        pushes,
        jobs: { 11: [rawJob(1), rawJob(2, { tier: 2 }), rawJob(3, { result: "testfailed", failure_classification_id: 2 })], 13: [rawJob(4)] },
        notes: { 3: [{ id: 9, failure_classification_id: 2, text: "13ab13ab13ab", who: EMAIL }] },
        failJobsOf: 12,
      });
      const imp = new TreeherderImporter({ dir, fetch, now: () => SETTLED, retries: 1, backoffMs: 1 });
      const e = await imp.importDay(DAY);
      assert.equal(e.pushes, 2);
      assert.equal(e.jobs, 3);
      assert.deepEqual(e.missing.map((m) => m.id), [12]);
      const raw = gunzipSync(readFileSync(join(dir, `${DAY}.jsonl.gz`))).toString();
      assert.equal(raw.includes("@"), false, "no e-mail address is written");
      assert.equal(readFileSync(join(dir, "days.jsonl"), "utf8").includes("@"), false);
      const r = loadTreeherderRange(dir, DAY, DAY);
      assert.deepEqual(r.pushes.map((p) => [p.id, p.backout, p.jobs.map((j) => j.id)]), [[11, false, [1, 3]], [13, true, [4]]]);
      assert.equal(r.pushes[0]!.jobs[1]!.fixedBy, "13ab13ab13ab");
      assert.equal(r.pushes[0]!.jobs[0]!.fixedBy, undefined);
      assert.deepEqual(r.missing.map((m) => m.id), [12]);
      // A second run skips the recorded day.
      assert.equal((await imp.importDay(DAY)).skipped, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a day whose push list reaches the cap, and a range holding an unimported or vanished day", async () => {
    const dir = mkdtempSync(join(tmpdir(), "th-"));
    try {
      const many = Array.from({ length: 1000 }, (_, i) => ({ id: i + 1, revision: `r${i}`, push_timestamp: T0 + i, revision_count: 1 }));
      const capped = new TreeherderImporter({ dir, fetch: fakeApi({ pushes: many, jobs: {} }).fetch, now: () => SETTLED });
      await assert.rejects(capped.importDay(DAY), /cap/);
      assert.equal(readTreeherderDays(dir).size, 0);

      const imp = new TreeherderImporter({ dir, fetch: fakeApi({ pushes: [], jobs: {} }).fetch, now: () => SETTLED });
      await imp.importDay(DAY);
      assert.throws(() => loadTreeherderRange(dir, DAY, "2026-11-11"), /no import record for 1 day/);
      unlinkSync(join(dir, `${DAY}.jsonl.gz`));
      assert.throws(() => loadTreeherderRange(dir, DAY, DAY), /file is gone/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
