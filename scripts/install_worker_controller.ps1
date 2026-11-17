param(
    [string]$TaskName = "ScribaSheetWorkerController",
    [switch]$NoStart
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$RunnerScript = Join-Path $RepoRoot "scripts\run_worker_controller.ps1"
$PythonExe = Join-Path $RepoRoot "backend\.venv\Scripts\python.exe"
$TokenPath = Join-Path $RepoRoot "logs\worker_controller.token"

if (-not (Test-Path $RunnerScript)) {
    throw "Controller runner script not found: $RunnerScript"
}
if (-not (Test-Path $PythonExe)) {
    throw "Python virtual environment executable not found: $PythonExe"
}

$ActionArgs = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$RunnerScript`""
$Action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $ActionArgs -WorkingDirectory $RepoRoot

$CurrentUser = if ($env:USERDOMAIN) { "$($env:USERDOMAIN)\$($env:USERNAME)" } else { $env:USERNAME }
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $CurrentUser
$Principal = New-ScheduledTaskPrincipal -UserId $CurrentUser -LogonType Interactive -RunLevel Limited

$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -StartWhenAvailable

$Existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($Existing) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Principal $Principal `
    -Settings $Settings `
    -Description "ScribaSheet lightweight local worker controller (127.0.0.1 only; does not auto-start ML worker)." | Out-Null

if (-not $NoStart) {
    Start-ScheduledTask -TaskName $TaskName
    Start-Sleep -Seconds 1
}

$Task = Get-ScheduledTask -TaskName $TaskName
Write-Host "Scheduled Task '$TaskName' installed."
Write-Host "  State      : $($Task.State)"
Write-Host "  Bind Host  : 127.0.0.1 (port 47832)"
Write-Host "  Token File : $TokenPath"
Write-Host "  Note       : The transcription worker is NOT auto-started; use the ScribaSheet UI to Start/Stop it."
