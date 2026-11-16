# remove-with-data.ps1 -ProductCode <{…}>: the Start menu's "Remove HSN Hub and its data"
# (m2-design.md section 9, "Uninstalling"): a confirmation naming what is lost, then the .msi's
# removal with REMOVEDATA=1, elevated. Cancelling removes nothing. An uninstall from Settings keeps
# the data.
param([Parameter(Mandatory = $true)][string]$ProductCode)
Add-Type -AssemblyName System.Windows.Forms
$text = "This removes HSN Hub and all its data: every person, phone and setting, and every device's key, so each device must be paired again.`n`nIt cannot be undone. Remove HSN Hub and its data?"
$answer = [System.Windows.Forms.MessageBox]::Show($text, "Remove HSN Hub and its data", "YesNo", "Warning", "Button2")
if ($answer -ne "Yes") { exit 1 }
Start-Process -FilePath "msiexec.exe" -ArgumentList @("/x", $ProductCode, "REMOVEDATA=1") -Verb RunAs -Wait
