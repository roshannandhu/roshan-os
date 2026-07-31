[CmdletBinding()]
param(
  [string]$OutputApk
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$source = Join-Path $root "rom\branding\setupwizard-overlay"
if ([string]::IsNullOrWhiteSpace($OutputApk)) {
  $OutputApk = Join-Path $root "rom\build\RoshanSetupWizardOverlay.apk"
}
$OutputApk = [System.IO.Path]::GetFullPath($OutputApk)

$sdkRootCandidates = @(
  $env:ANDROID_SDK_ROOT,
  $env:ANDROID_HOME,
  (Join-Path $env:LOCALAPPDATA "Android\Sdk")
) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
$sdkRoot = $sdkRootCandidates |
  Where-Object { Test-Path -LiteralPath (Join-Path $_ "platforms\android-34\android.jar") } |
  Select-Object -First 1
if (-not $sdkRoot) {
  throw "Android SDK platform 34 was not found."
}

$buildTools = Get-ChildItem -LiteralPath (Join-Path $sdkRoot "build-tools") -Directory |
  Sort-Object Name -Descending |
  Where-Object {
    (Test-Path -LiteralPath (Join-Path $_.FullName "aapt2.exe")) -and
    (Test-Path -LiteralPath (Join-Path $_.FullName "zipalign.exe")) -and
    (Test-Path -LiteralPath (Join-Path $_.FullName "apksigner.bat"))
  } |
  Select-Object -First 1
if (-not $buildTools) {
  throw "A complete Android build-tools installation was not found."
}

foreach ($name in @(
  "ROSHANOS_KEYSTORE_PATH",
  "ROSHANOS_KEYSTORE_PASSWORD",
  "ROSHANOS_KEY_ALIAS",
  "ROSHANOS_KEY_PASSWORD"
)) {
  $value = [Environment]::GetEnvironmentVariable($name)
  if ([string]::IsNullOrWhiteSpace($value)) {
    throw "Required signing environment variable $name is missing."
  }
}
if (-not (Test-Path -LiteralPath $env:ROSHANOS_KEYSTORE_PATH -PathType Leaf)) {
  throw "The configured RoshanOS signing keystore does not exist."
}

$manifest = Join-Path $source "AndroidManifest.xml"
$resources = Join-Path $source "res"
if (-not (Test-Path -LiteralPath $manifest -PathType Leaf) -or
    -not (Test-Path -LiteralPath $resources -PathType Container)) {
  throw "RoshanOS Setup Wizard overlay sources are incomplete."
}

$outputDirectory = Split-Path $OutputApk -Parent
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null

$tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$work = Join-Path $tempRoot ("roshanos-setup-overlay-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $work | Out-Null

try {
  $compiled = Join-Path $work "compiled.zip"
  $unsigned = Join-Path $work "unsigned.apk"
  $aligned = Join-Path $work "aligned.apk"
  $aapt2 = Join-Path $buildTools.FullName "aapt2.exe"
  $zipalign = Join-Path $buildTools.FullName "zipalign.exe"
  $apksigner = Join-Path $buildTools.FullName "apksigner.bat"
  $androidJar = Join-Path $sdkRoot "platforms\android-34\android.jar"

  & $aapt2 compile --dir $resources -o $compiled
  if ($LASTEXITCODE -ne 0) {
    throw "aapt2 failed to compile RoshanOS Setup Wizard overlay resources."
  }

  & $aapt2 link `
    -o $unsigned `
    -I $androidJar `
    --manifest $manifest `
    --min-sdk-version 30 `
    --target-sdk-version 34 `
    --version-code 1 `
    --version-name 1.0 `
    --no-resource-deduping `
    --no-resource-removal `
    $compiled
  if ($LASTEXITCODE -ne 0) {
    throw "aapt2 failed to link the RoshanOS Setup Wizard overlay."
  }

  & $zipalign -f 4 $unsigned $aligned
  if ($LASTEXITCODE -ne 0) {
    throw "zipalign failed for the RoshanOS Setup Wizard overlay."
  }

  & $apksigner sign `
    --ks $env:ROSHANOS_KEYSTORE_PATH `
    --ks-key-alias $env:ROSHANOS_KEY_ALIAS `
    --ks-pass env:ROSHANOS_KEYSTORE_PASSWORD `
    --key-pass env:ROSHANOS_KEY_PASSWORD `
    --out $OutputApk `
    $aligned
  if ($LASTEXITCODE -ne 0) {
    throw "apksigner failed for the RoshanOS Setup Wizard overlay."
  }

  & $apksigner verify --verbose --print-certs $OutputApk
  if ($LASTEXITCODE -ne 0) {
    throw "The signed RoshanOS Setup Wizard overlay did not verify."
  }

  $entries = & tar -tf $OutputApk
  if ($LASTEXITCODE -ne 0) {
    throw "The signed RoshanOS Setup Wizard overlay could not be inspected."
  }
  if ($entries -contains "classes.dex") {
    throw "Resource-only Setup Wizard overlay unexpectedly contains classes.dex."
  }

  $hash = Get-FileHash -Algorithm SHA256 -LiteralPath $OutputApk
  Write-Host "Signed RoshanOS Setup Wizard overlay: $OutputApk"
  Write-Host "SHA256: $($hash.Hash)"
} finally {
  $resolvedWork = [System.IO.Path]::GetFullPath($work)
  if ($resolvedWork.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and
      (Split-Path $resolvedWork -Leaf).StartsWith(
        "roshanos-setup-overlay-",
        [StringComparison]::Ordinal
      )) {
    Remove-Item -LiteralPath $resolvedWork -Recurse -Force -ErrorAction SilentlyContinue
  }
}
