# build-msi.ps1 -Out <folder>
#
# Builds HSN-Hub-<version>.msi (m2-design.md section 9, Windows) on a Windows x64 machine (the
# hosted runner), from a checkout with the web app exported (`bun run app:export`). Needs Bun and
# WiX Toolset 5 with its UI and Util extensions (`dotnet tool install --global wix --version 5.*`,
# `wix extension add WixToolset.UI.wixext WixToolset.Util.wixext`, done by the workflow, not here).
# Downloads WinSW 2.12.0 and refuses it unless its SHA-256 is the one pinned in winsw.sha256; its
# licence is the copy kept beside this script (WinSW-LICENSE.txt), not downloaded. The hub
# folders' access list is A11's SDDL in hub-folder.sddl: the build refuses without it. The work
# folder is removed whatever happens.
#
# Every stage says itself ("build-msi: <stage>"), every command's whole output is printed, and a
# failure ends with one line, "build-msi: FAILED at <stage> (exit <n>): <the command>", so a hosted
# run's log names the step, the command, its exit code and the tool's own words.
param([Parameter(Mandatory = $true)][string]$Out)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = (Resolve-Path (Join-Path $here "..\..\..")).Path
$work = Join-Path ([System.IO.Path]::GetTempPath()) ("hsn-msi-" + [guid]::NewGuid())
$stage = "start"

# Runs a native command, printing all it says; throws, naming the stage and the command, on a
# non-zero exit.
function Invoke-Native([string]$Name, [string]$Shown, [scriptblock]$Command) {
  $script:stage = $Name
  Write-Output "build-msi: $Name"
  Write-Output "build-msi: > $Shown"
  # A tool's own words on standard error are output here, never a terminating error.
  $ErrorActionPreference = "Continue"
  $said = & $Command 2>&1
  $code = $LASTEXITCODE
  $ErrorActionPreference = "Stop"
  foreach ($line in @($said)) { Write-Output "  $line" }
  if ($code -ne 0) { throw "FAILED at $Name (exit $code): $Shown" }
}

New-Item -ItemType Directory -Force -Path $work | Out-Null
try {
  $stage = "the files beside build-msi.ps1"
  foreach ($f in @("hub-folder.sddl", "WinSW-LICENSE.txt", "hsn-hub.wix.xml", "prepare-upgrade.ps1")) {
    if (-not (Test-Path (Join-Path $here $f))) { throw "FAILED at ${stage}: $f is missing" }
  }
  $buildProgram = Join-Path $repo "hub\packaging\shared\build-program.ts"
  Invoke-Native "build-program.ts (the hub, the launcher, hsn)" "bun $buildProgram --target bun-windows-x64 --out $work\program" {
    & bun $buildProgram --target bun-windows-x64 --out "$work\program"
  }
  $version = (Get-Content "$work\program\version").Trim()
  Write-Output "build-msi: version $version"

  $bin = Join-Path $work "bin"
  New-Item -ItemType Directory -Force -Path $bin | Out-Null
  $stage = "WinSW 2.12.0 fetched"
  Write-Output "build-msi: $stage"
  Invoke-WebRequest -Uri "https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe" -OutFile "$work\WinSW-x64.exe"
  $pin = Join-Path $here "winsw-pin.ts"
  Invoke-Native "WinSW checked against winsw.sha256" "bun $pin $work\WinSW-x64.exe" {
    & bun $pin "$work\WinSW-x64.exe"
  }

  $stage = "the package's bin folder staged"
  Write-Output "build-msi: $stage"
  Copy-Item "$work\WinSW-x64.exe" "$bin\HSNHub.exe"
  Copy-Item "$work\program\bin\hsn-launcher.exe" $bin
  Copy-Item "$work\program\bin\hsn.exe" $bin
  foreach ($f in @("HSNHub.xml", "tree.ps1", "install-service.ps1", "uninstall-service.ps1", "remove-with-data.ps1", "hub-folder.sddl", "WinSW-LICENSE.txt")) {
    Copy-Item (Join-Path $here $f) $bin
  }
  Set-Content -Path "$bin\version" -Value $version -NoNewline -Encoding ascii
  Get-ChildItem $bin | ForEach-Object { Write-Output "  $($_.Name) $($_.Length)" }
  $prepare = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes((Get-Content (Join-Path $here "prepare-upgrade.ps1") -Raw)))

  New-Item -ItemType Directory -Force -Path $Out | Out-Null
  $msi = Join-Path $Out "HSN-Hub-$version.msi"
  $wxs = Join-Path $here "hsn-hub.wix.xml"
  Invoke-Native "wix build" "wix build -arch x64 -ext WixToolset.UI.wixext -ext WixToolset.Util.wixext -d Version=$version -d ProgramDir=$work\program -d BinDir=$bin -d PrepareUpgrade=<$($prepare.Length) characters> $wxs -o $msi" {
    & wix build -arch x64 -ext WixToolset.UI.wixext -ext WixToolset.Util.wixext -d "Version=$version" -d "ProgramDir=$work\program" -d "BinDir=$bin" -d "PrepareUpgrade=$prepare" $wxs -o $msi
  }
  Write-Output "build-msi: built $msi"
  Write-Output $msi
} catch {
  $message = $_.Exception.Message
  if ($message -notmatch '^FAILED at ') { $message = "FAILED at ${stage}: $message" }
  Write-Output "build-msi: $message"
  exit 1
} finally {
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $work
}
