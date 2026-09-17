$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
$rows=@(Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(python.*|node|java|gradle|adb|emulator|qemu.*|ffmpeg|cargo|rustc|cmake|ninja|claude)\.exe$' } | ForEach-Object {
  $command=[string]$_.CommandLine
  $command=$command -replace '(?i)((?:token|password|secret|api[-_]key)[=: ]+)([^ ]+)','$1[redacted]'
  [pscustomobject]@{pid=$_.ProcessId;parentPid=$_.ParentProcessId;name=$_.Name;command=$command;created=[string]$_.CreationDate;kernelTime=[string]$_.KernelModeTime;userTime=[string]$_.UserModeTime}
})
ConvertTo-Json -InputObject $rows -Depth 3 -Compress
