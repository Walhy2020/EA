param(
    [string]$ProjectDir = "",
    [int]$Port = 39200,
    [int]$PollSeconds = 30,
    [int]$RestartDelaySeconds = 60
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($ProjectDir)) {
    $ProjectDir = Split-Path -Parent $PSScriptRoot
}

$ProjectDir = (Resolve-Path -LiteralPath $ProjectDir).Path
$entryScript = Join-Path $ProjectDir "src\main.js"
$logDir = Join-Path $ProjectDir "logs"
$logPath = Join-Path $logDir "ea-supervisor.log"
$lockPath = Join-Path $logDir "ea-supervisor.lock"

if (-not (Test-Path -LiteralPath $entryScript)) {
    throw "EA entry script not found: $entryScript"
}

New-Item -ItemType Directory -Path $logDir -Force | Out-Null

function Write-SupervisorLog {
    param([string]$Message)

    $line = "[{0}] [EA-SUPERVISOR] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
    Add-Content -LiteralPath $logPath -Value $line -Encoding utf8
}

function Test-EaListening {
    $client = [System.Net.Sockets.TcpClient]::new()
    try {
        $connectTask = $client.ConnectAsync("127.0.0.1", $Port)
        if (-not $connectTask.Wait(2000)) {
            return $false
        }
        return $client.Connected
    } catch {
        return $false
    } finally {
        $client.Dispose()
    }
}

try {
    $supervisorLock = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
} catch {
    Write-SupervisorLog "Another supervisor instance is already active. Exiting."
    exit 0
}

try {
    Write-SupervisorLog "Supervisor started. ProjectDir=$ProjectDir Port=$Port PollSeconds=$PollSeconds RestartDelaySeconds=$RestartDelaySeconds"

    while ($true) {
        if (Test-EaListening) {
            Start-Sleep -Seconds $PollSeconds
            continue
        }

        Write-SupervisorLog "EA is not listening on port $Port. Starting node src/main.js."
        try {
            $process = Start-Process -FilePath "node" -ArgumentList "src/main.js" -WorkingDirectory $ProjectDir -WindowStyle Hidden -PassThru
            Write-SupervisorLog "EA start requested. ProcessId=$($process.Id)"
        } catch {
            Write-SupervisorLog "EA start failed: $($_.Exception.Message)"
        }

        Start-Sleep -Seconds $RestartDelaySeconds
    }
} finally {
    $supervisorLock.Dispose()
}
