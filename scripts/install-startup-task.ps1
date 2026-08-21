param(
    [string]$TaskName = "EazyGameIntegratedAssistant",
    [string]$ProjectDir = ""
)

$ErrorActionPreference = "Stop"

$scriptRoot = Split-Path -Parent $PSCommandPath
if ([string]::IsNullOrWhiteSpace($ProjectDir)) {
    $ProjectDir = Split-Path -Parent $scriptRoot
}

$ProjectDir = (Resolve-Path -LiteralPath $ProjectDir).Path
$scriptPath = Join-Path $ProjectDir "scripts\start.cmd"
$supervisorPath = Join-Path $ProjectDir "scripts\ea-supervisor.ps1"
if (-not (Test-Path $scriptPath)) {
    throw "start.cmd not found: $scriptPath"
}
if (-not (Test-Path $supervisorPath)) {
    throw "ea-supervisor.ps1 not found: $supervisorPath"
}

$action = New-ScheduledTaskAction -Execute $scriptPath -WorkingDirectory $ProjectDir
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -MultipleInstances IgnoreNew

try {
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description "Start EA at logon and restart it after unexpected exits." -Force
    Write-Host "Installed scheduled task: $TaskName"
    Write-Host "Project directory: $ProjectDir"
    Write-Host "Restart policy: once per minute, up to 999 unexpected exits, single instance only."
    return
} catch {
    $runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
    $launchCommand = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$supervisorPath`""
    New-ItemProperty -Path $runKey -Name $TaskName -PropertyType String -Value $launchCommand -Force | Out-Null
    Write-Host "Scheduled task registration was denied; installed current-user startup fallback."
    Write-Host "Startup value: $TaskName"
    Write-Host "Project directory: $ProjectDir"
    Write-Host "Supervisor checks port 39200 every 30 seconds, starts EA immediately when it is down, and retries failed starts after one minute."
}
