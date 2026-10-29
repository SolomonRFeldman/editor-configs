# setup.ps1: sets up remote-winmux's server on this Windows machine (see
# bin/remote-winmux and bin/README.md). Run it from an elevated PowerShell 7 in
# this repository's clone:
#
#   .\setup.ps1
#
# It installs the server's packages with npm ci, adds the hooks that send
# Claude's state to the Mac to ~/.claude/settings.json, and registers a scheduled task,
# "remote-winmux", that starts the server when you sign in and restarts it if
# it dies. Run it again after moving the clone or changing Node.
#
# The server, and every session it starts, runs as a Claude you start from the
# desktop does: in your desktop session, not session 0, which has no display,
# so a program a session opens can show its window; and not elevated, since an
# Interactive logon at the limited run level gives an administrator the same
# filtered token Explorer has. So it runs only while you are signed in: from a
# reboot until you sign in there is no server, and signing out ends its
# sessions, though locking the screen doesn't and sleep only pauses them.
# conhost --headless gives Node its console without a window on the desktop.

param([string]$Repo = $PSScriptRoot)

$ErrorActionPreference = "Stop"

foreach ($tool in "node", "npm", "claude") {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "$tool isn't on PATH" }
}
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole("Administrators")) {
  throw "registering the task needs an elevated PowerShell"
}

# A server already running is stopped first: it holds node-pty's native
# module open, which npm ci can't then replace, and it keeps the pipe, so a new
# one would exit at once. Stopping the task doesn't stop it: mise's shim starts
# Node as a process of its own, which outlives the shim the task ends. Its
# sessions end with it.
Stop-ScheduledTask -TaskName "remote-winmux" -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -match "remote-winmux.? server" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep -Seconds 1

# mise's npm shim doesn't always pass npm's failure on, so the packages are
# also checked by loading them.
Push-Location (Join-Path $Repo "lib\remote-winmux")
try {
  npm ci --no-fund --no-audit
  if ($LASTEXITCODE) { throw "npm ci failed" }
  node -e "require('node-pty'); require('@xterm/headless'); require('@xterm/addon-serialize')"
  if ($LASTEXITCODE) { throw "npm ci left the server's packages incomplete" }
} finally { Pop-Location }

# Claude Code's hooks, which send its state in each session to the Mac's tabs;
# the rest of ~/.claude/settings.json is left as it is, after a backup.
node (Join-Path $Repo "bin\remote-winmux") install-hooks
if ($LASTEXITCODE) { throw "adding the hooks failed" }

# mise's shim follows mise to a new Node; a path into its installs would not.
$shim = Join-Path $env:LOCALAPPDATA "mise\shims\node.exe"
$node = if (Test-Path $shim) { $shim } else { (Get-Command node).Source }

$action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot "System32\conhost.exe") `
  -Argument "--headless `"$node`" `"$(Join-Path $Repo 'bin\remote-winmux')`" server" -WorkingDirectory $Repo
# Your account's full name from Windows itself: USERDOMAIN is WORKGROUP under sshd.
$me = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$triggers = @(New-ScheduledTaskTrigger -AtLogOn -User $me)
$principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

Register-ScheduledTask -TaskName "remote-winmux" -Action $action -Trigger $triggers -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName "remote-winmux"
Write-Host "remote-winmux's server is registered and started; its log is $env:LOCALAPPDATA\remote-winmux\server.log"
