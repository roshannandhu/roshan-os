param(
  [string]$ControllerBindIp,
  [Parameter(Mandatory = $true)]
  [string]$PhoneIp,
  [ValidateRange(1024, 65535)]
  [int]$Port = 3000
)

$ErrorActionPreference = "Stop"

function Test-PrivateIpv4([string]$Value) {
  $parts = $Value.Split(".")
  if ($parts.Count -ne 4) { return $false }
  try {
    $numbers = @($parts | ForEach-Object { [int]$_ })
  } catch {
    return $false
  }
  if ($numbers | Where-Object { $_ -lt 0 -or $_ -gt 255 }) { return $false }
  return $numbers[0] -eq 10 -or
    ($numbers[0] -eq 172 -and $numbers[1] -ge 16 -and $numbers[1] -le 31) -or
    ($numbers[0] -eq 192 -and $numbers[1] -eq 168)
}

if (-not (Test-PrivateIpv4 $PhoneIp)) {
  throw "PhoneIp must be a private IPv4 address. No firewall changes will be made."
}

# Load .env.local for credentials (never printed)
$envLocalPath = Join-Path $PSScriptRoot '..' '.env.local'
$envLocalPath = [System.IO.Path]::GetFullPath($envLocalPath)

$ipWebcamUser = $null
$ipWebcamPass = $null

if (Test-Path $envLocalPath) {
  Get-Content $envLocalPath | ForEach-Object {
    if ($_ -match '^TABLET_IP_WEBCAM_USERNAME=(.+)$') { $ipWebcamUser = $Matches[1] }
    if ($_ -match '^TABLET_IP_WEBCAM_PASSWORD=(.+)$') { $ipWebcamPass = $Matches[1] }
  }
}

if (-not $ipWebcamUser -or -not $ipWebcamPass) {
  throw "IP Webcam credentials not found in .env.local. Run: node .local/setup-ipwebcam-auth.mjs"
}

$securePassword = Read-Host "Enter a new temporary controller password (20+ characters)" -AsSecureString
$passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
try {
  $temporaryPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
}

if ($temporaryPassword.Length -lt 20) {
  throw "The temporary controller password must contain at least 20 characters."
}

$tabletAdb = "C:\platform-tools\platform-tools\adb.exe"
$addressLines = & $tabletAdb shell "ip -4 addr show wlan0"
$ipv4Match = [regex]::Match(($addressLines -join "`n"), "inet\s+(\d{1,3}(?:\.\d{1,3}){3})/")
if (-not $ipv4Match.Success) {
  throw "Read-only ADB could not determine the tablet LAN address."
}

if ([string]::IsNullOrWhiteSpace($ControllerBindIp)) {
  $networkPath = Test-NetConnection -ComputerName $ipv4Match.Groups[1].Value -Port 8080 -InformationLevel Detailed -WarningAction SilentlyContinue
  $ControllerBindIp = $networkPath.SourceAddress
}

if (-not (Test-PrivateIpv4 $ControllerBindIp)) {
  throw "Could not determine a private controller LAN address. Supply ControllerBindIp explicitly."
}

$sessionBytes = New-Object byte[] 48
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
try {
  $rng.GetBytes($sessionBytes)
}
finally {
  $rng.Dispose()
}
$temporarySessionSecret = [Convert]::ToBase64String($sessionBytes)

$env:TABLET_ADAPTER_MODE = "real-readonly"
$env:TABLET_IP_WEBCAM_BASE_URL = "http://" + $ipv4Match.Groups[1].Value + ":8080"
$env:TABLET_TRANSPORT = "trusted-lan"
$env:TABLET_REQUEST_TIMEOUT_MS = "5000"
$env:TABLET_STREAM_MAX_RECONNECT_ATTEMPTS = "3"
$env:TABLET_IP_WEBCAM_USERNAME = $ipWebcamUser
$env:TABLET_IP_WEBCAM_PASSWORD = $ipWebcamPass
$env:CONTROLLER_EXPOSURE_MODE = "lan-validation"
$env:CONTROLLER_BIND_HOST = $ControllerBindIp
$env:CONTROLLER_ALLOWED_CLIENT_IP = $PhoneIp
$env:CONTROLLER_PORT = [string]$Port
$env:CONTROLLER_SERVE_WEB = "true"
$env:CONTROLLER_ADMIN_PASSWORD = $temporaryPassword
$env:CONTROLLER_SESSION_SECRET = $temporarySessionSecret

try {
  npm run build
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

  Write-Host "AUTHENTICATED_VALIDATION_READY"
  Write-Host "Open http://$ControllerBindIp`:$Port on the approved phone."
  Write-Host "Press Ctrl+C after validation."
  node .\apps\controller-api\dist\server.js
} finally {
  Remove-Item Env:TABLET_ADAPTER_MODE -ErrorAction SilentlyContinue
  Remove-Item Env:TABLET_IP_WEBCAM_BASE_URL -ErrorAction SilentlyContinue
  Remove-Item Env:TABLET_TRANSPORT -ErrorAction SilentlyContinue
  Remove-Item Env:TABLET_REQUEST_TIMEOUT_MS -ErrorAction SilentlyContinue
  Remove-Item Env:TABLET_STREAM_MAX_RECONNECT_ATTEMPTS -ErrorAction SilentlyContinue
  Remove-Item Env:TABLET_IP_WEBCAM_USERNAME -ErrorAction SilentlyContinue
  Remove-Item Env:TABLET_IP_WEBCAM_PASSWORD -ErrorAction SilentlyContinue
  Remove-Item Env:CONTROLLER_EXPOSURE_MODE -ErrorAction SilentlyContinue
  Remove-Item Env:CONTROLLER_BIND_HOST -ErrorAction SilentlyContinue
  Remove-Item Env:CONTROLLER_ALLOWED_CLIENT_IP -ErrorAction SilentlyContinue
  Remove-Item Env:CONTROLLER_PORT -ErrorAction SilentlyContinue
  Remove-Item Env:CONTROLLER_SERVE_WEB -ErrorAction SilentlyContinue
  Remove-Item Env:CONTROLLER_ADMIN_PASSWORD -ErrorAction SilentlyContinue
  Remove-Item Env:CONTROLLER_SESSION_SECRET -ErrorAction SilentlyContinue
  $temporaryPassword = $null
  $temporarySessionSecret = $null
  $ipWebcamUser = $null
  $ipWebcamPass = $null
  Write-Host "AUTHENTICATED_VALIDATION_REMOVED"
}
