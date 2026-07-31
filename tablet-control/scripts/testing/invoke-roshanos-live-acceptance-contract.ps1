[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$harnessPath = Join-Path $root "scripts\invoke-roshanos-live-acceptance.ps1"
if (-not (Test-Path -LiteralPath $harnessPath)) {
  throw "Live acceptance harness is missing."
}

$tokens = $null
$parseErrors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile(
  $harnessPath,
  [ref]$tokens,
  [ref]$parseErrors
)
if (@($parseErrors).Count -ne 0) {
  throw "Live acceptance harness has PowerShell syntax errors."
}

$source = Get-Content -Raw -LiteralPath $harnessPath
$forbiddenMutationPatterns = @(
  '(?im)\badb(?:\.exe)?\b[^\r\n]*(?:\binstall\b|\buninstall\b|\bpush\b|\bremount\b)',
  '(?im)\bpm\s+(?:clear|uninstall|disable-user)\b',
  '(?im)\bdpm\s+remove-active-admin\b',
  '(?im)\bfastboot\b[^\r\n]*\bflash\b'
)
foreach ($pattern in $forbiddenMutationPatterns) {
  if ($source -match $pattern) {
    throw "A forbidden deployment/reset mutation pattern is present in the harness."
  }
}

foreach ($requiredFragment in @(
  "controller-secret-store.ps1",
  "forward",
  "--remove",
  "Assert-MutationGate",
  "TestReboot",
  "TestWifiRecovery",
  "TestCrashRecovery",
  "TestAccessLock"
)) {
  if (-not $source.Contains($requiredFragment)) {
    throw "Harness contract fragment is missing."
  }
}

$selfTestText = & powershell.exe `
  -NoProfile `
  -NonInteractive `
  -ExecutionPolicy Bypass `
  -File $harnessPath `
  -SelfTest `
  -OutputFormat Json
if ($LASTEXITCODE -ne 0) {
  throw "Harness self-test process failed."
}
$selfTest = ($selfTestText -join "") | ConvertFrom-Json
if ($selfTest.passed -ne $true -or $selfTest.readOnly -ne $true) {
  throw "Harness self-test contract did not pass."
}

$guardText = & powershell.exe `
  -NoProfile `
  -NonInteractive `
  -ExecutionPolicy Bypass `
  -File $harnessPath `
  -TestReboot `
  -AdbPath "Z:\intentionally-unavailable\adb.exe" `
  -OutputFormat Json
$guardExitCode = $LASTEXITCODE
$guard = ($guardText -join "") | ConvertFrom-Json
if (
  $guardExitCode -eq 0 -or
  $guard.mutationsAuthorized -ne $false -or
  $guard.readOnly -ne $true -or
  $guard.failedChecks -notcontains "mutationAuthorization" -or
  $null -ne $guard.PSObject.Properties["serial"]
) {
  throw "Mutation authorization was not rejected before ADB access."
}

[pscustomobject][ordered]@{
  schemaVersion = 1
  passed = $true
  syntaxErrors = 0
  selfTests = @($selfTest.checks).Count
  unauthorizedMutationRejectedBeforeAdb = $true
  defaultMode = "read-only"
  mutationGate = "double opt-in"
  tabletTouched = $false
} | ConvertTo-Json -Depth 5
