# Resident lighthouse server that takes your own test runs (ROADMAP C37).
#
#   LIGHTHOUSE_PROFILE=test-stream  LIGHTHOUSE_SOURCE=ingest  LIGHTHOUSE_PERSIST_HISTORY=10
#   LIGHTHOUSE_INGEST_LOG=data/ingest/builds.jsonl  (accepted builds survive a restart)
#
# Start it without a console window — a visible window gets closed as clutter, and that kills the
# server with 0xC000013A (2026-09-30, the Wikimedia collector). For a Task Scheduler action, or by hand:
#   conhost.exe --headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File <this file> [-Port 3001] [-Node <node.exe>]
#
# Build first (`npm run build` in server/): this runs dist/index.js as it is.
# node runs in the foreground so the task's state follows the server's. Each start gets its own log
# pair under data/logs/ (nothing is overwritten), and the PID goes to data/lighthouse-ingest.pid, so
#   Stop-Process -Id (Get-Content data\lighthouse-ingest.pid)
# stops it (stopping the task alone may leave node running).
#
# Then send a project's tests to it with LIGHTHOUSE_INGEST_URL=http://localhost:<Port> set
# (server/scripts/lighthouse-test.mjs; `npm test` in server/ already goes through it).
param(
  [int]$Port = 3001,
  [string]$Node = (Get-Command node -ErrorAction Stop).Source
)
$ErrorActionPreference = "Stop"
$server = Split-Path -Parent $PSScriptRoot
$repo = Split-Path -Parent $server
$logDir = Join-Path $repo "data\logs"
New-Item -ItemType Directory -Force $logDir | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"

$env:LIGHTHOUSE_PROFILE = "test-stream"
$env:LIGHTHOUSE_SOURCE = "ingest"
$env:LIGHTHOUSE_PERSIST_HISTORY = "10"
$env:LIGHTHOUSE_INGEST_LOG = Join-Path $repo "data\ingest\builds.jsonl"
$env:PORT = "$Port"

$p = Start-Process -FilePath $Node -ArgumentList "dist/index.js" `
  -WorkingDirectory $server -NoNewWindow -PassThru `
  -RedirectStandardOutput (Join-Path $logDir "lighthouse-ingest-$stamp.out.log") `
  -RedirectStandardError (Join-Path $logDir "lighthouse-ingest-$stamp.err.log")
$null = $p.Handle  # without this, ExitCode reads back empty after the process exits
Set-Content (Join-Path $repo "data\lighthouse-ingest.pid") $p.Id
$p.WaitForExit()
exit $p.ExitCode
