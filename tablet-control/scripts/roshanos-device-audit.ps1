param(
  [string]$AdbPath = "C:\Users\Roshan Raj\AppData\Local\Android\Sdk\platform-tools\adb.exe",
  [string]$ExpectedSerial = "",
  [string]$OutputPath = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Continue"

if (-not (Test-Path -LiteralPath $AdbPath)) {
  throw "ADB was not found at $AdbPath"
}

function Invoke-AdbText {
  param([Parameter(Mandatory)][string[]]$Arguments)

  $allArguments = @()
  if (-not [string]::IsNullOrWhiteSpace($script:SelectedSerial)) {
    $allArguments += @("-s", $script:SelectedSerial)
  }
  $allArguments += $Arguments
  $text = & $AdbPath @allArguments 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "ADB command failed: adb $($Arguments -join ' ')`n$($text -join "`n")"
  }
  return ($text -join "`n").Trim()
}

function Test-Contains {
  param(
    [AllowEmptyString()][string]$Text,
    [Parameter(Mandatory)][string]$Pattern
  )
  return [regex]::IsMatch($Text, $Pattern, [Text.RegularExpressions.RegexOptions]::IgnoreCase)
}

$deviceRows = & $AdbPath devices -l 2>$null
if ($LASTEXITCODE -ne 0) {
  throw "Unable to enumerate ADB devices: $($deviceRows -join "`n")"
}

$online = @(
  $deviceRows |
    Select-Object -Skip 1 |
    Where-Object { $_ -match '^\S+\s+device(?:\s|$)' }
)
if ($online.Count -eq 0) {
  [Console]::Error.WriteLine(
    "No authorized Android ADB device is online. Boot Android, select File Transfer, enable USB debugging, and approve this computer."
  )
  exit 2
}

$serials = @($online | ForEach-Object { ($_ -split '\s+')[0] })
if (-not [string]::IsNullOrWhiteSpace($ExpectedSerial)) {
  if ($ExpectedSerial -notin $serials) {
    throw "Expected ADB serial '$ExpectedSerial' is not online. Online serials: $($serials -join ', ')"
  }
  $script:SelectedSerial = $ExpectedSerial
} elseif ($serials.Count -eq 1) {
  $script:SelectedSerial = $serials[0]
} else {
  throw "Multiple ADB devices are online. Supply -ExpectedSerial. Online serials: $($serials -join ', ')"
}

$packageName = "com.tabletcontrol.companion"
$tailscalePackage = "com.tailscale.ipn"
$webcamPackage = "com.pas.webcam"

$properties = Invoke-AdbText @("shell", "getprop")
$devicePolicy = Invoke-AdbText @("shell", "dumpsys", "device_policy")
$packageDump = Invoke-AdbText @("shell", "dumpsys", "package", $packageName)
$activityDump = Invoke-AdbText @("shell", "dumpsys", "activity", "services", $packageName)
$launcherResolution = Invoke-AdbText @(
  "shell", "cmd", "package", "resolve-activity", "--brief",
  "-a", "android.intent.action.MAIN",
  "-c", "android.intent.category.HOME"
)
$launcherActivities = Invoke-AdbText @(
  "shell", "cmd", "package", "query-activities", "--brief",
  "-a", "android.intent.action.MAIN",
  "-c", "android.intent.category.LAUNCHER"
)
$allPackages = Invoke-AdbText @("shell", "pm", "list", "packages")
$systemPackages = Invoke-AdbText @("shell", "pm", "list", "packages", "-s")
$secureSetup = Invoke-AdbText @("shell", "settings", "get", "secure", "user_setup_complete")
$globalProvisioned = Invoke-AdbText @("shell", "settings", "get", "global", "device_provisioned")
$overlayAppOp = Invoke-AdbText @("shell", "cmd", "appops", "get", $packageName, "SYSTEM_ALERT_WINDOW")
$vpnDump = Invoke-AdbText @("shell", "dumpsys", "connectivity")
$listeningSockets = Invoke-AdbText @("shell", "netstat", "-ltn")

$coreInstalled = Test-Contains $allPackages "(?m)^package:$([regex]::Escape($packageName))$"
$tailscaleInstalled = Test-Contains $allPackages "(?m)^package:$([regex]::Escape($tailscalePackage))$"
$webcamInstalled = Test-Contains $allPackages "(?m)^package:$([regex]::Escape($webcamPackage))$"
$isSystemApp = Test-Contains $systemPackages "(?m)^package:$([regex]::Escape($packageName))$"
$isDeviceOwner = Test-Contains $devicePolicy "Device Owner.*$([regex]::Escape($packageName))|admin=ComponentInfo\{$([regex]::Escape($packageName))/"
$isDefaultHome = Test-Contains $launcherResolution "(?m)^$([regex]::Escape($packageName))/.+KioskActivity"
$hasLauncherEntry = Test-Contains $launcherActivities "(?m)^$([regex]::Escape($packageName))/"
$companionRunning = Test-Contains $activityDump "\.CompanionService"
$cameraRunning = Test-Contains $activityDump "\.CameraService"
$overlayAllowed = Test-Contains $overlayAppOp "allow"
$tailscaleVpnActive = Test-Contains $vpnDump "$([regex]::Escape($tailscalePackage))"
$port8765Listening = Test-Contains $listeningSockets "[:.]8765\s"
$port8081Listening = Test-Contains $listeningSockets "127\.0\.0\.1:8081\s|\[::ffff:127\.0\.0\.1\]:8081\s"

$checks = [ordered]@{
  coreInstalled = $coreInstalled
  coreIsSystemApp = $isSystemApp
  deviceOwner = $isDeviceOwner
  defaultHomeIsRoshanOS = $isDefaultHome
  noRoshanCoreLauncherEntry = -not $hasLauncherEntry
  companionServiceRunning = $companionRunning
  cameraServiceRunning = $cameraRunning
  accessLockOverlayAllowed = $overlayAllowed
  tailscaleInstalled = $tailscaleInstalled
  tailscaleVpnVisibleToSystem = $tailscaleVpnActive
  ipWebcamFallbackInstalled = $webcamInstalled
  controlPort8765Listening = $port8765Listening
  mediaPort8081LoopbackListening = $port8081Listening
  userSetupComplete = $secureSetup -eq "1"
  deviceProvisioned = $globalProvisioned -eq "1"
}

$failedChecks = @(
  $checks.GetEnumerator() |
    Where-Object { -not $_.Value } |
    ForEach-Object { $_.Key }
)

$result = [ordered]@{
  schemaVersion = 1
  capturedAt = (Get-Date).ToUniversalTime().ToString("o")
  serial = $script:SelectedSerial
  product = [regex]::Match($properties, '\[ro\.product\.model\]: \[(.*?)\]').Groups[1].Value
  androidVersion = [regex]::Match($properties, '\[ro\.build\.version\.release\]: \[(.*?)\]').Groups[1].Value
  buildFingerprint = [regex]::Match($properties, '\[ro\.build\.fingerprint\]: \[(.*?)\]').Groups[1].Value
  defaultHome = $launcherResolution
  checks = $checks
  passed = $failedChecks.Count -eq 0
  failedChecks = $failedChecks
}

$json = $result | ConvertTo-Json -Depth 6
if (-not [string]::IsNullOrWhiteSpace($OutputPath)) {
  $resolvedParent = Split-Path -Parent $OutputPath
  if (-not [string]::IsNullOrWhiteSpace($resolvedParent) -and -not (Test-Path -LiteralPath $resolvedParent)) {
    New-Item -ItemType Directory -Path $resolvedParent | Out-Null
  }
  Set-Content -LiteralPath $OutputPath -Value $json -Encoding UTF8
}

$json
if (-not $result.passed) {
  exit 1
}
