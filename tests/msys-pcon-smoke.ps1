param(
  [Parameter(Mandatory = $true)][string]$Bash,
  [Parameter(Mandatory = $true)][string]$Python
)
$ErrorActionPreference = "Stop"

Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class PiWindowProbe {
    public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, StringBuilder text, int maxCount);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    public static Dictionary<long, string> VisibleConsoleWindows() {
        var result = new Dictionary<long, string>();
        EnumWindows((hwnd, state) => {
            if (!IsWindowVisible(hwnd)) return true;
            var name = new StringBuilder(256);
            GetClassName(hwnd, name, name.Capacity);
            var className = name.ToString();
            if (className == "ConsoleWindowClass" || className.IndexOf("CASCADIA", StringComparison.OrdinalIgnoreCase) >= 0) {
                uint pid;
                GetWindowThreadProcessId(hwnd, out pid);
                result[hwnd.ToInt64()] = className + ":" + pid;
            }
            return true;
        }, IntPtr.Zero);
        return result;
    }
}
'@

function Convert-ToMsysPath([string]$Value) {
  $full = [IO.Path]::GetFullPath($Value).Replace('\', '/')
  if ($full -match '^([A-Za-z]):/(.*)$') { return '/' + $matches[1].ToLowerInvariant() + '/' + $matches[2] }
  return $full
}
function Quote-Bash([string]$Value) {
  $single = [string][char]39
  $replacement = [string][char]39 + [char]34 + [char]39 + [char]34 + [char]39
  return $single + $Value.Replace($single, $replacement) + $single
}
function Quote-NativeArgument([string]$Value) {
  if ($Value -notmatch '[\s"]') { return $Value }
  $builder = [Text.StringBuilder]::new()
  [void]$builder.Append('"')
  $slashes = 0
  foreach ($character in $Value.ToCharArray()) {
    if ($character -eq '\') { $slashes++; continue }
    if ($character -eq '"') {
      [void]$builder.Append(('\' * ($slashes * 2 + 1)))
      [void]$builder.Append('"')
      $slashes = 0
      continue
    }
    if ($slashes) { [void]$builder.Append(('\' * $slashes)); $slashes = 0 }
    [void]$builder.Append($character)
  }
  if ($slashes) { [void]$builder.Append(('\' * ($slashes * 2))) }
  [void]$builder.Append('"')
  return $builder.ToString()
}

if (-not (Test-Path -LiteralPath $Bash -PathType Leaf)) { throw "bash missing: $Bash" }
if (-not (Test-Path -LiteralPath $Python -PathType Leaf)) { throw "python missing: $Python" }
$tempBase = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }
$root = Join-Path $tempBase ("pi-msys-pcon-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $root | Out-Null
$probe = Join-Path $root "console_probe.py"
@'
import ctypes
import json
import subprocess
import sys
import time

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

def state(role):
    hwnd = int(kernel32.GetConsoleWindow() or 0)
    return {"role": role, "consoleHwnd": hwnd, "consoleVisible": bool(hwnd and user32.IsWindowVisible(hwnd))}

print(json.dumps(state("parent")), flush=True)
print("stderr-marker", file=sys.stderr, flush=True)
child_code = r'''import ctypes,json,time
u=ctypes.windll.user32
k=ctypes.windll.kernel32
h=int(k.GetConsoleWindow() or 0)
print(json.dumps({"role":"child","consoleHwnd":h,"consoleVisible":bool(h and u.IsWindowVisible(h))}),flush=True)
time.sleep(1.2)'''
child = subprocess.run([sys.executable, "-c", child_code], check=False)
print("stdout-marker", flush=True)
time.sleep(1.2)
sys.exit(7 if child.returncode == 0 else 97)
'@ | Set-Content -LiteralPath $probe -Encoding utf8

$before = [PiWindowProbe]::VisibleConsoleWindows()
$foregroundBefore = [PiWindowProbe]::GetForegroundWindow().ToInt64()
$seen = New-Object 'System.Collections.Generic.Dictionary[long,string]'
$startInfo = [Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = (Resolve-Path -LiteralPath $Bash).Path
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
$startInfo.RedirectStandardInput = $true
$startInfo.RedirectStandardOutput = $true
$startInfo.RedirectStandardError = $true
if ($startInfo.PSObject.Properties.Name -contains "Environment") { $startInfo.Environment["MSYS"] = "enable_pcon" }
else { $startInfo.EnvironmentVariables["MSYS"] = "enable_pcon" }
$command = (Quote-Bash (Convert-ToMsysPath $Python)) + " " + (Quote-Bash (Convert-ToMsysPath $probe))
if ($startInfo.PSObject.Properties.Name -contains "ArgumentList") {
  $startInfo.ArgumentList.Add("-c")
  $startInfo.ArgumentList.Add($command)
} else {
  $startInfo.Arguments = "-c " + (Quote-NativeArgument $command)
}
$process = [Diagnostics.Process]::new()
$process.StartInfo = $startInfo
$started = $false
try {
  if (-not $process.Start()) { throw "failed to start bash" }
  $started = $true
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  while (-not $process.HasExited) {
    foreach ($entry in [PiWindowProbe]::VisibleConsoleWindows().GetEnumerator()) {
      if (-not $before.ContainsKey($entry.Key)) { $seen[$entry.Key] = $entry.Value }
    }
    Start-Sleep -Milliseconds 10
  }
  $process.WaitForExit()
  $stdout = $stdoutTask.GetAwaiter().GetResult()
  $stderr = $stderrTask.GetAwaiter().GetResult()
  $foregroundAfter = [PiWindowProbe]::GetForegroundWindow().ToInt64()
  $states = @([regex]::Matches($stdout, '\{[^\r\n]+"consoleVisible"[^\r\n]+\}') | ForEach-Object { $_.Value | ConvertFrom-Json })
  if ($process.ExitCode -ne 7) { throw "exit code mismatch: $($process.ExitCode); stdout=$stdout; stderr=$stderr" }
  if ($stdout -notmatch 'stdout-marker') { throw "stdout marker missing: $stdout" }
  if (($stdout + $stderr) -notmatch 'stderr-marker') { throw "stderr marker missing: stdout=$stdout stderr=$stderr" }
  if ($states.Count -ne 2) { throw "expected parent+child console states: $stdout" }
  if (@($states | Where-Object consoleVisible).Count -ne 0) { throw "visible console reported by probe: $($states | ConvertTo-Json -Compress)" }
  if ($seen.Count -ne 0) { throw "new visible console windows detected: $($seen | ConvertTo-Json -Compress)" }
  if ($foregroundBefore -ne 0 -and $foregroundAfter -ne $foregroundBefore) { throw "foreground changed: $foregroundBefore -> $foregroundAfter" }
  Write-Host "PASS MSYS ConPTY runtime: visibleConsoleWindows=0 focusSteals=0 parentAndChild=2 exit=7 stdout=1 stderr=1"
} finally {
  if ($started -and -not $process.HasExited) {
    try { $process.Kill($true) } catch { $process.Kill() }
  }
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
  $process.Dispose()
}
