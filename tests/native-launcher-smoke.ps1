param(
  [Parameter(Mandatory = $true)][string]$Launcher,
  [Parameter(Mandatory = $true)][string]$Node
)
$ErrorActionPreference = "Stop"
$root = Join-Path $env:RUNNER_TEMP ("pi-native-smoke-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path (Join-Path $root "runtime"), (Join-Path $root "src") | Out-Null
Copy-Item -LiteralPath $Launcher -Destination (Join-Path $root "pi-portable-launcher.exe")
Copy-Item -LiteralPath $Node -Destination (Join-Path $root "runtime\node.exe")
@'
import fs from "node:fs";
import path from "node:path";
const root = process.env.PI_PORTABLE_HOME;
const data = path.join(root, "data");
fs.mkdirSync(data, { recursive: true });
fs.writeFileSync(path.join(data, "hosted-child.json"), JSON.stringify({
  root,
  node: process.execPath,
  processHost: process.env.PI_PROCESS_HOST,
  args: process.argv.slice(2)
}, null, 2));
'@ | Set-Content -LiteralPath (Join-Path $root "src\hosted-child.mjs") -Encoding utf8
@'
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
const root = process.env.PI_PORTABLE_HOME;
const data = path.join(root, "data");
fs.mkdirSync(data, { recursive: true });
const countFile = path.join(data, "count.txt");
const count = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, "utf8")) + 1 : 1;
fs.writeFileSync(countFile, String(count));
fs.writeFileSync(path.join(data, `run-${count}.json`), JSON.stringify({
  count,
  root,
  node: process.execPath,
  supervisor: process.env.PI_LAUNCH_SUPERVISOR,
  processHost: process.env.PI_PROCESS_HOST,
  args: process.argv.slice(2)
}, null, 2));
if (count === 1) process.exit(75);
const hosted = spawnSync(process.env.PI_PROCESS_HOST, [
  "--pi-node-host",
  path.join(root, "src", "hosted-child.mjs"),
  "child-arg"
], { env: process.env, stdio: "ignore", windowsHide: true });
fs.writeFileSync(path.join(data, "hosted-status.txt"), String(hosted.status));
process.exit(hosted.status ?? 1);
'@ | Set-Content -LiteralPath (Join-Path $root "src\launcher.mjs") -Encoding utf8

$trace = "PiNativeSmoke-" + [guid]::NewGuid().ToString("N")
Register-CimIndicationEvent -ClassName Win32_ProcessStartTrace -SourceIdentifier $trace | Out-Null
try {
  Start-Sleep -Milliseconds 700
  $process = Start-Process -FilePath (Join-Path $root "pi-portable-launcher.exe") -ArgumentList "smoke-arg" -WorkingDirectory $root -WindowStyle Hidden -PassThru
  if (-not $process.WaitForExit(30000)) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    throw "native launcher smoke timed out"
  }
  Start-Sleep -Seconds 1
  $events = @(Get-Event -SourceIdentifier $trace -ErrorAction SilentlyContinue | ForEach-Object {
    $e = $_.SourceEventArgs.NewEvent
    [pscustomobject]@{ Name = [string]$e.ProcessName; PID = [int]$e.ProcessID; ParentPID = [int]$e.ParentProcessID }
  })
  $descendantIds = New-Object 'System.Collections.Generic.HashSet[int]'
  [void]$descendantIds.Add($process.Id)
  $changed = $true
  while ($changed) {
    $changed = $false
    foreach ($eventRecord in $events) {
      if ($descendantIds.Contains($eventRecord.ParentPID) -and -not $descendantIds.Contains($eventRecord.PID)) {
        [void]$descendantIds.Add($eventRecord.PID)
        $changed = $true
      }
    }
  }
  $descendants = @($events | Where-Object { $descendantIds.Contains($_.PID) -and $_.PID -ne $process.Id })
  $nodePids = @($descendants | Where-Object Name -eq "node.exe" | Select-Object -ExpandProperty PID)
  $hostPids = @($descendants | Where-Object Name -eq "pi-portable-launcher.exe" | Select-Object -ExpandProperty PID)
  $forbidden = @($descendants | Where-Object { $_.Name -in @("cmd.exe", "conhost.exe", "OpenConsole.exe", "wscript.exe", "cscript.exe") })
  if ($process.ExitCode -ne 0) { throw "native launcher exit=$($process.ExitCode)" }
  if ($nodePids.Count -ne 3) { throw "expected three detached node launches, got $($nodePids.Count): $($events | ConvertTo-Json -Compress)" }
  if ($hostPids.Count -ne 1) { throw "expected one nested native node host, got $($hostPids.Count): $($events | ConvertTo-Json -Compress)" }
  if ($forbidden.Count -ne 0) { throw "forbidden shell/console host started: $($forbidden | ConvertTo-Json -Compress)" }
  $run1 = Get-Content -LiteralPath (Join-Path $root "data\run-1.json") -Raw | ConvertFrom-Json
  $run2 = Get-Content -LiteralPath (Join-Path $root "data\run-2.json") -Raw | ConvertFrom-Json
  $hostedChild = Get-Content -LiteralPath (Join-Path $root "data\hosted-child.json") -Raw | ConvertFrom-Json
  foreach ($run in @($run1, $run2)) {
    if ($run.root -ne $root) { throw "portable root mismatch: $($run.root) vs $root" }
    if ($run.node -ne (Join-Path $root "runtime\node.exe")) { throw "portable node mismatch: $($run.node)" }
    if ($run.supervisor -ne "1") { throw "supervisor env missing" }
    if ($run.processHost -ne (Join-Path $root "pi-portable-launcher.exe")) { throw "process host env mismatch" }
    if (@($run.args).Count -ne 1 -or $run.args[0] -ne "smoke-arg") { throw "argument forwarding mismatch" }
  }
  if ($hostedChild.node -ne (Join-Path $root "runtime\node.exe")) { throw "hosted child node mismatch" }
  if (@($hostedChild.args).Count -ne 1 -or $hostedChild.args[0] -ne "child-arg") { throw "hosted child argument mismatch" }
  if ((Get-Content -LiteralPath (Join-Path $root "data\hosted-status.txt") -Raw) -ne "0") { throw "nested process host failed" }
  $log = Get-Content -LiteralPath (Join-Path $root "data\launcher-bootstrap.log") -Raw
  if ($log -notmatch "RESTART requested" -or $log -notmatch "mode=node-host") { throw "native supervisor/process-host log evidence missing" }
  Write-Host "PASS native launcher runtime: nodeStarts=3 nestedHosts=1 forbiddenHosts=0 restart=1 exit=0"
} finally {
  Unregister-Event -SourceIdentifier $trace -ErrorAction SilentlyContinue
  Remove-Job -Name $trace -Force -ErrorAction SilentlyContinue
}
