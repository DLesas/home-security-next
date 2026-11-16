# uninstall-service.ps1 [-RemoveData <0|1>]: the .msi's deferred, elevated custom action on removal
# (not on an upgrade; m2-design.md section 9, "Uninstalling" and "The privilege boundary"): the
# service stopped (waiting until every process of its account has ended) and removed, the
# firewall's rules, the event log's source and the marker removed, and the package's tree removed
# whole. The hub's two trees are kept, unless "Remove HSN Hub and its data" (REMOVEDATA=1, after
# its confirmation): then each is removed whole, every reparse point as itself (tree.ps1).
param([string]$RemoveData = "")
$ErrorActionPreference = "Continue"
. (Join-Path $PSScriptRoot "tree.ps1")
$Package = Join-Path $env:ProgramFiles "HSN Hub"
# A hub that will not stop keeps its data: nothing is removed under a running hub.
$stopped = $true
try { Stop-HubService } catch { $stopped = $false; Write-Warning "the hub did not stop: $_" }
& (Join-Path $Package "bin\HSNHub.exe") uninstall | Out-Null
foreach ($name in @("HSN Hub devices", "HSN Hub apps", "HSN Hub mDNS")) {
  & netsh.exe advfirewall firewall delete rule name="$name" | Out-Null
}
if ([System.Diagnostics.EventLog]::SourceExists("HSN Hub")) { [System.Diagnostics.EventLog]::DeleteEventSource("HSN Hub") }
Remove-Item -Path "HKLM:\Software\HSN Hub" -Force -ErrorAction SilentlyContinue
# The versions the package kept beyond its own files; the installer removes the rest.
foreach ($name in @("packaged", "kept")) { Remove-TreeSafely (Join-Path $Package $name) }
if ($RemoveData -eq "1" -and $stopped) {
  Remove-TreeSafely (Join-Path $env:ProgramData "HSN Hub")
  Remove-TreeSafely (Join-Path $env:ProgramData "HSN Hub Program")
}
exit 0
