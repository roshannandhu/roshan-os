[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$harnessPath = Join-Path $root "scripts\invoke-roshanos-functional-acceptance.ps1"
if (-not (Test-Path -LiteralPath $harnessPath)) {
  throw "Functional acceptance harness is missing."
}

$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
  $harnessPath,
  [ref]$tokens,
  [ref]$parseErrors
)
if (@($parseErrors).Count -ne 0) {
  throw "Functional acceptance harness has PowerShell syntax errors."
}

$source = Get-Content -Raw -LiteralPath $harnessPath
$forbiddenMutationPatterns = @(
  '(?im)\badb(?:\.exe)?\b[^\r\n]*(?:\binstall\b|\buninstall\b|\bpush\b|\bpull\b|\bremount\b|\breboot\b)',
  '(?im)\bpm\s+(?:clear|uninstall|disable-user|enable)\b',
  '(?im)\bdpm\s+remove-active-admin\b',
  '(?im)\bfastboot\b',
  '(?im)\b(?:flash|factory-reset|factory_reset|wipe-data|wipe_data)\b',
  '(?im)\b(?:Remove-Item|Move-Item)\b[^\r\n]*-Recurse\b',
  '(?im)\bshell\b[^\r\n]*\bsu\b[^\r\n]*-c\b',
  '(?im)\bStart-Process\b'
)
foreach ($pattern in $forbiddenMutationPatterns) {
  if ($source -match $pattern) {
    throw "A forbidden deployment, privilege, reset, or destructive pattern is present."
  }
}

foreach ($requiredFragment in @(
  "controller-secret-store.ps1",
  "forward",
  "--remove",
  "Assert-MutationGate",
  "AllowMutations",
  "TestBrightness",
  "TestVolumeAndMute",
  "TestApprovedAppLifecycle",
  "TestCamera",
  "TestMicrophone",
  "TestRemoteControl",
  "TestAccessLock",
  "Restore-Brightness",
  "Restore-Volume",
  "Restore-AppApproval",
  "Restore-CameraSelection",
  "Restore-RemoteControl",
  "Restore-AccessLock",
  "Invoke-EmergencyRestoration",
  "finally",
  "Test-JpegBytes",
  "Test-WavPcmBytes",
  "Test-PngBytes",
  "Find-JpegFrame",
  "cameraResourceIdle",
  "nonZeroSamples",
  "gridObserved",
  "foregroundApiObserved",
  "auditObserved",
  "shadeBlocked",
  "blockingUnprovenChecks",
  "tabletTouched",
  "secretsLoaded"
)) {
  if (-not $source.Contains($requiredFragment)) {
    throw "Functional harness contract fragment is missing: $requiredFragment"
  }
}

if ($source -match '(?im)^\s*Write-Host\b') {
  throw "The functional harness must emit structured results only."
}
if ($source -notmatch 'http://127\.0\.0\.1:\$\(\$script:LocalPort\)') {
  throw "Companion requests are not visibly restricted to the ADB loopback forward."
}
if (
  $source -match
    '(?im)\b(?:https?|wss?)://(?!127\.0\.0\.1\b|localhost\b)[A-Za-z0-9]'
) {
  throw "The harness contains a non-loopback network origin."
}

$commandAsts = @(
  $ast.FindAll(
    {
      param($node)
      $node -is [System.Management.Automation.Language.CommandAst]
    },
    $true
  )
)
$commandNames = @(
  $commandAsts | ForEach-Object { $_.GetCommandName() } |
    Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
)
foreach ($forbiddenCommand in @(
  "Invoke-Expression",
  "iex",
  "Start-Process",
  "Remove-Item",
  "Move-Item"
)) {
  if ($forbiddenCommand -in $commandNames) {
    throw "Forbidden command is callable from the functional harness."
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
  throw "Functional harness offline mock self-test process failed."
}
$selfTest = ($selfTestText -join "") | ConvertFrom-Json
if (
  $selfTest.passed -ne $true -or
  $selfTest.readOnly -ne $true -or
  $selfTest.tabletTouched -ne $false -or
  $selfTest.secretsLoaded -ne $false -or
  @($selfTest.checks).Count -lt 6
) {
  throw "Functional harness offline mock self-test contract did not pass."
}

$missingAdb = "Z:\intentionally-unavailable\adb.exe"
$guardText = & powershell.exe `
  -NoProfile `
  -NonInteractive `
  -ExecutionPolicy Bypass `
  -File $harnessPath `
  -TestBrightness `
  -AdbPath $missingAdb `
  -OutputFormat Json
$guardExitCode = $LASTEXITCODE
$guard = ($guardText -join "") | ConvertFrom-Json
if (
  $guardExitCode -eq 0 -or
  $guard.mutationsRequested -ne $true -or
  $guard.mutationsAuthorized -ne $false -or
  $guard.tabletTouched -ne $false -or
  $guard.secretsLoaded -ne $false -or
  $guard.failedChecks -notcontains "mutationAuthorization" -or
  $null -ne $guard.PSObject.Properties["serial"]
) {
  throw "Mutation authorization was not rejected before ADB or secret access."
}

$selectionText = & powershell.exe `
  -NoProfile `
  -NonInteractive `
  -ExecutionPolicy Bypass `
  -File $harnessPath `
  -AdbPath $missingAdb `
  -OutputFormat Json
$selectionExitCode = $LASTEXITCODE
$selection = ($selectionText -join "") | ConvertFrom-Json
if (
  $selectionExitCode -eq 0 -or
  $selection.tabletTouched -ne $false -or
  $selection.secretsLoaded -ne $false -or
  $selection.blockingUnprovenChecks -notcontains "functionalSelection" -or
  $null -ne $selection.PSObject.Properties["serial"]
) {
  throw "Empty functional selection accessed ADB or reported a false pass."
}

$mutationFlagNames = @(
  "TestBrightness",
  "TestVolumeAndMute",
  "TestApprovedAppLifecycle",
  "TestCamera",
  "TestMicrophone",
  "TestRemoteControl",
  "TestAccessLock"
)
$parameterNames = @(
  $ast.ParamBlock.Parameters | ForEach-Object {
    $_.Name.VariablePath.UserPath
  }
)
foreach ($flagName in $mutationFlagNames) {
  if ($flagName -notin $parameterNames) {
    throw "An individual mutation flag is not declared: $flagName"
  }
}

[pscustomobject][ordered]@{
  schemaVersion = 1
  passed = $true
  syntaxErrors = 0
  offlineMockSelfTests = @($selfTest.checks).Count
  validators = @("jpeg", "png", "mjpeg", "wav-pcm", "adb-output")
  individualMutationFlags = $mutationFlagNames.Count
  unauthorizedMutationRejectedBeforeAdb = $true
  emptySelectionRejectedBeforeAdb = $true
  loopbackOnly = $true
  secretSource = "current-user DPAPI helper pipe"
  destructiveOperations = 0
  tabletTouched = $false
} | ConvertTo-Json -Depth 5
