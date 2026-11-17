param(
    [string]$TaskName = "ScribaSheetWorkerController",
    [switch]$NoStart
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$BackendDir = Join-Path $RepoRoot "backend"
$RunnerScript = Join-Path $RepoRoot "scripts\run_worker_controller.ps1"
$PythonExe = Join-Path $BackendDir ".venv\Scripts\python.exe"
$LogsDir = Join-Path $RepoRoot "logs"
$LogFile = Join-Path $LogsDir "controller.log"
$TokenPath = Join-Path $LogsDir "worker_controller.token"
$HealthUrl = "http://127.0.0.1:47832/health"

if (-not (Test-Path $RunnerScript)) {
    throw "Controller runner script not found: $RunnerScript"
}
if (-not (Test-Path $PythonExe)) {
    throw "Python virtual environment executable not found: $PythonExe"
}

Push-Location $BackendDir
try {
    & $PythonExe -c "import app.worker_controller"
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to import app.worker_controller using $PythonExe"
    }
} finally {
    Pop-Location
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
    if ($Existing.State -eq "Running") {
        Stop-ScheduledTask -TaskName $TaskName
        Start-Sleep -Seconds 1
    }
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Principal $Principal `
    -Settings $Settings `
    -Description "ScribaSheet lightweight local worker controller (127.0.0.1 only; does not auto-start ML worker)." | Out-Null

$HealthOk = $false
if (-not $NoStart) {
    Start-ScheduledTask -TaskName $TaskName
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 500
        try {
            $resp = Invoke-WebRequest -Uri $HealthUrl -UseBasicParsing -TimeoutSec 2
            if ($resp.StatusCode -eq 200) {
                $HealthOk = $true
                break
            }
        } catch {
            # keep polling until timeout
        }
    }
    if (-not $HealthOk) {
        $TaskNow = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        $InfoNow = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
        throw "Controller task '$TaskName' started (State=$($TaskNow.State), LastTaskResult=$($InfoNow.LastTaskResult)), but $HealthUrl did not respond with HTTP 200. Check $LogFile."
    }
}

$Task = Get-ScheduledTask -TaskName $TaskName
$Info = Get-ScheduledTaskInfo -TaskName $TaskName
Write-Host "Scheduled Task '$TaskName' installed."
Write-Host "  State      : $($Task.State)"
Write-Host "  Last Result: $($Info.LastTaskResult)"
Write-Host "  Bind Host  : 127.0.0.1 (port 47832)"
if (-not $NoStart) {
    Write-Host "  Health     : HTTP 200 OK ($HealthUrl)"
}
Write-Host "  Log File   : $LogFile"
Write-Host "  Token File : $TokenPath"
Write-Host "  Note       : The transcription worker is NOT auto-started; use the ScribaSheet UI to Start/Stop it."
