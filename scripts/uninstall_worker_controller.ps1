param(
    [string]$TaskName = "ScribaSheetWorkerController"
)

$ErrorActionPreference = "Stop"

$Task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $Task) {
    Write-Host "Scheduled Task '$TaskName' is not registered."
    exit 0
}

if ($Task.State -eq "Running") {
    Stop-ScheduledTask -TaskName $TaskName
    Write-Host "Stopped running task '$TaskName'."
}

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Host "Unregistered Scheduled Task '$TaskName'. Logs, project data, and backend\\.venv were preserved."
