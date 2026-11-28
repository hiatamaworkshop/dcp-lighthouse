import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The sender of ROADMAP C37, run as a user runs it (`server/scripts/lighthouse-test.mjs`). */
const SCRIPT = fileURLToPath(new URL("../scripts/lighthouse-test.mjs", import.meta.url));

function fixture(failing: boolean): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "lh-sender-"));
  writeFileSync(
    join(dir, "x.test.mjs"),
    `import { it } from "node:test";\nimport assert from "node:assert";\n` +
      `it("passes", () => {});\nit("may fail", () => { assert.equal(1, ${failing ? 2 : 1}); });\n`,
  );
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function runSender(dir: string, url: string | undefined, extraNodeArgs: string[] = []): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const env = { ...process.env };
  // This file runs under `node --test`, which marks its children; a nested runner that sees the mark reports to it.
  delete env.NODE_TEST_CONTEXT;
  delete env.LIGHTHOUSE_INGEST_URL;
  if (url !== undefined) env.LIGHTHOUSE_INGEST_URL = url;
  return new Promise((done) => {
    const child = spawn(process.execPath, [SCRIPT, "--job", "fixture", "--cwd", dir, "--", ...extraNodeArgs, "--test", "x.test.mjs"], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("exit", (code) => done({ code, stdout, stderr }));
  });
}

async function withReceiver<T>(status: number, fn: (url: string, got: Array<{ url: string; type: string; body: string }>) => Promise<T>): Promise<T> {
  const got: Array<{ url: string; type: string; body: string }> = [];
  const server = createServer((req: IncomingMessage, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      got.push({ url: req.url ?? "", type: String(req.headers["content-type"]), body });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(status === 200 ? JSON.stringify({ accepted: true, events: 2, failed: 1, announcements: [] }) : JSON.stringify({ error: "refused" }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, got);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

describe("scripts/lighthouse-test.mjs (ROADMAP C37)", () => {
  it("without LIGHTHOUSE_INGEST_URL runs the tests only and keeps their exit code", async () => {
    const f = fixture(true);
    try {
      const r = await runSender(f.dir, undefined);
      assert.equal(r.code, 1);
      assert.doesNotMatch(r.stderr, /\[lighthouse\]/);
    } finally {
      f.cleanup();
    }
  });

  it("sends one JUnit build with job, buildId and times, and keeps a failing run's exit code", async () => {
    const f = fixture(true);
    try {
      await withReceiver(200, async (url, got) => {
        const r = await runSender(f.dir, url);
        assert.equal(r.code, 1);
        assert.match(r.stdout, /may fail/, "the spec reporter still prints to stdout");
        assert.equal(got.length, 1);
        const q = new URL(got[0]!.url, "http://x").searchParams;
        assert.equal(new URL(got[0]!.url, "http://x").pathname, "/ingest/build");
        assert.equal(q.get("job"), "fixture");
        assert.ok(q.get("buildId"));
        assert.ok(Number(q.get("finishedMs")) >= Number(q.get("startedMs")));
        assert.equal(got[0]!.type, "application/xml");
        assert.match(got[0]!.body, /<testcase[^>]*name="may fail"/);
        assert.match(r.stderr, /\[lighthouse\] sent fixture build/);
      });
    } finally {
      f.cleanup();
    }
  });

  it("a refused or unreachable server costs a warning, never the exit code", async () => {
    const f = fixture(false);
    try {
      await withReceiver(409, async (url) => {
        const r = await runSender(f.dir, url);
        assert.equal(r.code, 0);
        assert.match(r.stderr, /not sent to .*HTTP 409/);
      });
      const down = await runSender(f.dir, "http://127.0.0.1:9");
      assert.equal(down.code, 0);
      assert.match(down.stderr, /not sent to http:\/\/127\.0\.0\.1:9/);
    } finally {
      f.cleanup();
    }
  });

  it("formatCommit fails closed (undefined) when git diff is unavailable instead of returning clean HEAD", async () => {
    const { formatCommit } = (await import(new URL("../scripts/lighthouse-test.mjs", import.meta.url).href)) as {
      formatCommit: (head: string | undefined, diff: Buffer | undefined) => string | undefined;
    };
    const head = "0123456789abcdef0123456789abcdef01234567";
    assert.equal(formatCommit(head, Buffer.alloc(0)), head);
    assert.equal(formatCommit(head, undefined), undefined, "unreadable diff must not masquerade as clean HEAD");
    const dirty = formatCommit(head, Buffer.from("diff --git a/x b/x\n"));
    assert.match(dirty ?? "", new RegExp(`^${head}\\+dirty\\.[0-9a-f]{12}$`));
    assert.equal(formatCommit(undefined, Buffer.alloc(0)), undefined);
  });

  it("does not send an interrupted test run (Ctrl+C / signal exit)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lh-sender-abort-"));
    writeFileSync(
      join(dir, "x.test.mjs"),
      `import { it } from "node:test";\nit("passes first", () => {});\nit("aborts", () => { process.exit(0xc000013a); });\n`,
    );
    try {
      await withReceiver(200, async (url, got) => {
        // --test-isolation=none runs the test in the node --test process itself so process.exit simulates Ctrl+C on the runner.
        const r = await runSender(dir, url, ["--test-isolation=none"]);
        assert.notEqual(r.code, 0);
        assert.equal(got.length, 0, "aborted run must not be posted to /ingest/build");
        assert.match(r.stderr, /not sent: test run terminated by SIGINT/);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
