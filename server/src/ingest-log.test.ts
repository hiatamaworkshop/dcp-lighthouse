import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { IngestLog, parseIngestLogPath } from "./ingest-log.js";
import { LiveBuildIngestor } from "./ingest-build.js";
import { prowEventExtractor } from "./prow-live.js";
import { describeFlakyHistory } from "./prow-persist.js";
import type { ProwBuild } from "./prow-import.js";
import { DashboardServer } from "./dashboard.js";
import { MockStreamGenerator, type TestEvent } from "./mock-stream-generator.js";
import { TestorAdapter } from "./testor-adapter.js";
import { QRegistry } from "./q-registry.js";
import { RetentionBuffer } from "./retention-buffer.js";
import { ObservationOverlay } from "./lens-view.js";
import { WindowHistory } from "./window-history.js";
import { Comparator } from "./comparison.js";
import { RuleBrain } from "./rule-brain.js";

const T0 = Date.UTC(2026, 10, 28, 9, 0, 0);

function tempLogPath(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "lh-ingest-log-"));
  return { path: join(dir, "nested", "builds.jsonl"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function jsonBuild(buildId: string, minute: number, failing: string[]) {
  const names = ["a", "b", "c"];
  return {
    job: "dcp-lighthouse",
    buildId,
    commit: `c${minute}`,
    startedMs: T0 + minute * 60_000,
    finishedMs: T0 + minute * 60_000 + 5_000,
    cases: names.map((n) => ({ name: n, classname: "suite", status: failing.includes(n) ? "failed" : "passed", durationMs: 3 })),
  };
}

const JUNIT = `<?xml version="1.0" encoding="utf-8"?>
<testsuites><testsuite name="x.test.js"><testcase name="a" classname="suite" time="0.001"/>
<testcase name="b" classname="suite" time="0.002"><failure message="boom">boom</failure></testcase></testsuite></testsuites>`;

/** The production wiring of index.ts, small: an ingestor over a buffer and overlay, behind a dashboard. */
function startServer(logPath: string, restore: boolean) {
  const registry = new QRegistry();
  registry.set("observe:test_result:v1#coarse", { window_ms: 3_600_000, align: "epoch" });
  registry.set("compare:test_result:v1", { reference: "preceding", null_model: "independent" });
  const buffer = new RetentionBuffer<TestEvent>(prowEventExtractor, { retentionWindowMs: 6 * 3_600_000 });
  const overlay = new ObservationOverlay(registry);
  overlay.add("coarse", "test_result:v1", { view: "coarse" });
  const history = new WindowHistory(buffer, { maxHistoryMs: 3_600_000 });
  const log = new IngestLog(logPath);
  const ingestor = new LiveBuildIngestor(
    (ev) => {
      const lensEv = prowEventExtractor(ev, "test_result:v1");
      if (lensEv !== null) overlay.push("test_result:v1", lensEv);
      buffer.observe(ev, "test_result:v1");
    },
    { flakyHistory: { runs: 10 }, log },
  );
  const restored = restore ? ingestor.restore(log.load().builds) : undefined;
  const dashboard = new DashboardServer(
    new MockStreamGenerator(),
    new TestorAdapter({ windowMs: 5_000 }),
    new RuleBrain(registry),
    registry,
    new Comparator({ spikeZThreshold: 2.0, includeBaseline: true }, history),
    overlay,
    buffer,
    undefined,
    undefined,
    undefined,
    undefined,
    () => ingestor.announcements(),
    describeFlakyHistory(10, "the ingested build stream"),
    ingestor,
  );
  const server = dashboard.start({ port: 0 });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const close = () => new Promise<void>((res) => server.close(() => res()));
  return { baseUrl, close, buffer, restored };
}

async function postJson(baseUrl: string, body: unknown): Promise<number> {
  const r = await fetch(`${baseUrl}/ingest/build`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  await r.text();
  return r.status;
}

async function readState(baseUrl: string) {
  const persistence = await (await fetch(`${baseUrl}/persistence`)).json();
  const status = (await (await fetch(`${baseUrl}/status`)).json()) as { ingest: unknown };
  return { persistence, ingest: status.ingest };
}

function lineCount(path: string): number {
  return readFileSync(path, "utf-8").split("\n").filter((l) => l.trim() !== "").length;
}

describe("IngestLog (ROADMAP C37)", () => {
  it("restores /persistence and the /status ingest totals exactly across a restart", async () => {
    const tmp = tempLogPath();
    try {
      const first = startServer(tmp.path, false);
      assert.equal(await postJson(first.baseUrl, jsonBuild("b1", 0, [])), 200);
      assert.equal(await postJson(first.baseUrl, jsonBuild("b2", 10, ["b"])), 200);
      assert.equal(await postJson(first.baseUrl, jsonBuild("b3", 20, ["b", "c"])), 200);
      const junit = await fetch(`${first.baseUrl}/ingest/build?job=dcp-lighthouse&buildId=b4&commit=c30&finishedMs=${T0 + 30 * 60_000}`, {
        method: "POST",
        headers: { "content-type": "application/xml" },
        body: JUNIT,
      });
      assert.equal(junit.status, 200);
      const before = await readState(first.baseUrl);
      const sizeBefore = first.buffer.size();
      await first.close();

      const announced = (before.persistence as { announcements: unknown[] }).announcements;
      assert.ok(announced.length >= 1, "two consecutive failures of b must be announced before the restart");

      const second = startServer(tmp.path, true);
      try {
        assert.deepEqual(second.restored, { builds: 4, announcements: announced.length });
        assert.deepEqual(await readState(second.baseUrl), before);
        assert.equal(second.buffer.size(), sizeBefore);
        // A build resent after the restart is still a resend.
        assert.equal(await postJson(second.baseUrl, jsonBuild("b3", 20, ["b", "c"])), 409);
      } finally {
        await second.close();
      }
    } finally {
      tmp.cleanup();
    }
  });

  it("writes only accepted builds: 400, 409 and out-of-order builds never reach the file", async () => {
    const tmp = tempLogPath();
    try {
      const s = startServer(tmp.path, false);
      try {
        assert.equal(await postJson(s.baseUrl, jsonBuild("b1", 10, [])), 200);
        assert.equal(await postJson(s.baseUrl, { job: "dcp-lighthouse", cases: "nope" }), 400);
        assert.equal(await postJson(s.baseUrl, jsonBuild("b1", 10, [])), 409);
        assert.equal(await postJson(s.baseUrl, jsonBuild("b0", 0, [])), 400); // earlier than b1
        assert.equal(lineCount(tmp.path), 1);
      } finally {
        await s.close();
      }
    } finally {
      tmp.cleanup();
    }
  });

  it("refuses a build it cannot write, with nothing applied", () => {
    const events: unknown[] = [];
    let diskFull = true;
    const written: string[] = [];
    const ingestor = new LiveBuildIngestor((ev) => events.push(ev), {
      log: {
        append: (b) => {
          if (diskFull) throw new Error("disk full");
          written.push(b.id);
        },
      },
    });
    assert.throws(() => ingestor.ingestJson(jsonBuild("b1", 0, ["a"])), /disk full/);
    assert.equal(events.length, 0);
    assert.equal(ingestor.status().builds, 0);
    // Not remembered as seen either: the same build can be sent again once the disk recovers.
    diskFull = false;
    assert.equal(ingestor.ingestJson(jsonBuild("b1", 0, ["a"])).accepted, true);
    assert.deepEqual(written, ["b1"]);
    assert.equal(events.length, 3);
  });

  it("restore neither rewrites the log nor calls onAnnouncement", () => {
    const tmp = tempLogPath();
    try {
      const log = new IngestLog(tmp.path);
      const a = new LiveBuildIngestor(() => {}, { log });
      a.ingestJson(jsonBuild("b1", 0, ["a"]));
      a.ingestJson(jsonBuild("b2", 10, ["a"]));
      const linesBefore = lineCount(tmp.path);
      let called = 0;
      const b = new LiveBuildIngestor(() => {}, { log, onAnnouncement: () => called++ });
      const r = b.restore(log.load().builds);
      assert.equal(r.builds, 2);
      assert.equal(r.announcements, a.announcements().length);
      assert.equal(called, 0);
      assert.equal(lineCount(tmp.path), linesBefore);
      assert.deepEqual(b.announcements(), a.announcements());
      assert.deepEqual(b.status(), a.status());
    } finally {
      tmp.cleanup();
    }
  });

  it("cuts off an unterminated last line and appends cleanly after it", () => {
    const tmp = tempLogPath();
    try {
      const log = new IngestLog(tmp.path);
      const a = new LiveBuildIngestor(() => {}, { log });
      a.ingestJson(jsonBuild("b1", 0, []));
      appendFileSync(tmp.path, '{"job":"dcp-lighthouse","id":"b2","sched');
      const loaded = log.load();
      assert.equal(loaded.builds.length, 1);
      assert.ok(loaded.droppedTailBytes > 0);
      const b = new LiveBuildIngestor(() => {}, { log });
      b.restore(loaded.builds);
      b.ingestJson(jsonBuild("b2", 10, []));
      const again = log.load();
      assert.deepEqual(again.builds.map((x: ProwBuild) => x.id), ["b1", "b2"]);
      assert.equal(again.droppedTailBytes, 0);
    } finally {
      tmp.cleanup();
    }
  });

  it("refuses to load a damaged line that is not the last one", () => {
    const tmp = tempLogPath();
    try {
      const log = new IngestLog(tmp.path);
      const a = new LiveBuildIngestor(() => {}, { log });
      a.ingestJson(jsonBuild("b1", 0, []));
      const good = readFileSync(tmp.path, "utf-8");
      writeFileSync(tmp.path, "{broken\n" + good);
      assert.throws(() => log.load(), /:1: unreadable line/);
      writeFileSync(tmp.path, '{"job":"x"}\n' + good);
      assert.throws(() => log.load(), /:1: not an ingested build \(id\)/);
    } finally {
      tmp.cleanup();
    }
  });

  it("treats a missing file as an empty log", () => {
    const tmp = tempLogPath();
    try {
      assert.deepEqual(new IngestLog(tmp.path).load(), { builds: [], droppedTailBytes: 0 });
    } finally {
      tmp.cleanup();
    }
  });
});

describe("parseIngestLogPath (ROADMAP C37)", () => {
  it("is off when unset or empty", () => {
    assert.equal(parseIngestLogPath(undefined, "ingest"), undefined);
    assert.equal(parseIngestLogPath("  ", "mock"), undefined);
  });
  it("reads a path with ingest and refuses it with any other source", () => {
    assert.equal(parseIngestLogPath(" ../data/ingest/builds.jsonl ", "ingest"), "../data/ingest/builds.jsonl");
    assert.throws(() => parseIngestLogPath("x.jsonl", "prow"), /only with LIGHTHOUSE_SOURCE=ingest/);
    assert.throws(() => parseIngestLogPath("x.jsonl", "mock"), /only with LIGHTHOUSE_SOURCE=ingest/);
  });
});
