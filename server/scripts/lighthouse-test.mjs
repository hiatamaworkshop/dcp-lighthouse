#!/usr/bin/env node
/**
 * Runs `node --test` and sends the result to a lighthouse server as one build (ROADMAP C37).
 *
 *   node scripts/lighthouse-test.mjs [--job NAME] [--cwd DIR] -- <node arguments, including --test>
 *
 * With LIGHTHOUSE_INGEST_URL unset it runs `node <arguments>` and nothing else: same output, same exit
 * code. With it set (e.g. http://localhost:3001), it adds a JUnit reporter beside the spec reporter,
 * then POSTs the JUnit file to `<url>/ingest/build` as job NAME (default: the git top-level folder's
 * name), a unique buildId and the commit under test. The send never changes the exit code: a server
 * that is down or refuses the build costs one warning line on stderr.
 *
 * The commit: HEAD for a clean tree. For a dirty tree, HEAD plus a hash of `git diff HEAD`, because the
 * persistence detector reads "this test passed on this commit" as flakiness — two runs over different
 * uncommitted edits must not share a commit. Untracked files are not part of that hash.
 *
 * No dependencies: it runs from another project's folder with --cwd as well.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SEND_TIMEOUT_MS = 5000;

function warn(msg) {
  process.stderr.write(`[lighthouse] ${msg}\n`);
}

function parseArgs(argv) {
  const sep = argv.indexOf("--");
  if (sep < 0) throw new Error("usage: lighthouse-test.mjs [--job NAME] [--cwd DIR] -- <node arguments, including --test>");
  const own = argv.slice(0, sep);
  const nodeArgs = argv.slice(sep + 1);
  let job;
  let cwd = process.cwd();
  for (let i = 0; i < own.length; i++) {
    if (own[i] === "--job" && own[i + 1] !== undefined) job = own[++i];
    else if (own[i] === "--cwd" && own[i + 1] !== undefined) cwd = resolve(own[++i]);
    else throw new Error(`unknown argument ${own[i]}`);
  }
  return { job, cwd, nodeArgs };
}

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "buffer", maxBuffer: 256 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : undefined;
}

export function formatCommit(head, diff) {
  if (!head) return undefined;
  // Fail closed when `git diff` fails: mistaking an unreadable diff for a clean HEAD would
  // attribute dirty-tree passes to HEAD and let PersistenceDetector suppress real regressions.
  if (diff === undefined) return undefined;
  if (diff.length === 0) return head;
  return `${head}+dirty.${createHash("sha1").update(diff).digest("hex").slice(0, 12)}`;
}

function commitUnderTest(cwd) {
  const head = git(cwd, ["rev-parse", "HEAD"])?.toString("utf-8").trim();
  if (!head) return undefined;
  const diff = git(cwd, ["diff", "HEAD", "--binary"]);
  return formatCommit(head, diff);
}

function defaultJob(cwd) {
  const top = git(cwd, ["rev-parse", "--show-toplevel"])?.toString("utf-8").trim();
  return basename(top || cwd);
}

function run(cwd, args) {
  return new Promise((done) => {
    const child = spawn(process.execPath, args, { cwd, stdio: "inherit" });
    // Ctrl+C reaches the child too; stay alive to forward its exit code, and remember
    // the interrupt (on Windows, Ctrl+C exits the child with 0xC000013A and signal=null).
    let interrupted = false;
    const onSigint = () => { interrupted = true; };
    process.on("SIGINT", onSigint);
    child.on("error", (err) => {
      process.off("SIGINT", onSigint);
      warn(`could not start node: ${err.message}`);
      done({ code: 1, signal: null });
    });
    child.on("exit", (code, signal) => {
      process.off("SIGINT", onSigint);
      const ctrlC = interrupted || code === 0xc000013a || code === -1073741510 || code === 130;
      const abortedBy = signal ?? (ctrlC ? "SIGINT" : null);
      done({ code: code ?? (signal ? 1 : 0), signal: abortedBy });
    });
  });
}

async function send(url, xml, meta) {
  const q = new URLSearchParams({
    job: meta.job,
    buildId: meta.buildId,
    startedMs: String(meta.startedMs),
    finishedMs: String(meta.finishedMs),
    ...(meta.commit ? { commit: meta.commit } : {}),
  });
  const res = await fetch(`${url.replace(/\/+$/, "")}/ingest/build?${q}`, {
    method: "POST",
    headers: { "content-type": "application/xml" },
    body: xml,
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    warn(err.message);
    return 2;
  }
  const { cwd, nodeArgs } = parsed;
  const url = process.env.LIGHTHOUSE_INGEST_URL?.trim();
  if (!url) return (await run(cwd, nodeArgs)).code;

  const testAt = nodeArgs.indexOf("--test");
  if (testAt < 0 || nodeArgs.some((a) => a.startsWith("--test-reporter"))) {
    warn("not sending: the arguments need --test and no --test-reporter of their own");
    return (await run(cwd, nodeArgs)).code;
  }
  const dir = mkdtempSync(join(tmpdir(), "lighthouse-test-"));
  const junitPath = join(dir, "junit.xml");
  const args = [
    ...nodeArgs.slice(0, testAt + 1),
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    "--test-reporter=junit",
    `--test-reporter-destination=${junitPath}`,
    ...nodeArgs.slice(testAt + 1),
  ];
  const job = parsed.job ?? defaultJob(cwd);
  const commit = commitUnderTest(cwd);
  const startedMs = Date.now();
  const { code, signal } = await run(cwd, args);
  const finishedMs = Date.now();
  try {
    if (signal !== null) {
      warn(`not sent: test run terminated by ${signal}`);
      return code;
    }
    let xml;
    try {
      xml = readFileSync(junitPath, "utf-8");
    } catch {
      warn("not sent: the test run wrote no JUnit file");
      return code;
    }
    if (xml.trim() === "") {
      warn("not sent: the JUnit file is empty");
      return code;
    }
    const buildId = `${startedMs}-${process.pid}`;
    try {
      const r = await send(url, xml, { job, buildId, commit, startedMs, finishedMs });
      const said = r.announcements?.length ? `, ${r.announcements.length} persistence announcement(s)` : "";
      warn(`sent ${job} build ${buildId}: ${r.events} results, ${r.failed} failed${said}`);
    } catch (err) {
      warn(`not sent to ${url}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return code;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) {
  process.exitCode = await main();
}
