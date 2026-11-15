# uninstall-service.ps1: the .msi's deferred, elevated custom action on removal (not on an upgrade):
# the service stopped and removed, the firewall's rules removed. The data folder is kept (section 9,
# "Uninstalling"); the program folder's versions the hub unpacked itself are removed with it.
$ErrorActionPreference = "Continue"
$LauncherDir = Join-Path $env:ProgramFiles "HSN Hub Launcher"
& (Join-Path $LauncherDir "HSNHub.exe") stop | Out-Null
& (Join-Path $LauncherDir "HSNHub.exe") uninstall | Out-Null
foreach ($name in @("HSN Hub devices", "HSN Hub apps", "HSN Hub mDNS")) {
  & netsh.exe advfirewall firewall delete rule name="$name" | Out-Null
}
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $env:ProgramFiles "HSN Hub")
exit 0
