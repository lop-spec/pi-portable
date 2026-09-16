param(
  [string]$Root = '',
  [Parameter(Mandatory=$true)][string]$DataRoot,
  [string]$Node = '',
  [switch]$InspectOnly
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$name = 'PiWeb-AccountPoolSync'
if (-not $Root) { $Root = Split-Path -Parent $PSScriptRoot }
if (-not $Node) { $Node = Join-Path $Root 'runtime\node.exe' }
$worker = Join-Path $Root 'src\account-pool-sync.mjs'
$wrapper = Join-Path $Root 'tools\pool-sync-task.vbs'
foreach ($file in @($Node, $worker, $wrapper, (Join-Path $Root 'src\account-pool-sync-core.mjs'))) {
  if (-not (Test-Path -LiteralPath $file)) { throw "Required asset missing: $file" }
}
if (-not $InspectOnly) {
  $old = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  if ($old) {
    $folder = Join-Path $DataRoot ('backups\pool-sync-task-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    New-Item -ItemType Directory -Path $folder -Force | Out-Null
    $export = Join-Path $folder 'scheduled-task.xml'
    [IO.File]::WriteAllText($export, (Export-ScheduledTask -TaskName $name), [Text.Encoding]::Unicode)
    & $Node (Join-Path $Root 'tools\backup.mjs') $export
    if ($LASTEXITCODE -ne 0) { throw 'Task physical backup failed' }
  }
  $action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\wscript.exe" -Argument ('//B //Nologo "' + $wrapper + '" "' + $Node + '" "' + $worker + '" "' + $DataRoot + '"') -WorkingDirectory $Root
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $logon = New-ScheduledTaskTrigger -AtLogOn -User $identity
  $watchdog = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
  $settings = New-ScheduledTaskSettingsSet -Hidden -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
  $principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
  $task = New-ScheduledTask -Action $action -Trigger @($logon,$watchdog) -Settings $settings -Principal $principal -Description 'Model-free two-way account pool membership sync. No credential transfer. Hidden persistent watcher with SSH relay and offline recovery.'
  Register-ScheduledTask -TaskName $name -InputObject $task -Force | Out-Null
  Start-ScheduledTask -TaskName $name
}
$t = Get-ScheduledTask -TaskName $name
$i = Get-ScheduledTaskInfo -TaskName $name
if (-not $t.Settings.Hidden -or $t.Settings.MultipleInstances -ne 'IgnoreNew') { throw 'Task hidden/non-overlap contract failed' }
@{name=$t.TaskName;state=[string]$t.State;hidden=$t.Settings.Hidden;multipleInstances=[string]$t.Settings.MultipleInstances;lastResult=$i.LastTaskResult;principal=$t.Principal.UserId;execute=$t.Actions.Execute;arguments=$t.Actions.Arguments} | ConvertTo-Json
