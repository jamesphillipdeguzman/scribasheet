param(
    [switch]$NoBackend,
    [switch]$NoFrontend,
    [switch]$NoWorker
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$BackendDir = Join-Path $RepoRoot "backend"
$FrontendDir = Join-Path $RepoRoot "frontend"
$PythonExe = Join-Path $BackendDir ".venv\Scripts\python.exe"
$WorkerScript = Join-Path $RepoRoot "scripts\run_worker_background.ps1"

if (-not $NoBackend -or -not $NoWorker) {
    if (-not (Test-Path $PythonExe)) {
        throw "Missing backend virtual environment Python executable: $PythonExe"
    }
}

$StartedProcs = @()

try {
    if (-not $NoBackend) {
        Write-Host "Starting FastAPI backend on http://127.0.0.1:8000 ..."
        $backendProc = Start-Process -FilePath $PythonExe `
            -ArgumentList "-m", "uvicorn", "app.main:app", "--reload", "--host", "127.0.0.1", "--port", "8000" `
            -WorkingDirectory $BackendDir `
            -PassThru
        $StartedProcs += $backendProc
    }

    if (-not $NoFrontend) {
        Write-Host "Starting Vite frontend dev server..."
        $frontendProc = Start-Process -FilePath "npm.cmd" `
            -ArgumentList "run", "dev" `
            -WorkingDirectory $FrontendDir `
            -PassThru
        $StartedProcs += $frontendProc
    }

    if (-not $NoWorker) {
        $existingWorker = Get-CimInstance Win32_Process -Filter "Name = 'python.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -match "app\.worker_agent" }
        if ($existingWorker) {
            Write-Host "Background worker is already running (PID $($existingWorker[0].ProcessId)); skipping duplicate launch."
        } else {
            Write-Host "Starting local worker (protected by single-instance lock)..."
            $workerProc = Start-Process -FilePath "powershell.exe" `
                -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$WorkerScript`"" `
                -WorkingDirectory $RepoRoot `
                -PassThru
            $StartedProcs += $workerProc
        }
    }

    Write-Host "Development stack running. Press Ctrl+C to stop launched processes."
    while ($StartedProcs | Where-Object { -not $_.HasExited }) {
        Start-Sleep -Seconds 1
    }
} finally {
    foreach ($proc in $StartedProcs) {
        if ($proc -and -not $proc.HasExited) {
            Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        }
    }
}
