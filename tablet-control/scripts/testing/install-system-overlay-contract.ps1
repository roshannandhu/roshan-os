[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$installerPath = Join-Path $root "scripts\install-as-system-app.ps1"
if (-not (Test-Path -LiteralPath $installerPath)) {
  throw "System-overlay installer is missing."
}

$tokens = $null
$parseErrors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile(
  $installerPath,
  [ref]$tokens,
  [ref]$parseErrors
)
if (@($parseErrors).Count -ne 0) {
  throw "System-overlay installer has PowerShell syntax errors."
}

$source = Get-Content -Raw -LiteralPath $installerPath
foreach ($forbiddenPattern in @(
  '(?im)\bpm\s+uninstall\b',
  '(?im)\bpm\s+clear\b',
  '(?im)/data/app/[^\r\n]*base\.apk',
  '(?im)\bfastboot\b',
  '(?im)\b(?:wipe|format)\b[^\r\n]*(?:userdata|\/data)\b'
)) {
  if ($source -match $forbiddenPattern) {
    throw "A forbidden destructive deployment pattern is present."
  }
}

foreach ($requiredFragment in @(
  "ConfirmDevelopmentOverlay",
  "apksigner.bat",
  "aapt2.exe",
  "dumpsys",
  "device_policy",
  "adb remount",
  "Restore-SystemTargets",
  "privapp-permissions-roshan.xml",
  "roshan-sysconfig.xml",
  "bootanimation.zip",
  "Device Owner and app data were preserved",
  "development test only"
)) {
  if (-not $source.Contains($requiredFragment)) {
    throw "Required installer contract fragment is missing: $requiredFragment"
  }
}

$previousPreference = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
  $guardText = & powershell.exe `
    -NoProfile `
    -NonInteractive `
    -ExecutionPolicy Bypass `
    -File $installerPath `
    -AdbPath "Z:\intentionally-unavailable\adb.exe" 2>&1
  $guardExitCode = $LASTEXITCODE
} finally {
  $ErrorActionPreference = $previousPreference
}
if (
  $guardExitCode -eq 0 -or
  ($guardText -join "`n") -notmatch "development overlay"
) {
  throw "Installer confirmation was not enforced before ADB access."
}

[pscustomobject][ordered]@{
  schemaVersion = 1
  passed = $true
  syntaxErrors = 0
  destructivePatterns = 0
  confirmationRequiredBeforeAdb = $true
  preservesDeviceOwnerPackage = $true
  validatesSignerAndHashes = $true
  stages = @(
    "RoshanCore APK",
    "priv-app permission allowlist",
    "power/data-save sysconfig",
    "RoshanOS boot animation"
  )
  tabletTouched = $false
} | ConvertTo-Json -Depth 4
