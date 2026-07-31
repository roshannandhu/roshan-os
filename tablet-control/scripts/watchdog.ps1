param(
  [switch]$Wait
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Continue"

$root = Split-Path $PSScriptRoot -Parent
$startScript = Join-Path $root "scripts\start-controller.ps1"
$logDir = Join-Path $root ".local\logs"
$watchdogLog = Join-Path $logDir "watchdog.log"
$pidFile = Join-Path $root ".local\run\controller.pid"

# Ensure log directory exists
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
if (Test-Path -LiteralPath $watchdogLog) {
    $watchdogInfo = Get-Item -LiteralPath $watchdogLog
    if ($watchdogInfo.Length -gt 5MB) {
        Move-Item -LiteralPath $watchdogLog -Destination "$watchdogLog.1.old" -Force
    }
}

function Write-WatchdogLog {
    param([string]$Message)
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "[$timestamp] $Message"
    Write-Host $line
    $line | Out-File -FilePath $watchdogLog -Append -Encoding UTF8
}

function Get-ControllerPort {
    $envFile = Join-Path $root ".env.local"
    $configuredPort = 3001
    if (Test-Path $envFile) {
        foreach ($l in Get-Content $envFile) {
            if ($l -match '^\s*CONTROLLER_PORT\s*=\s*(\d+)\s*$') {
                $configuredPort = [int]$matches[1]
                break
            }
        }
    }
    return $configuredPort
}

function Test-ControllerHealth {
    param([int]$Port)
    $url = "http://127.0.0.1:$Port/api/v1/health"
    try {
        $r = Invoke-RestMethod -Uri $url -Method Get -TimeoutSec 5 -ErrorAction Stop
        return $r.ok -eq $true
    } catch {
        return $false
    }
}

$port = Get-ControllerPort

function Stop-UnhealthyControllerListener {
    param([int]$Port)

    $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($null -eq $listener) { return $true }

    $process = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
    $processDetails = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction SilentlyContinue
    $pidMatches = $false
    if (Test-Path -LiteralPath $pidFile) {
        $recordedPid = (Get-Content -Raw -LiteralPath $pidFile).Trim()
        $pidMatches = $recordedPid -eq [string]$listener.OwningProcess
    }
    $commandMatches = $processDetails -ne $null -and
        [string]$processDetails.CommandLine -match 'controller-api[\\/]dist[\\/]server\.js'
    $isKnownController = $process -ne $null -and $process.Name -match '^node' -and
        ($pidMatches -or $commandMatches)

    if (-not $isKnownController) {
        Write-WatchdogLog "Port $Port belongs to an unknown process; refusing to terminate it."
        return $false
    }

    Write-WatchdogLog "Stopping unresponsive controller PID $($listener.OwningProcess)."
    Stop-Process -Id $listener.OwningProcess -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    return -not [bool](
        Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    )
}

Write-WatchdogLog "=== Windows Controller Watchdog Started ==="

# Check Tailscale serve once at startup (idempotent)
try {
    $tsExe = "C:\Program Files\Tailscale\tailscale.exe"
    if (Test-Path $tsExe) {
        $serveStatus = & $tsExe serve status 2>&1 | Out-String
        if ($serveStatus -notmatch [regex]::Escape("127.0.0.1:$port")) {
            Write-WatchdogLog "Configuring Tailscale serve for controller port $port..."
            & $tsExe serve --bg $port 2>&1 | Out-File -FilePath (Join-Path $logDir "tailscale-serve.log") -Append
        } else {
            Write-WatchdogLog "Tailscale serve already configured for port $port."
        }
    } else {
        Write-WatchdogLog "Tailscale CLI not found at expected path."
    }
} catch {
    Write-WatchdogLog "Tailscale serve check failed: $_"
}

$retryCount = 0
$maxRetries = 20
$healthyRunSeconds = 0

while ($true) {
    # Rate-limit restarts: after maxRetries consecutive failures, pause longer
    if ($retryCount -ge $maxRetries) {
        Write-WatchdogLog "Reached $maxRetries consecutive restart attempts. Cooling down for 5 minutes."
        Start-Sleep -Seconds 300
        $retryCount = 0
    }

    # Check if a healthy controller is already running on the port
    if (Test-ControllerHealth -Port $port) {
        Write-WatchdogLog "Controller already healthy on port $port. Monitoring..."
        $retryCount = 0
        while (Test-ControllerHealth -Port $port) {
            Start-Sleep -Seconds 10
        }
        Write-WatchdogLog "Controller health check failed. Will attempt restart."
        Start-Sleep -Seconds 5
        continue
    }

    if (-not (Stop-UnhealthyControllerListener -Port $port)) {
        Write-WatchdogLog "Controller restart is blocked by an unrelated port owner. Retrying later."
        Start-Sleep -Seconds 30
        continue
    }

    Write-WatchdogLog "Launching controller via start-controller.ps1"
    $proc = Start-Process -FilePath "powershell.exe" `
        -ArgumentList "-WindowStyle Hidden -ExecutionPolicy Bypass -File `"$startScript`"" `
        -NoNewWindow -PassThru
    $controllerPid = $proc.Id
    Write-WatchdogLog "Controller launcher PID $controllerPid started"

    # Wait for health (max 30 attempts, 2s each = 60s)
    $healthy = $false
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Seconds 2
        if (Test-ControllerHealth -Port $port) { $healthy = $true; break }
        if ($proc.HasExited) { break }
    }

    if (-not $healthy) {
        Write-WatchdogLog "Controller failed to become healthy within 60 seconds."
        if (-not $proc.HasExited) {
            Stop-Process -Id $controllerPid -Force -ErrorAction SilentlyContinue
        }
    } else {
        Write-WatchdogLog "Controller is healthy. Monitoring..."
        $retryCount = 0
        while ($true) {
            Start-Sleep -Seconds 10
            if (-not (Test-ControllerHealth -Port $port)) {
                Write-WatchdogLog "Health check failed during runtime."
                # Give it one more chance
                Start-Sleep -Seconds 3
                if (-not (Test-ControllerHealth -Port $port)) {
                    Write-WatchdogLog "Confirmed unhealthy. Will restart."
                    if (-not $proc.HasExited) {
                        Stop-Process -Id $controllerPid -Force -ErrorAction SilentlyContinue
                    }
                    break
                }
            }
        }
    }

    $delay = [math]::Min(30, [math]::Pow(2, [math]::Min($retryCount, 5)))
    $retryCount++
    Write-WatchdogLog "Restarting in $delay seconds (attempt $retryCount of $maxRetries)"
    Start-Sleep -Seconds $delay
}
