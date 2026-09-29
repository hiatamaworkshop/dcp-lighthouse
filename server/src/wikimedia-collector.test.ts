import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  GapTracker,
  SseParser,
  WikimediaCollector,
  toRecord,
  utcDay,
  type WikiRecord,
} from "./wikimedia-collector.js";

const T0 = Date.parse("2026-10-01T00:00:00.000Z");

const raw = (over: Record<string, unknown> = {}, id = "e1", offsetMs = 0) => ({
  meta: { id, dt: new Date(T0 + offsetMs).toISOString() },
  bot: false,
  wiki: "enwiki",
  type: "edit",
  namespace: 0,
  // Fields that must never reach disk:
  user: "SomeEditor",
  title: "Some page",
  comment: "a comment",
  ...over,
});

const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "wiki-collector-"));
}

describe("toRecord", () => {
  it("maps bot→1 / human→0 and keeps only the v1 fields (no user, title, comment)", () => {
    const rec = toRecord(raw({ bot: true }, "abc", 500))!;
    assert.deepEqual(rec, {
      ts: T0 + 500,
      value: 1,
      wiki: "enwiki",
      type: "edit",
      namespace: 0,
      eid: "abc",
    });
    assert.equal(toRecord(raw({ bot: false }))!.value, 0);
  });

  it("rejects payloads it cannot assign a value or time to, rather than guessing", () => {
    assert.equal(toRecord(null), null);
    assert.equal(toRecord(raw({ bot: undefined })), null, "no bot flag → no value");
    assert.equal(toRecord(raw({ meta: { id: "x", dt: "garbage" } })), null);
    assert.equal(toRecord(raw({ meta: { dt: new Date(T0).toISOString() } })), null, "no eid");
  });

  it("falls back to `timestamp` (seconds) when meta.dt is unusable", () => {
    const rec = toRecord(raw({ meta: { id: "x", dt: "garbage" }, timestamp: 1_800_000_000 }))!;
    assert.equal(rec.ts, 1_800_000_000_000);
  });
});

describe("SseParser", () => {
  it("assembles events across arbitrary chunk boundaries and ignores comments", () => {
    const p = new SseParser();
    const text = ":ok\n\nevent: message\ndata: {\"a\":1}\n\ndata: one\ndata: two\n\n";
    const out: string[] = [];
    for (const ch of text) out.push(...p.push(ch)); // one character at a time
    assert.deepEqual(out, ['{"a":1}', "one\ntwo"]);
  });

  it("handles CRLF line endings split between chunks", () => {
    const p = new SseParser();
    assert.deepEqual([...p.push("data: x\r"), ...p.push("\n\r"), ...p.push("\n")], ["x"]);
  });
});

describe("GapTracker", () => {
  it("flags a hole wider than the tolerance, measured from the running maximum", () => {
    const g = new GapTracker(10_000);
    assert.equal(g.observe(1_000), null);
    assert.equal(g.observe(5_000), null);
    // an out-of-order straggler is not a hole and must not lower the reference
    assert.equal(g.observe(2_000), null);
    assert.deepEqual(g.observe(20_000), { kind: "gap", fromTs: 5_000, toTs: 20_000 });
    assert.equal(g.observe(21_000), null);
  });

  it("a seeded reference makes the first event after a restart reveal the downtime", () => {
    const g = new GapTracker(10_000);
    g.seed(1_000);
    assert.deepEqual(g.observe(100_000), { kind: "gap", fromTs: 1_000, toTs: 100_000 });
  });
});

/** A fetch that serves the given bodies, one per connection, then hangs until aborted. */
function fakeFetch(bodies: string[], urls: string[] = []): typeof fetch {
  let i = 0;
  return (async (url: string | URL | Request, init?: RequestInit) => {
    urls.push(String(url));
    const body = bodies[i++];
    const signal = init?.signal;
    if (body === undefined) {
      await new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    }
    const enc = new TextEncoder();
    return new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(enc.encode(body));
          c.close();
        },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
}

async function runUntilIdle(c: WikimediaCollector, ms = 60): Promise<void> {
  const ac = new AbortController();
  const done = c.run(ac.signal);
  await new Promise((r) => setTimeout(r, ms));
  ac.abort();
  await done;
}

const lines = (path: string): WikiRecord[] =>
  readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as WikiRecord);

describe("WikimediaCollector", () => {
  it("writes v1 records only, drops duplicates and malformed payloads, and counts both", async () => {
    const dir = tmp();
    try {
      const now = () => T0;
      const body =
        sse(raw({}, "a", 0)) + sse(raw({ bot: true }, "b", 1_000)) + sse(raw({}, "a", 0)) + "data: not json\n\n";
      const c = new WikimediaCollector({
        dir, now, log: () => {}, backoffMinMs: 5, backoffMaxMs: 5,
        fetchFn: fakeFetch([body]),
      });
      await runUntilIdle(c);
      const recs = lines(join(dir, `${utcDay(T0)}.jsonl`));
      assert.deepEqual(recs.map((r) => r.eid), ["a", "b"]);
      assert.deepEqual(Object.keys(recs[0]).sort(), ["eid", "namespace", "ts", "type", "value", "wiki"]);
      assert.equal(c.stats.duplicates, 1);
      assert.equal(c.stats.malformed, 1);
      assert.ok(!readFileSync(join(dir, `${utcDay(T0)}.jsonl`), "utf8").includes("SomeEditor"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records a hole in event time to gaps.jsonl — a silent stretch is blindness, not quiet", async () => {
    const dir = tmp();
    try {
      const body = sse(raw({}, "a", 0)) + sse(raw({}, "b", 30_000));
      const c = new WikimediaCollector({
        dir, now: () => T0, log: () => {}, gapToleranceMs: 10_000,
        backoffMinMs: 5, backoffMaxMs: 5, fetchFn: fakeFetch([body]),
      });
      await runUntilIdle(c);
      const gaps = lines(join(dir, "gaps.jsonl")) as unknown as { fromTs: number; toTs: number }[];
      assert.deepEqual(gaps, [{ kind: "gap", fromTs: T0, toTs: T0 + 30_000 }] as never);
      assert.equal(c.stats.gaps, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resubscribes with `since` (minus the overlap) and de-duplicates the overlap", async () => {
    const dir = tmp();
    try {
      const urls: string[] = [];
      const first = sse(raw({}, "a", 0)) + sse(raw({}, "b", 2_000));
      // the reconnect replays "b" (inside the overlap) and then a fresh event
      const second = sse(raw({}, "b", 2_000)) + sse(raw({}, "c", 3_000));
      const c = new WikimediaCollector({
        dir, now: () => T0, log: () => {}, sinceOverlapMs: 1_000,
        backoffMinMs: 5, backoffMaxMs: 5, fetchFn: fakeFetch([first, second], urls),
      });
      await runUntilIdle(c, 120);
      assert.equal(urls[0].includes("since="), false, "first connect has nothing to resume from");
      assert.equal(urls[1], `https://stream.wikimedia.org/v2/stream/recentchange?since=${new Date(T0 + 1_000).toISOString()}`);
      assert.deepEqual(lines(join(dir, `${utcDay(T0)}.jsonl`)).map((r) => r.eid), ["a", "b", "c"]);
      assert.equal(c.stats.duplicates, 1);
      assert.equal(c.stats.gaps, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a restarted process restores its dedup ring and gap reference from the day file", async () => {
    const dir = tmp();
    try {
      const day = utcDay(T0);
      const rec = (eid: string, off: number): WikiRecord =>
        ({ ts: T0 + off, value: 0, wiki: "enwiki", type: "edit", namespace: 0, eid });
      writeFileSync(join(dir, `${day}.jsonl`), JSON.stringify(rec("a", 0)) + "\n" + JSON.stringify(rec("b", 1_000)) + "\n{torn");
      const urls: string[] = [];
      const c = new WikimediaCollector({
        dir, now: () => T0, log: () => {}, gapToleranceMs: 10_000, sinceOverlapMs: 0,
        backoffMinMs: 5, backoffMaxMs: 5,
        fetchFn: fakeFetch([sse(raw({}, "b", 1_000)) + sse(raw({}, "c", 60_000))], urls),
      });
      await runUntilIdle(c);
      assert.ok(urls[0].includes(`since=${new Date(T0 + 1_000).toISOString()}`), "resumes from the restored maximum");
      assert.equal(c.stats.duplicates, 1, "b was already on disk");
      assert.equal(c.stats.gaps, 1, "the downtime is reported, not read as quiet");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rolls the day file over to gzip when the UTC day changes", async () => {
    const dir = tmp();
    try {
      let clock = T0;
      const c = new WikimediaCollector({ dir, now: () => clock, log: () => {} });
      c.ingest(JSON.stringify(raw({}, "a", 0)));
      clock = T0 + 24 * 3600_000;
      c.ingest(JSON.stringify(raw({}, "b", 24 * 3600_000)));
      await c.close();
      // (the 24h jump between the two events is itself a gap, so gaps.jsonl exists)
      const files = readdirSync(dir).filter((f) => f !== "gaps.jsonl").sort();
      assert.deepEqual(files, [`${utcDay(T0)}.jsonl.gz`, `${utcDay(T0 + 24 * 3600_000)}.jsonl`]);
      assert.ok(gunzipSync(readFileSync(join(dir, files[0]))).toString().includes('"eid":"a"'));
      assert.equal(existsSync(join(dir, `${utcDay(T0)}.jsonl`)), false, "raw file removed after gzip");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drops a connection that goes silent past the watchdog and reconnects", async () => {
    const dir = tmp();
    try {
      let calls = 0;
      const hang: typeof fetch = (async (_u: string | URL | Request, init?: RequestInit) => {
        calls++;
        return new Response(
          new ReadableStream({
            start(c) {
              init?.signal?.addEventListener("abort", () => c.error(new Error("aborted")));
            },
          }),
          { status: 200 },
        );
      }) as typeof fetch;
      const c = new WikimediaCollector({
        dir, log: () => {}, watchdogMs: 30, backoffMinMs: 5, backoffMaxMs: 5, fetchFn: hang,
      });
      await runUntilIdle(c, 250);
      assert.ok(calls >= 2, `expected a reconnect, saw ${calls} connection(s)`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
