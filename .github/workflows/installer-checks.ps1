# installer-checks.ps1: dot-sourced by installers.yml's Windows steps (PowerShell 7), owner A9.
#
# The same rules as installer-checks.sh: every check appends one line to the job summary and never
# stops the step; a failure is counted in $HsnChecks\failures, and the job's last step fails when
# that file has any line. Logs are copied only after Hide-Secrets, into $HsnChecks\logs, the one
# folder uploaded.
#
# A check is a script block whose last output is $true for a pass, or a string saying why not.

$ErrorActionPreference = "Continue"
$HsnChecks = Join-Path $env:RUNNER_TEMP "hsn-checks"
New-Item -ItemType Directory -Force -Path (Join-Path $HsnChecks "logs") | Out-Null
$HsnFailures = Join-Path $HsnChecks "failures"
if (-not (Test-Path $HsnFailures)) { New-Item -ItemType File -Path $HsnFailures | Out-Null }

function Write-Summary([string[]]$Lines) {
  Add-Content -Path $env:GITHUB_STEP_SUMMARY -Value $Lines -Encoding utf8
}
function Write-Heading([string]$Text) { Write-Summary @("", "### $Text", "") }

# Hides anything that could be a secret (as installer-checks.sh's `redact`); GUIDs are kept, so
# that an installer's log stays readable.
function Hide-Secrets([string]$Text) {
  if ($null -eq $Text) { return "" }
  $t = $Text -replace 'hsn://[^\s"]+', 'hsn://[redacted]'
  $t = $t -replace '(https?://[^\s"#]*)#[^\s"]+', '$1#[redacted]'
  $t = $t -replace '("(code|token|secret|url|qr|key|psk|password|backupKey)"\s*:\s*)"[^"]*"', '$1"[redacted]"'
  $t = [regex]::Replace($t, '[A-Za-z0-9_-]{32,}', {
      param($m)
      if ($m.Value -match '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$') { $m.Value } else { '[redacted]' }
    })
  $t -replace '[A-Za-z0-9+/]{40,}={0,2}', '[redacted]'
}

function ConvertTo-OneLine([string]$Text) {
  $one = ((Hide-Secrets $Text) -replace '\s+', ' ').Trim()
  if ($one.Length -gt 300) { $one.Substring(0, 300) } else { $one }
}

function Write-Pass([string]$Name, [string]$Detail = "") {
  Write-Summary ("- ✅ $Name" + $(if ($Detail) { " — $Detail" } else { "" }))
}
function Write-Fail([string]$Name, [string]$Detail = "") {
  Write-Summary ("- ❌ $Name" + $(if ($Detail) { " — $(ConvertTo-OneLine $Detail)" } else { "" }))
  Add-Content -Path $HsnFailures -Value $Name -Encoding utf8
  Write-Host "::error title=installer check failed::$Name"
}
function Write-Info([string]$Name, [string]$Detail = "") {
  Write-Summary ("- ℹ️ $Name" + $(if ($Detail) { " — $(ConvertTo-OneLine $Detail)" } else { "" }))
}
function Write-Warn([string]$Name, [string]$Detail = "") {
  Write-Summary ("- ⚠️ $Name" + $(if ($Detail) { " — $(ConvertTo-OneLine $Detail)" } else { "" }))
}

function Test-Check([string]$Name, [scriptblock]$Test) {
  try {
    $result = @(& $Test)
    $last = if ($result.Count -gt 0) { $result[-1] } else { $null }
    if ($last -eq $true) { Write-Pass $Name }
    elseif ($last -is [string]) { Write-Fail $Name $last }
    else { Write-Fail $Name "the check gave no answer" }
  }
  catch { Write-Fail $Name $_.Exception.Message }
}

# Runs the block every 2 s until it gives $true, at most $Seconds.
function Wait-Until([int]$Seconds, [scriptblock]$Test) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  do {
    $result = @(& $Test)
    if ($result.Count -gt 0 -and $result[-1] -eq $true) { return $true }
    Start-Sleep -Seconds 2
  } while ((Get-Date) -lt $deadline)
  return $false
}

# A file's redacted copy into the uploaded logs, and its tail in the summary.
# The job stops here: the reason in the environment (later steps skip on it) and as the error.
function Stop-Job([string]$Why) {
  "HSN_STOPPED=$Why" | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
  Write-Host "::error title=stopped::$Why"
  exit 1
}

function Save-Log([string]$Name, [string]$Source, [int]$Lines = 40) {
  if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) {
    Write-Info $Name "not present at $Source"
    return
  }
  $text = Get-Content -LiteralPath $Source -Raw -ErrorAction SilentlyContinue
  Save-Text $Name $text $Lines
}

# A8's hub/packaging/hosted/check.ps1, elevated (this job is); one line per step, its output
# redacted before it is shown or kept. (Not $Name or $Command here: names ignore case, and a
# caller's script block would see these instead of its own.)
function Invoke-Hosted([string]$HostedStep, [string]$HostedCommand = "") {
  $hostedArgs = @("-NoProfile", "-File", "hub/packaging/hosted/check.ps1", "-Step", $HostedStep)
  if ($HostedCommand -ne "") { $hostedArgs += @("-Command", $HostedCommand) }
  $hostedOut = (& pwsh @hostedArgs 2>&1 | Out-String)
  $hostedCode = $LASTEXITCODE
  Add-Content -Path (Join-Path $HsnChecks "logs\hosted-checks.txt") -Value @("== check.ps1 $HostedStep (exit $hostedCode)", (Hide-Secrets $hostedOut)) -Encoding utf8
  Write-Host "::group::check.ps1 $HostedStep (exit $hostedCode, whole, redacted)"
  Write-Host (Hide-Secrets $hostedOut)
  Write-Host "::endgroup::"
  $lastLines = (($hostedOut -split "`r?`n") | Where-Object { $_ } | Select-Object -Last 3) -join " "
  if ($hostedCode -eq 0) { Write-Pass "A8's hosted check ``$HostedStep``" (ConvertTo-OneLine $lastLines) }
  else { Write-Fail "A8's hosted check ``$HostedStep``" "exit ${hostedCode}: $lastLines" }
}

function Save-Text([string]$Name, [string]$Text, [int]$Lines = 40) {
  $target = Join-Path $HsnChecks "logs\$Name"
  $hidden = Hide-Secrets $Text
  Set-Content -LiteralPath $target -Value $hidden -Encoding utf8
  # The whole of it in the log too (redacted), so a first run reads from `gh run view --log` alone.
  Write-Host "::group::$Name (whole, redacted)"
  Write-Host $hidden
  Write-Host "::endgroup::"
  $tail = @($hidden -split "`r?`n" | Select-Object -Last $Lines)
  Write-Summary (@("", "<details><summary>$Name (last $Lines lines, redacted)</summary>", "", '```') + $tail + @('```', "", "</details>"))
}
