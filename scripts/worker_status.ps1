param(
    [string]$TaskName = "ScribaSheetTranscriptionWorker"
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$LogFile = Join-Path $RepoRoot "logs\worker.log"

$Task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($Task) {
    $Info = Get-ScheduledTaskInfo -TaskName $TaskName
    Write-Host "Scheduled Task '$TaskName':"
    Write-Host "  Exists          : True"
    Write-Host "  State           : $($Task.State)"
    Write-Host "  Last Run Time   : $($Info.LastRunTime)"
    Write-Host "  Last Task Result: $($Info.LastTaskResult)"
} else {
    Write-Host "Scheduled Task '$TaskName':"
    Write-Host "  Exists          : False"
}

$WorkerProcs = Get-CimInstance Win32_Process -Filter "Name = 'python.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match "app\.worker_agent" }

Write-Host "Local Worker Process:"
if ($WorkerProcs) {
    foreach ($p in $WorkerProcs) {
        Write-Host "  Active PID      : $($p.ProcessId)"
    }
} else {
    Write-Host "  Active PID      : None"
}

Write-Host "Worker Log:"
Write-Host "  Path            : $LogFile"
if (Test-Path $LogFile) {
    $sizeKB = [Math]::Round((Get-Item $LogFile).Length / 1024, 1)
    Write-Host "  Size            : $sizeKB KB"
} else {
    Write-Host "  Size            : Not created yet"
}

Write-Host ""
Write-Host "Note: Production worker availability is authoritatively determined by the Railway coordinator heartbeat (GET /api/v1/worker/status)."
