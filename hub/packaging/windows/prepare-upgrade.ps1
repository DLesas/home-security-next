# prepare-upgrade.ps1: run by the .msi, elevated, before the old version's files are removed by a
# major upgrade (m2-design.md section 9, "A package upgrade keeps the previous version"): the
# service stopped, waiting until it has, and the packaged versions copied aside inside the
# package's own tree (%ProgramFiles%\HSN Hub\kept), so install-service.ps1 puts the one before
# back beside the new one. Passed to PowerShell encoded by build-msi.ps1, since the new package's
# files are not on disk yet. Never touches a hub tree.
# It cannot dot-source tree.ps1 (the old install may have none), so its two waits are written out
# here as tree.ps1's Stop-HubService does them: the service stopped, then every process of the
# service's account ended, so no file of the old version is still in use.
$ErrorActionPreference = "Continue"
$service = Get-Service -Name HSNHub -ErrorAction SilentlyContinue
if ($null -ne $service -and $service.Status -ne "Stopped") {
  Stop-Service -Name HSNHub -Force
  $service.WaitForStatus("Stopped", [TimeSpan]::FromSeconds(60))
}
for ($i = 0; $i -lt 30; $i++) {
  $left = @(Get-CimInstance Win32_Process | Where-Object {
    $owner = Invoke-CimMethod -InputObject $_ -MethodName GetOwner -ErrorAction SilentlyContinue
    $owner.Domain -eq "NT SERVICE" -and $owner.User -eq "HSNHub"
  })
  if ($left.Count -eq 0) { break }
  Start-Sleep -Seconds 1
}
$package = Join-Path $env:ProgramFiles "HSN Hub"
$packaged = Join-Path $package "packaged"
$kept = Join-Path $package "kept"
if (Test-Path -LiteralPath $packaged) {
  & robocopy.exe $packaged $kept /E /XJ /R:0 /W:0 /NFL /NDL /NJH /NJS | Out-Null
}
exit 0
