import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProwImporter,
  commitOfVersion,
  daysBetween,
  loadProwRange,
  parseJunit,
  prowBuildTimeMs,
  prowDayRefusal,
  readProwDays,
  type FetchLike,
} from "./prow-import.js";

const SNOWFLAKE_EPOCH_MS = 1_288_834_974_657;
/** A build id scheduled at this instant (the inverse of prowBuildTimeMs). */
const idAt = (iso: string, seq = 0): string => ((BigInt(Date.parse(iso) - SNOWFLAKE_EPOCH_MS) << 22n) + BigInt(seq)).toString();

describe("prowBuildTimeMs", () => {
  it("reads the scheduling instant out of a real build id (2026-11-17, checked against started.json)", () => {
    // ci-kubernetes-unit 2122497153946357760: started.json said 2026-11-17T01:09:17Z, 27 s after the id's instant.
    assert.equal(new Date(prowBuildTimeMs("2122497153946357760")).toISOString(), "2026-11-17T01:08:50.248Z");
    assert.equal(prowBuildTimeMs(idAt("2026-11-01T12:00:00Z", 5)), Date.parse("2026-11-01T12:00:00Z"));
  });
});

describe("parseJunit", () => {
  it("reads Go's one-suite-per-package form: suite timestamps, statuses, escaped names", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
	<testsuite tests="2" failures="1" time="3.5" name="[sig-auth] k8s.io/api/authorization" timestamp="2026-11-17T01:23:05Z">
		<properties><property name="go.version" value="go1.27.4 linux/amd64"></property></properties>
		<testcase classname="[sig-auth] k8s.io/api/authorization" name="v1" time="1.012000"></testcase>
		<testcase classname="[sig-auth] k8s.io/api/authorization" name="Test&#34;quoted&#34; &amp; more" time="2.5">
			<failure message="Failed" type="">boom &lt;testcase name="not a case"&gt;</failure>
		</testcase>
	</testsuite>
	<testsuite tests="1" failures="0" time="1.0" name="k8s.io/api/core" timestamp="2026-11-17T01:23:06Z">
		<testcase classname="k8s.io/api/core" name="v1" time="1.0"/>
	</testsuite>
</testsuites>`;
    const suites = parseJunit(xml);
    assert.equal(suites.length, 2);
    assert.equal(suites[0]!.name, "[sig-auth] k8s.io/api/authorization");
    assert.equal(suites[0]!.ts, Date.parse("2026-11-17T01:23:05Z"));
    assert.deepEqual(suites[0]!.cases.map((c) => c.status), ["passed", "failed"]);
    assert.equal(suites[0]!.cases[1]!.name, 'Test"quoted" & more');
    assert.equal(suites[0]!.cases[1]!.time, 2.5);
    assert.deepEqual(suites[1]!.cases, [{ name: "v1", classname: "k8s.io/api/core", time: 1, status: "passed" }]);
  });

  it("reads ginkgo's e2e form: one suite, a zone-less timestamp read as UTC, skipped cases, CDATA that quotes tags", () => {
    const xml = `<testsuites tests="3" disabled="1">
  <testsuite name="Kubernetes e2e suite" tests="3" skipped="1" failures="1" timestamp="2026-11-16T05:41:29">
    <testcase name="[It] [sig-cli] Kubectl works" classname="Kubernetes e2e suite" status="passed" time="13.6"></testcase>
    <testcase name="[It] [sig-node] Pods skipped one" classname="Kubernetes e2e suite" status="skipped" time="0"><skipped message="skipped"></skipped></testcase>
    <testcase name="[It] [sig-node] Pods broke" classname="Kubernetes e2e suite" status="failed" time="60.1">
      <failure message="timed out" type="failed"><![CDATA[log: <testcase name="fake"> <skipped/> ]]></failure>
      <system-err><![CDATA[<testsuite name="fake suite">]]></system-err>
    </testcase>
  </testsuite>
</testsuites>`;
    const suites = parseJunit(xml);
    assert.equal(suites.length, 1, "a tag quoted inside CDATA opens nothing");
    assert.equal(suites[0]!.ts, Date.parse("2026-11-16T05:41:29Z"));
    assert.deepEqual(suites[0]!.cases.map((c) => [c.name, c.status]), [
      ["[It] [sig-cli] Kubectl works", "passed"],
      ["[It] [sig-node] Pods skipped one", "skipped"],
      ["[It] [sig-node] Pods broke", "failed"],
    ]);
  });

  it("counts an <error> as failed, and failure wins over skipped", () => {
    const suites = parseJunit(`<testsuite name="s"><testcase name="a"><error/></testcase><testcase name="b"><skipped/><failure/></testcase><testcase name="c"><failure/><skipped/></testcase></testsuite>`);
    assert.deepEqual(suites[0]!.cases.map((c) => c.status), ["failed", "failed", "failed"]);
    assert.equal(suites[0]!.ts, undefined);
  });
});

describe("commitOfVersion", () => {
  it("takes the hash after the + of a version string, and nothing else", () => {
    assert.equal(commitOfVersion("v1.38.0-beta.0.504+04d3cc7a37391a"), "04d3cc7a37391a");
    assert.equal(commitOfVersion("v1.38.0"), undefined);
    assert.equal(commitOfVersion("master"), undefined);
    assert.equal(commitOfVersion(undefined), undefined);
  });
});

describe("prowDayRefusal", () => {
  it("refuses a day until 12 hours after it ended", () => {
    const end = Date.parse("2026-11-16T00:00:00Z");
    assert.match(prowDayRefusal("2026-11-15", end + 11 * 3_600_000) ?? "", /not settled yet/);
    assert.equal(prowDayRefusal("2026-11-15", end + 12 * 3_600_000), undefined);
    assert.match(prowDayRefusal("15 Nov", end) ?? "", /not a UTC day/);
  });
});

/** A stand-in for the bucket: object name → body, with listings derived from the names. */
function fakeBucket(objects: Record<string, string>, failing: Set<string> = new Set()): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetchFn: FetchLike = async (url) => {
    calls.push(url);
    const u = new URL(url);
    if (u.pathname.startsWith("/storage/v1/b/")) {
      const prefix = u.searchParams.get("prefix") ?? "";
      const names = Object.keys(objects).filter((n) => n.startsWith(prefix));
      if (u.searchParams.get("delimiter") === "/") {
        const prefixes = [...new Set(names.map((n) => prefix + n.slice(prefix.length).split("/")[0] + "/"))].sort();
        return { ok: true, status: 200, text: async () => JSON.stringify({ prefixes }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ items: names.map((name) => ({ name })) }) };
    }
    const name = decodeURIComponent(u.pathname.split("/").slice(2).join("/"));
    if (failing.has(name)) return { ok: false, status: 500, text: async () => "" };
    const body = objects[name];
    return body === undefined ? { ok: false, status: 404, text: async () => "" } : { ok: true, status: 200, text: async () => body };
  };
  return { fetch: fetchFn, calls };
}

const JUNIT = `<testsuite name="pkg/a" timestamp="2026-11-01T10:05:00Z"><testcase classname="pkg/a" name="t1" time="1"/><testcase classname="pkg/a" name="t2" time="2"><failure/></testcase></testsuite>`;

function buildObjects(job: string, id: string, o: { finished?: object | null; started?: object; junit?: Record<string, string> }): Record<string, string> {
  const out: Record<string, string> = { [`logs/${job}/${id}/build-log.txt`]: "log" };
  if (o.finished !== null) out[`logs/${job}/${id}/finished.json`] = JSON.stringify(o.finished ?? { timestamp: 1_793_534_700, result: "SUCCESS" });
  if (o.started !== undefined) out[`logs/${job}/${id}/started.json`] = JSON.stringify(o.started);
  for (const [f, xml] of Object.entries(o.junit ?? {})) out[`logs/${job}/${id}/artifacts/${f}`] = xml;
  return out;
}

describe("ProwImporter", () => {
  const job = "ci-test-job";
  const now = () => Date.parse("2026-11-10T00:00:00Z");
  const old = idAt("2026-10-30T10:00:00Z");
  const a = idAt("2026-11-01T10:00:00Z");
  const b = idAt("2026-11-01T11:00:00Z");
  const c = idAt("2026-11-01T23:30:00Z");
  const next = idAt("2026-11-02T00:10:00Z");

  it("files a day's builds, keeps the published fields, and records what it could not read as missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prow-"));
    try {
      const objects = {
        ...buildObjects(job, old, { junit: { "junit_1.xml": JUNIT } }),
        ...buildObjects(job, a, {
          finished: { timestamp: Date.parse("2026-11-01T10:30:00Z") / 1000, result: "FAILURE" },
          started: { timestamp: Date.parse("2026-11-01T10:00:30Z") / 1000, "repo-commit": "abc123" },
          junit: { "junit_1.xml": JUNIT, "junit_runner.xml": `<testsuite name="r"><testcase classname="e2e.go" name="Up" time="3"/></testsuite>`, "notes.txt": "x" },
        }),
        ...buildObjects(job, b, { finished: { timestamp: Date.parse("2026-11-01T11:20:00Z") / 1000, result: "SUCCESS", metadata: { revision: "v1.38.0-beta.0.504+04d3cc7a37391a" } }, junit: {} }),
        ...buildObjects(job, c, { finished: null, junit: { "junit_1.xml": JUNIT } }),
        ...buildObjects(job, next, { junit: { "junit_1.xml": JUNIT } }),
      };
      const importer = new ProwImporter({ dir, fetch: fakeBucket(objects).fetch, now, retries: 0 });
      const entry = await importer.importDay(job, "2026-11-01");
      assert.equal(entry.builds, 2);
      assert.deepEqual(entry.missing.map((m) => [m.id, /no finished\.json/.test(m.reason)]), [[c, true]]);

      const range = loadProwRange(dir, job, "2026-11-01", "2026-11-01");
      assert.deepEqual(range.builds.map((x) => x.id), [a, b], "only the day's own builds, oldest first");
      assert.equal(range.missing.length, 1);
      const first = range.builds[0]!;
      assert.equal(first.result, "FAILURE");
      assert.equal(first.commit, "abc123");
      assert.equal(first.startedMs, Date.parse("2026-11-01T10:00:30Z"));
      assert.equal(first.scheduledMs, Date.parse("2026-11-01T10:00:00Z"));
      assert.deepEqual(first.files.map((f) => f.file), ["artifacts/junit_1.xml", "artifacts/junit_runner.xml"], "junit files only");
      assert.deepEqual(first.files[0]!.suites[0]!.cases.map((x) => x.status), ["passed", "failed"]);
      const second = range.builds[1]!;
      assert.equal(second.commit, "04d3cc7a37391a", "the e2e form: commit from finished.json's version");
      assert.equal(second.startedMs, undefined);
      assert.deepEqual(second.files, []);

      // A second import of the same day is a no-op unless forced.
      const again = await importer.importDay(job, "2026-11-01");
      assert.equal(again.skipped, true);
      assert.equal(readProwDays(dir, job).size, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a build whose fetch fails is missing (blind), not absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prow-"));
    try {
      const objects = { ...buildObjects(job, old, {}), ...buildObjects(job, a, { junit: { "junit_1.xml": JUNIT } }) };
      const failing = new Set([`logs/${job}/${a}/artifacts/junit_1.xml`]);
      const importer = new ProwImporter({ dir, fetch: fakeBucket(objects, failing).fetch, now, retries: 0 });
      const entry = await importer.importDay(job, "2026-11-01");
      assert.equal(entry.builds, 0);
      assert.match(entry.missing[0]!.reason, /fetch failed: .*HTTP 500/);
      const range = loadProwRange(dir, job, "2026-11-01", "2026-11-01");
      assert.equal(range.builds.length, 0);
      assert.equal(range.missing.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a day that is not settled, and a day older than what the bucket still lists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prow-"));
    try {
      const objects = { ...buildObjects(job, a, { junit: { "junit_1.xml": JUNIT } }) };
      const importer = new ProwImporter({ dir, fetch: fakeBucket(objects).fetch, now, retries: 0 });
      await assert.rejects(importer.importDay(job, "2026-11-09"), /not settled yet/);
      await assert.rejects(importer.importDay(job, "2026-11-01"), /before the oldest build the bucket still lists/, "the day's first hours may already have rolled off");
      await assert.rejects(importer.importDay(job, "2026-10-20"), /before the oldest build/);
      await assert.rejects(new ProwImporter({ dir, fetch: fakeBucket({}).fetch, now, retries: 0 }).importDay("nope", "2026-11-01"), /lists no builds/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("loadProwRange", () => {
  const job = "ci-test-job";
  const now = () => Date.parse("2026-11-10T00:00:00Z");

  it("refuses a range holding a day that was never imported, or whose file is gone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prow-"));
    try {
      const objects = {
        ...buildObjects(job, idAt("2026-10-30T10:00:00Z"), {}),
        ...buildObjects(job, idAt("2026-11-01T10:00:00Z"), { junit: { "junit_1.xml": JUNIT } }),
        ...buildObjects(job, idAt("2026-11-03T10:00:00Z"), { junit: { "junit_1.xml": JUNIT } }),
      };
      const importer = new ProwImporter({ dir, fetch: fakeBucket(objects).fetch, now, retries: 0 });
      await importer.importDay(job, "2026-11-01");
      await importer.importDay(job, "2026-11-03");
      assert.throws(() => loadProwRange(dir, job, "2026-11-01", "2026-11-03"), /no import record for 1 day\(s\).*2026-11-02.*would read as a day without tests/);
      assert.throws(() => loadProwRange(dir, "other-job", "2026-11-01", "2026-11-01"), /no import record/);
      // A day on which no build was scheduled is a real, imported, empty day.
      const empty = await importer.importDay(job, "2026-11-02");
      assert.equal(empty.builds, 0);
      assert.equal(loadProwRange(dir, job, "2026-11-01", "2026-11-03").builds.length, 2);
      unlinkSync(join(dir, job, "2026-11-03.jsonl.gz"));
      assert.throws(() => loadProwRange(dir, job, "2026-11-01", "2026-11-03"), /its file is gone/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("daysBetween", () => {
  it("lists whole UTC days inclusive, across a month end", () => {
    assert.deepEqual(daysBetween("2026-10-30", "2026-11-02"), ["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
    assert.throws(() => daysBetween("2026-11-02", "2026-11-01"), /bad day range/);
  });
});
