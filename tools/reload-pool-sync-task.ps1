param(
  [Parameter(Mandatory=$true)][string]$DataRoot,
  [string]$Root = '',
  [string]$Node = ''
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
if (-not $Node) { $Node = Join-Path $Root 'runtime\node.exe' }
$name = 'PiWeb-AccountPoolSync'
$stateFile = Join-Path $DataRoot 'account-pool-sync\state.json'
$statusFile = Join-Path $DataRoot 'account-pool-sync\status.json'
if (Test-Path -LiteralPath $stateFile) {
  & $Node (Join-Path $Root 'tools\backup.mjs') $stateFile --label 'before-login-sync'
  if ($LASTEXITCODE -ne 0) { throw 'State backup failed' }
}
$old = $null
if (Test-Path -LiteralPath $statusFile) {
  $s = Get-Content -LiteralPath $statusFile -Raw -Encoding UTF8 | ConvertFrom-Json
  $candidate = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$s.pid)
  if ($candidate) {
    $command = ([string]$candidate.CommandLine).Replace('/','\').ToLowerInvariant()
    $worker = (Join-Path $Root 'src\account-pool-sync.mjs').Replace('/','\').ToLowerInvariant()
    if ($candidate.Name -ne 'node.exe' -or -not $command.Contains($worker) -or -not $command.Contains('watch --data-root') -or -not $command.Contains($DataRoot.Replace('/','\').ToLowerInvariant())) { throw 'Refusing to stop an unrelated process' }
    $old = $candidate.ProcessId
  }
}
$task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
if ($task) { Stop-ScheduledTask -TaskName $name }
if ($old -and (Get-Process -Id $old -ErrorAction SilentlyContinue)) { Stop-Process -Id $old -ErrorAction Stop; Wait-Process -Id $old -Timeout 5 -ErrorAction SilentlyContinue }
& (Join-Path $Root 'tools\install-pool-sync-task.ps1') -Root $Root -DataRoot $DataRoot -Node $Node
if (-not $?) { throw 'Task installation failed' }
Write-Output ('RELOADED_SYNC_ONLY previousPid=' + $old)
