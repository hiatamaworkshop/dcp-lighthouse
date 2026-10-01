# The H4 judgment day, unattended (ROADMAP_BRIEF.md 2026-09-27 (3) H4, revisions 2026-09-30 / 2026-10-01 (2)).
#
# Register a one-shot task whose action is
#   conhost.exe --headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File <this file> -Node <node.exe> -DemoDir <opentelemetry-demo>
# (headless for the same reason as run-wiki-collector.ps1). In order:
#   1. stop the containers named by -Pause (the Demo needs the memory; only running ones are stopped and restarted)
#   2. start the OTLP receiver into -DataDir, then the Demo with server/otel's collector extras and compose override
#   3. wait for flagd-ui, then until -StartUtc, and run the flag scheduler in the foreground
#      (pre-registered schedule: lead 30m, ON 10m / rest 50m x 23, 50% against a 10% rest)
#   4. at -EndUtc stop the receiver and the Demo, and restart what step 1 stopped
# The default times put every ON span inside UTC 2026-10-03: first ON 00:00Z, last OFF 22:10Z.
# Not a Claude Code background task: those are killed after 2 h.
# Everything goes to data/logs/h4-day-<stamp>.*.log; the PIDs to data/h4-*.pid.
# Pass the real node.exe as -Node (nvm's ...\nvm\installs\<ver>\node.exe), not what `Get-Command node`
# finds: nvm's ...\.nodejs\node.exe starts the real one as a child, so its PID is not the receiver's.
# The teardown kills the whole tree anyway (a dry run left an orphan holding :4318).
param(
  [string]$Node = (Get-Command node -ErrorAction Stop).Source,
  [Parameter(Mandatory = $true)][string]$DemoDir,
  [string]$StartUtc = "2026-10-02T23:30:00Z",
  [string]$EndUtc = "2026-10-04T00:10:00Z",
  [string]$DataDir = "",
  [string]$ScheduleArgs = "",  # one string: `-File` cannot pass an array (e.g. "--lead 1m --cycles 1" for a dry run)
  [string[]]$Pause = @("cairn-qdrant", "engram-gateway", "engram-qdrant")
)
# Windows PowerShell 5.1 turns a native command's stderr into terminating errors under "Stop",
# and docker compose writes its progress to stderr. Exit codes are checked by hand instead.
$ErrorActionPreference = "Continue"
$server = Split-Path -Parent $PSScriptRoot
$repo = Split-Path -Parent $server
$logDir = Join-Path $repo "data\logs"
New-Item -ItemType Directory -Force $logDir | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$log = Join-Path $logDir "h4-day-$stamp.log"
if ($DataDir -eq "") { $DataDir = Join-Path $repo "data\otel" }
$env:OTEL_DATA_DIR = $DataDir
$env:OTEL_COLLECTOR_CONFIG_EXTRAS = Join-Path $server "otel\otelcol-config-lighthouse.yml"
$compose = @("compose", "--env-file", ".env", "-f", "compose.yaml", "-f", "compose.extras.yaml",
  "-f", (Join-Path $server "otel\compose.lighthouse.yaml"))

function L([string]$msg) { "$([DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')) $msg" | Add-Content $log }
function UntilUtc([DateTimeOffset]$t) {
  while ([DateTimeOffset]::UtcNow -lt $t) {
    $left = ($t - [DateTimeOffset]::UtcNow).TotalSeconds
    Start-Sleep -Seconds ([Math]::Max(1, [Math]::Min(60, [Math]::Ceiling($left))))
  }
}
function Compose([string[]]$a) {  # not "Docker": PowerShell names are case-insensitive, and a function named Docker shadows docker.exe (it recursed into itself)
  Push-Location $DemoDir
  try { & docker.exe @a 2>&1 | ForEach-Object { L "  docker: $_" } } finally { Pop-Location }
  return $LASTEXITCODE
}
function StartNode([string]$name, [string[]]$a) {
  $p = Start-Process -FilePath $Node -ArgumentList $a -WorkingDirectory $server -NoNewWindow -PassThru `
    -RedirectStandardOutput (Join-Path $logDir "h4-day-$stamp.$name.out.log") `
    -RedirectStandardError (Join-Path $logDir "h4-day-$stamp.$name.err.log")
  $null = $p.Handle  # without this, ExitCode reads back empty after the process exits
  Set-Content (Join-Path $repo "data\h4-$name.pid") $p.Id
  L "$name started (pid $($p.Id))"
  return $p
}

$start = [DateTimeOffset]::Parse($StartUtc)
$end = [DateTimeOffset]::Parse($EndUtc)
$schedule = @($ScheduleArgs.Split(" ", [StringSplitOptions]::RemoveEmptyEntries))
L "H4 day: data $DataDir, scheduler at $($start.ToString('o')), teardown at $($end.ToString('o')), schedule args '$ScheduleArgs'"
# One run per directory: a second run's flips would interleave with the first's truth log.
if (Test-Path (Join-Path $DataDir "flags.jsonl")) { L "refusing: $DataDir already has flags.jsonl"; exit 2 }
if ([DateTimeOffset]::UtcNow -gt $start) { L "WARNING: started after $($start.ToString('o')); the schedule shifts by the delay" }

if (Get-NetTCPConnection -LocalPort 4318 -State Listen -ErrorAction SilentlyContinue) {
  L "refusing: :4318 is already taken (an earlier receiver?)"; exit 2
}

$paused = @()
foreach ($c in $Pause) {
  $t = Get-Date
  $running = (& docker.exe inspect -f "{{.State.Running}}" $c 2>&1)
  L "  $c running=[$running] ($([Math]::Round(((Get-Date) - $t).TotalSeconds, 1)) s)"
  if ($running -eq "true") { & docker.exe stop $c 2>&1 | ForEach-Object { L "  docker: $_" }; $paused += $c }
}
L "paused: $($paused -join ', ')"

$receiver = StartNode "receiver" @("dist/run-otlp-receiver.js")
Start-Sleep -Seconds 5
if ($receiver.HasExited) {
  L "receiver exited at once ($($receiver.ExitCode)); see its err.log. Nothing else is started"
  foreach ($c in $paused) { & docker.exe start $c 2>&1 | Out-Null }
  exit 1
}
$rc = Compose ($compose + @("up", "-d"))
L "demo up: exit $rc"

$ready = $false
for ($i = 0; $i -lt 90 -and -not $ready; $i++) {
  try { $null = Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 "http://localhost:8080/feature/api/read"; $ready = $true }
  catch { Start-Sleep -Seconds 10 }
}
if (-not $ready) { L "flagd-ui never answered in 15 min; the scheduler is not started" }
else {
  L "flagd-ui ready; waiting for $($start.ToString('o'))"
  UntilUtc $start
  $scheduler = StartNode "scheduler" (@("dist/run-otel-flag-schedule.js") + $schedule)
  $scheduler.WaitForExit()
  L "scheduler exited $($scheduler.ExitCode)"
}

UntilUtc $end
# The tree, not the PID: a launcher's child would survive Stop-Process. Appends are synchronous; nothing is buffered.
& taskkill.exe /T /F /PID $receiver.Id 2>&1 | Out-Null  # its message is in the console code page; the exit code says enough
L "receiver stopped (taskkill exit $LASTEXITCODE)"
$rc = Compose ($compose + @("stop"))
L "demo stopped: exit $rc"
foreach ($c in $paused) { & docker.exe start $c 2>&1 | Out-Null }
L "restarted: $($paused -join ', ')"
