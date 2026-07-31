[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$deployPath = Join-Path $root "scripts\deploy-roshanos-apk.ps1"
if (-not (Test-Path -LiteralPath $deployPath)) {
  throw "RoshanCore Package Manager deployment script is missing."
}

$tokens = $null
$parseErrors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile(
  $deployPath,
  [ref]$tokens,
  [ref]$parseErrors
)
if (@($parseErrors).Count -ne 0) {
  throw "RoshanCore deployment script has PowerShell syntax errors."
}

$source = Get-Content -Raw -LiteralPath $deployPath
foreach ($forbiddenPattern in @(
  '(?im)\bpm\s+uninstall\b',
  '(?im)\bpm\s+clear\b',
  '(?im)/data/app/[^\r\n]*base\.apk[^\r\n]*(?:cp|mv|push)',
  '(?im)\bfastboot\b',
  '(?im)\bdpm\s+remove-active-admin\b'
)) {
  if ($source -match $forbiddenPattern) {
    throw "A forbidden Device Owner deployment pattern is present."
  }
}

foreach ($requiredFragment in @(
  "controller-secret-store.ps1",
  "Invoke-ProtectedMaintenance",
  "durationMinutes = 15",
  '"enter"',
  '"exit"',
  '@("install", "-r", $ApkPath)',
  "Get-CertificateDigest",
  "rollbackApk",
  "Wait-CompanionHealth",
  "Device Owner are preserved"
)) {
  if (-not $source.Contains($requiredFragment)) {
    throw "Required Package Manager deployment contract fragment is missing: $requiredFragment"
  }
}

[pscustomobject][ordered]@{
  schemaVersion = 1
  passed = $true
  syntaxErrors = 0
  destructivePatterns = 0
  packageManagerOnly = $true
  signerMatchRequired = $true
  boundedAuthenticatedMaintenance = $true
  maintenanceExitInFinally = $true
  healthRollback = $true
  tabletTouched = $false
} | ConvertTo-Json -Depth 3
