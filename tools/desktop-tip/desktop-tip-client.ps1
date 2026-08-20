param(
  [string]$ConfigPath = "",
  [string]$UserId = "",
  [string]$ServerBaseUrl = "",
  [switch]$Once,
  [switch]$SelfTest
)

$ErrorActionPreference = "Stop"
$Script:Version = "0.3.4"
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
$Script:LastUpdateCheckAt = [DateTime]::MinValue

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
    $launcher = Join-Path $Script:Root ((TextFromCodes @(21551,21160,69,65,21491,19979,35282,25552,37266)) + ".bat")
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
  if ($Script:UpdateInProgress) {
    return
  }
  $now = Get-Date
  if (-not $Interactive) {
    $minutes = [Math]::Max(1, [int]$Script:Config.updateCheckMinutes)
    if (($now - $Script:LastUpdateCheckAt).TotalMinutes -lt $minutes) {
      return
    }
  }
  $Script:LastUpdateCheckAt = $now
  try {
    $manifest = Get-UpdateManifest
    if ((Compare-Version ([string]$manifest.version) $Script:Version) -le 0) {
      if ($Interactive) {
        [System.Windows.Forms.MessageBox]::Show((TextFromCodes @(24403,21069,24050,26159,26368,26032,29256,26412,32,118)) + $Script:Version + (TextFromCodes @(12290)), (TextFromCodes @(69,65,32,26700,38754,25552,37266,26356,26032)), [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Information) | Out-Null
      }
      Write-TipLog "INFO" "Client update not needed" @{
        currentVersion = $Script:Version
        manifestVersion = [string]$manifest.version
      }
      return
    }
    if ($Script:CurrentTip -or $Script:PendingEvents.Count -gt 0) {
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
    $notes = @($manifest.releaseNotes) -join [Environment]::NewLine
    $message = (TextFromCodes @(21457,29616,32,69,65,32,26700,38754,25552,37266,26032,29256,26412,12290)) + "`n" + (TextFromCodes @(24403,21069,29256,26412,65306,118)) + $Script:Version + "`n" + (TextFromCodes @(26032,29256,26412,65306,118)) + $manifest.version
    if ($notes) {
      $message += "`n`n" + (TextFromCodes @(26356,26032,35828,26126,65306)) + "`n$notes"
    }
    $choice = [System.Windows.Forms.MessageBox]::Show($message, (TextFromCodes @(69,65,32,26700,38754,25552,37266,26356,26032)), [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Information)
    if ($choice -eq [System.Windows.Forms.DialogResult]::Yes) {
      Start-ClientUpdate -Manifest $manifest
    } else {
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
  $updateItem = $exitMenu.Items.Add((TextFromCodes @(26816,26597,26356,26032)))
  $updateItem.Add_Click({ Check-ClientUpdate -Interactive })
  $exitItem = $exitMenu.Items.Add((TextFromCodes @(0x9000,0x51FA,0x20,0x45,0x41,0x20,0x54,0x69,0x70,0x73)))
  $exitItem.Add_Click({ $form.Close() })
  $form.ContextMenuStrip = $exitMenu

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

Start-TipWindow
