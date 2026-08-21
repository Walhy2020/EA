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
$launcherPath = Join-Path $ProjectDir "tools\ea-launcher\OutPackage\EA.exe"
if (-not (Test-Path -LiteralPath $launcherPath)) {
    throw "EA launcher was not found: $launcherPath. Run npm run build:ea-launcher first."
}

$launcherArguments = "--background --project-dir `"$ProjectDir`""
$action = New-ScheduledTaskAction -Execute $launcherPath -Argument $launcherArguments -WorkingDirectory $ProjectDir
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -MultipleInstances IgnoreNew

try {
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description "Start EA at logon and restart it after unexpected exits." -Force
    $startupLink = Join-Path ([Environment]::GetFolderPath("Startup")) "$TaskName.lnk"
    Remove-Item -LiteralPath $startupLink -Force -ErrorAction SilentlyContinue
    Write-Host "Installed scheduled task: $TaskName"
    Write-Host "Project directory: $ProjectDir"
    Write-Host "Launcher: $launcherPath"
    Write-Host "EA runs without a console and is monitored by the tray launcher."
    return
} catch {
    $startupDir = [Environment]::GetFolderPath("Startup")
    $startupLink = Join-Path $startupDir "$TaskName.lnk"
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($startupLink)
    $shortcut.TargetPath = $launcherPath
    $shortcut.Arguments = $launcherArguments
    $shortcut.WorkingDirectory = $ProjectDir
    $shortcut.IconLocation = "$launcherPath,0"
    $shortcut.Description = "EA background launcher"
    $shortcut.Save()
    Write-Host "Scheduled task registration was denied; installed the current-user Startup shortcut."
    Write-Host "Startup shortcut: $startupLink"
    Write-Host "Project directory: $ProjectDir"
    Write-Host "The EXE starts with Windows, checks EA every 30 seconds, and restarts it without a console when needed."
}
