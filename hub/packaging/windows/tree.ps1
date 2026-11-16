# tree.ps1: the elevated installer's two ways into a hub tree (m2-design.md section 9, "The
# privilege boundary"), dot-sourced by install-service.ps1, uninstall-service.ps1 and the hosted
# checks. Nothing else elevated touches %ProgramData%\HSN Hub or %ProgramData%\HSN Hub Program.
#
# - Set-HubTopFolder: the top folder made if missing, refused unless it is a plain folder (no
#   reparse point: no junction, symbolic link or mount point), and its owner and access list set
#   on its own handle, opened without following a reparse point, by SetKernelObjectSecurity, which
#   never propagates into the contents. The list is the hub checker's own SDDL (A11's), from
#   hub-folder.sddl beside this file, so the installer and the checker cannot disagree.
# - Remove-TreeSafely: a whole tree removed with the service stopped, every reparse point removed
#   as itself (RemoveDirectoryW or DeleteFileW on the point) and never entered; a hard link only
#   loses a name. PowerShell's Remove-Item -Recurse is not used.
Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class HsnTree {
  const uint READ_CONTROL = 0x00020000, WRITE_DAC = 0x00040000, WRITE_OWNER = 0x00080000;
  const uint FILE_READ_ATTRIBUTES = 0x80, OPEN_EXISTING = 3, SHARE_ALL = 7;
  const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000, FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
  const uint FILE_ATTRIBUTE_DIRECTORY = 0x10, FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
  const uint OWNER = 1, DACL = 4, PROTECTED_DACL = 0x80000000;
  [StructLayout(LayoutKind.Sequential)]
  struct Info { public uint Attributes; public long C, A, W; public uint Serial, SizeHigh, SizeLow, Links, IndexHigh, IndexLow; }
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr sa, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetFileInformationByHandle(SafeFileHandle h, out Info info);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string sddl, uint revision, out IntPtr sd, out uint size);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool SetKernelObjectSecurity(SafeFileHandle h, uint what, IntPtr sd);
  [DllImport("kernel32.dll")]
  static extern IntPtr LocalFree(IntPtr p);
  public static void SetTop(string path, string sddl) {
    using (var h = CreateFileW(path, READ_CONTROL | WRITE_DAC | WRITE_OWNER | FILE_READ_ATTRIBUTES, SHARE_ALL, IntPtr.Zero,
        OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero)) {
      if (h.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(), "open " + path);
      Info info;
      if (!GetFileInformationByHandle(h, out info)) throw new Win32Exception(Marshal.GetLastWin32Error(), "inspect " + path);
      if ((info.Attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) throw new InvalidOperationException(path + " is a reparse point");
      if ((info.Attributes & FILE_ATTRIBUTE_DIRECTORY) == 0) throw new InvalidOperationException(path + " is not a folder");
      IntPtr sd; uint size;
      if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, out sd, out size)) throw new Win32Exception(Marshal.GetLastWin32Error(), "the SDDL");
      try {
        if (!SetKernelObjectSecurity(h, OWNER | DACL | PROTECTED_DACL, sd)) throw new Win32Exception(Marshal.GetLastWin32Error(), "set " + path);
      } finally { LocalFree(sd); }
    }
  }
}
"@

function Get-HubFolderSddl {
  $file = Join-Path $PSScriptRoot "hub-folder.sddl"
  if (-not (Test-Path -LiteralPath $file)) { throw "hub-folder.sddl is missing: the hub folders' access list is A11's (pending)" }
  $sddl = (Get-Content -LiteralPath $file -Raw).Trim()
  if ($sddl -notmatch '^O:BA') { throw "hub-folder.sddl does not make Administrators the owner" }
  return $sddl
}

# The service's own SID in the list must be the one Windows derives from the service's name: the
# whole boundary rests on that match, so the installer refuses when they differ.
function Assert-ServiceSid([string]$Sddl) {
  $inList = @([regex]::Matches($Sddl, 'S-1-5-80-[0-9-]+') | ForEach-Object { $_.Value } | Sort-Object -Unique)
  $line = (& sc.exe showsid HSNHub | Where-Object { $_ -match 'SERVICE SID:' }) -replace '^.*SERVICE SID:\s*', ''
  if ($inList.Count -ne 1 -or $inList[0] -ne $line.Trim()) {
    throw "hub-folder.sddl names $($inList -join ', '), but sc showsid HSNHub says $line"
  }
}

function Set-HubTopFolder([string]$Path) {
  $parent = Split-Path -Parent $Path
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  if ($null -eq $item) {
    [System.IO.Directory]::CreateDirectory($Path) | Out-Null
  } elseif ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
    throw "refusing ${Path}: it is a reparse point"
  } elseif (-not $item.PSIsContainer) {
    throw "refusing ${Path}: it is not a folder"
  }
  if ($parent -ne $env:ProgramData) { throw "refusing ${Path}: not in %ProgramData%" }
  $sddl = Get-HubFolderSddl
  Assert-ServiceSid $sddl
  [HsnTree]::SetTop($Path, $sddl)
}

function Remove-TreeSafely([string]$Path) {
  $attributes = $null
  try { $attributes = [System.IO.File]::GetAttributes($Path) } catch [System.IO.FileNotFoundException], [System.IO.DirectoryNotFoundException] { return }
  $directory = [bool]($attributes -band [System.IO.FileAttributes]::Directory)
  if ($attributes -band [System.IO.FileAttributes]::ReparsePoint) {
    if (-not $directory) { [System.IO.File]::Delete($Path); return }
    try { [System.IO.Directory]::Delete($Path, $false) } catch {
      # A volume mount point: unmounted, never entered, then the empty folder removed.
      & mountvol.exe $Path /D | Out-Null
      [System.IO.Directory]::Delete($Path, $false)
    }
    return
  }
  if ($directory) {
    foreach ($entry in [System.IO.Directory]::GetFileSystemEntries($Path)) { Remove-TreeSafely $entry }
    [System.IO.Directory]::Delete($Path, $false)
  } else {
    [System.IO.File]::Delete($Path)
  }
}

# Waits until no process runs as the hub's account (the service's processes all ended).
function Wait-HubProcessesEnded([int]$Seconds = 30) {
  for ($i = 0; $i -lt $Seconds; $i++) {
    $left = @(Get-CimInstance Win32_Process | Where-Object {
      $owner = Invoke-CimMethod -InputObject $_ -MethodName GetOwner -ErrorAction SilentlyContinue
      $owner.Domain -eq "NT SERVICE" -and $owner.User -eq "HSNHub"
    })
    if ($left.Count -eq 0) { return }
    Start-Sleep -Seconds 1
  }
  throw "the hub's processes did not end"
}

# The service stopped, waiting until it has (sc.exe stop does not wait).
function Stop-HubService {
  $service = Get-Service -Name HSNHub -ErrorAction SilentlyContinue
  if ($null -eq $service) { return }
  if ($service.Status -ne "Stopped") { Stop-Service -Name HSNHub -Force -ErrorAction Stop }
  $service.WaitForStatus("Stopped", [TimeSpan]::FromSeconds(60))
  Wait-HubProcessesEnded
}
