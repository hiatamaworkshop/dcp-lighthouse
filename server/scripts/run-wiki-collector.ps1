# Task Scheduler entry point for the Wikimedia collector (real-data calibration period).
#
# Register the task's action as
#   conhost.exe --headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File <this file> -Node <node.exe>
# `--headless` matters: a bare node.exe (or powershell.exe) action opens a console
# window at logon, and closing that window kills the collector with 0xC000013A
# (2026-09-30: the window was closed as clutter and two hours went uncollected).
#
# node runs in the foreground so the task's state follows the collector's. Each
# start gets its own log pair under data/logs/ (nothing is overwritten), and the
# PID goes to data/collector.pid so `Stop-Process -Id (Get-Content data\collector.pid)`
# stops it (stopping the task alone may leave node running).
param(
  [string]$Node = (Get-Command node -ErrorAction Stop).Source
)
$ErrorActionPreference = "Stop"
$server = Split-Path -Parent $PSScriptRoot
$repo = Split-Path -Parent $server
$logDir = Join-Path $repo "data\logs"
New-Item -ItemType Directory -Force $logDir | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"

$p = Start-Process -FilePath $Node -ArgumentList "dist/run-wikimedia-collector.js" `
  -WorkingDirectory $server -NoNewWindow -PassThru `
  -RedirectStandardOutput (Join-Path $logDir "collector-$stamp.out.log") `
  -RedirectStandardError (Join-Path $logDir "collector-$stamp.err.log")
$null = $p.Handle  # without this, ExitCode reads back empty after the process exits
Set-Content (Join-Path $repo "data\collector.pid") $p.Id
$p.WaitForExit()
exit $p.ExitCode
