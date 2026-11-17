param(
    [string]$TaskName = "ScribaSheetTranscriptionWorker",
    [switch]$NoStart
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$LauncherScript = Join-Path $RepoRoot "scripts\run_worker_background.ps1"
$PythonExe = Join-Path $RepoRoot "backend\.venv\Scripts\python.exe"

if (-not (Test-Path $LauncherScript)) {
    throw "Background launcher script not found: $LauncherScript"
}
if (-not (Test-Path $PythonExe)) {
    throw "Python virtual environment executable not found: $PythonExe"
}

$ActionArgs = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$LauncherScript`""
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
    -Description "ScribaSheet local CPU transcription worker (auto-start at Windows logon)." | Out-Null

if (-not $NoStart) {
    Start-ScheduledTask -TaskName $TaskName
    Start-Sleep -Seconds 1
}

$Task = Get-ScheduledTask -TaskName $TaskName
$Info = Get-ScheduledTaskInfo -TaskName $TaskName
Write-Host "Scheduled Task '$TaskName' installed."
Write-Host "  State           : $($Task.State)"
Write-Host "  Executable      : powershell.exe $ActionArgs"
Write-Host "  Python Venv     : $PythonExe"
Write-Host "  Last Run Time   : $($Info.LastRunTime)"
Write-Host "  Last Task Result: $($Info.LastTaskResult)"
