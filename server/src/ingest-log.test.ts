import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { IngestLog, foldCount, parseIngestLogKeepHours, parseIngestLogPath, restoreFromLog } from "./ingest-log.js";
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
function startServer(logPath: string, restore: boolean, keepMs?: number) {
  const registry = new QRegistry();
  registry.set("observe:test_result:v1#coarse", { window_ms: 3_600_000, align: "epoch" });
  registry.set("compare:test_result:v1", { reference: "preceding", null_model: "independent" });
  const buffer = new RetentionBuffer<TestEvent>(prowEventExtractor, { retentionWindowMs: RETENTION_MS });
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
  const restored = restore ? restoreFromLog(log, ingestor, keepMs) : undefined;
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
  return { baseUrl, close, buffer, restored, ingestor };
}

const RETENTION_MS = 6 * 3_600_000;

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
        assert.deepEqual(second.restored, { droppedTailBytes: 0, checkpointBuilds: 0, replayedBuilds: 4, folded: 0 });
        assert.equal(second.ingestor.announcements().length, announced.length);
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

describe("Folding the ingest log (ROADMAP C38)", () => {
  // Hourly builds h0…h12. b fails from h1 to the end and c now and then, so the 6-hour cut
  // (h0…h5 folded) falls inside b's run.
  const hourly = (h: number) => jsonBuild(`h${h}`, h * 60, h === 0 ? [] : h % 4 === 2 ? ["b", "c"] : ["b"]);

  async function fill(logPath: string) {
    const s = startServer(logPath, false);
    for (let h = 0; h <= 12; h++) assert.equal(await postJson(s.baseUrl, hourly(h)), 200);
    const state = await readState(s.baseUrl);
    const size = s.buffer.size();
    await s.close();
    return { state, size };
  }

  it("keeps /persistence, /status and the buffer across restarts, and never announces a run twice", async () => {
    const tmp = tempLogPath();
    try {
      const before = await fill(tmp.path);
      const announced = (before.state.persistence as { announcements: Array<{ testId: string; firstBuildId: string }> }).announcements;
      assert.deepEqual(announced.map((a) => a.firstBuildId), ["h1"]);

      // What dropping the old lines would do: b's run starts again at the cut and is announced again.
      const all = new IngestLog(tmp.path).load().builds;
      assert.equal(foldCount(all, RETENTION_MS).count, 6);
      const naive = new LiveBuildIngestor(() => {}, { flakyHistory: { runs: 10 } });
      naive.restore(all.slice(6));
      assert.deepEqual(naive.announcements().map((a) => a.firstBuildId), ["h6"]);

      const second = startServer(tmp.path, true, RETENTION_MS);
      try {
        assert.deepEqual(second.restored, { droppedTailBytes: 0, checkpointBuilds: 0, replayedBuilds: 13, folded: 6 });
        assert.deepEqual(await readState(second.baseUrl), before.state);
        assert.equal(second.buffer.size(), before.size);
      } finally {
        await second.close();
      }
      const lines = readFileSync(tmp.path, "utf-8").split("\n").filter((l) => l !== "");
      assert.equal(lines.length, 1 + 7);
      assert.ok(lines[0]!.startsWith('{"$checkpoint":'));
      assert.deepEqual(new IngestLog(tmp.path).load().checkpoint?.foldedBuilds, 6);

      const third = startServer(tmp.path, true, RETENTION_MS);
      try {
        assert.deepEqual(third.restored, { droppedTailBytes: 0, checkpointBuilds: 6, replayedBuilds: 7, folded: 0 });
        assert.deepEqual(await readState(third.baseUrl), before.state);
        assert.equal(third.buffer.size(), before.size);
        // A folded build is still a resend, and b's run goes on without a second announcement.
        assert.equal(await postJson(third.baseUrl, hourly(2)), 409);
        assert.equal(await postJson(third.baseUrl, hourly(13)), 200);
        const after = (await readState(third.baseUrl)).persistence as { announcements: unknown[] };
        assert.deepEqual(after.announcements, announced);
        assert.equal(lineCount(tmp.path), 1 + 8);
      } finally {
        await third.close();
      }
    } finally {
      tmp.cleanup();
    }
  });

  it("keeps the log whole when the fold cannot be written, and the boot goes on", async () => {
    const tmp = tempLogPath();
    try {
      const before = await fill(tmp.path);
      mkdirSync(`${tmp.path}.tmp`); // the sibling file cannot be opened
      const s = startServer(tmp.path, true, RETENTION_MS);
      try {
        assert.equal(s.restored?.folded, 0);
        assert.ok(s.restored?.foldError !== undefined);
        assert.deepEqual(await readState(s.baseUrl), before.state);
        assert.equal(lineCount(tmp.path), 13);
      } finally {
        await s.close();
      }
    } finally {
      tmp.cleanup();
    }
  });

  it("refuses a checkpoint made with another flaky history, and a checkpoint below the first line", async () => {
    const tmp = tempLogPath();
    try {
      await fill(tmp.path);
      const log = new IngestLog(tmp.path);
      restoreFromLog(log, new LiveBuildIngestor(() => {}, { flakyHistory: { runs: 10 } }), RETENTION_MS);
      assert.throws(() => restoreFromLog(log, new LiveBuildIngestor(() => {})), /LIGHTHOUSE_PERSIST_HISTORY must match/);
      const [cp, ...rest] = readFileSync(tmp.path, "utf-8").split("\n").filter((l) => l !== "");
      writeFileSync(tmp.path, [rest[0], cp, ...rest.slice(1)].join("\n") + "\n");
      assert.throws(() => log.load(), /:2: a checkpoint is only ever the first line/);
    } finally {
      tmp.cleanup();
    }
  });

  it("folds nothing without KEEP_HOURS, and nothing newer than the cut", () => {
    const tmp = tempLogPath();
    try {
      const log = new IngestLog(tmp.path);
      const a = new LiveBuildIngestor(() => {}, { log });
      for (let h = 0; h <= 12; h++) a.ingestJson(hourly(h));
      assert.equal(restoreFromLog(log, new LiveBuildIngestor(() => {})).folded, 0);
      assert.equal(restoreFromLog(log, new LiveBuildIngestor(() => {}), 24 * 3_600_000).folded, 0);
      assert.equal(lineCount(tmp.path), 13);
    } finally {
      tmp.cleanup();
    }
  });
});

describe("parseIngestLogKeepHours (ROADMAP C38)", () => {
  const RET = 34 * 3_600_000;
  it("is off when unset or empty", () => {
    assert.equal(parseIngestLogKeepHours(undefined, "x.jsonl", RET), undefined);
    assert.equal(parseIngestLogKeepHours(" ", undefined, RET), undefined);
  });
  it("reads whole hours at or above the retention", () => {
    assert.equal(parseIngestLogKeepHours("34", "x.jsonl", RET), RET);
    assert.equal(parseIngestLogKeepHours(" 168 ", "x.jsonl", RET), 168 * 3_600_000);
  });
  it("refuses it without a log, a non-integer, and below the retention", () => {
    assert.throws(() => parseIngestLogKeepHours("48", undefined, RET), /LIGHTHOUSE_INGEST_LOG, which is unset/);
    assert.throws(() => parseIngestLogKeepHours("1.5", "x.jsonl", RET), /positive integer/);
    assert.throws(() => parseIngestLogKeepHours("0", "x.jsonl", RET), /positive integer/);
    assert.throws(() => parseIngestLogKeepHours("33", "x.jsonl", RET), /shorter than the retention/);
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
