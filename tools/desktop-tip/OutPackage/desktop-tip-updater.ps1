param(
  [Parameter(Mandatory = $true)][string]$PackagePath,
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [Parameter(Mandatory = $true)][string]$MainScript,
  [string]$LauncherPath = "",
  [int]$OriginalPid = 0,
  [string]$ExpectedVersion = "",
  [string]$ExpectedSha256 = "",
  [int64]$ExpectedSize = 0
)

$ErrorActionPreference = "Stop"

function Write-UpdateLog {
  param(
    [string]$Level,
    [string]$Message,
    [hashtable]$Meta = @{}
  )
  $logDir = Join-Path $InstallDir "logs"
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  $metaText = ""
  if ($Meta.Count -gt 0) {
    $metaText = " " + ($Meta | ConvertTo-Json -Compress -Depth 6)
  }
  Add-Content -Path (Join-Path $logDir "desktop-tip-updater.log") -Value "[$stamp] [$Level] $Message$metaText" -Encoding UTF8
}

function TextFromCodes {
  param([int[]]$Codes)
  return -join ($Codes | ForEach-Object { [char]$_ })
}

function Assert-WithinDir {
  param(
    [string]$BaseDir,
    [string]$TargetPath
  )
  $base = [System.IO.Path]::GetFullPath($BaseDir).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
  $target = [System.IO.Path]::GetFullPath($TargetPath)
  if (-not ($target -eq $base -or $target.StartsWith($base + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase))) {
    throw "path escapes install dir: $TargetPath"
  }
  return $target
}

function Normalize-ZipPath {
  param([string]$EntryName)
  $name = ([string]$EntryName).Replace("\", "/").TrimStart("/")
  if (-not $name -or $name.EndsWith("/")) {
    return ""
  }
  if ($name.Contains(":") -or $name.StartsWith("../") -or $name.Contains("/../") -or $name -eq "..") {
    throw "zip entry path is unsafe: $EntryName"
  }
  return $name
}

function Validate-ZipEntries {
  param([string]$ZipPath)
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $allowed = New-Object "System.Collections.Generic.HashSet[string]" ([System.StringComparer]::OrdinalIgnoreCase)
  @(
    "desktop-tip-client.ps1",
    "desktop-tip-updater.ps1",
    ((TextFromCodes @(21551,21160,69,65,21491,19979,35282,25552,37266)) + ".bat"),
    "README.md",
    "README.txt"
  ) | ForEach-Object { [void]$allowed.Add($_) }
  $zip = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
  try {
    foreach ($entry in $zip.Entries) {
      $relative = Normalize-ZipPath $entry.FullName
      if (-not $relative) {
        continue
      }
      $target = Join-Path $InstallDir $relative
      Assert-WithinDir -BaseDir $InstallDir -TargetPath $target | Out-Null
      if (-not $allowed.Contains($relative)) {
        throw "zip entry is not whitelisted: $relative"
      }
    }
  } finally {
    $zip.Dispose()
  }
  return $allowed
}

function Restore-Backup {
  param(
    [string]$BackupDir,
    [string[]]$Files
  )
  foreach ($relative in $Files) {
    $backupFile = Join-Path $BackupDir $relative
    if (Test-Path -LiteralPath $backupFile) {
      Copy-Item -LiteralPath $backupFile -Destination (Join-Path $InstallDir $relative) -Force
    }
  }
}

function Get-FileSha256 {
  param([string]$Path)
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
      $hash = $sha.ComputeHash($stream)
      return ([System.BitConverter]::ToString($hash) -replace "-", "").ToLowerInvariant()
    } finally {
      $sha.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}

function Normalize-PathText {
  param([string]$PathText)
  return ([System.IO.Path]::GetFullPath([string]$PathText)).TrimEnd("\","/").Replace("/", "\").ToLowerInvariant()
}

function Test-CommandLineTargetsMainScript {
  param([string]$CommandLine)
  $mainScriptPath = if ($MainScript) { $MainScript } else { Join-Path $InstallDir "desktop-tip-client.ps1" }
  $mainScriptPath = Normalize-PathText $mainScriptPath
  $command = ([string]$CommandLine).Replace("/", "\").ToLowerInvariant()
  return $command.Contains($mainScriptPath)
}

function Stop-OtherDesktopTipClientInstances {
  $stopped = 0
  try {
    try {
      $processes = Get-CimInstance Win32_Process -ErrorAction Stop
    } catch {
      $searcher = New-Object System.Management.ManagementObjectSearcher "SELECT ProcessId,Name,CommandLine FROM Win32_Process"
      $processes = $searcher.Get()
    }
    $processes = @($processes) | Where-Object {
      [int]$_.ProcessId -ne $PID -and
      ([string]$_.Name -match "^(powershell|pwsh)(\.exe)?$") -and
      (Test-CommandLineTargetsMainScript ([string]$_.CommandLine))
    }
    foreach ($process in @($processes)) {
      if ($OriginalPid -gt 0 -and [int]$process.ProcessId -eq $OriginalPid) {
        continue
      }
      try {
        Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction Stop
        $stopped += 1
        Write-UpdateLog "INFO" "Stopped duplicate old desktop tip client process" @{
          processId = [int]$process.ProcessId
        }
      } catch {
        Write-UpdateLog "WARN" "Failed to stop duplicate old desktop tip client process" @{
          processId = [int]$process.ProcessId
          message = $_.Exception.Message
        }
      }
    }
  } catch {
    Write-UpdateLog "WARN" "Duplicate desktop tip client process scan skipped; Win32_Process command line is unavailable" @{
      message = $_.Exception.Message
    }
  }
  return $stopped
}

try {
  $InstallDir = Assert-WithinDir -BaseDir $InstallDir -TargetPath $InstallDir
  $PackagePath = [System.IO.Path]::GetFullPath($PackagePath)
  if (-not (Test-Path -LiteralPath $PackagePath)) {
    throw "update package does not exist: $PackagePath"
  }
  if ($ExpectedSize -gt 0) {
    $actualSize = (Get-Item -LiteralPath $PackagePath).Length
    if ($actualSize -ne $ExpectedSize) {
      throw "package size mismatch expected=$ExpectedSize actual=$actualSize"
    }
  }
  if ($ExpectedSha256) {
    $actualSha = Get-FileSha256 -Path $PackagePath
    if ($actualSha -ne $ExpectedSha256.ToLowerInvariant()) {
      throw "package SHA256 mismatch"
    }
  }
  if ($OriginalPid -gt 0) {
    try {
      $process = Get-Process -Id $OriginalPid -ErrorAction SilentlyContinue
      if ($process) {
        Wait-Process -Id $OriginalPid -Timeout 20 -ErrorAction SilentlyContinue
      }
    } catch {}
  }
  Stop-OtherDesktopTipClientInstances | Out-Null

  $allowed = Validate-ZipEntries -ZipPath $PackagePath
  $workDir = Join-Path -Path ([System.IO.Path]::GetTempPath()) -ChildPath ("ea-desktop-tip-extract-" + [Guid]::NewGuid().ToString("N"))
  $backupDir = Join-Path $InstallDir ("backup\update-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
  New-Item -ItemType Directory -Force -Path $workDir | Out-Null
  New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
  [System.IO.Compression.ZipFile]::ExtractToDirectory($PackagePath, $workDir)
  $files = @()
  foreach ($entry in Get-ChildItem -LiteralPath $workDir -File -Recurse) {
    $relative = $entry.FullName.Substring($workDir.Length).TrimStart("\","/")
    $relative = $relative.Replace("\", "/")
    if (-not $allowed.Contains($relative)) {
      throw "extracted file is not whitelisted: $relative"
    }
    $files += $relative
  }
  if ($files.Count -le 0) {
    throw "update package has no files to replace"
  }

  try {
    foreach ($relative in $files) {
      $target = Join-Path $InstallDir $relative
      Assert-WithinDir -BaseDir $InstallDir -TargetPath $target | Out-Null
      if (Test-Path -LiteralPath $target) {
        Copy-Item -LiteralPath $target -Destination (Join-Path $backupDir $relative) -Force
      }
    }
    foreach ($relative in $files) {
      $source = Join-Path $workDir $relative
      $target = Join-Path $InstallDir $relative
      Copy-Item -LiteralPath $source -Destination $target -Force
    }
  } catch {
    Restore-Backup -BackupDir $backupDir -Files $files
    throw
  }

  Write-UpdateLog "INFO" "Client update applied" @{
    expectedVersion = $ExpectedVersion
    fileCount = $files.Count
  }

  $restartTarget = if ($LauncherPath -and (Test-Path -LiteralPath $LauncherPath)) { $LauncherPath } else { $MainScript }
  if ($restartTarget.EndsWith(".bat", [System.StringComparison]::OrdinalIgnoreCase)) {
    Start-Process -FilePath $restartTarget -WorkingDirectory $InstallDir
  } else {
    Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $restartTarget) -WorkingDirectory $InstallDir -WindowStyle Hidden
  }
  Write-UpdateLog "INFO" "Client restarted after update" @{
    target = [System.IO.Path]::GetFileName($restartTarget)
  }
} catch {
  Write-UpdateLog "ERROR" "Client update failed" @{
    expectedVersion = $ExpectedVersion
    message = $_.Exception.Message
  }
  exit 1
}
