param([Parameter(Mandatory=$true)][string]$Helper,[Parameter(Mandatory=$true)][string]$AuditRoot,[Parameter(Mandatory=$true)][string]$Node)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$root=Split-Path -Parent $PSScriptRoot
$name='PiWeb-AutoArchive-0500'
. $Helper
$arguments='"'+$root+'/src/piweb-auto-archive.mjs"'
$action=New-SilentScheduledTaskAction -Executable $Node -Arguments $arguments -WorkingDirectory $root
$old=Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
if($old){throw 'Auto archive task already exists; inspect before replacing'}
$user=[Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$daily=New-ScheduledTaskTrigger -Daily -At '05:00'
$logon=New-ScheduledTaskTrigger -AtLogOn -User $user
$logon.Delay='PT1M'
$settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5)
Register-ScheduledTask -TaskName $name -Action $action -Principal $principal -Trigger @($daily,$logon) -Settings $settings -Description 'Archive idle conversations older than 7 days at local 05:00; enabled by default; shared switch in Pi Web settings.' | Out-Null
$readback=Get-ScheduledTask -TaskName $name
if(-not (Test-SilentScheduledTaskAction -Action $readback.Actions[0] -Executable $Node -Arguments $arguments -WorkingDirectory $root)){Unregister-ScheduledTask -TaskName $name -Confirm:$false;throw 'Task readback mismatch'}
& ($AuditRoot+'/runtime/node/node.exe') ($AuditRoot+'/tools/silent-autostart.mjs') check
if($LASTEXITCODE -ne 0){Unregister-ScheduledTask -TaskName $name -Confirm:$false;throw 'Silent audit failed'}
$audit=Get-Content -LiteralPath ($AuditRoot+'/state/silent-autostart-audit.json') -Raw -Encoding utf8 | ConvertFrom-Json
if(-not $audit.ok -or -not $audit.compliant){Unregister-ScheduledTask -TaskName $name -Confirm:$false;throw 'Silent audit did not pass'}
Start-ScheduledTask -TaskName $name
Start-Sleep -Seconds 3
$info=Get-ScheduledTaskInfo -TaskName $name
[pscustomobject]@{task=$name;action=$readback.Actions[0].Execute;nextRun=$info.NextRunTime;result=$info.LastTaskResult;silentAudit=$audit.ok}|ConvertTo-Json
