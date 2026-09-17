param([switch]$Enable,[switch]$InspectOnly,[switch]$PiOnly)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
$root=Split-Path -Parent $PSScriptRoot
$desktop=$env:COMPUTERNAME -ieq 'DESKTOP-3EGB4LB'
if($desktop){$node=Join-Path $root 'runtime\node.exe';$data=Join-Path $root 'data'}else{$node=(Get-Command node.exe).Source;$data='C:\Users\lop\AppData\Local\pi-web\portable\data'}
$allNames=@('PiWeb-QuotaIdle-30min','PiWeb-LongGoals-Astra-15min','PiWeb-LongGoals-Astra-30min','PiWeb-LongGoals-Fable-30min')
if($InspectOnly){
  $a15=Get-ScheduledTask -TaskName 'PiWeb-LongGoals-Astra-15min' -ErrorAction SilentlyContinue
  $a30=Get-ScheduledTask -TaskName 'PiWeb-LongGoals-Astra-30min' -ErrorAction SilentlyContinue
  $PiOnly=[bool]($a15 -and $a15.Settings.Enabled -and -not($a30 -and $a30.Settings.Enabled))
  $inspectionEnabled=[bool](($a15 -and $a15.Settings.Enabled) -or ($a30 -and $a30.Settings.Enabled))
}
$astraMinutes=if($PiOnly){15}else{30}
$profiles=@(@{Name=('PiWeb-LongGoals-Astra-'+$astraMinutes+'min');Profile='astra';Minutes=$astraMinutes;Offset=0},@{Name='PiWeb-LongGoals-Fable-30min';Profile='fable';Minutes=30;Offset=15})
$retiredNames=@($allNames|Where-Object{$_ -notin @($profiles|ForEach-Object{$_.Name})})
if(-not $InspectOnly){
  foreach($file in @($node,(Join-Path $root 'src\goal-review.mjs'),(Join-Path $root 'src\goal-inspect.mjs'),(Join-Path $root 'src\goal-astra-review.mjs'),(Join-Path $root 'src\goal-review-tool.mjs'),(Join-Path $root 'src\goal-review-session.mjs'),(Join-Path $root 'src\goal-claude-review.mjs'),(Join-Path $root 'tools\goal-review-task.vbs'))){if(-not(Test-Path -LiteralPath $file)){throw "Missing $file"}}
  $backup=Join-Path $data ('backups\long-goal-tasks-'+(Get-Date -Format 'yyyyMMdd-HHmmss'))
  New-Item -ItemType Directory -Path $backup -Force|Out-Null
  foreach($name in $allNames){
    $t=Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if($t){$export=Join-Path $backup ($name+'.xml');[IO.File]::WriteAllText($export,(Export-ScheduledTask -TaskName $name),[Text.Encoding]::Unicode);& $node (Join-Path $root 'tools\backup.mjs') $export;if($LASTEXITCODE -ne 0){throw 'Physical task backup failed'}}
  }
  Write-Output "BACKUP=$backup"
  foreach($p in $profiles){
    $launcher=Join-Path $root 'tools\goal-review-task.vbs';$worker=Join-Path $root 'src\goal-review.mjs'
    $action=New-ScheduledTaskAction -Execute "$env:WINDIR\System32\wscript.exe" -Argument ('//B //Nologo "'+$launcher+'" "'+$node+'" "'+$worker+'" '+$p.Profile) -WorkingDirectory $root
    $clock=Get-Date;$base=$clock.Date.AddMinutes(([Math]::Floor(($clock.TimeOfDay.TotalMinutes-$p.Offset)/$p.Minutes)+1)*$p.Minutes+$p.Offset)
    $trigger=New-ScheduledTaskTrigger -Once -At $base -RepetitionInterval (New-TimeSpan -Minutes $p.Minutes)
    $settings=New-ScheduledTaskSettingsSet -Hidden -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent().Name
    $principal=New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
    $task=New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description ('Explicit local long-goal review; '+$p.Profile+'; original-session advice/resume; Fable executes on YANGYONG; no credential or goal-file synchronization.')
    $task.Settings.Enabled=[bool]($Enable -and (-not $PiOnly -or $p.Profile -eq 'astra'))
    Register-ScheduledTask -TaskName $p.Name -InputObject $task -Force|Out-Null
  }
  foreach($name in $retiredNames){if(Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue){Disable-ScheduledTask -TaskName $name|Out-Null}}
}
# CIM Get-ScheduledTaskInfo misreports seconds under the peer's locale; COM returns native timestamps.
$scheduler=New-Object -ComObject Schedule.Service
$scheduler.Connect()
foreach($p in $profiles){
  $t=Get-ScheduledTask -TaskName $p.Name;$i=$scheduler.GetFolder('\').GetTask($p.Name);$xml=[xml](Export-ScheduledTask -TaskName $p.Name)
  $interval=[string]$xml.Task.Triggers.TimeTrigger.Repetition.Interval
  if($interval -ne ('PT'+$p.Minutes+'M') -or -not $t.Settings.Hidden -or $t.Settings.MultipleInstances -ne 'IgnoreNew'){throw 'Task contract mismatch'}
  $start=[datetime]$xml.Task.Triggers.TimeTrigger.StartBoundary
  if(($start.Minute % $p.Minutes) -ne $p.Offset -or $start.Second -ne 0){throw 'Task phase mismatch'}
  if($InspectOnly){$expected=[bool]($inspectionEnabled -and (-not $PiOnly -or $p.Profile -eq 'astra'))}else{$expected=[bool]($Enable -and (-not $PiOnly -or $p.Profile -eq 'astra'))}
  if($t.Settings.Enabled -ne $expected){throw 'Task enabled-mode mismatch'}
  if($t.Settings.Enabled -and (($i.NextRunTime.Minute % $p.Minutes) -ne $p.Offset -or $i.NextRunTime.Second -ne 0)){throw 'Native next-run phase mismatch'}
  [pscustomobject]@{Name=$t.TaskName;Enabled=$t.Settings.Enabled;Interval=$interval;PhaseMinute=($start.Minute % $p.Minutes);Hidden=$t.Settings.Hidden;MultipleInstances=[string]$t.Settings.MultipleInstances;NextRun=$i.NextRunTime.ToString('o');LastRun=$i.LastRunTime.ToString('o');LastResult=$i.LastTaskResult;Action=$t.Actions.Arguments}|ConvertTo-Json -Compress
}
foreach($name in $retiredNames){
  $old=Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  if($old -and $old.Settings.Enabled){throw ('Retired scheduler is still enabled: '+$name)}
}
Write-Output ('MODE='+$(if($PiOnly){'pi-only-15min'}else{'alternating-15min'}))
Write-Output 'LEGACY_DISABLED=True'
