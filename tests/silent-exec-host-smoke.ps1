param(
  [Parameter(Mandatory = $true)][string]$Launcher,
  [Parameter(Mandatory = $true)][string]$Node
)
$ErrorActionPreference = "Stop"
$root = Join-Path $env:RUNNER_TEMP ("pi-silent-exec-smoke-" + [guid]::NewGuid().ToString("N"))
$hostRoot = Join-Path $root "host-only"
$workRoot = Join-Path $root "fixture-work"
New-Item -ItemType Directory -Force -Path $hostRoot, $workRoot | Out-Null
$hostPath = Join-Path $hostRoot "windows-silent-exec-host.exe"
Copy-Item -LiteralPath $Launcher -Destination $hostPath
$fixture = Join-Path $workRoot "fixture.mjs"
$resultPath = Join-Path $workRoot "result.json"
@'
import fs from "node:fs";
fs.writeFileSync(process.argv[2], JSON.stringify({
  cwd: process.cwd(),
  execPath: process.execPath,
  args: process.argv.slice(3),
  piPortableHome: process.env.PI_PORTABLE_HOME ?? null,
  piNodeExe: process.env.PI_NODE_EXE ?? null,
  piProcessHost: process.env.PI_PROCESS_HOST ?? null
}, null, 2));
'@ | Set-Content -LiteralPath $fixture -Encoding utf8

if (Test-Path -LiteralPath (Join-Path $hostRoot "runtime\node.exe")) {
  throw "standalone host smoke must not contain a bundled Pi runtime"
}
$env:PI_PORTABLE_HOME = "caller-home-sentinel"
$env:PI_NODE_EXE = "caller-node-sentinel"
$env:PI_PROCESS_HOST = "caller-host-sentinel"
$trace = "PiSilentExecSmoke-" + [guid]::NewGuid().ToString("N")
Register-CimIndicationEvent -ClassName Win32_ProcessStartTrace -SourceIdentifier $trace | Out-Null
try {
  Start-Sleep -Milliseconds 700
  $arguments = @(
    "--pi-silent-exec",
    ('"' + $workRoot + '"'),
    ('"' + $Node + '"'),
    ('"' + $fixture + '"'),
    ('"' + $resultPath + '"'),
    "hosted-arg"
  )
  $process = Start-Process -FilePath $hostPath -ArgumentList $arguments -WorkingDirectory $hostRoot -WindowStyle Hidden -PassThru
  if (-not $process.WaitForExit(30000)) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    throw "standalone host smoke timed out"
  }
  Start-Sleep -Seconds 1
  $events = @(Get-Event -SourceIdentifier $trace -ErrorAction SilentlyContinue | ForEach-Object {
    $event = $_.SourceEventArgs.NewEvent
    [pscustomobject]@{ Name = [string]$event.ProcessName; PID = [int]$event.ProcessID; ParentPID = [int]$event.ParentProcessID }
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
  $nodeStarts = @($descendants | Where-Object Name -eq "node.exe")
  $forbidden = @($descendants | Where-Object { $_.Name -in @("cmd.exe", "conhost.exe", "OpenConsole.exe", "WindowsTerminal.exe", "wscript.exe", "cscript.exe", "powershell.exe") })
  if ($process.ExitCode -ne 0) { throw "standalone host exit=$($process.ExitCode)" }
  if ($nodeStarts.Count -ne 1) { throw "expected one exact child node: $($events | ConvertTo-Json -Compress)" }
  if ($forbidden.Count -ne 0) { throw "forbidden shell/console host started: $($forbidden | ConvertTo-Json -Compress)" }
  if (-not (Test-Path -LiteralPath $resultPath -PathType Leaf)) { throw "fixture result missing" }
  $result = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
  if ($result.cwd -ne $workRoot) { throw "working directory mismatch: $($result.cwd)" }
  if ($result.execPath -ne $Node) { throw "exact executable mismatch: $($result.execPath)" }
  if (@($result.args).Count -ne 1 -or $result.args[0] -ne "hosted-arg") { throw "argument forwarding mismatch" }
  if ($result.piPortableHome -ne "caller-home-sentinel" -or
      $result.piNodeExe -ne "caller-node-sentinel" -or
      $result.piProcessHost -ne "caller-host-sentinel") {
    throw "standalone mode must not inject or overwrite Pi environment variables"
  }
  $log = Get-Content -LiteralPath (Join-Path $hostRoot "data\launcher-bootstrap.log") -Raw
  if ($log -notmatch "START mode=silent-exec" -or $log -notmatch "EXIT mode=silent-exec child code=0") {
    throw "standalone host lifecycle evidence missing"
  }

  $badArguments = @("--pi-silent-exec", ('"' + $workRoot + '"'), ('"' + (Join-Path $workRoot "missing.exe") + '"'))
  $bad = Start-Process -FilePath $hostPath -ArgumentList $badArguments -WorkingDirectory $hostRoot -WindowStyle Hidden -PassThru
  if (-not $bad.WaitForExit(5000)) {
    Stop-Process -Id $bad.Id -Force -ErrorAction SilentlyContinue
    throw "background failure opened UI or failed to terminate"
  }
  if ($bad.ExitCode -eq 0) { throw "missing target must fail closed" }
  Write-Host "PASS standalone silent exec host: exactChild=1 forbiddenHosts=0 noPiEnvMutation=1 backgroundFailureNoUi=1"
} finally {
  Unregister-Event -SourceIdentifier $trace -ErrorAction SilentlyContinue
  Remove-Job -Name $trace -Force -ErrorAction SilentlyContinue
}
