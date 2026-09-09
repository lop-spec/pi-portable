# pi-portable tray host: NotifyIcon resident; menu actions emitted as line protocol
# on stdout, consumed by launcher.mjs. Protocol: READY / OPEN / RESTART / EXIT.
# Icon reuses pi-web's own icon-192.png (converted to HICON at runtime, no new art
# asset); falls back to the system application icon when missing.
# ASCII-only by contract (PS 5.1 parses .ps1 as ANSI): localized menu labels are
# passed in via argv from launcher.mjs.
param(
  [string]$IconPng = "",
  [string]$Title = "Pi Web",
  [int]$ParentPid = 0,
  [string]$MenuOpen = "Open",
  [string]$MenuRestart = "Restart",
  [string]$MenuExit = "Exit",
  [switch]$SelfTest
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$icon = $null
$iconSource = "fallback"
if ($IconPng -and (Test-Path -LiteralPath $IconPng)) {
  try {
    if ($IconPng -match '\.ico$') {
      $icon = New-Object System.Drawing.Icon($IconPng)
    } else {
      $bmp = [System.Drawing.Bitmap]::FromFile($IconPng)
      $icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
    }
    $iconSource = "custom"
  } catch { $icon = $null; $iconSource = "fallback" }
}
if (-not $icon) { $icon = [System.Drawing.SystemIcons]::Application }

$script:out = [Console]::Out
function Send-Cmd([string]$cmd) { $script:out.WriteLine($cmd); $script:out.Flush() }

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = $icon
$notify.Text = $Title
$menu = New-Object System.Windows.Forms.ContextMenuStrip
[void]$menu.Items.Add($MenuOpen, $null, { Send-Cmd "OPEN" })
$restartItem = $menu.Items.Add($MenuRestart, $null, { Send-Cmd "RESTART" })
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
[void]$menu.Items.Add($MenuExit, $null, { Send-Cmd "EXIT" })
$notify.ContextMenuStrip = $menu
$notify.add_MouseClick({ param($s, $e)
  if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Send-Cmd "OPEN" }
})
$notify.Visible = $true

if ($SelfTest) {
  Send-Cmd "ICON:$iconSource"
  Send-Cmd "READY"
  $notify.Visible = $false
  $notify.Dispose()
  exit 0
}

# Same-user named event permits explicit remote restart through the real menu handler.
# No network listener, polling files, model calls or automatic session continuation.
$restartEvent = $null
if ($ParentPid -gt 0) {
  try {
    $restartEvent = [System.Threading.EventWaitHandle]::new($false, [System.Threading.EventResetMode]::AutoReset, "Global\PiPortable.Restart.$ParentPid")
  } catch { Send-Cmd ("ERROR:restart-event unavailable: " + $_.Exception.GetType().Name) }
  $script:ticks = 0
  $timer = New-Object System.Windows.Forms.Timer
  $timer.Interval = 100
  $timer.add_Tick({
    if ($restartEvent -and $restartEvent.WaitOne(0)) { $restartItem.PerformClick() }
    $script:ticks++
    if (($script:ticks % 20) -eq 0 -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) {
      $notify.Visible = $false
      [System.Windows.Forms.Application]::Exit()
    }
  })
  $timer.Start()
}

Send-Cmd "READY"
[System.Windows.Forms.Application]::Run()
if ($restartEvent) { $restartEvent.Dispose() }
$notify.Visible = $false
$notify.Dispose()
