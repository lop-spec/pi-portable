$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
@(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine) | ConvertTo-Json -Depth 3 -Compress
