# install-service.ps1 -Version <v> [-UserSid <S-1-5-…> -LocalAppData <folder>]
#
# The .msi's deferred, elevated custom action (m2-design.md section 9, Windows; spikes W2, W3), at
# install and at every upgrade:
#   1. the service registered by WinSW, under NT SERVICE\HSNHub, start type automatic;
#   2. the data folder's access list: protected, full control for NT SERVICE\HSNHub, Administrators
#      (S-1-5-32-544) and SYSTEM (S-1-5-18), nothing else, on the folder and everything in it;
#   3. the program folder writable by the service account (it unpacks updates there), the
#      launcher's folder readable only;
#   4. this version selected by the launcher;
#   5. the firewall's rules for the two LAN ports and mDNS;
#   6. the service started; on a fresh install the first console page written for the installing
#      user (below); and the event log's source "HSN Hub", which the launcher writes failures to.
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$UserSid = "",
  [string]$LocalAppData = ""
)
$ErrorActionPreference = "Stop"
$Service = "HSNHub"
$Account = "NT SERVICE\HSNHub"
$Prefix = Join-Path $env:ProgramFiles "HSN Hub"
$LauncherDir = Join-Path $env:ProgramFiles "HSN Hub Launcher"
$Data = Join-Path $env:ProgramData "HSN Hub"
$fresh = -not (Test-Path (Join-Path $Data "hub.db"))

# 1. The service.
& sc.exe query $Service *> $null
if ($LASTEXITCODE -ne 0) {
  & (Join-Path $LauncherDir "HSNHub.exe") install
  if ($LASTEXITCODE -ne 0) { throw "WinSW could not install the service" }
}
& sc.exe config $Service obj= $Account start= auto | Out-Null
if ($LASTEXITCODE -ne 0) { throw "sc.exe config failed" }

# 2. The data folder's access list: set here at every install and upgrade, whatever was there.
New-Item -ItemType Directory -Force -Path $Data | Out-Null
$sid = (New-Object System.Security.Principal.NTAccount($Account)).Translate([System.Security.Principal.SecurityIdentifier])
$admins = New-Object System.Security.Principal.SecurityIdentifier("S-1-5-32-544")
$system = New-Object System.Security.Principal.SecurityIdentifier("S-1-5-18")
$acl = New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true, $false)
$acl.SetOwner($admins)
foreach ($who in @($sid, $admins, $system)) {
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($who, "FullControl", "ContainerInherit,ObjectInherit", "None", "Allow")
  $acl.AddAccessRule($rule)
}
Set-Acl -Path $Data -AclObject $acl
# Everything inside takes only what the folder gives: no entry of its own survives.
Get-ChildItem -LiteralPath $Data -Recurse -Force | ForEach-Object { & icacls.exe $_.FullName /reset /Q | Out-Null }

# 3. The program folder and the launcher's.
New-Item -ItemType Directory -Force -Path (Join-Path $Prefix "state") | Out-Null
& icacls.exe $Prefix /grant "${Account}:(OI)(CI)M" /Q | Out-Null
& icacls.exe $LauncherDir /grant "${Account}:(OI)(CI)RX" /Q | Out-Null

# 4. This version.
& (Join-Path $LauncherDir "hsn-launcher.exe") --prefix $Prefix --select $Version
if ($LASTEXITCODE -ne 0) { throw "the launcher could not select $Version" }

# 5. The firewall.
$rules = @(
  @{ Name = "HSN Hub devices"; Protocol = "TCP"; Port = "8443" },
  @{ Name = "HSN Hub apps"; Protocol = "TCP"; Port = "8444" },
  @{ Name = "HSN Hub mDNS"; Protocol = "UDP"; Port = "5353" }
)
foreach ($r in $rules) {
  & netsh.exe advfirewall firewall delete rule name="$($r.Name)" | Out-Null
  & netsh.exe advfirewall firewall add rule name="$($r.Name)" dir=in action=allow protocol=$($r.Protocol) localport=$($r.Port) profile=private,domain | Out-Null
}

# 6. The event log's source, the service started, the setup page on a fresh install.
& eventcreate.exe /L APPLICATION /SO "HSN Hub" /T INFORMATION /ID 1 /D "HSN Hub $Version installed" | Out-Null
& sc.exe start $Service | Out-Null
if (-not $fresh) { exit 0 }
# The setup page (section 9): the token asked for here, elevated, and written into the installing
# user's own folder, which only that user, SYSTEM and Administrators can read; the Finish dialog
# opens the page's path from the installer's interface, unelevated. Nothing secret is on a command
# line. A silent install passes no user, and opens nothing.
if ($UserSid -eq "" -or $LocalAppData -eq "") { exit 0 }
$socket = Join-Path $Data "control.sock"
for ($i = 0; $i -lt 60 -and -not (Test-Path $socket); $i++) { Start-Sleep -Seconds 1 }
$program = Join-Path $Prefix "current\bin\hsn-hub.exe"
& $program installer-page --data $Data --sid $UserSid --folder (Join-Path $LocalAppData "HSN Hub") | Out-Null
exit 0
