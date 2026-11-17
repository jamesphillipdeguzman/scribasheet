$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$BackendDir = Join-Path $RepoRoot "backend"
$PythonExe = Join-Path $BackendDir ".venv\Scripts\python.exe"
$LogsDir = Join-Path $RepoRoot "logs"
$LogFile = Join-Path $LogsDir "controller.log"
$BackupLogFile = Join-Path $LogsDir "controller.log.1"
$MaxLogBytes = 5 * 1024 * 1024

if (-not (Test-Path $LogsDir)) {
    New-Item -ItemType Directory -Path $LogsDir -Force | Out-Null
}

if (Test-Path $LogFile) {
    $info = Get-Item $LogFile
    if ($info.Length -gt $MaxLogBytes) {
        if (Test-Path $BackupLogFile) { Remove-Item -Path $BackupLogFile -Force }
        Move-Item -Path $LogFile -Destination $BackupLogFile -Force
    }
}

if (-not (Test-Path $PythonExe)) {
    $msg = "[$(Get-Date -Format o)] [ERROR] Missing virtual environment Python executable: $PythonExe"
    Add-Content -Path $LogFile -Value $msg -Encoding utf8
    Write-Error $msg
    exit 1
}

$env:PYTHONUNBUFFERED = "1"
Add-Content -Path $LogFile -Value "[$(Get-Date -Format o)] [INFO] Starting ScribaSheet local worker controller on 127.0.0.1" -Encoding utf8

$prevErrPref = $ErrorActionPreference
$ErrorActionPreference = "Continue"
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
    $PSNativeCommandUseErrorActionPreference = $false
}

Push-Location $BackendDir
try {
    & $PythonExe -m app.worker_controller 2>&1 | ForEach-Object {
        $line = if ($_ -is [System.Management.Automation.ErrorRecord]) {
            $_.Exception.Message
        } else {
            [string]$_
        }
        if ($line) {
            Add-Content -Path $LogFile -Value $line -Encoding utf8
        }
    }
    $exitCode = $LASTEXITCODE
} finally {
    Pop-Location
    $ErrorActionPreference = $prevErrPref
}

Add-Content -Path $LogFile -Value "[$(Get-Date -Format o)] [INFO] ScribaSheet local worker controller exited with code $exitCode" -Encoding utf8
exit $exitCode
