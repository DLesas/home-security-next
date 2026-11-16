# check.ps1 <step> [<command>]: the installer's checks on a hosted Windows machine, elevated
# (m2-design.md section 9, "The privilege boundary", "Tested on the hosted machines"), called by
# A9's installer workflow around the .msi's install, upgrade, uninstall and "Remove HSN Hub and
# its data" (msiexec /x <product> REMOVEDATA=1):
#
#   owners     the package's tree Administrators' and SYSTEM's, NT SERVICE\HSNHub with Read and
#              Execute only on it; each hub tree's top folder a plain folder owned by
#              Administrators; the list's service SID Windows' own; and the hub's own verdict:
#              plain `hsn status`, the package's bin\hsn.exe found on the PATH, answers
#   plant      protected targets outside every tree (a file and a folder), and in each hub tree, at
#              its top and below it: a junction and a symbolic link to the folder, and a mount
#              point of the system volume; the targets' owners, access lists and contents noted
#   verify     after an upgrade, an uninstall or a removal with data: every target present and
#              unchanged, the system volume's files untouched
#   link-top   a hub tree's top folder replaced by a junction; the installer step <command> must
#              refuse; the folder put back
#   console    "the console opens" with no desktop: the console listener's page and headers
#
# Each exits non-zero, saying what failed.
param([Parameter(Mandatory = $true)][string]$Step, [string]$Command = "")
$ErrorActionPreference = "Stop"
$Package = Join-Path $env:ProgramFiles "HSN Hub"
$Data = Join-Path $env:ProgramData "HSN Hub"
$Program = Join-Path $env:ProgramData "HSN Hub Program"
$Targets = Join-Path $env:SystemDrive "hsn-plant-targets"
$Notes = Join-Path $env:SystemDrive "hsn-plant-notes.txt"
function Fail([string]$why) { Write-Error "check: $why"; exit 1 }
function Note([string]$path) {
  $acl = (Get-Acl -LiteralPath $path).Sddl
  $hash = if (Test-Path -LiteralPath $path -PathType Leaf) { (Get-FileHash -LiteralPath $path).Hash } else { "folder" }
  return "$path|$acl|$hash"
}

switch ($Step) {
  "owners" {
    foreach ($item in @(Get-Item -LiteralPath $Package) + @(Get-ChildItem -LiteralPath $Package -Recurse -Force)) {
      $acl = Get-Acl -LiteralPath $item.FullName
      if ($acl.Owner -notin @("BUILTIN\Administrators", "NT AUTHORITY\SYSTEM")) { Fail "$($item.FullName) is owned by $($acl.Owner)" }
      foreach ($rule in $acl.Access) {
        $who = $rule.IdentityReference.Value
        if ($who -in @("BUILTIN\Administrators", "NT AUTHORITY\SYSTEM", "NT SERVICE\TrustedInstaller", "CREATOR OWNER")) { continue }
        $writes = [System.Security.AccessControl.FileSystemRights]"Write, Modify, FullControl, Delete, ChangePermissions, TakeOwnership, CreateFiles, AppendData"
        if (($rule.AccessControlType -eq "Allow") -and ($rule.FileSystemRights -band $writes)) { Fail "$who may write $($item.FullName)" }
      }
    }
    foreach ($top in @($Data, $Program)) {
      $item = Get-Item -LiteralPath $top -Force
      if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { Fail "$top is a reparse point" }
      if ((Get-Acl -LiteralPath $top).Owner -ne "BUILTIN\Administrators") { Fail "$top is not owned by Administrators" }
    }
    # The service SID the folders' list names is the one Windows derives from the service's name.
    . (Join-Path $Package "bin\tree.ps1")
    Assert-ServiceSid (Get-HubFolderSddl)
    # The hub's own verdict: as the service it refuses to open its socket while a top folder is
    # open, so plain `hsn status` (on the machine's PATH, as a person types it) answering is the
    # check that the installer's lists are what the hub's checker accepts.
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $hsn = (Get-Command hsn -ErrorAction SilentlyContinue).Source
    if ($hsn -ne (Join-Path $Package "bin\hsn.exe")) { Fail "hsn on the PATH is '$hsn', not the package's bin\hsn.exe" }
    $status = $null
    for ($i = 0; $i -lt 60; $i++) {
      $status = & hsn status 2>&1 | Out-String
      if ($LASTEXITCODE -eq 0) { break }
      Start-Sleep -Seconds 1
    }
    if ($LASTEXITCODE -ne 0) { Fail "plain hsn status did not reach the hub: $status" }
    Write-Output "check: owners and access lists as section 9 has them"
  }
  "plant" {
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $Targets
    New-Item -ItemType Directory -Force -Path (Join-Path $Targets "folder") | Out-Null
    Set-Content -LiteralPath (Join-Path $Targets "file") -Value "a protected file"
    Set-Content -LiteralPath (Join-Path $Targets "folder\inside") -Value "inside a protected folder"
    & icacls.exe $Targets /inheritance:r /grant:r "*S-1-5-32-544:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" /Q | Out-Null
    $notes = @((Note (Join-Path $Targets "file")), (Note (Join-Path $Targets "folder")), (Note (Join-Path $Targets "folder\inside")))
    $volume = (& mountvol.exe $env:SystemDrive /L).Trim()
    $notes += "volume|$volume|$((Get-ChildItem -LiteralPath "$env:SystemDrive\" -Force | Measure-Object).Count)"
    Set-Content -LiteralPath $Notes -Value $notes
    foreach ($tree in @($Data, $Program)) {
      foreach ($at in @($tree, (Join-Path $tree "staged"))) {
        New-Item -ItemType Directory -Force -Path $at | Out-Null
        & cmd.exe /c mklink /J "$at\planted-junction" "$Targets\folder" | Out-Null
        & cmd.exe /c mklink /D "$at\planted-symlink" "$Targets\folder" | Out-Null
        New-Item -ItemType Directory -Force -Path "$at\planted-mount" | Out-Null
        & mountvol.exe "$at\planted-mount" $volume | Out-Null
      }
    }
    Write-Output "check: planted"
  }
  "verify" {
    $notes = Get-Content -LiteralPath $Notes
    foreach ($line in $notes) {
      $path = $line.Split("|")[0]
      if ($path -eq "volume") {
        $count = (Get-ChildItem -LiteralPath "$env:SystemDrive\" -Force | Measure-Object).Count
        if ("$count" -ne $line.Split("|")[2]) { Fail "the system volume's top changed" }
        continue
      }
      if (-not (Test-Path -LiteralPath $path)) { Fail "$path is gone" }
      if ((Note $path) -ne $line) { Fail "$path changed" }
    }
    Write-Output "check: every target unchanged"
  }
  "link-top" {
    if ($Command -eq "") { Fail "link-top needs the installer step to run" }
    Rename-Item -LiteralPath $Data -NewName "HSN Hub.moved"
    New-Item -ItemType Directory -Force -Path (Join-Path $Targets "folder") | Out-Null
    & cmd.exe /c mklink /J "$Data" "$Targets\folder" | Out-Null
    & cmd.exe /c $Command | Out-Null
    $refused = $LASTEXITCODE -ne 0
    [System.IO.Directory]::Delete($Data, $false)
    Rename-Item -LiteralPath "$Data.moved" -NewName "HSN Hub"
    if (-not $refused) { Fail "the installer did not refuse a top folder replaced by a junction" }
    Write-Output "check: refused"
  }
  "console" {
    # On a runner with no desktop "the console opens" means (section 9): the console listener
    # answers http://127.0.0.1:8445/ with the web app's page and section 5's headers. Opening a
    # browser is a person's check; `hsn open`'s printed code is the CLI's (A2) and not judged here.
    $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:8445/"
    if ($response.StatusCode -ne 200) { Fail "the console listener answered $($response.StatusCode)" }
    if (-not $response.Headers["Content-Security-Policy"]) { Fail "the console page has no CSP header" }
    if ($response.Content -notmatch "<html") { Fail "the console page is not the web app's" }
    Write-Output "check: the console opens (no desktop)"
  }
  default { Fail "usage: check.ps1 owners | plant | verify | link-top <command> | console" }
}
