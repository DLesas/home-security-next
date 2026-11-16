# install-service.ps1 -Version <v> [-UILevel <n> -UserSid <S-1-5-…> -LocalAppData <folder>]
#
# The .msi's deferred, elevated custom action at install and at every upgrade (m2-design.md
# section 9, Windows, and "The privilege boundary"), run from the package's tree only:
#   1. each hub tree's top folder (%ProgramData%\HSN Hub, %ProgramData%\HSN Hub Program) made or
#      checked and its access list set on that folder alone (tree.ps1): never its contents. First,
#      before anything is made inside: WinSW's `install` writes logs\wrapper.log in the data folder
#      as SYSTEM, and what is made before the shaping keeps %ProgramData%'s own list (run
#      43872833188: the hub could not then close logs\, Windows error 5);
#   2. the service registered by WinSW, under NT SERVICE\HSNHub, start type automatic;
#   3. the package's tree, %ProgramFiles%\HSN Hub: the service account may read and run it only;
#      the version this package replaced kept beside the new one, then at most two;
#   4. the firewall's rules for the two LAN ports and mDNS;
#   5. the event log's source "HSN Hub", the service started;
#   6. on a fresh install (the registry's marker, not the hub's files), with a person at the full
#      interface, the first console page written for the installing user through the package's
#      own hsn. A silent install (any interface below the full one) makes no token and no page.
# It never runs anything from a hub tree and never chooses a version: the launcher does, as the
# service account, at its next start.
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [int]$UILevel = 2,
  [string]$UserSid = "",
  [string]$LocalAppData = ""
)
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "tree.ps1")
$Service = "HSNHub"
$Account = "NT SERVICE\HSNHub"
$Package = Join-Path $env:ProgramFiles "HSN Hub"
$Bin = Join-Path $Package "bin"
$Data = Join-Path $env:ProgramData "HSN Hub"
$Program = Join-Path $env:ProgramData "HSN Hub Program"
$Marker = "HKLM:\Software\HSN Hub"
$fresh = -not ((Get-ItemProperty -Path $Marker -Name Installed -ErrorAction SilentlyContinue).Installed -eq 1)

# 1. The hub's two trees: their top folders only, before anything is made inside them. The list
# names the service's SID, which Windows derives from its name whether or not the service exists.
Set-HubTopFolder $Data
Set-HubTopFolder $Program

# 2. The service.
& sc.exe query $Service *> $null
if ($LASTEXITCODE -ne 0) {
  & (Join-Path $Bin "HSNHub.exe") install
  if ($LASTEXITCODE -ne 0) { throw "WinSW could not install the service" }
}
& sc.exe config $Service obj= $Account start= auto | Out-Null
if ($LASTEXITCODE -ne 0) { throw "sc.exe config failed" }

# 3. The package's tree: Administrators' and SYSTEM's; the service account reads and runs it.
& icacls.exe $Package /grant "${Account}:(OI)(CI)RX" /Q | Out-Null
if ($LASTEXITCODE -ne 0) { throw "icacls on $Package failed" }
$packaged = Join-Path $Package "packaged"
$kept = Join-Path $Package "kept"
if (Test-Path -LiteralPath $kept) {
  foreach ($old in Get-ChildItem -LiteralPath $kept -Directory) {
    $to = Join-Path $packaged $old.Name
    if (-not (Test-Path -LiteralPath $to)) { Move-Item -LiteralPath $old.FullName -Destination $to }
  }
  Remove-TreeSafely $kept
}
$others = @(Get-ChildItem -LiteralPath $packaged -Directory | Where-Object { $_.Name -ne $Version -and $_.Name -match '^\d+\.\d+\.\d+' } |
  Sort-Object { [version]($_.Name -replace '[-+].*$', '') } -Descending)
foreach ($extra in ($others | Select-Object -Skip 1)) { Remove-TreeSafely $extra.FullName }

# 4. The firewall.
$rules = @(
  @{ Name = "HSN Hub devices"; Protocol = "TCP"; Port = "8443" },
  @{ Name = "HSN Hub apps"; Protocol = "TCP"; Port = "8444" },
  @{ Name = "HSN Hub mDNS"; Protocol = "UDP"; Port = "5353" }
)
foreach ($r in $rules) {
  & netsh.exe advfirewall firewall delete rule name="$($r.Name)" | Out-Null
  & netsh.exe advfirewall firewall add rule name="$($r.Name)" dir=in action=allow protocol=$($r.Protocol) localport=$($r.Port) profile=private,domain | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "the firewall rule $($r.Name) failed" }
}

# 5. The event log's source, the marker, the service started.
if (-not [System.Diagnostics.EventLog]::SourceExists("HSN Hub")) {
  [System.Diagnostics.EventLog]::CreateEventSource("HSN Hub", "Application")
}
New-Item -Path $Marker -Force | Out-Null
Set-ItemProperty -Path $Marker -Name Installed -Value 1 -Type DWord
& sc.exe start $Service | Out-Null
if (-not $fresh) { exit 0 }

# 6. The setup page, only with a person at the full interface (UILevel 5): the token asked for
# through the package's own hsn, elevated, and written into the installing user's own folder,
# which only that user, SYSTEM and Administrators can read; the Finish dialog opens the page's
# path from the installer's interface, unelevated. Nothing secret is on a command line.
if ($UILevel -lt 5 -or $UserSid -eq "" -or $LocalAppData -eq "") { exit 0 }
$hsn = Join-Path $Bin "hsn.exe"
for ($i = 0; $i -lt 60; $i++) {
  & $hsn --data $Data status *> $null
  if ($LASTEXITCODE -eq 0) { break }
  Start-Sleep -Seconds 1
}
# The folder arrives with a trailing "." (hsn-hub.wix.xml: a trailing backslash would escape the
# closing quote).
$folder = Join-Path ($LocalAppData.TrimEnd('.').TrimEnd('\')) "HSN Hub"
# The package's own program, root's (Administrators'), never a version the hub staged.
$own = Join-Path $Package "packaged\$Version\bin\hsn-hub.exe"
& $own installer-page --data $Data --sid $UserSid --folder $folder
if ($LASTEXITCODE -ne 0) {
  # The install stands: the page is the person's to open later from the Start menu.
  Write-Warning "the setup page could not be written; use the Start menu's HSN Hub setup"
}
exit 0
