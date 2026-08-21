param(
  [string]$ConfigPath = "",
  [string]$UserId = "",
  [string]$ServerBaseUrl = "",
  [switch]$Once,
  [switch]$SelfTest,
  [switch]$SingleInstanceProbe,
  [int]$HoldSingleInstanceSeconds = 0,
  [switch]$SelfCleanOldInstancesTest,
  [switch]$LauncherMigrationTest,
  [string]$ProcessSnapshotPath = ""
)

$ErrorActionPreference = "Stop"
$Script:Version = "0.5.0"
$Script:Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Script:ConfigPath = if ($ConfigPath) { $ConfigPath } else { Join-Path $Script:Root "config\desktop-tip-client.config.json" }
$Script:LogDir = Join-Path $Script:Root "logs"
$Script:LogFile = Join-Path $Script:LogDir "desktop-tip-client.log"
$Script:ClientIdFile = Join-Path $Script:Root "data\client-id.txt"
$Script:Config = $null
$Script:ClientId = ""
$Script:PendingEvents = New-Object System.Collections.Queue
$Script:SeenEventIds = @{}
$Script:CurrentTip = $null
$Script:LastPollError = ""
$Script:LastDisplayedTipId = ""
$Script:UpdateInProgress = $false
$Script:UpdatePromptInProgress = $false
$Script:LastUpdateCheckAt = [DateTime]::MinValue
$Script:LastPromptedUpdateVersion = ""
$Script:LastUpdatePostponedVersion = ""
$Script:LastUpdatePostponedAt = [DateTime]::MinValue
$Script:SingleInstanceMutex = $null
$Script:SingleInstanceWakeEvent = $null
$Script:LauncherPayloadBase64 = "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YXJ0AFBhcnNlAC5jdG9yAFNob3J0Y3V0TmFtZQBBcHBseVByZWZlcmVuY2UAUmVhZFByZWZlcmVuY2UAU3luYwBfcGF0aABJbml0aWFsaXplAFdyaXRlAGFyZ3MAaW5zdGFsbERpcgB2YWx1ZQBleGVjdXRhYmxlUGF0aABwcmVmZXJlbmNlUGF0aABldmVudE5hbWUAZGV0YWlsAFN5c3RlbS5SZWZsZWN0aW9uAEFzc2VtYmx5VGl0bGVBdHRyaWJ1dGUAQXNzZW1ibHlEZXNjcmlwdGlvbkF0dHJpYnV0ZQBBc3NlbWJseUNvbXBhbnlBdHRyaWJ1dGUAQXNzZW1ibHlQcm9kdWN0QXR0cmlidXRlAEFzc2VtYmx5VmVyc2lvbkF0dHJpYnV0ZQBBc3NlbWJseUZpbGVWZXJzaW9uQXR0cmlidXRlAFN5c3RlbS5SdW50aW1lLkNvbXBpbGVyU2VydmljZXMAQ29tcGlsYXRpb25SZWxheGF0aW9uc0F0dHJpYnV0ZQBSdW50aW1lQ29tcGF0aWJpbGl0eUF0dHJpYnV0ZQBFQS1EZXNrdG9wLVRpcC5idWlsZABTVEFUaHJlYWRBdHRyaWJ1dGUAQXBwRG9tYWluAGdldF9DdXJyZW50RG9tYWluAGdldF9CYXNlRGlyZWN0b3J5AENoYXIAU3lzdGVtLklPAFBhdGgARGlyZWN0b3J5U2VwYXJhdG9yQ2hhcgBTdHJpbmcAVHJpbUVuZABDb25jYXQAU3lzdGVtLlRocmVhZGluZwBNdXRleABTeXN0ZW0uV2luZG93cy5Gb3JtcwBBcHBsaWNhdGlvbgBnZXRfRXhlY3V0YWJsZVBhdGgAVG9TdHJpbmcATWVzc2FnZUJveABEaWFsb2dSZXN1bHQATWVzc2FnZUJveEJ1dHRvbnMATWVzc2FnZUJveEljb24AU2hvdwBJRGlzcG9zYWJsZQBEaXNwb3NlAEV4Y2VwdGlvbgBDb21iaW5lAEZpbGUARXhpc3RzAEZpbGVOb3RGb3VuZEV4Y2VwdGlvbgBJc051bGxPcldoaXRlU3BhY2UAR2V0RmlsZU5hbWUAU3lzdGVtLkRpYWdub3N0aWNzAFByb2Nlc3NTdGFydEluZm8Ac2V0X0ZpbGVOYW1lAHNldF9Bcmd1bWVudHMAc2V0X1dvcmtpbmdEaXJlY3RvcnkAc2V0X1VzZVNoZWxsRXhlY3V0ZQBzZXRfQ3JlYXRlTm9XaW5kb3cAUHJvY2Vzc1dpbmRvd1N0eWxlAHNldF9XaW5kb3dTdHlsZQBQcm9jZXNzAFN0YXJ0AGdldF9JZABJbnQzMgBFbnZpcm9ubWVudABTcGVjaWFsRm9sZGVyAEdldEZvbGRlclBhdGgAR2V0RW52aXJvbm1lbnRWYXJpYWJsZQBQYXRoU2VwYXJhdG9yAFN0cmluZ1NwbGl0T3B0aW9ucwBTcGxpdABUcmltAFJlcGxhY2UAR2V0RnVsbFBhdGgAVG9VcHBlckludmFyaWFudABTeXN0ZW0uU2VjdXJpdHkuQ3J5cHRvZ3JhcGh5AFNIQTI1NgBDcmVhdGUAU3lzdGVtLlRleHQARW5jb2RpbmcAZ2V0X1VURjgAR2V0Qnl0ZXMASGFzaEFsZ29yaXRobQBDb21wdXRlSGFzaABTdHJpbmdCdWlsZGVyAEJ5dGUAQXBwZW5kAFN0cmluZ0NvbXBhcmlzb24ARXF1YWxzAERpcmVjdG9yeQBEaXJlY3RvcnlJbmZvAENyZWF0ZURpcmVjdG9yeQBEZWxldGUAVHlwZQBHZXRUeXBlRnJvbVByb2dJRABvcF9FcXVhbGl0eQBJbnZhbGlkT3BlcmF0aW9uRXhjZXB0aW9uAEFjdGl2YXRvcgBDcmVhdGVJbnN0YW5jZQBCaW5kaW5nRmxhZ3MAQmluZGVyAEludm9rZU1lbWJlcgBHZXRUeXBlAEdldERpcmVjdG9yeU5hbWUAVVRGOEVuY29kaW5nAFdyaXRlQWxsVGV4dABTeXN0ZW0uUnVudGltZS5JbnRlcm9wU2VydmljZXMATWFyc2hhbABJc0NvbU9iamVjdABGaW5hbFJlbGVhc2VDb21PYmplY3QAUmVhZEFsbFRleHQAZ2V0X01lc3NhZ2UAR2V0VGVtcFBhdGgARGF0ZVRpbWUAZ2V0X05vdwBnZXRfTmV3TGluZQBNb25pdG9yAEVudGVyAEFwcGVuZEFsbFRleHQARXhpdAAuY2N0b3IAAAAbbABhAHUAbgBjAGgAZQByAF8AYgBvAG8AdAAAM3YAZQByAHMAaQBvAG4APQAwAC4ANQAuADAAIABpAG4AcwB0AGEAbABsAEsAZQB5AD0AADdMAG8AYwBhAGwAXABFAEEARABlAHMAawB0AG8AcABUAGkAcABMAGEAdQBuAGMAaABlAHIAXwAAJWwAYQB1AG4AYwBoAGUAcgBfAGQAdQBwAGwAaQBjAGEAdABlAAAXYQBjAHQAaQBvAG4APQBlAHgAaQB0AAAfbABhAHUAbgBjAGgAZQByAF8AZgBhAGkAbABlAGQAAICFRQBBACAAZABlAHMAawB0AG8AcAAgAHQAaQBwACAAZgBhAGkAbABlAGQAIAB0AG8AIABzAHQAYQByAHQALgAgAFMAZQBlACAAbABvAGcAcwBcAGQAZQBzAGsAdABvAHAALQB0AGkAcAAtAGwAYQB1AG4AYwBoAGUAcgAuAGwAbwBnAC4AAR1FAEEAIABEAGUAcwBrAHQAbwBwACAAVABpAHAAAC1kAGUAcwBrAHQAbwBwAC0AdABpAHAALQBjAGwAaQBlAG4AdAAuAHAAcwAxAAFRRABlAHMAawB0AG8AcAAgAHQAaQBwACAAYwBsAGkAZQBuAHQAIABzAGMAcgBpAHAAdAAgAHcAYQBzACAAbgBvAHQAIABmAG8AdQBuAGQALgAAQ1cAaQBuAGQAbwB3AHMAIABQAG8AdwBlAHIAUwBoAGUAbABsACAAdwBhAHMAIABuAG8AdAAgAGYAbwB1AG4AZAAuAAAhcwBlAGwAZgBfAHQAZQBzAHQAXwBwAGEAcwBzAGUAZAAAF3AAbwB3AGUAcgBzAGgAZQBsAGwAPQAAIXMAZQBsAGYAXwB0AGUAcwB0AF8AZgBhAGkAbABlAGQAAHstAE4AbwBQAHIAbwBmAGkAbABlACAALQBFAHgAZQBjAHUAdABpAG8AbgBQAG8AbABpAGMAeQAgAEIAeQBwAGEAcwBzACAALQBXAGkAbgBkAG8AdwBTAHQAeQBsAGUAIABIAGkAZABkAGUAbgAgAC0ARgBpAGwAZQAgAAEtYwBsAGkAZQBuAHQAXwBzAHQAYQByAHQAXwByAGUAcQB1AGUAcwB0AGUAZAAACXAAaQBkAD0AABFTAHkAcwB0AGUAbQAzADIAACNXAGkAbgBkAG8AdwBzAFAAbwB3AGUAcgBTAGgAZQBsAGwAAAl2ADEALgAwAAAdcABvAHcAZQByAHMAaABlAGwAbAAuAGUAeABlAAAJUABBAFQASAAAAQADIgAABVwAIgAABXgAMgAAFy0ALQBzAGUAbABmAC0AdABlAHMAdAABIS0ALQBzAGsAaQBwAC0AYQB1AHQAbwBzAHQAYQByAHQAAQlkAGEAdABhAAAxYQB1AHQAbwBzAHQAYQByAHQALQBwAHIAZQBmAGUAcgBlAG4AYwBlAC4AdAB4AHQAASFFAEEARABlAHMAawB0AG8AcABUAGkAcAAuAGwAbgBrAAAlYQB1AHQAbwBzAHQAYQByAHQAXwBkAGkAcwBhAGIAbABlAGQAAC9tAGUAdABoAG8AZAA9AHMAdABhAHIAdAB1AHAAXwBzAGgAbwByAHQAYwB1AHQAABtXAFMAYwByAGkAcAB0AC4AUwBoAGUAbABsAABHVwBpAG4AZABvAHcAcwAgAFMAYwByAGkAcAB0ACAASABvAHMAdAAgAGkAcwAgAHUAbgBhAHYAYQBpAGwAYQBiAGwAZQAuAAAdQwByAGUAYQB0AGUAUwBoAG8AcgB0AGMAdQB0AAAVVABhAHIAZwBlAHQAUABhAHQAaAAAE0EAcgBnAHUAbQBlAG4AdABzAAAhVwBvAHIAawBpAG4AZwBEAGkAcgBlAGMAdABvAHIAeQAAGUkAYwBvAG4ATABvAGMAYQB0AGkAbwBuAAAFLAAwAAAXRABlAHMAYwByAGkAcAB0AGkAbwBuAAAdRQBBACAAZABlAHMAawB0AG8AcAAgAHQAaQBwAAAJUwBhAHYAZQAAD2UAbgBhAGIAbABlAGQAACNhAHUAdABvAHMAdABhAHIAdABfAGUAbgBhAGIAbABlAGQAABFkAGkAcwBhAGIAbABlAGQAAEFhAHUAdABvAHMAdABhAHIAdABfAHAAcgBlAGYAZQByAGUAbgBjAGUAXwByAGUAYQBkAF8AZgBhAGkAbABlAGQAAAlsAG8AZwBzAAAxZABlAHMAawB0AG8AcAAtAHQAaQBwAC0AbABhAHUAbgBjAGgAZQByAC4AbABvAGcAAR1lAGEALQBkAGUAcwBrAHQAbwBwAC0AdABpAHAAAQMNAAADIAAAAwoAAANbAAAveQB5AHkAeQAtAE0ATQAtAGQAZAAgAEgASAA6AG0AbQA6AHMAcwAuAGYAZgBmAAE5XQAgAFsARQBBAC0ARABFAFMASwBUAE8AUAAtAFQASQBQAC0ATABBAFUATgBDAEgARQBSAF0AIAABAACqJpUe8Q7JS7Z2qZ4m+TBbAAi3elxWGTTgiQIGDgowAC4ANQAuADAALGQAZQBzAGsAdABvAHAALQB0AGkAcAAtAGMAbABpAGUAbgB0AC4AcABzADEABQABCB0OBAABCA4EAAEBDgMAAA4EAAEODgIGAgYAARIMHQ4DIAABIEUAQQBEAGUAcwBrAHQAbwBwAFQAaQBwAC4AbABuAGsABQACAQ4OBAABAg4CBhwEIAEBDgQgAQEIBAEAAAAEAAASLQMgAA4CBgMFIAEOHQMFAAIODg4HIAMBAg4QAgoABBFJDg4RTRFRDgcIDhIMDgISPRJZCB0DBSACAQ4OBwcEDg4SWQgEIAEBAgUgAQERaQYAARJtEmUDIAAIBQACDhwcCAcEDg4SZRJtBQABDhF5BQABDh0OCCACHQ4dAxF9DgcJDg4ODg4dDh0DHQ4IBSACDg4OBgADDg4ODgUAABKAgQUAABKAhQUgAR0FDgYgAR0FHQUEIAEODgYgARKAjQ4PBwcOEoCBHQUSgI0IDh0DCAADAg4OEYCVCQcFEgwODh0OCAYAARKAnQ4GAAESgKEOCQACAhKAoRKAoQYAARwSgKENIAUcDhGArRKAsRwdHAUgABKAoQgAAwEODhKAhQQAAQIcBAABCBwaBw4OAg4OHBwSgKESgKEdHB0cHRwdHB0cHRwHAAIODhKAhQYHAw4SWQIEBwIODgUAABGAvQYAAgEcEAIEAAEBHAsHBg4OAh0OEYC9HAMAAAETAQAORUEgRGVza3RvcCBUaXAAACUBACBFQSBkZXNrdG9wIG5vdGlmaWNhdGlvbiBsYXVuY2hlcgAADQEACEVhenlHYW1lAAAMAQAHMC41LjAuMAAACAEACAAAAAAAHgEAAQBUAhZXcmFwTm9uRXhjZXB0aW9uVGhyb3dzAXBAAAAAAAAAAAAAAI5AAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAQAAAAAAAAAAAAAAAAAAAAABfQ29yRXhlTWFpbgBtc2NvcmVlLmRsbAAAAAAA/yUAIEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACABAAAAAgAACAGAAAADgAAIAAAAAAAAAAAAAAAAAAAAEAAQAAAFAAAIAAAAAAAAAAAAAAAAAAAAEAAQAAAGgAAIAAAAAAAAAAAAAAAAAAAAEAAAAAAIAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAJAAAACgYAAAaAMAAAAAAAAAAAAACGQAAOoBAAAAAAAAAAAAAGgDNAAAAFYAUwBfAFYARQBSAFMASQBPAE4AXwBJAE4ARgBPAAAAAAC9BO/+AAABAAUAAAAAAAAABQAAAAAAAAA/AAAAAAAAAAQAAAABAAAAAAAAAAAAAAAAAAAARAAAAAEAVgBhAHIARgBpAGwAZQBJAG4AZgBvAAAAAAAkAAQAAABUAHIAYQBuAHMAbABhAHQAaQBvAG4AAAAAAAAAsATIAgAAAQBTAHQAcgBpAG4AZwBGAGkAbABlAEkAbgBmAG8AAACkAgAAAQAwADAAMAAwADAANABiADAAAABcACEAAQBDAG8AbQBtAGUAbgB0AHMAAABFAEEAIABkAGUAcwBrAHQAbwBwACAAbgBvAHQAaQBmAGkAYwBhAHQAaQBvAG4AIABsAGEAdQBuAGMAaABlAHIAAAAAADQACQABAEMAbwBtAHAAYQBuAHkATgBhAG0AZQAAAAAARQBhAHoAeQBHAGEAbQBlAAAAAABIAA8AAQBGAGkAbABlAEQAZQBzAGMAcgBpAHAAdABpAG8AbgAAAAAARQBBACAARABlAHMAawB0AG8AcAAgAFQAaQBwAAAAAAAwAAgAAQBGAGkAbABlAFYAZQByAHMAaQBvAG4AAAAAADAALgA1AC4AMAAuADAAAABUABkAAQBJAG4AdABlAHIAbgBhAGwATgBhAG0AZQAAAEUAQQAtAEQAZQBzAGsAdABvAHAALQBUAGkAcAAuAGIAdQBpAGwAZAAuAGUAeABlAAAAAAAoAAIAAQBMAGUAZwBhAGwAQwBvAHAAeQByAGkAZwBoAHQAAAAgAAAAXAAZAAEATwByAGkAZwBpAG4AYQBsAEYAaQBsAGUAbgBhAG0AZQAAAEUAQQAtAEQAZQBzAGsAdABvAHAALQBUAGkAcAAuAGIAdQBpAGwAZAAuAGUAeABlAAAAAABAAA8AAQBQAHIAbwBkAHUAYwB0AE4AYQBtAGUAAAAAAEUAQQAgAEQAZQBzAGsAdABvAHAAIABUAGkAcAAAAAAANAAIAAEAUAByAG8AZAB1AGMAdABWAGUAcgBzAGkAbwBuAAAAMAAuADUALgAwAC4AMAAAADgACAABAEEAcwBzAGUAbQBiAGwAeQAgAFYAZQByAHMAaQBvAG4AAAAwAC4ANQAuADAALgAwAAAA77u/PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiIHN0YW5kYWxvbmU9InllcyI/Pg0KPGFzc2VtYmx5IHhtbG5zPSJ1cm46c2NoZW1hcy1taWNyb3NvZnQtY29tOmFzbS52MSIgbWFuaWZlc3RWZXJzaW9uPSIxLjAiPg0KICA8YXNzZW1ibHlJZGVudGl0eSB2ZXJzaW9uPSIxLjAuMC4wIiBuYW1lPSJNeUFwcGxpY2F0aW9uLmFwcCIvPg0KICA8dHJ1c3RJbmZvIHhtbG5zPSJ1cm46c2NoZW1hcy1taWNyb3NvZnQtY29tOmFzbS52MiI+DQogICAgPHNlY3VyaXR5Pg0KICAgICAgPHJlcXVlc3RlZFByaXZpbGVnZXMgeG1sbnM9InVybjpzY2hlbWFzLW1pY3Jvc29mdC1jb206YXNtLnYzIj4NCiAgICAgICAgPHJlcXVlc3RlZEV4ZWN1dGlvbkxldmVsIGxldmVsPSJhc0ludm9rZXIiIHVpQWNjZXNzPSJmYWxzZSIvPg0KICAgICAgPC9yZXF1ZXN0ZWRQcml2aWxlZ2VzPg0KICAgIDwvc2VjdXJpdHk+DQogIDwvdHJ1c3RJbmZvPg0KPC9hc3NlbWJseT4NCgAAAAAAAAAAAAAAAAAAAEAAAAwAAACgMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
$Script:LauncherPayloadSha256 = "f734ec38faf37d049a0a9728824f8a307828d63b1f42592c77e4043f7929f183"

function Write-TipLog {
  param(
    [string]$Level,
    [string]$Message,
    [hashtable]$Meta = @{}
  )
  New-Item -ItemType Directory -Force -Path $Script:LogDir | Out-Null
  $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  $metaText = ""
  if ($Meta.Count -gt 0) {
    $metaText = " " + ($Meta | ConvertTo-Json -Compress -Depth 6)
  }
  Add-Content -Path $Script:LogFile -Value "[$stamp] [$Level] $Message$metaText" -Encoding UTF8
}

function TextFromCodes {
  param([int[]]$Codes)
  return -join ($Codes | ForEach-Object { [char]$_ })
}

function Mask-LogId {
  param([string]$Value)
  $text = ([string]$Value).Trim()
  if (-not $text) {
    return ""
  }
  if ($text.Length -le 4) {
    return "***"
  }
  return $text.Substring(0, 2) + "***" + $text.Substring($text.Length - 2)
}

function Get-Sha256Text {
  param([string]$Text)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes([string]$Text)
    return ([System.BitConverter]::ToString($sha.ComputeHash($bytes)) -replace "-", "").ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

function Normalize-PathText {
  param([string]$PathText)
  return ([System.IO.Path]::GetFullPath([string]$PathText)).TrimEnd("\","/").Replace("/", "\").ToLowerInvariant()
}

function Get-InstallInstanceKey {
  $rootPath = Normalize-PathText $Script:Root
  return (Get-Sha256Text $rootPath).Substring(0, 24)
}

function Initialize-SingleInstance {
  $key = Get-InstallInstanceKey
  $mutexName = "Local\EADesktopTip_" + $key
  $wakeName = "Local\EADesktopTipWake_" + $key
  $createdNew = $false
  $mutex = New-Object System.Threading.Mutex($true, $mutexName, [ref]$createdNew)
  if (-not $createdNew) {
    try {
      $wakeEvent = New-Object System.Threading.EventWaitHandle($false, [System.Threading.EventResetMode]::AutoReset, $wakeName)
      [void]$wakeEvent.Set()
      $wakeEvent.Dispose()
    } catch {}
    Write-TipLog "INFO" "Duplicate desktop tip client instance rejected" @{
      installKey = $key
      root = $Script:Root
    }
    $mutex.Dispose()
    return $false
  }
  $Script:SingleInstanceMutex = $mutex
  $Script:SingleInstanceWakeEvent = New-Object System.Threading.EventWaitHandle($false, [System.Threading.EventResetMode]::AutoReset, $wakeName)
  Write-TipLog "INFO" "Desktop tip client single instance acquired" @{
    installKey = $key
    root = $Script:Root
  }
  return $true
}

function Release-SingleInstance {
  try {
    if ($Script:SingleInstanceWakeEvent) {
      $Script:SingleInstanceWakeEvent.Dispose()
      $Script:SingleInstanceWakeEvent = $null
    }
  } catch {}
  try {
    if ($Script:SingleInstanceMutex) {
      $Script:SingleInstanceMutex.ReleaseMutex()
      $Script:SingleInstanceMutex.Dispose()
      $Script:SingleInstanceMutex = $null
    }
  } catch {}
}

function Test-CommandLineTargetsMainScript {
  param([string]$CommandLine)
  $mainScript = Normalize-PathText (Join-Path $Script:Root "desktop-tip-client.ps1")
  $command = ([string]$CommandLine).Replace("/", "\").ToLowerInvariant()
  return $command.Contains($mainScript)
}

function Stop-OtherDesktopTipClientInstances {
  $stopped = 0
  try {
    if ($ProcessSnapshotPath -and (Test-Path -LiteralPath $ProcessSnapshotPath)) {
      $rawSnapshot = Get-Content -Path $ProcessSnapshotPath -Raw -Encoding UTF8 | ConvertFrom-Json
      $processes = @($rawSnapshot.processes)
    } else {
      try {
        $processes = Get-CimInstance Win32_Process -ErrorAction Stop
      } catch {
        $searcher = New-Object System.Management.ManagementObjectSearcher "SELECT ProcessId,Name,CommandLine FROM Win32_Process"
        $processes = $searcher.Get()
      }
    }
    $processes = @($processes) | Where-Object {
      [int]$_.ProcessId -ne $PID -and
      ([string]$_.Name -match "^(powershell|pwsh)(\.exe)?$") -and
      (Test-CommandLineTargetsMainScript ([string]$_.CommandLine))
    }
    foreach ($process in @($processes)) {
      try {
        Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction Stop
        $stopped += 1
        Write-TipLog "INFO" "Stopped duplicate old desktop tip client process" @{
          processId = [int]$process.ProcessId
        }
      } catch {
        Write-TipLog "WARN" "Failed to stop duplicate old desktop tip client process" @{
          processId = [int]$process.ProcessId
          message = $_.Exception.Message
        }
      }
    }
  } catch {
    Write-TipLog "WARN" "Duplicate desktop tip client process scan skipped; Win32_Process command line is unavailable" @{
      message = $_.Exception.Message
    }
  }
  return $stopped
}

function Default-Config {
  [ordered]@{
    version = $Script:Version
    serverBaseUrl = "http://127.0.0.1:39200"
    userId = ""
    clientToken = ""
    pollSeconds = 8
    floatingButtonText = "EA"
    openUrl = "https://work.weixin.qq.com"
    updateEnabled = $true
    updateCheckMinutes = 30
  }
}

function Format-ChinaTime {
  param([string]$IsoText)
  if (-not $IsoText) {
    return "-"
  }
  try {
    return ([DateTimeOffset]::Parse($IsoText).ToLocalTime()).ToString("MM-dd HH:mm")
  } catch {
    return "-"
  }
}

function Format-RemainingTime {
  param([string]$IsoText)
  if (-not $IsoText) {
    return "-"
  }
  try {
    $target = [DateTimeOffset]::Parse($IsoText).ToLocalTime()
    $span = $target - [DateTimeOffset]::Now
    if ($span.TotalSeconds -le 0) {
      return "00:00:00"
    }
    return "{0:00}:{1:00}:{2:00}" -f [Math]::Floor($span.TotalHours), $span.Minutes, $span.Seconds
  } catch {
    return "-"
  }
}

function Get-MaintenanceMeta {
  param([object]$Tip)
  if ($Tip -and $Tip.meta -and $Tip.meta.sourceKey -eq "production_maintenance" -and $Tip.meta.maintenance) {
    return $Tip.meta.maintenance
  }
  return $null
}

function Maintenance-StatusText {
  param([object]$Maintenance)
  if (-not $Maintenance) {
    return ""
  }
  switch ([string]$Maintenance.messageType) {
    "maintenance_countdown" {
      return (TextFromCodes @(27491,24335,26381,20572,26381,20498,35745,26102,32,32,21097,20313,32)) + (Format-RemainingTime ([string]$Maintenance.scheduledStopAt))
    }
    "maintenance_stopped" { return TextFromCodes @(24050,20572,26381) }
    "maintenance_extended" { return (TextFromCodes @(20572,26381,24050,24310,38271,32)) + [string]$Maintenance.extensionMinutes + (TextFromCodes @(32,20998,38047)) }
    "maintenance_completed" { return TextFromCodes @(27491,24335,26381,26356,26032,23436,25104) }
    default { return [string]$Maintenance.statusLabel }
  }
}

function Maintenance-StatusColor {
  param([object]$Maintenance)
  if (-not $Maintenance) {
    return "#1677ff"
  }
  switch ([string]$Maintenance.messageType) {
    "maintenance_stopped" { return "#dc2626" }
    "maintenance_extended" { return "#f97316" }
    "maintenance_completed" { return "#16a34a" }
    default { return "#f59e0b" }
  }
}

function Maintenance-BodyText {
  param(
    [object]$Tip,
    [object]$Maintenance
  )
  $lines = New-Object System.Collections.Generic.List[string]
  $lines.Add((TextFromCodes @(20107,20214,65306)) + [string]$Maintenance.title)
  $lines.Add((TextFromCodes @(27491,24335,26381,65306)) + [string]$Maintenance.serverName)
  if ([string]$Maintenance.messageType -eq "maintenance_countdown") {
    $lines.Add((TextFromCodes @(21097,20313,26102,38388,65306)) + (Format-RemainingTime ([string]$Maintenance.scheduledStopAt)))
  }
  $lines.Add((TextFromCodes @(35745,21010,20572,26381,65306)) + (Format-ChinaTime ([string]$Maintenance.scheduledStopAt)))
  $lines.Add((TextFromCodes @(39044,35745,24674,22797,65306)) + (Format-ChinaTime ([string]$Maintenance.expectedResumeAt)))
  if ([string]$Maintenance.messageType -eq "maintenance_extended") {
    $lines.Add((TextFromCodes @(26412,27425,24310,38271,65306)) + [string]$Maintenance.extensionMinutes + (TextFromCodes @(32,20998,38047)))
    $lines.Add((TextFromCodes @(32047,35745,24310,38271,65306)) + [string]$Maintenance.totalExtensionMinutes + (TextFromCodes @(32,20998,38047)))
  }
  if ($Maintenance.reason) {
    $lines.Add((TextFromCodes @(21407,22240,65306)) + [string]$Maintenance.reason)
  }
  if ([string]$Maintenance.messageType -eq "maintenance_completed") {
    $lines.Add((TextFromCodes @(23454,38469,23436,25104,65306)) + (Format-ChinaTime ([string]$Maintenance.completedAt)))
  }
  foreach ($line in @($Tip.detailLines)) {
    if ($line -and -not ($lines -contains [string]$line)) {
      $lines.Add([string]$line)
    }
  }
  return ($lines -join [Environment]::NewLine)
}

function Save-Config {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Script:ConfigPath) | Out-Null
  $Script:Config | ConvertTo-Json -Depth 6 | Set-Content -Path $Script:ConfigPath -Encoding UTF8
}

function Load-Config {
  if (Test-Path $Script:ConfigPath) {
    $raw = Get-Content -Path $Script:ConfigPath -Raw -Encoding UTF8
    $loaded = $raw | ConvertFrom-Json
    $default = Default-Config
    foreach ($key in @($default.Keys)) {
      if ($null -eq $loaded.$key) {
        $loaded | Add-Member -NotePropertyName $key -NotePropertyValue $default[$key]
      }
    }
    $Script:Config = $loaded
  } else {
    $Script:Config = [pscustomobject](Default-Config)
    Save-Config
  }

  if ($ServerBaseUrl) {
    $Script:Config.serverBaseUrl = $ServerBaseUrl
  }
  if ($Script:Config.userId) {
    $Script:Config.userId = ""
    Save-Config
  }
}

function Ensure-ClientId {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Script:ClientIdFile) | Out-Null
  if (Test-Path $Script:ClientIdFile) {
    $Script:ClientId = (Get-Content -Path $Script:ClientIdFile -Raw -Encoding UTF8).Trim()
  }
  if (-not $Script:ClientId) {
    $Script:ClientId = "ea_tip_" + ([Guid]::NewGuid().ToString("N"))
    Set-Content -Path $Script:ClientIdFile -Value $Script:ClientId -Encoding UTF8
  }
}

function Request-Headers {
  $headers = @{}
  if ($Script:Config.clientToken) {
    $headers["X-EA-Tip-Token"] = [string]$Script:Config.clientToken
  }
  return $headers
}

function Api-Base {
  ([string]$Script:Config.serverBaseUrl).TrimEnd("/")
}

function Compare-Version {
  param(
    [string]$Left,
    [string]$Right
  )
  $leftParts = @(([string]$Left).TrimStart([char[]]"vV").Split(".") | ForEach-Object { if ($_ -match "^\d+$") { [int]$_ } else { 0 } })
  $rightParts = @(([string]$Right).TrimStart([char[]]"vV").Split(".") | ForEach-Object { if ($_ -match "^\d+$") { [int]$_ } else { 0 } })
  $max = [Math]::Max($leftParts.Count, $rightParts.Count)
  for ($i = 0; $i -lt $max; $i++) {
    $leftValue = if ($i -lt $leftParts.Count) { $leftParts[$i] } else { 0 }
    $rightValue = if ($i -lt $rightParts.Count) { $rightParts[$i] } else { 0 }
    if ($leftValue -gt $rightValue) { return 1 }
    if ($leftValue -lt $rightValue) { return -1 }
  }
  return 0
}

function Get-UpdateManifest {
  $base = Api-Base
  $uri = "$base/api/desktop-tip/client-update/manifest"
  $response = Invoke-RestMethod -Method Get -Uri $uri -TimeoutSec 10
  if (-not $response.ok -or -not $response.manifest) {
    throw (TextFromCodes @(26356,26032,32,109,97,110,105,102,101,115,116,32,21709,24212,26080,25928))
  }
  return $response.manifest
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

function Get-LauncherFileName {
  return (TextFromCodes @(69,65,26700,38754,25552,37266)) + ".exe"
}

function Get-LauncherPath {
  return Join-Path $Script:Root (Get-LauncherFileName)
}

function Get-AutoStartPreferencePath {
  return Join-Path $Script:Root "data\autostart-preference.txt"
}

function Get-AutoStartShortcutPath {
  $startupDir = [Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)
  return Join-Path $startupDir "EADesktopTip.lnk"
}

function Ensure-DesktopTipLauncher {
  $launcherPath = Get-LauncherPath
  $payloadReady = $Script:LauncherPayloadBase64 -and
    -not $Script:LauncherPayloadBase64.StartsWith("__EA_DESKTOP_TIP_LAUNCHER_") -and
    $Script:LauncherPayloadSha256 -match "^[a-fA-F0-9]{64}$"

  if (Test-Path -LiteralPath $launcherPath) {
    if (-not $payloadReady) {
      return $true
    }
    $existingSha = Get-FileSha256 -Path $launcherPath
    if ($existingSha -eq $Script:LauncherPayloadSha256.ToLowerInvariant()) {
      return $true
    }
  }

  if (-not $payloadReady) {
    Write-TipLog "WARN" "Desktop tip EXE payload is unavailable" @{
      launcherExists = [bool](Test-Path -LiteralPath $launcherPath)
    }
    return $false
  }

  $tempPath = Join-Path $Script:Root ("EA-Desktop-Tip-" + [Guid]::NewGuid().ToString("N") + ".tmp")
  try {
    $bytes = [Convert]::FromBase64String($Script:LauncherPayloadBase64)
    [System.IO.File]::WriteAllBytes($tempPath, $bytes)
    $actualSha = Get-FileSha256 -Path $tempPath
    if ($actualSha -ne $Script:LauncherPayloadSha256.ToLowerInvariant()) {
      throw "desktop tip launcher payload SHA256 mismatch"
    }
    Move-Item -LiteralPath $tempPath -Destination $launcherPath -Force
    Write-TipLog "INFO" "Desktop tip EXE installed from verified payload" @{
      version = $Script:Version
      size = $bytes.Length
      sha256Prefix = $actualSha.Substring(0, 12)
    }
    return $true
  } catch {
    Write-TipLog "WARN" "Desktop tip EXE installation failed" @{
      version = $Script:Version
      message = $_.Exception.Message
    }
    return $false
  } finally {
    Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
  }
}

function Read-AutoStartPreference {
  $path = Get-AutoStartPreferencePath
  if (-not (Test-Path -LiteralPath $path)) {
    return $true
  }
  try {
    $value = ([string](Get-Content -LiteralPath $path -Raw -Encoding UTF8)).Trim()
    return $value -ne "disabled"
  } catch {
    Write-TipLog "WARN" "Desktop tip autostart preference read failed" @{
      message = $_.Exception.Message
    }
    return $true
  }
}

function Test-DesktopTipAutoStart {
  return Test-Path -LiteralPath (Get-AutoStartShortcutPath)
}

function Set-DesktopTipAutoStart {
  param([bool]$Enabled)
  $preferencePath = Get-AutoStartPreferencePath
  $shortcutPath = Get-AutoStartShortcutPath
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $preferencePath) | Out-Null

  if (-not $Enabled) {
    Remove-Item -LiteralPath $shortcutPath -Force -ErrorAction SilentlyContinue
    Set-Content -LiteralPath $preferencePath -Value "disabled" -Encoding UTF8
    Write-TipLog "INFO" "Desktop tip autostart disabled" @{
      method = "startup_shortcut"
    }
    return
  }

  if (-not (Ensure-DesktopTipLauncher)) {
    throw ((TextFromCodes @(26080,27861,21019,24314,69,65,26700,38754,25552,37266,31243,24207,65292,26080,27861,35774,32622,24320,26426,33258,21160,21160,12290)))
  }
  $launcherPath = Get-LauncherPath
  $shell = $null
  $shortcut = $null
  try {
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $launcherPath
    $shortcut.Arguments = ""
    $shortcut.WorkingDirectory = $Script:Root
    $shortcut.IconLocation = "$launcherPath,0"
    $shortcut.Description = "EA desktop tip"
    $shortcut.Save()
    Set-Content -LiteralPath $preferencePath -Value "enabled" -Encoding UTF8
    Write-TipLog "INFO" "Desktop tip autostart enabled" @{
      method = "startup_shortcut"
    }
  } finally {
    if ($shortcut -and [System.Runtime.InteropServices.Marshal]::IsComObject($shortcut)) {
      [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut)
    }
    if ($shell -and [System.Runtime.InteropServices.Marshal]::IsComObject($shell)) {
      [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)
    }
  }
}

function Initialize-DesktopTipLauncher {
  if (-not (Ensure-DesktopTipLauncher)) {
    return
  }
  try {
    Set-DesktopTipAutoStart -Enabled (Read-AutoStartPreference)
  } catch {
    Write-TipLog "WARN" "Desktop tip autostart initialization failed" @{
      message = $_.Exception.Message
    }
  }
}

function Start-ClientUpdate {
  param([object]$Manifest)
  if ($Script:UpdateInProgress) {
    Write-TipLog "INFO" "Client update skipped by lock" @{
      version = [string]$Manifest.version
    }
    return
  }
  $Script:UpdateInProgress = $true
  $tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("ea-desktop-tip-update-" + [Guid]::NewGuid().ToString("N"))
  try {
    New-Item -ItemType Directory -Force -Path $tempDir | Out-Null
    $packagePath = Join-Path $tempDir "desktop-tip-update.zip"
    $base = Api-Base
    $packageUrl = [string]$Manifest.packageUrl
    if (-not $packageUrl.StartsWith("http", [System.StringComparison]::OrdinalIgnoreCase)) {
      $packageUrl = $base + "/" + $packageUrl.TrimStart("/")
    }
    Write-TipLog "INFO" "Client update download started" @{
      currentVersion = $Script:Version
      nextVersion = [string]$Manifest.version
      packageUrl = $packageUrl
    }
    Invoke-WebRequest -Uri $packageUrl -OutFile $packagePath -UseBasicParsing -TimeoutSec 60
    $actualSize = (Get-Item -LiteralPath $packagePath).Length
    $expectedSize = [int64]$Manifest.size
    if ($actualSize -ne $expectedSize) {
      throw ((TextFromCodes @(26356,26032,21253,22823,23567,19981,21305,37197,32,101,120,112,101,99,116,101,100,61)) + $expectedSize + (TextFromCodes @(32,97,99,116,117,97,108,61)) + $actualSize)
    }
    $actualSha = Get-FileSha256 -Path $packagePath
    $expectedSha = ([string]$Manifest.sha256).ToLowerInvariant()
    if ($actualSha -ne $expectedSha) {
      throw (TextFromCodes @(26356,26032,21253,32,83,72,65,50,53,54,32,19981,21305,37197))
    }
    $updaterPath = Join-Path $Script:Root "desktop-tip-updater.ps1"
    if (-not (Test-Path -LiteralPath $updaterPath)) {
      throw ((TextFromCodes @(26356,26032,21161,25163,19981,23384,22312,65306)) + $updaterPath)
    }
    $mainScript = Join-Path $Script:Root "desktop-tip-client.ps1"
    $launcher = Get-LauncherPath
    Write-TipLog "INFO" "Client update verified; updater will take over" @{
      currentVersion = $Script:Version
      nextVersion = [string]$Manifest.version
      size = $actualSize
      sha256Prefix = $actualSha.Substring(0, 12)
    }
    $args = @(
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-File", $updaterPath,
      "-PackagePath", $packagePath,
      "-InstallDir", $Script:Root,
      "-MainScript", $mainScript,
      "-LauncherPath", $launcher,
      "-OriginalPid", $PID,
      "-ExpectedVersion", ([string]$Manifest.version),
      "-ExpectedSha256", $expectedSha,
      "-ExpectedSize", ([string]$expectedSize)
    )
    Start-Process -FilePath "powershell.exe" -ArgumentList $args -WindowStyle Hidden
    [System.Windows.Forms.Application]::Exit()
  } catch {
    $Script:UpdateInProgress = $false
    Write-TipLog "WARN" "Client update failed before updater takeover" @{
      currentVersion = $Script:Version
      nextVersion = [string]$Manifest.version
      message = $_.Exception.Message
    }
    [System.Windows.Forms.MessageBox]::Show((TextFromCodes @(69,65,32,26700,38754,25552,37266,26356,26032,22833,36133,65292,24050,20445,30041,24403,21069,29256,26412,12290)) + "`n$($_.Exception.Message)", (TextFromCodes @(69,65,32,26700,38754,25552,37266,26356,26032)), [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Warning) | Out-Null
  }
}

function Check-ClientUpdate {
  param([switch]$Interactive)
  if (-not $Script:Config.updateEnabled) {
    return
  }
  if ($Script:UpdateInProgress -or $Script:UpdatePromptInProgress) {
    Write-TipLog "INFO" "Client update check skipped by prompt lock" @{
      interactive = [bool]$Interactive
      updateInProgress = [bool]$Script:UpdateInProgress
      promptInProgress = [bool]$Script:UpdatePromptInProgress
    }
    return
  }
  $now = Get-Date
  if (-not $Interactive) {
    $minutes = [Math]::Max(1, [int]$Script:Config.updateCheckMinutes)
    if (($now - $Script:LastUpdateCheckAt).TotalMinutes -lt $minutes) {
      return
    }
  }
  try {
    $manifest = Get-UpdateManifest
    if ((Compare-Version ([string]$manifest.version) $Script:Version) -le 0) {
      $Script:LastUpdateCheckAt = $now
      if ($Interactive) {
        [System.Windows.Forms.MessageBox]::Show((TextFromCodes @(24403,21069,24050,26159,26368,26032,29256,26412,32,118)) + $Script:Version + (TextFromCodes @(12290)), (TextFromCodes @(69,65,32,26700,38754,25552,37266,26356,26032)), [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information) | Out-Null
      }
      Write-TipLog "INFO" "Client update not needed" @{
        currentVersion = $Script:Version
        manifestVersion = [string]$manifest.version
      }
      return
    }
    if (-not $Interactive -and $Script:LastUpdatePostponedVersion -eq [string]$manifest.version) {
      $minutes = [Math]::Max(1, [int]$Script:Config.updateCheckMinutes)
      if (($now - $Script:LastUpdatePostponedAt).TotalMinutes -lt $minutes) {
        Write-TipLog "INFO" "Client update auto prompt skipped after postpone" @{
          currentVersion = $Script:Version
          nextVersion = [string]$manifest.version
        }
        return
      }
    }
    if ($Script:CurrentTip -or $Script:PendingEvents.Count -gt 0) {
      $Script:LastUpdateCheckAt = $now
      Write-TipLog "INFO" "Client update prompt deferred by pending tips" @{
        currentVersion = $Script:Version
        nextVersion = [string]$manifest.version
        pendingCount = $Script:PendingEvents.Count
        hasCurrentTip = [bool]$Script:CurrentTip
      }
      if ($Interactive) {
        [System.Windows.Forms.MessageBox]::Show((TextFromCodes @(24403,21069,26377,27491,22312,26174,31034,25110,24453,22788,29702,25552,37266,65292,35831,22788,29702,21518,20877,26816,26597,26356,26032,12290)), (TextFromCodes @(69,65,32,26700,38754,25552,37266,26356,26032)), [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information) | Out-Null
      }
      return
    }
    $Script:UpdatePromptInProgress = $true
    $Script:LastUpdateCheckAt = $now
    $Script:LastPromptedUpdateVersion = [string]$manifest.version
    $notes = @($manifest.releaseNotes) -join [Environment]::NewLine
    $message = (TextFromCodes @(21457,29616,32,69,65,32,26700,38754,25552,37266,26032,29256,26412,12290)) + "`n" + (TextFromCodes @(24403,21069,29256,26412,65306,118)) + $Script:Version + "`n" + (TextFromCodes @(26032,29256,26412,65306,118)) + $manifest.version
    if ($notes) {
      $message += "`n`n" + (TextFromCodes @(26356,26032,35828,26126,65306)) + "`n$notes"
    }
    $choice = [System.Windows.Forms.MessageBox]::Show($message, (TextFromCodes @(69,65,32,26700,38754,25552,37266,26356,26032)), [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Information)
    if ($choice -eq [System.Windows.Forms.DialogResult]::Yes) {
      Start-ClientUpdate -Manifest $manifest
    } else {
      $Script:LastUpdatePostponedVersion = [string]$manifest.version
      $Script:LastUpdatePostponedAt = Get-Date
      Write-TipLog "INFO" "Client update postponed by user" @{
        currentVersion = $Script:Version
        nextVersion = [string]$manifest.version
      }
    }
  } catch {
    Write-TipLog "WARN" "Client update check failed" @{
      currentVersion = $Script:Version
      message = $_.Exception.Message
    }
    if ($Interactive) {
      [System.Windows.Forms.MessageBox]::Show((TextFromCodes @(26816,26597,26356,26032,22833,36133,65306)) + $_.Exception.Message, (TextFromCodes @(69,65,32,26700,38754,25552,37266,26356,26032)), [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Warning) | Out-Null
    }
  } finally {
    $Script:UpdatePromptInProgress = $false
  }
}

function Get-DesktopTipEvents {
  $base = Api-Base
  $client = [uri]::EscapeDataString([string]$Script:ClientId)
  $version = [uri]::EscapeDataString([string]$Script:Version)
  $uri = "$base/api/desktop-tip/events?clientId=$client&clientVersion=$version"
  Invoke-RestMethod -Method Get -Uri $uri -Headers (Request-Headers) -TimeoutSec 10
}

function Send-TipAck {
  param(
    [object]$Tip,
    [string]$Action
  )
  if (-not $Tip -or -not $Tip.id) {
    return
  }
  $base = Api-Base
  $body = @{
    eventId = [string]$Tip.id
    clientId = [string]$Script:ClientId
    action = $Action
  } | ConvertTo-Json -Depth 5
  try {
    Invoke-RestMethod -Method Post -Uri "$base/api/desktop-tip/events/ack" -Headers (Request-Headers) -Body $body -ContentType "application/json; charset=utf-8" -TimeoutSec 10 | Out-Null
    Write-TipLog "INFO" "Tip ack sent" @{
      eventId = [string]$Tip.id
      action = $Action
    }
  } catch {
    Write-TipLog "WARN" "Tip ack failed" @{
      eventId = [string]$Tip.id
      action = $Action
      message = $_.Exception.Message
    }
  }
}

function Poll-Events {
  try {
    $result = Get-DesktopTipEvents
    $Script:LastPollError = ""
    $events = @($result.events)
    foreach ($tip in $events) {
      if (-not $tip.id) {
        continue
      }
      if ($Script:SeenEventIds.ContainsKey([string]$tip.id)) {
        continue
      }
      $Script:SeenEventIds[[string]$tip.id] = $true
      $Script:PendingEvents.Enqueue($tip)
      Send-TipAck -Tip $tip -Action "shown"
      Write-TipLog "INFO" "Tip event queued locally" @{
        eventId = [string]$tip.id
        title = [string]$tip.title
        clientId = Mask-LogId ([string]$Script:ClientId)
      }
    }
    return $events.Count
  } catch {
    $message = $_.Exception.Message
    if ($Script:LastPollError -ne $message) {
      Write-TipLog "WARN" "Tip polling failed" @{
        serverBaseUrl = [string]$Script:Config.serverBaseUrl
        clientId = Mask-LogId ([string]$Script:ClientId)
        message = $message
      }
    }
    $Script:LastPollError = $message
    return 0
  }
}

function Get-ClientSendOptions {
  $base = Api-Base
  $client = [uri]::EscapeDataString([string]$Script:ClientId)
  $version = [uri]::EscapeDataString([string]$Script:Version)
  $uri = "$base/api/desktop-tip/client-send/options?clientId=$client&clientVersion=$version"
  Invoke-RestMethod -Method Get -Uri $uri -Headers (Request-Headers) -TimeoutSec 10
}

function Send-ClientManualMessage {
  param(
    [string]$Title,
    [string]$Body,
    [bool]$WecomEnabled,
    [object[]]$Targets
  )
  $base = Api-Base
  $payload = [ordered]@{
    clientId = [string]$Script:ClientId
    clientVersion = [string]$Script:Version
    title = $Title
    body = $Body
    wecomGroups = @{
      enabled = $WecomEnabled
      targets = @($Targets)
    }
  }
  $json = $payload | ConvertTo-Json -Depth 8
  Invoke-RestMethod -Method Post -Uri "$base/api/desktop-tip/client-send/manual-message" -Headers (Request-Headers) -Body $json -ContentType "application/json; charset=utf-8" -TimeoutSec 20
}

function Format-ClientSendResult {
  param([object]$Result)
  $desktopQueued = [int]($Result.queuedCount)
  $desktopTotal = [int]($Result.recipientCount)
  $text = (TextFromCodes @(24050,21457,36865,65292,26700,38754,25490,38431,32)) + $desktopQueued + "/" + $desktopTotal
  if ($Result.wecomGroups -and $Result.wecomGroups.enabled) {
    $success = [int]$Result.wecomGroups.successCount
    $requested = [int]$Result.wecomGroups.requestedCount
    $failed = [int]$Result.wecomGroups.failedCount
    $text += (TextFromCodes @(65292,32676,25104,21151,32)) + $success + "/" + $requested
    if ($failed -gt 0) {
      $failedNames = @()
      foreach ($item in @($Result.wecomGroups.results)) {
        if (-not $item.ok) {
          $name = [string]$item.displayName
          if (-not $name) { $name = [string]$item.groupId }
          $reason = [string]$item.message
          if (-not $reason) { $reason = [string]$item.errmsg }
          $failedNames += ($name + ":" + $reason)
        }
      }
      $text += (TextFromCodes @(65292,22833,36133,65306)) + ($failedNames -join "; ")
    }
  }
  return $text
}

function Show-SendNotificationWindow {
  Load-Config
  Ensure-ClientId
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing

  $form = New-Object System.Windows.Forms.Form
  $form.Text = TextFromCodes @(21457,36865,36890,30693)
  $form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
  $form.Width = 560
  $form.Height = 620
  $form.MinimumSize = New-Object System.Drawing.Size(520, 560)
  $form.BackColor = [System.Drawing.Color]::White
  $form.ShowInTaskbar = $true

  $titleLabel = New-Object System.Windows.Forms.Label
  $titleLabel.Text = TextFromCodes @(28040,24687,26631,39064)
  $titleLabel.Left = 18
  $titleLabel.Top = 18
  $titleLabel.Width = 500
  $titleLabel.Height = 22
  $titleLabel.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 10, [System.Drawing.FontStyle]::Bold)
  $form.Controls.Add($titleLabel)

  $titleBox = New-Object System.Windows.Forms.TextBox
  $titleBox.Left = 18
  $titleBox.Top = 44
  $titleBox.Width = 504
  $titleBox.Height = 28
  $titleBox.Text = TextFromCodes @(69,65,26700,38754,25552,37266,36890,30693)
  $form.Controls.Add($titleBox)

  $bodyLabel = New-Object System.Windows.Forms.Label
  $bodyLabel.Text = TextFromCodes @(28040,24687,20869,23481)
  $bodyLabel.Left = 18
  $bodyLabel.Top = 84
  $bodyLabel.Width = 500
  $bodyLabel.Height = 22
  $bodyLabel.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 10, [System.Drawing.FontStyle]::Bold)
  $form.Controls.Add($bodyLabel)

  $bodyBox = New-Object System.Windows.Forms.RichTextBox
  $bodyBox.Left = 18
  $bodyBox.Top = 110
  $bodyBox.Width = 504
  $bodyBox.Height = 160
  $bodyBox.WordWrap = $true
  $bodyBox.ScrollBars = [System.Windows.Forms.RichTextBoxScrollBars]::Vertical
  $bodyBox.DetectUrls = $false
  $bodyBox.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 10)
  $form.Controls.Add($bodyBox)

  $scopeLabel = New-Object System.Windows.Forms.Label
  $scopeLabel.Left = 18
  $scopeLabel.Top = 282
  $scopeLabel.Width = 504
  $scopeLabel.Height = 24
  $scopeLabel.Text = TextFromCodes @(26700,38754,36890,30693,65306,20840,37096,24050,30331,35760,23458,25143,31471,31471)
  $form.Controls.Add($scopeLabel)

  $wecomCheck = New-Object System.Windows.Forms.CheckBox
  $wecomCheck.Left = 18
  $wecomCheck.Top = 314
  $wecomCheck.Width = 260
  $wecomCheck.Height = 24
  $wecomCheck.Text = TextFromCodes @(21516,26102,21457,36865,20225,19994,24494,20449,32676)
  $form.Controls.Add($wecomCheck)

  $modeLabel = New-Object System.Windows.Forms.Label
  $modeLabel.Left = 292
  $modeLabel.Top = 316
  $modeLabel.Width = 90
  $modeLabel.Height = 22
  $modeLabel.Text = TextFromCodes @(36890,30693,26041,24335)
  $form.Controls.Add($modeLabel)

  $modeBox = New-Object System.Windows.Forms.ComboBox
  $modeBox.Left = 386
  $modeBox.Top = 312
  $modeBox.Width = 136
  $modeBox.DropDownStyle = [System.Windows.Forms.ComboBoxStyle]::DropDownList
  [void]$modeBox.Items.Add((TextFromCodes @(26222,36890,36890,30693)))
  [void]$modeBox.Items.Add((TextFromCodes @(64,25152,26377,20154)))
  $modeBox.SelectedIndex = 0
  $form.Controls.Add($modeBox)

  $groupList = New-Object System.Windows.Forms.CheckedListBox
  $groupList.Left = 18
  $groupList.Top = 348
  $groupList.Width = 504
  $groupList.Height = 110
  $groupList.CheckOnClick = $true
  $groupList.DisplayMember = "DisplayName"
  $groupList.HorizontalScrollbar = $true
  $form.Controls.Add($groupList)

  $statusLabel = New-Object System.Windows.Forms.Label
  $statusLabel.Left = 18
  $statusLabel.Top = 468
  $statusLabel.Width = 504
  $statusLabel.Height = 46
  $statusLabel.ForeColor = [System.Drawing.ColorTranslator]::FromHtml("#334155")
  $form.Controls.Add($statusLabel)

  $sendButton = New-Object System.Windows.Forms.Button
  $sendButton.Text = TextFromCodes @(21457,36865)
  $sendButton.Left = 326
  $sendButton.Top = 526
  $sendButton.Width = 92
  $sendButton.Height = 34
  $sendButton.BackColor = [System.Drawing.ColorTranslator]::FromHtml("#1677ff")
  $sendButton.ForeColor = [System.Drawing.Color]::White
  $sendButton.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
  $sendButton.FlatAppearance.BorderSize = 0
  $form.Controls.Add($sendButton)

  $closeButton = New-Object System.Windows.Forms.Button
  $closeButton.Text = TextFromCodes @(20851,38381)
  $closeButton.Left = 430
  $closeButton.Top = 526
  $closeButton.Width = 92
  $closeButton.Height = 34
  $closeButton.Add_Click({ $form.Close() })
  $form.Controls.Add($closeButton)

  $groupList.Enabled = $false
  $modeBox.Enabled = $false
  $sendButton.Enabled = $false
  $statusLabel.Text = TextFromCodes @(27491,22312,21152,36733,21457,36865,36873,39033)

  try {
    $options = Get-ClientSendOptions
    $registeredCount = [int]$options.registeredClientCount
    $scopeLabel.Text = (TextFromCodes @(26700,38754,36890,30693,65306,20840,37096,24050,30331,35760,23458,25143,31471,32,40)) + $registeredCount + (TextFromCodes @(21488,41))
    foreach ($group in @($options.wecomGroups.groups)) {
      $item = New-Object psobject -Property @{
        GroupId = [string]$group.groupId
        DisplayName = [string]$group.displayName
      }
      [void]$groupList.Items.Add($item)
    }
    if ($registeredCount -le 0) {
      $statusLabel.Text = TextFromCodes @(24403,21069,27809,26377,24050,30331,35760,23458,25143,31471)
    } else {
      $sendButton.Enabled = $true
      $statusLabel.Text = (TextFromCodes @(21487,21457,36865,21040,32)) + $registeredCount + (TextFromCodes @(32,21488,24050,30331,35760,23458,25143,31471))
    }
    if ($groupList.Items.Count -gt 0) {
      $wecomCheck.Enabled = $true
    } else {
      $wecomCheck.Enabled = $false
    }
  } catch {
    $statusLabel.ForeColor = [System.Drawing.ColorTranslator]::FromHtml("#dc2626")
    $statusLabel.Text = (TextFromCodes @(21152,36733,21457,36865,36873,39033,22833,36133,65306)) + $_.Exception.Message
    Write-TipLog "WARN" "Client send options load failed" @{
      clientId = Mask-LogId ([string]$Script:ClientId)
      message = $_.Exception.Message
    }
  }

  $wecomCheck.Add_CheckedChanged({
    $groupList.Enabled = [bool]$wecomCheck.Checked
    $modeBox.Enabled = [bool]$wecomCheck.Checked
  })

  $sendButton.Add_Click({
    if (-not $sendButton.Enabled) {
      return
    }
    $title = ([string]$titleBox.Text).Trim()
    $body = ([string]$bodyBox.Text).Trim()
    if (-not $title) {
      $statusLabel.ForeColor = [System.Drawing.ColorTranslator]::FromHtml("#dc2626")
      $statusLabel.Text = TextFromCodes @(28040,24687,26631,39064,19981,33021,20026,31354)
      return
    }
    if (-not $body) {
      $statusLabel.ForeColor = [System.Drawing.ColorTranslator]::FromHtml("#dc2626")
      $statusLabel.Text = TextFromCodes @(28040,24687,20869,23481,19981,33021,20026,31354)
      return
    }
    if ($title.Length -gt 80) {
      $statusLabel.ForeColor = [System.Drawing.ColorTranslator]::FromHtml("#dc2626")
      $statusLabel.Text = TextFromCodes @(28040,24687,26631,39064,19981,33021,36229,36807,32,56,48,32,20010,23383)
      return
    }
    if ($body.Length -gt 1000) {
      $statusLabel.ForeColor = [System.Drawing.ColorTranslator]::FromHtml("#dc2626")
      $statusLabel.Text = TextFromCodes @(28040,24687,20869,23481,19981,33021,36229,36807,32,49,48,48,48,32,20010,23383)
      return
    }
    $targets = @()
    if ($wecomCheck.Checked) {
      foreach ($item in @($groupList.CheckedItems)) {
        $mentionMode = if ($modeBox.SelectedIndex -eq 1) { "all" } else { "none" }
        $targets += @{ groupId = [string]$item.GroupId; mentionMode = $mentionMode }
      }
      if ($targets.Count -le 0) {
        $statusLabel.ForeColor = [System.Drawing.ColorTranslator]::FromHtml("#dc2626")
        $statusLabel.Text = TextFromCodes @(21246,36873,20225,19994,24494,20449,32676,36890,30693,21518,33267,23569,36873,25321,32,49,32,20010,24050,32465,23450,32676)
        return
      }
    }
    $sendButton.Enabled = $false
    $statusLabel.ForeColor = [System.Drawing.ColorTranslator]::FromHtml("#334155")
    $statusLabel.Text = TextFromCodes @(27491,22312,21457,36865,65292,35831,31245,20505)
    try {
      $result = Send-ClientManualMessage -Title $title -Body $body -WecomEnabled ([bool]$wecomCheck.Checked) -Targets $targets
      $statusLabel.ForeColor = [System.Drawing.ColorTranslator]::FromHtml("#16a34a")
      $statusLabel.Text = Format-ClientSendResult -Result $result
      Write-TipLog "INFO" "Client manual message submitted" @{
        queuedCount = [int]$result.queuedCount
        recipientCount = [int]$result.recipientCount
        wecomGroupEnabled = [bool]($result.wecomGroups -and $result.wecomGroups.enabled)
        wecomGroupSuccess = [int]($result.wecomGroups.successCount)
        wecomGroupFailed = [int]($result.wecomGroups.failedCount)
      }
    } catch {
      $statusLabel.ForeColor = [System.Drawing.ColorTranslator]::FromHtml("#dc2626")
      $statusLabel.Text = (TextFromCodes @(21457,36865,22833,36133,65306)) + $_.Exception.Message
      Write-TipLog "WARN" "Client manual message submit failed" @{
        clientId = Mask-LogId ([string]$Script:ClientId)
        titleLength = $title.Length
        bodyLength = $body.Length
        message = $_.Exception.Message
      }
    } finally {
      $sendButton.Enabled = $true
    }
  })

  $form.ShowDialog() | Out-Null
}

function Run-SelfTest {
  Load-Config
  Ensure-ClientId
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $testFont = New-Object System.Drawing.Font("Microsoft YaHei UI", 12)
  $testSize = New-Object System.Drawing.Size(340, 10000)
  $testFlags = [System.Windows.Forms.TextFormatFlags]::WordBreak -bor [System.Windows.Forms.TextFormatFlags]::TextBoxControl
  $shortSingle = [System.Windows.Forms.TextRenderer]::MeasureText("ok", $testFont, $testSize, $testFlags)
  $shortMulti = [System.Windows.Forms.TextRenderer]::MeasureText(("ok" + [Environment]::NewLine + "ok"), $testFont, $testSize, $testFlags)
  $longMultiText = ((1..20) | ForEach-Object { "EA desktop tip long body line " + $_ }) -join [Environment]::NewLine
  $longMulti = [System.Windows.Forms.TextRenderer]::MeasureText($longMultiText, $testFont, $testSize, $testFlags)
  if ($shortSingle.Height -gt 108 -or $shortMulti.Height -gt 108 -or $longMulti.Height -le 108) {
    throw "Body scroll self test failed"
  }
  Write-TipLog "INFO" "Self test passed" @{
    version = $Script:Version
    configPath = $Script:ConfigPath
    clientId = $Script:ClientId
    bodyScrollMode = "native_on_demand"
  }
  Write-Output ((TextFromCodes @(69,65,32,26700,38754,25552,37266,32,118)) + $Script:Version + (TextFromCodes @(32,115,101,108,102,32,116,101,115,116,32,112,97,115,115,101,100,65292,27491,24335,26381,20572,26381,26356,26032,38754,26495,20013,25991,33258,26816,36890,36807)))
}

function Run-Once {
  Load-Config
  Ensure-ClientId
  $count = Poll-Events
  Write-Output ((TextFromCodes @(69,65,32,26700,38754,25552,37266,32,118)) + $Script:Version + (TextFromCodes @(32,112,111,108,108,32,102,105,110,105,115,104,101,100,44,32,101,118,101,110,116,115,61)) + $count)
}

function Start-TipWindow {
  Load-Config
  Ensure-ClientId
  Save-Config
  Stop-OtherDesktopTipClientInstances | Out-Null
  Initialize-DesktopTipLauncher

  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  [System.Windows.Forms.Application]::EnableVisualStyles()

  $form = New-Object System.Windows.Forms.Form
  $form.Text = (TextFromCodes @(69,65,32,26700,38754,25552,37266,32,118)) + $Script:Version
  $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
  $form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
  $form.TopMost = $true
  $form.ShowInTaskbar = $true
  $form.BackColor = [System.Drawing.ColorTranslator]::FromHtml("#101820")

  $button = New-Object System.Windows.Forms.Button
  $button.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
  $button.FlatAppearance.BorderSize = 0
  $button.BackColor = [System.Drawing.ColorTranslator]::FromHtml("#1677ff")
  $button.ForeColor = [System.Drawing.Color]::White
  $button.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 11, [System.Drawing.FontStyle]::Bold)
  $button.Text = [string]$Script:Config.floatingButtonText
  $button.Left = 0
  $button.Top = 0
  $button.Width = 58
  $button.Height = 58
  $form.Controls.Add($button)

  $versionLabel = New-Object System.Windows.Forms.Label
  $versionLabel.Text = "V" + $Script:Version
  $versionLabel.BackColor = [System.Drawing.ColorTranslator]::FromHtml("#1677ff")
  $versionLabel.ForeColor = [System.Drawing.ColorTranslator]::FromHtml("#dbeafe")
  $versionLabel.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 7.5)
  $versionLabel.Left = 0
  $versionLabel.Top = 39
  $versionLabel.Width = 58
  $versionLabel.Height = 17
  $versionLabel.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter
  $form.Controls.Add($versionLabel)

  $titleLabel = New-Object System.Windows.Forms.Label
  $titleLabel.ForeColor = [System.Drawing.Color]::White
  $titleLabel.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 12, [System.Drawing.FontStyle]::Bold)
  $titleLabel.Left = 72
  $titleLabel.Top = 34
  $titleLabel.Width = 286
  $titleLabel.Height = 28
  $form.Controls.Add($titleLabel)

  $statusLabel = New-Object System.Windows.Forms.Label
  $statusLabel.ForeColor = [System.Drawing.Color]::White
  $statusLabel.BackColor = [System.Drawing.ColorTranslator]::FromHtml("#1677ff")
  $statusLabel.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 10, [System.Drawing.FontStyle]::Bold)
  $statusLabel.Left = 18
  $statusLabel.Top = 66
  $statusLabel.Width = 340
  $statusLabel.Height = 28
  $statusLabel.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter
  $form.Controls.Add($statusLabel)

  $bodyBox = New-Object System.Windows.Forms.RichTextBox
  $bodyBox.ReadOnly = $true
  $bodyBox.BorderStyle = [System.Windows.Forms.BorderStyle]::None
  $bodyBox.ScrollBars = [System.Windows.Forms.RichTextBoxScrollBars]::Vertical
  $bodyBox.WordWrap = $true
  $bodyBox.DetectUrls = $false
  $bodyBox.BackColor = [System.Drawing.ColorTranslator]::FromHtml("#101820")
  $bodyBox.ForeColor = [System.Drawing.ColorTranslator]::FromHtml("#e8eef5")
  $bodyBox.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 9)
  $bodyBox.Left = 18
  $bodyBox.Top = 72
  $bodyBox.Width = 340
  $bodyBox.Height = 100
  $form.Controls.Add($bodyBox)

  $openButton = New-Object System.Windows.Forms.Button
  $openButton.Text = TextFromCodes @(0x6253,0x5F00)
  $openButton.Left = 190
  $openButton.Top = 184
  $openButton.Width = 78
  $openButton.Height = 30
  $openButton.BackColor = [System.Drawing.ColorTranslator]::FromHtml("#16a34a")
  $openButton.ForeColor = [System.Drawing.Color]::White
  $openButton.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
  $openButton.FlatAppearance.BorderSize = 0
  $form.Controls.Add($openButton)

  $dismissButton = New-Object System.Windows.Forms.Button
  $dismissButton.Text = TextFromCodes @(0x6536,0x8D77)
  $dismissButton.Left = 280
  $dismissButton.Top = 184
  $dismissButton.Width = 78
  $dismissButton.Height = 30
  $dismissButton.BackColor = [System.Drawing.ColorTranslator]::FromHtml("#334155")
  $dismissButton.ForeColor = [System.Drawing.Color]::White
  $dismissButton.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
  $dismissButton.FlatAppearance.BorderSize = 0
  $form.Controls.Add($dismissButton)

  $exitMenu = New-Object System.Windows.Forms.ContextMenuStrip
  $menuVersionItem = $exitMenu.Items.Add((TextFromCodes @(69,65,32,26700,38754,25552,37266,32,86)) + $Script:Version)
  $menuVersionItem.Enabled = $false
  [void]$exitMenu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
  $sendItem = $exitMenu.Items.Add((TextFromCodes @(21457,36865,36890,30693)))
  $sendItem.Add_Click({ Show-SendNotificationWindow })
  $autoStartItem = $exitMenu.Items.Add((TextFromCodes @(24320,26426,33258,21160,21551,21160)))
  $autoStartItem.CheckOnClick = $false
  $autoStartItem.Checked = Test-DesktopTipAutoStart
  $autoStartItem.Add_Click({
    try {
      Set-DesktopTipAutoStart -Enabled (-not (Test-DesktopTipAutoStart))
      $autoStartItem.Checked = Test-DesktopTipAutoStart
    } catch {
      Write-TipLog "WARN" "Desktop tip autostart toggle failed" @{
        message = $_.Exception.Message
      }
      [System.Windows.Forms.MessageBox]::Show((TextFromCodes @(24320,26426,33258,21160,21551,21160,35774,32622,22833,36133,12290)) + "`n$($_.Exception.Message)", (TextFromCodes @(69,65,32,26700,38754,25552,37266)), [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Warning) | Out-Null
    }
  })
  $updateItem = $exitMenu.Items.Add((TextFromCodes @(26816,26597,26356,26032)))
  $updateItem.Add_Click({ Check-ClientUpdate -Interactive })
  $exitItem = $exitMenu.Items.Add((TextFromCodes @(0x9000,0x51FA,0x20,0x45,0x41,0x20,0x54,0x69,0x70,0x73)))
  $exitItem.Add_Click({ $form.Close() })
  $form.ContextMenuStrip = $exitMenu
  $exitMenu.Add_Opening({
    $autoStartItem.Checked = Test-DesktopTipAutoStart
  })

  function Move-ToBottomRight {
    param([int]$Width, [int]$Height)
    $area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    $form.Width = $Width
    $form.Height = $Height
    $form.Left = $area.Right - $form.Width - 12
    $form.Top = $area.Bottom - $form.Height - 12
  }

  function Set-Collapsed {
    $versionLabel.Visible = $false
    $titleLabel.Visible = $false
    $statusLabel.Visible = $false
    $bodyBox.Visible = $false
    $openButton.Visible = $false
    $dismissButton.Visible = $false
    $button.Text = [string]$Script:Config.floatingButtonText
    Move-ToBottomRight -Width 58 -Height 58
  }

  function Set-Expanded {
    param([object]$Tip)
    $versionLabel.Visible = $true
    $titleLabel.Visible = $true
    $statusLabel.Visible = $false
    $bodyBox.Visible = $true
    $openButton.Visible = $true
    $dismissButton.Visible = $true
    $openButton.Enabled = $true
    $dismissButton.Enabled = $true
    $button.Text = "EA"
    $titleLabel.Text = [string]$Tip.title
    $maintenance = Get-MaintenanceMeta -Tip $Tip
    if ($maintenance) {
      $form.BackColor = [System.Drawing.ColorTranslator]::FromHtml("#16181d")
      $bodyBox.BackColor = [System.Drawing.ColorTranslator]::FromHtml("#16181d")
      $statusLabel.Visible = $true
      $statusLabel.Text = Maintenance-StatusText -Maintenance $maintenance
      $statusLabel.BackColor = [System.Drawing.ColorTranslator]::FromHtml((Maintenance-StatusColor -Maintenance $maintenance))
      $bodyBox.Text = Maintenance-BodyText -Tip $Tip -Maintenance $maintenance
      $bodyBox.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 9)
      $bodyBox.Top = 104
      $bodyBox.Width = 384
      $bodyBox.Height = 124
      $titleLabel.Width = 330
      $openButton.Text = TextFromCodes @(26597,30475,35814,24773)
      $dismissButton.Text = TextFromCodes @(30693,36947,20102)
      $openButton.Left = 230
      $dismissButton.Left = 322
      $openButton.Top = 242
      $dismissButton.Top = 242
      Move-ToBottomRight -Width 420 -Height 286
    } else {
      $form.BackColor = [System.Drawing.ColorTranslator]::FromHtml("#101820")
      $bodyBox.BackColor = [System.Drawing.ColorTranslator]::FromHtml("#101820")
      if ($Tip.body) {
        $bodyBox.Text = [string]$Tip.body
      } else {
        $bodyBox.Text = ""
      }
      $bodyBox.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 12)
      $bodyBox.Top = 76
      $bodyBox.Width = 340
      $bodyBox.Height = 108
      $titleLabel.Width = 286
      $openButton.Text = TextFromCodes @(25910,21040)
      $genericWindowWidth = 376
      $genericActionCenter = $bodyBox.Left + [int]($bodyBox.Width / 2)
      $openButton.Left = [int]($genericActionCenter - ($openButton.Width / 2))
      $openButton.Top = 194
      $dismissButton.Visible = $false
      Move-ToBottomRight -Width $genericWindowWidth -Height 240
    }
    $form.WindowState = [System.Windows.Forms.FormWindowState]::Normal
    $form.Show()
    $form.TopMost = $false
    $form.TopMost = $true
    $form.Activate()
    if ($Tip.id -and $Script:LastDisplayedTipId -ne [string]$Tip.id) {
      $Script:LastDisplayedTipId = [string]$Tip.id
      Write-TipLog "INFO" "Tip displayed" @{
        eventId = [string]$Tip.id
        title = [string]$Tip.title
      }
    }
  }

  function Show-NextTip {
    if ($Script:CurrentTip) {
      return
    }
    if ($Script:PendingEvents.Count -le 0) {
      Set-Collapsed
      return
    }
    $Script:CurrentTip = $Script:PendingEvents.Dequeue()
    Set-Expanded -Tip $Script:CurrentTip
  }

  function Wake-DesktopTipWindow {
    $form.WindowState = [System.Windows.Forms.FormWindowState]::Normal
    if (-not $form.Visible) {
      $form.Show()
    }
    $form.TopMost = $false
    $form.TopMost = $true
    $form.Activate()
    Write-TipLog "INFO" "Desktop tip window waked by duplicate launch" @{
      currentTip = [bool]$Script:CurrentTip
    }
  }

  $logoClick = {
    if ($Script:CurrentTip) {
      Set-Expanded -Tip $Script:CurrentTip
      return
    }
    Poll-Events | Out-Null
    Show-NextTip
  }
  $button.Add_Click($logoClick)
  $versionLabel.Add_Click($logoClick)

  $dismissButton.Add_Click({
    if ($Script:CurrentTip) {
      Send-TipAck -Tip $Script:CurrentTip -Action "dismissed"
      $Script:CurrentTip = $null
    }
    Show-NextTip
  })

  $openButton.Add_Click({
    if ($Script:CurrentTip) {
      if (-not $openButton.Enabled) {
        return
      }
      $openButton.Enabled = $false
      $primaryAction = if (Get-MaintenanceMeta -Tip $Script:CurrentTip) { "opened" } else { "done" }
      try {
        if ($primaryAction -eq "opened") {
          Send-TipAck -Tip $Script:CurrentTip -Action "opened"
          $url = [string]$Script:CurrentTip.openUrl
          if (-not $url) {
            $url = [string]$Script:Config.openUrl
          }
          try {
            Start-Process $url
          } catch {
            Write-TipLog "WARN" "Open url failed" @{
              eventId = [string]$Script:CurrentTip.id
              url = $url
              message = $_.Exception.Message
            }
          }
        } else {
          Send-TipAck -Tip $Script:CurrentTip -Action "done"
        }
      } catch {
        Write-TipLog "WARN" "Tip primary action failed" @{
          eventId = [string]$Script:CurrentTip.id
          action = $primaryAction
          message = $_.Exception.Message
        }
      } finally {
        $openButton.Enabled = $true
      }
      $Script:CurrentTip = $null
    }
    Show-NextTip
  })

  $timer = New-Object System.Windows.Forms.Timer
  $timer.Interval = [Math]::Max(3000, [int]$Script:Config.pollSeconds * 1000)
  $timer.Add_Tick({
    if ($Script:SingleInstanceWakeEvent -and $Script:SingleInstanceWakeEvent.WaitOne(0)) {
      Wake-DesktopTipWindow
    }
    Poll-Events | Out-Null
    if ($Script:CurrentTip -and (Get-MaintenanceMeta -Tip $Script:CurrentTip)) {
      Set-Expanded -Tip $Script:CurrentTip
    }
    Show-NextTip
    Check-ClientUpdate | Out-Null
  })
  $timer.Start()

  Write-TipLog "INFO" "EA desktop tip started" @{
    version = $Script:Version
    serverBaseUrl = [string]$Script:Config.serverBaseUrl
    clientId = Mask-LogId ([string]$Script:ClientId)
    pollSeconds = [int]$Script:Config.pollSeconds
  }

  Set-Collapsed
  Poll-Events | Out-Null
  Show-NextTip
  Check-ClientUpdate | Out-Null
  [System.Windows.Forms.Application]::Run($form)
}

if ($SelfTest) {
  Run-SelfTest
  exit 0
}

if ($Once) {
  Run-Once
  exit 0
}

if ($LauncherMigrationTest) {
  if (Ensure-DesktopTipLauncher) {
    Write-Output ("launcher-migration-ok path=" + (Get-LauncherPath))
    exit 0
  }
  Write-Error "launcher-migration-failed"
  exit 1
}

if ($SingleInstanceProbe) {
  if (Initialize-SingleInstance) {
    Write-Output "single-instance-acquired"
    if ($HoldSingleInstanceSeconds -gt 0) {
      Start-Sleep -Seconds $HoldSingleInstanceSeconds
    }
    Release-SingleInstance
    exit 0
  }
  Write-Output "single-instance-duplicate"
  exit 2
}

if ($SelfCleanOldInstancesTest) {
  $count = Stop-OtherDesktopTipClientInstances
  Write-Output ("stopped=" + $count)
  exit 0
}

if (-not (Initialize-SingleInstance)) {
  exit 0
}
try {
  Start-TipWindow
} finally {
  Release-SingleInstance
}
