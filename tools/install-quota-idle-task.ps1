param(
  [string]$Root = (Split-Path -Parent $PSScriptRoot),
  [string]$DataRoot = '',
  [string]$Node = '',
  [switch]$Disabled,
  [switch]$InspectOnly
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$taskName = 'PiWeb-QuotaIdle-30min'
if (-not $DataRoot) { $DataRoot = Join-Path $Root 'data' }
if (-not $Node) { $Node = Join-Path $Root 'runtime\node.exe' }
$worker = Join-Path $Root 'src\quota-idle-scheduler.mjs'
$launcher = Join-Path $Root 'tools\quota-idle-task.vbs'
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if (-not $InspectOnly) {
  foreach ($file in @($Node, $worker, $launcher, (Join-Path $DataRoot '.pi\agent\settings.json'))) {
    if (-not (Test-Path -LiteralPath $file)) { throw "Required asset missing: $file" }
  }
  if ($existing) {
    $backupRoot = Join-Path $DataRoot ('backups\quota-idle-task-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
    $export = Join-Path $backupRoot 'scheduled-task.xml'
    [IO.File]::WriteAllText($export, (Export-ScheduledTask -TaskName $taskName), [Text.Encoding]::Unicode)
    & $Node (Join-Path $Root 'tools\backup.mjs') $export
    if ($LASTEXITCODE -ne 0) { throw 'Task physical backup failed' }
    Write-Output "BACKUP=$export"
  }
  $action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\wscript.exe" -Argument ('//B //Nologo "' + $launcher + '" "' + $Node + '" "' + $worker + '" "' + $DataRoot + '"') -WorkingDirectory $Root
  $clock = Get-Date
  $start = $clock.Date.AddMinutes(([Math]::Floor($clock.TimeOfDay.TotalMinutes / 30) + 1) * 30)
  $trigger = New-ScheduledTaskTrigger -Once -At $start -RepetitionInterval (New-TimeSpan -Minutes 30)
  $settings = New-ScheduledTaskSettingsSet -Hidden -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
  $definition = New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Every 30 minutes: refresh account quota; if reset <24h with quota and Pi Web idle, create separate target-mode conversations. No model-based scheduling.'
  if ($Disabled) { $definition.Settings.Enabled = $false }
  Register-ScheduledTask -TaskName $taskName -InputObject $definition -Force | Out-Null
}
$task = Get-ScheduledTask -TaskName $taskName
$info = Get-ScheduledTaskInfo -TaskName $taskName
$xml = [xml](Export-ScheduledTask -TaskName $taskName)
$interval = [string]$xml.Task.Triggers.TimeTrigger.Repetition.Interval
if ($interval -ne 'PT30M') { throw "Invalid task interval: $interval" }
if ($task.Settings.MultipleInstances -ne 'IgnoreNew' -or -not $task.Settings.Hidden) { throw 'Hidden/non-overlap contract failed' }
@{name=$task.TaskName;state=[string]$task.State;interval=$interval;nextRun=$info.NextRunTime.ToString('o');lastRun=$info.LastRunTime.ToString('o');lastResult=$info.LastTaskResult;hidden=$task.Settings.Hidden;multipleInstances=[string]$task.Settings.MultipleInstances;principal=$task.Principal.UserId;logonType=[string]$task.Principal.LogonType;action=$task.Actions.Execute;arguments=$task.Actions.Arguments;enabled=$task.Settings.Enabled} | ConvertTo-Json -Depth 4
