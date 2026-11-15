# build-msi.ps1 -Out <folder>
#
# Builds HSN-Hub-<version>.msi (m2-design.md section 9, Windows) on a Windows x64 machine (the
# hosted runner), from a checkout with the web app exported (`bun run app:export`). Needs Bun and
# WiX Toolset 5 with its UI and Util extensions (`dotnet tool install --global wix --version 5.*`,
# `wix extension add WixToolset.UI.wixext WixToolset.Util.wixext`, done by the workflow, not here).
# Downloads WinSW 2.12.0 and refuses it unless its SHA-256 is the one pinned in winsw.sha256.
param([Parameter(Mandatory = $true)][string]$Out)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Resolve-Path (Join-Path $here "..\..\..")
$work = Join-Path ([System.IO.Path]::GetTempPath()) ("hsn-msi-" + [guid]::NewGuid())
New-Item -ItemType Directory -Force -Path $work | Out-Null

& bun (Join-Path $repo "hub\packaging\shared\build-program.ts") --target bun-windows-x64 --out "$work\program" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "build-program failed" }
$version = (Get-Content "$work\program\version").Trim()

$launcher = Join-Path $work "launcher"
New-Item -ItemType Directory -Force -Path $launcher | Out-Null
$release = "https://github.com/winsw/winsw/releases/download/v2.12.0"
Invoke-WebRequest -Uri "$release/WinSW-x64.exe" -OutFile "$work\WinSW-x64.exe"
& bun (Join-Path $here "winsw-pin.ts") "$work\WinSW-x64.exe"
if ($LASTEXITCODE -ne 0) { throw "WinSW is not the pinned file" }
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/winsw/winsw/v2.12.0/LICENSE.txt" -OutFile "$launcher\WinSW-LICENSE.txt"
Copy-Item "$work\WinSW-x64.exe" "$launcher\HSNHub.exe"
Copy-Item "$work\program\launcher\hsn-launcher.exe" $launcher
foreach ($f in @("HSNHub.xml", "hsn.cmd", "install-service.ps1", "uninstall-service.ps1")) { Copy-Item (Join-Path $here $f) $launcher }

New-Item -ItemType Directory -Force -Path $Out | Out-Null
& wix build -arch x64 -ext WixToolset.UI.wixext -ext WixToolset.Util.wixext -d "Version=$version" -d "ProgramDir=$work\program" -d "LauncherDir=$launcher" `
  (Join-Path $here "hsn-hub.wix.xml") -o (Join-Path $Out "HSN-Hub-$version.msi")
if ($LASTEXITCODE -ne 0) { throw "wix build failed" }
Write-Output (Join-Path $Out "HSN-Hub-$version.msi")
