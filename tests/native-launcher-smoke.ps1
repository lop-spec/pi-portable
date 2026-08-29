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
const countFile = path.join(data, "count.txt");
const count = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, "utf8")) + 1 : 1;
fs.writeFileSync(countFile, String(count));
fs.writeFileSync(path.join(data, `run-${count}.json`), JSON.stringify({
  count,
  root,
  node: process.execPath,
  supervisor: process.env.PI_LAUNCH_SUPERVISOR,
  args: process.argv.slice(2)
}, null, 2));
process.exit(count === 1 ? 75 : 0);
'@ | Set-Content -LiteralPath (Join-Path $root "src\launcher.mjs") -Encoding utf8

$trace = "PiNativeSmoke-" + [guid]::NewGuid().ToString("N")
Register-CimIndicationEvent -ClassName Win32_ProcessStartTrace -SourceIdentifier $trace | Out-Null
try {
  $started = Get-Date
  $process = Start-Process -FilePath (Join-Path $root "pi-portable-launcher.exe") -ArgumentList "smoke-arg" -WorkingDirectory $root -WindowStyle Hidden -PassThru
  if (-not $process.WaitForExit(30000)) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    throw "native launcher smoke timed out"
  }
  Start-Sleep -Milliseconds 800
  $events = @(Get-Event -SourceIdentifier $trace -ErrorAction SilentlyContinue | ForEach-Object {
    $e = $_.SourceEventArgs.NewEvent
    [pscustomobject]@{ Name = [string]$e.ProcessName; PID = [int]$e.ProcessID; ParentPID = [int]$e.ParentProcessID }
  })
  $children = @($events | Where-Object ParentPID -eq $process.Id)
  $nodePids = @($children | Where-Object Name -eq "node.exe" | Select-Object -ExpandProperty PID)
  $forbidden = @($events | Where-Object {
    $_.Name -in @("cmd.exe", "conhost.exe", "OpenConsole.exe", "wscript.exe", "cscript.exe") -and
    ($_.ParentPID -eq $process.Id -or $_.ParentPID -in $nodePids)
  })
  if ($process.ExitCode -ne 0) { throw "native launcher exit=$($process.ExitCode)" }
  if ($nodePids.Count -ne 2) { throw "expected two supervised node launches, got $($nodePids.Count): $($events | ConvertTo-Json -Compress)" }
  if ($forbidden.Count -ne 0) { throw "forbidden shell/console host started: $($forbidden | ConvertTo-Json -Compress)" }
  $run1 = Get-Content -LiteralPath (Join-Path $root "data\run-1.json") -Raw | ConvertFrom-Json
  $run2 = Get-Content -LiteralPath (Join-Path $root "data\run-2.json") -Raw | ConvertFrom-Json
  foreach ($run in @($run1, $run2)) {
    if ($run.root -ne $root) { throw "portable root mismatch: $($run.root) vs $root" }
    if ($run.node -ne (Join-Path $root "runtime\node.exe")) { throw "portable node mismatch: $($run.node)" }
    if ($run.supervisor -ne "1") { throw "supervisor env missing" }
    if (@($run.args).Count -ne 1 -or $run.args[0] -ne "smoke-arg") { throw "argument forwarding mismatch" }
  }
  $log = Get-Content -LiteralPath (Join-Path $root "data\launcher-bootstrap.log") -Raw
  if ($log -notmatch "RESTART requested" -or $log -notmatch "EXIT child code=75") { throw "native supervisor log missing restart evidence" }
  Write-Host "PASS native launcher runtime: nodeStarts=2 forbiddenHosts=0 restart=1 exit=0"
} finally {
  Unregister-Event -SourceIdentifier $trace -ErrorAction SilentlyContinue
  Remove-Job -Name $trace -Force -ErrorAction SilentlyContinue
}
