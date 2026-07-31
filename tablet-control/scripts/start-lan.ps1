# Start a temporary, IP-restricted LAN validation controller.
# Credentials are generated only in this process and are never written to disk.
# Usage:
#   .\scripts\start-lan.ps1 -BindHost <private-PC-IP> -AllowedClientIp <private-client-IP>
param(
  [Parameter(Mandatory = $true)]
  [string]$AllowedClientIp,

  [Parameter(Mandatory = $true)]
  [string]$BindHost,

  [ValidateRange(1024, 65535)]
  [int]$Port = 3000
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = Split-Path $PSScriptRoot -Parent
$serverJs = Join-Path $root "apps\controller-api\dist\server.js"
$node = (Get-Command node).Source

if (-not (Test-Path -LiteralPath $serverJs)) {
  Write-Error "dist/server.js not found - run 'npm run build' first."
  exit 1
}

function Test-Ipv4Address {
  param([string]$Value)

  $parsed = $null
  return (
    [System.Net.IPAddress]::TryParse($Value, [ref]$parsed) -and
    $parsed.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork
  )
}

function New-CryptographicSecret {
  param([ValidateRange(32, 128)][int]$ByteCount)

  $bytes = New-Object byte[] $ByteCount
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($bytes)
    return [Convert]::ToBase64String($bytes)
  }
  finally {
    $rng.Dispose()
    [Array]::Clear($bytes, 0, $bytes.Length)
  }
}

if (-not (Test-Ipv4Address -Value $BindHost)) {
  throw "BindHost must be an explicit IPv4 address for the PC's current private interface."
}
if (-not (Test-Ipv4Address -Value $AllowedClientIp)) {
  throw "AllowedClientIp must be an explicit IPv4 address for the approved client."
}

$requiredCameraSettings = @(
  "TABLET_IP_WEBCAM_BASE_URL",
  "TABLET_IP_WEBCAM_USERNAME",
  "TABLET_IP_WEBCAM_PASSWORD"
)
foreach ($setting in $requiredCameraSettings) {
  if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($setting, "Process"))) {
    throw "$setting must be supplied through the current process environment for real-readonly LAN validation."
  }
}

$managedNames = @(
  "CONTROLLER_ADMIN_PASSWORD",
  "CONTROLLER_SESSION_SECRET",
  "CONTROLLER_BIND_HOST",
  "CONTROLLER_PORT",
  "CONTROLLER_EXPOSURE_MODE",
  "CONTROLLER_SERVE_WEB",
  "CONTROLLER_ALLOWED_CLIENT_IP",
  "TABLET_ADAPTER_MODE",
  "TABLET_TRANSPORT",
  "NODE_ENV"
)
$originalValues = @{}
foreach ($name in $managedNames) {
  $originalValues[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
}

$generatedAdminPassword = $null
$generatedSessionSecret = $null
try {
  if ([string]::IsNullOrWhiteSpace($originalValues["CONTROLLER_ADMIN_PASSWORD"])) {
    $generatedAdminPassword = New-CryptographicSecret -ByteCount 32
    [Environment]::SetEnvironmentVariable(
      "CONTROLLER_ADMIN_PASSWORD",
      $generatedAdminPassword,
      "Process"
    )
  }
  if ([string]::IsNullOrWhiteSpace($originalValues["CONTROLLER_SESSION_SECRET"])) {
    $generatedSessionSecret = New-CryptographicSecret -ByteCount 48
    [Environment]::SetEnvironmentVariable(
      "CONTROLLER_SESSION_SECRET",
      $generatedSessionSecret,
      "Process"
    )
  }

  [Environment]::SetEnvironmentVariable("CONTROLLER_BIND_HOST", $BindHost, "Process")
  [Environment]::SetEnvironmentVariable("CONTROLLER_PORT", $Port.ToString(), "Process")
  [Environment]::SetEnvironmentVariable(
    "CONTROLLER_EXPOSURE_MODE",
    "lan-validation",
    "Process"
  )
  [Environment]::SetEnvironmentVariable("CONTROLLER_SERVE_WEB", "true", "Process")
  [Environment]::SetEnvironmentVariable(
    "CONTROLLER_ALLOWED_CLIENT_IP",
    $AllowedClientIp,
    "Process"
  )
  [Environment]::SetEnvironmentVariable("TABLET_ADAPTER_MODE", "real-readonly", "Process")
  [Environment]::SetEnvironmentVariable("TABLET_TRANSPORT", "trusted-lan", "Process")
  [Environment]::SetEnvironmentVariable("NODE_ENV", "development", "Process")

  Write-Host "Starting temporary LAN controller on $BindHost`:$Port for one approved client."
  & $node $serverJs
  exit $LASTEXITCODE
}
finally {
  foreach ($name in $managedNames) {
    [Environment]::SetEnvironmentVariable($name, $originalValues[$name], "Process")
  }
  $generatedAdminPassword = $null
  $generatedSessionSecret = $null
}
