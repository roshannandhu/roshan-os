param(
  [switch]$Wait
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = Split-Path $PSScriptRoot -Parent
$runDir = Join-Path $root ".local\run"
$logDir = Join-Path $root ".local\logs"
$pidFile = Join-Path $runDir "controller.pid"
$logFile = Join-Path $logDir "controller.log"
$errLogFile = Join-Path $logDir "controller-err.log"
$envFile = Join-Path $root ".env.local"
$protectedSecretsFile = Join-Path $root ".local\controller-secrets.dpapi.json"

function Get-ControllerPort {
  $configuredPort = 3001
  if (Test-Path -LiteralPath $envFile) {
    foreach ($line in Get-Content -LiteralPath $envFile) {
      if ($line -match '^\s*CONTROLLER_PORT\s*=\s*(\d+)\s*$') {
        $configuredPort = [int]$matches[1]
      }
    }
  }
  if ($configuredPort -lt 1024 -or $configuredPort -gt 65535) {
    throw "CONTROLLER_PORT is outside the permitted range."
  }
  return $configuredPort
}

function Test-ControllerPublicOrigin {
  param([string]$Value)

  if (
    [string]::IsNullOrWhiteSpace($Value) -or
    $Value.Length -gt 2048 -or
    $Value -ne $Value.Trim() -or
    $Value -match '[\x00-\x20\x7F]'
  ) {
    return $false
  }
  if (-not ($Value -cmatch '^https://(?<originHost>[A-Za-z0-9.-]+)(?::443)?/?$')) {
    return $false
  }
  $rawHostName = $matches["originHost"].ToLowerInvariant()

  $parsedOrigin = $null
  if (-not [Uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$parsedOrigin)) {
    return $false
  }
  if (
    $parsedOrigin.Scheme -ne "https" -or
    (-not $parsedOrigin.IsDefaultPort -and $parsedOrigin.Port -ne 443) -or
    $parsedOrigin.UserInfo.Length -ne 0 -or
    $parsedOrigin.Query.Length -ne 0 -or
    $parsedOrigin.Fragment.Length -ne 0 -or
    $parsedOrigin.AbsolutePath -ne "/"
  ) {
    return $false
  }

  $hostName = $parsedOrigin.DnsSafeHost.ToLowerInvariant()
  if (
    $hostName -ne $rawHostName -or
    $hostName.Length -gt 253 -or
    $hostName -eq "ts.net" -or
    -not $hostName.EndsWith(".ts.net")
  ) {
    return $false
  }
  foreach ($label in $hostName.Split(".")) {
    if (
      $label.Length -lt 1 -or
      $label.Length -gt 63 -or
      $label -notmatch '^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$'
    ) {
      return $false
    }
  }
  return $true
}

if (-not (Test-Path $runDir)) { New-Item -ItemType Directory -Path $runDir | Out-Null }
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }

# Rotate bounded controller logs if larger than 5 MB.
foreach ($currentLog in @($logFile, $errLogFile)) {
  if (Test-Path -LiteralPath $currentLog) {
    $fileInfo = Get-Item -LiteralPath $currentLog
    if ($fileInfo.Length -gt 5MB) {
      $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
      Move-Item -LiteralPath $currentLog -Destination "$currentLog.$timestamp.old" -Force
    }
    Get-ChildItem -LiteralPath $logDir -Filter "$([IO.Path]::GetFileName($currentLog)).*.old" |
      Sort-Object LastWriteTime -Descending |
      Select-Object -Skip 3 |
      Remove-Item -Force
  }
}

# Duplicate start prevention and stale PID detection
$existingControllerProcess = $null
if (Test-Path $pidFile) {
  $oldPid = Get-Content $pidFile
  if ($oldPid -match '^\d+$') {
    $process = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
    if ($process -ne $null) {
      if ($process.Name -match "node") {
        # Keep a valid PID record. The listener and health check below decide whether it is the controller.
        $existingControllerProcess = $process
      }
    }
  }
  if ($existingControllerProcess -eq $null) {
    Remove-Item $pidFile -Force
  }
}

$port = Get-ControllerPort
$listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($listener) {
  $owner = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
  $healthUrl = "http://127.0.0.1:$port/api/v1/health"
  $healthy = $false
  try { $healthy = (Invoke-RestMethod -Uri $healthUrl -Method Get -TimeoutSec 3 -ErrorAction Stop).ok -eq $true } catch {}
  if ($owner -ne $null -and $owner.Name -match "node" -and $healthy) {
    $listener.OwningProcess | Out-File $pidFile -Encoding ascii -Force
    Write-Host "Controller is already healthy with PID $($listener.OwningProcess)."
    exit 0
  }
  Write-Error "Port $port is in use by a process that is not a healthy controller."
  exit 1
}

$serverJs = Join-Path $root "apps\controller-api\dist\server.js"
if (-not (Test-Path $serverJs)) {
  Write-Error "dist/server.js not found. Please run 'npm run build' first."
  exit 1
}

$node = (Get-Command node).Source
# A companion credential is accepted only from the current-user DPAPI store.
# Clear any inherited legacy value before parsing non-secret configuration.
[System.Environment]::SetEnvironmentVariable(
  "TABLET_COMPANION_SECRET",
  $null,
  "Process"
)
# Load production environment from .env.local and set explicitly so the
# controller starts in the correct mode regardless of inherited env.
if (Test-Path -LiteralPath $envFile) {
  Write-Host "Loading production configuration from .env.local..."
  foreach ($line in Get-Content -LiteralPath $envFile) {
    $trimmed = $line.Trim()
    if ($trimmed.Length -eq 0 -or $trimmed.StartsWith("#")) { continue }
    $eqIdx = $trimmed.IndexOf("=")
    if ($eqIdx -eq -1) { continue }
    $key = $trimmed.Substring(0, $eqIdx).Trim()
    $val = $trimmed.Substring($eqIdx + 1).Trim()
    if ($key -eq "TABLET_COMPANION_SECRET") { continue }
    if (($val.StartsWith('"') -and $val.EndsWith('"')) -or ($val.StartsWith("'") -and $val.EndsWith("'"))) {
      $val = $val.Substring(1, $val.Length - 2)
    }
    # Only set if not already in the process environment (envLoader.ts respects this)
    if (-not [System.Environment]::GetEnvironmentVariable($key)) {
      [System.Environment]::SetEnvironmentVariable($key, $val)
    }
  }
}

# Load secrets encrypted with Windows DPAPI for the current user. Legacy
# controller values remain process-local. TABLET_COMPANION_SECRET is explicitly
# excluded from the environment and is loaded by the controller over a private
# helper pipe.
$hasProtectedCompanionSecret = $false
if (Test-Path -LiteralPath $protectedSecretsFile) {
  $protectedSecrets = Get-Content -Raw -LiteralPath $protectedSecretsFile | ConvertFrom-Json
  foreach ($property in $protectedSecrets.PSObject.Properties) {
    if ($property.Name -eq "TABLET_COMPANION_SECRET") {
      $hasProtectedCompanionSecret = $true
      # The controller reads this DPAPI value through a private helper pipe.
      # It must never be placed in the parent or child process environment.
      [System.Environment]::SetEnvironmentVariable(
        "CONTROLLER_LOAD_DPAPI_COMPANION_SECRET",
        "true",
        "Process"
      )
      [System.Environment]::SetEnvironmentVariable(
        "TABLET_COMPANION_SECRET",
        $null,
        "Process"
      )
      continue
    }
    $secureValue = ConvertTo-SecureString -String ([string]$property.Value)
    $plainValue = ([System.Net.NetworkCredential]::new("", $secureValue)).Password
    [System.Environment]::SetEnvironmentVariable($property.Name, $plainValue, "Process")
    $plainValue = $null
    $secureValue = $null
  }
  Write-Host "Loaded protected controller secrets from the current-user DPAPI store."
}
if (-not $hasProtectedCompanionSecret) {
  Write-Error "The current-user DPAPI store does not contain TABLET_COMPANION_SECRET."
  exit 1
}

# Validate required production configuration is present
$adapterMode = [System.Environment]::GetEnvironmentVariable("TABLET_ADAPTER_MODE")
$serveWeb = [System.Environment]::GetEnvironmentVariable("CONTROLLER_SERVE_WEB")
$nodeEnv = [System.Environment]::GetEnvironmentVariable("NODE_ENV")
$controllerPublicOrigin = [System.Environment]::GetEnvironmentVariable("CONTROLLER_PUBLIC_ORIGIN")
if ($nodeEnv -ne "production") {
  Write-Error "Production requires NODE_ENV=production. Set it in .env.local."
  exit 1
}
if ($adapterMode -ne "companion") {
  Write-Error "Production requires TABLET_ADAPTER_MODE=companion. Set it in .env.local."
  exit 1
}
if ($serveWeb -ne "true") {
  Write-Error "Production requires CONTROLLER_SERVE_WEB=true. Set it in .env.local."
  exit 1
}
if (-not (Test-ControllerPublicOrigin -Value $controllerPublicOrigin)) {
  Write-Error "Production requires CONTROLLER_PUBLIC_ORIGIN as a strict HTTPS Tailscale ts.net origin."
  exit 1
}

Write-Host "Starting controller..."
$p = Start-Process `
  -FilePath $node `
  -ArgumentList "`"$serverJs`"" `
  -WorkingDirectory $root `
  -WindowStyle Hidden `
  -RedirectStandardOutput $logFile `
  -RedirectStandardError $errLogFile `
  -PassThru
$p.Id | Out-File $pidFile -Encoding ASCII

Write-Host "Controller started with PID $($p.Id). Logs in .local\logs\controller.log"

# Bounded health wait
Write-Host "Waiting for controller to become healthy..."
$healthUrl = "http://127.0.0.1:$port/api/v1/health"
$maxAttempts = 30
$attempt = 0
$healthy = $false

while ($attempt -lt $maxAttempts) {
  try {
    $response = Invoke-RestMethod -Uri $healthUrl -Method Get -ErrorAction Stop
    if ($response.ok -eq $true) {
      $healthy = $true
      break
    }
  } catch {
    # Ignore errors and retry
  }

  if ($p.HasExited) {
    Write-Error "Controller process crashed during startup."
    exit 1
  }

  Start-Sleep -Seconds 1
  $attempt++
}

if (-not $healthy) {
  Write-Error "Controller failed to become healthy within the timeout."
  Stop-Process -Id $p.Id -Force
  Remove-Item $pidFile -Force
  exit 1
}

Write-Host "Controller is healthy!"

if ($Wait) {
  Write-Host "Waiting for process to exit..."
  Wait-Process -Id $p.Id
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}
