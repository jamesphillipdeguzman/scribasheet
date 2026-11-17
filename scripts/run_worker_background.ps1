param(
    [switch]$RotateOnly
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$BackendDir = Join-Path $RepoRoot "backend"
$PythonExe = Join-Path $BackendDir ".venv\Scripts\python.exe"
$LogsDir = Join-Path $RepoRoot "logs"
$LogFile = Join-Path $LogsDir "worker.log"
$BackupLogFile = Join-Path $LogsDir "worker.log.1"
$MaxLogBytes = 5 * 1024 * 1024

if (-not (Test-Path $LogsDir)) {
    New-Item -ItemType Directory -Path $LogsDir -Force | Out-Null
}

function Invoke-WorkerLogRotation {
    if (Test-Path $LogFile) {
        $info = Get-Item $LogFile
        if ($info.Length -gt $MaxLogBytes) {
            if (Test-Path $BackupLogFile) {
                Remove-Item -Path $BackupLogFile -Force
            }
            Move-Item -Path $LogFile -Destination $BackupLogFile -Force
        }
    }
}

Invoke-WorkerLogRotation

if ($RotateOnly) {
    exit 0
}

if (-not (Test-Path $PythonExe)) {
    $msg = "[$(Get-Date -Format o)] [ERROR] Missing virtual environment Python executable: $PythonExe"
    Add-Content -Path $LogFile -Value $msg -Encoding utf8
    Write-Error $msg
    exit 1
}

# Load non-empty KEY=VALUE entries from backend\.env or backend\worker.env if not already set.
# Values are never logged.
foreach ($envFileName in @(".env", "worker.env")) {
    $envPath = Join-Path $BackendDir $envFileName
    if (Test-Path $envPath) {
        Get-Content $envPath | ForEach-Object {
            $line = $_.Trim()
            if (-not $line -or $line.StartsWith("#")) { return }
            $idx = $line.IndexOf("=")
            if ($idx -le 0) { return }
            $key = $line.Substring(0, $idx).Trim()
            $val = $line.Substring($idx + 1).Trim().Trim('"').Trim("'")
            if ($key -and -not [Environment]::GetEnvironmentVariable($key, "Process")) {
                [Environment]::SetEnvironmentVariable($key, $val, "Process")
            }
        }
    }
}

$env:PYTHONUNBUFFERED = "1"

$startStamp = Get-Date -Format o
Add-Content -Path $LogFile -Value "[$startStamp] [INFO] Starting ScribaSheet background worker via $PythonExe" -Encoding utf8

Push-Location $BackendDir
try {
    & $PythonExe -m app.worker_agent 2>&1 | ForEach-Object {
        $line = if ($_ -is [System.Management.Automation.ErrorRecord]) {
            $_.ToString()
        } else {
            [string]$_
        }
        Add-Content -Path $LogFile -Value $line -Encoding utf8
    }
    $exitCode = $LASTEXITCODE
} finally {
    Pop-Location
}

$endStamp = Get-Date -Format o
Add-Content -Path $LogFile -Value "[$endStamp] [INFO] ScribaSheet background worker exited with code $exitCode" -Encoding utf8
exit $exitCode
