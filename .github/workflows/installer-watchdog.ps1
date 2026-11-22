# Diagnostic only: started at a step's beginning; after $Seconds, if the step is still running,
# writes what everything is doing to the step's log, then ends the hsn and msiexec processes the
# step waits on, so the step ends and the job's log is kept.
param([int]$Seconds, [string]$Step, [int]$Parent)
# Gone quietly if the step ends first.
$end = (Get-Date).AddSeconds($Seconds)
while ((Get-Date) -lt $end) {
  if (-not (Get-Process -Id $Parent -ErrorAction SilentlyContinue)) {
    # The step's script has ended: say so, and what of ours is still alive (anything holding the
    # step's output open would keep the step from ending).
    [Console]::Out.WriteLine("DIAG $Step script ended: $(Get-Date -Format o)")
    Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'hsn|HSNHub|msiexec|winsw|pwsh|bun' } | ForEach-Object { [Console]::Out.WriteLine("DIAG alive $($_.ProcessId) parent $($_.ParentProcessId) $($_.Name): $($_.CommandLine)") }
    [Console]::Out.Flush()
    exit 0
  }
  Start-Sleep -Seconds 5
}
function Say([string]$Text) { [Console]::Out.WriteLine("DIAG $Text"); [Console]::Out.Flush() }
Say "$Step still running after $Seconds s: $(Get-Date -Format o)"
Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'hsn|HSNHub|msiexec|winsw' } | ForEach-Object { Say "proc $($_.ProcessId) parent $($_.ParentProcessId) $($_.Name) threads $($_.ThreadCount) started $($_.CreationDate): $($_.CommandLine)" }
& sc.exe queryex HSNHub | ForEach-Object { Say "sc $_" }
foreach ($name in @("hsn-hub", "hsn-launcher", "HSNHub", "hsn")) { foreach ($q in @(Get-Process $name -ErrorAction SilentlyContinue)) { Say "threads of $name $($q.Id): $(($q.Threads | ForEach-Object { "$($_.Id):$($_.ThreadState)/$($_.WaitReason)" }) -join ' ')" } }
$data = Join-Path $env:ProgramData "HSN Hub"
foreach ($file in Get-ChildItem -Path (Join-Path $data "logs") -Filter *.log -ErrorAction SilentlyContinue) { Say "===== $($file.Name) (last 80)"; Get-Content $file.FullName -Tail 80 | ForEach-Object { Say "  $_" } }
Say "===== launcher-status.json"; Get-Content (Join-Path $data "launcher-status.json") -ErrorAction SilentlyContinue | ForEach-Object { Say "  $_" }
Say "===== fatal.log"; Get-Content (Join-Path $data "fatal.log") -Tail 40 -ErrorAction SilentlyContinue | ForEach-Object { Say "  $_" }
Get-WinEvent -FilterHashtable @{ LogName = "System"; ProviderName = "Service Control Manager" } -MaxEvents 80 -ErrorAction SilentlyContinue | Where-Object { $_.Message -match 'HSN' } | ForEach-Object { Say "scm $($_.TimeCreated.ToString('o')) $($_.Id) $($_.Message)" }
Get-WinEvent -FilterHashtable @{ LogName = "Application"; ProviderName = "HSN Hub" } -MaxEvents 60 -ErrorAction SilentlyContinue | ForEach-Object { Say "app $($_.TimeCreated.ToString('o')) $($_.Id) $($_.Message)" }
Get-WinEvent -FilterHashtable @{ LogName = "Application"; ProviderName = "MsiInstaller" } -MaxEvents 20 -ErrorAction SilentlyContinue | ForEach-Object { Say "msi-event $($_.TimeCreated.ToString('o')) $($_.Id) $($_.Message)" }
foreach ($log in Get-ChildItem -Path $env:RUNNER_TEMP -Filter "msi-*.log" -ErrorAction SilentlyContinue) { Say "===== $($log.Name) (last 60)"; Get-Content $log.FullName -Tail 60 | ForEach-Object { Say "  $_" } }
foreach ($q in @(Get-Process hsn, msiexec -ErrorAction SilentlyContinue)) { Say "ending $($q.Name) $($q.Id)"; Stop-Process -Id $q.Id -Force -ErrorAction SilentlyContinue }
Say "watchdog done: $(Get-Date -Format o)"
