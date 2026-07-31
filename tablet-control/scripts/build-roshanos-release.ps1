Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = Split-Path $PSScriptRoot -Parent
$androidProject = Join-Path $root "apps\tablet-agent"
$keyStore = Join-Path $root ".local\signing\roshanos-release-v1.p12"
$secretFile = Join-Path $root ".local\signing\roshanos-signing.dpapi.json"

if (-not (Test-Path -LiteralPath $keyStore) -or -not (Test-Path -LiteralPath $secretFile)) {
  throw "RoshanOS signing material is missing. Run create-roshanos-signing-key.ps1 once."
}

$javaHomes = @(
  $env:JAVA_HOME,
  (Join-Path $root ".local\microsoft-jdk-17.0.20\runtime\jdk-17.0.20+8"),
  "C:\Program Files\Android\Android Studio\jbr",
  "C:\Users\Roshan Raj\jdk-17\jdk-17.0.2"
) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
$javaHome = $javaHomes |
  Where-Object { Test-Path -LiteralPath (Join-Path $_ "lib\jvm.cfg") } |
  Select-Object -First 1
if (-not $javaHome) {
  throw "A complete Java 17 runtime was not found."
}

$protected = Get-Content -Raw -LiteralPath $secretFile | ConvertFrom-Json
$storeSecure = ConvertTo-SecureString -String ([string]$protected.storePassword)
$keySecure = ConvertTo-SecureString -String ([string]$protected.keyPassword)
$storePassword = ([System.Net.NetworkCredential]::new("", $storeSecure)).Password
# Java PKCS#12 providers use the store password for private-key access. Older
# generated secret files may contain a distinct ignored key password.
$keyPassword = $storePassword

$env:JAVA_HOME = $javaHome
$env:ROSHANOS_KEYSTORE_PATH = $keyStore
$env:ROSHANOS_KEYSTORE_PASSWORD = $storePassword
$env:ROSHANOS_KEY_ALIAS = [string]$protected.keyAlias
$env:ROSHANOS_KEY_PASSWORD = $keyPassword

try {
  Push-Location $androidProject
  try {
    & ".\gradlew.bat" :app:testReleaseUnitTest :app:lintRelease :app:assembleRelease
    if ($LASTEXITCODE -ne 0) {
      throw "The RoshanOS release build failed with exit code $LASTEXITCODE."
    }
  } finally {
    Pop-Location
  }
} finally {
  Remove-Item Env:ROSHANOS_KEYSTORE_PATH -ErrorAction SilentlyContinue
  Remove-Item Env:ROSHANOS_KEYSTORE_PASSWORD -ErrorAction SilentlyContinue
  Remove-Item Env:ROSHANOS_KEY_ALIAS -ErrorAction SilentlyContinue
  Remove-Item Env:ROSHANOS_KEY_PASSWORD -ErrorAction SilentlyContinue
  $storePassword = $null
  $keyPassword = $null
  $storeSecure = $null
  $keySecure = $null
}

$apk = Join-Path $androidProject "app\build\outputs\apk\release\app-release.apk"
if (-not (Test-Path -LiteralPath $apk)) {
  throw "The signed release APK was not produced."
}

$sdkRoot = "C:\Users\Roshan Raj\AppData\Local\Android\Sdk"
$apksigner = Get-ChildItem -Path (Join-Path $sdkRoot "build-tools") -Filter "apksigner.bat" -Recurse |
  Sort-Object FullName -Descending |
  Select-Object -First 1 -ExpandProperty FullName
if (-not $apksigner) {
  throw "Android apksigner was not found."
}

& $apksigner verify --verbose --print-certs $apk
if ($LASTEXITCODE -ne 0) {
  throw "APK signature verification failed."
}

$hash = Get-FileHash -Algorithm SHA256 -LiteralPath $apk
Write-Host "Signed RoshanCore APK: $apk"
Write-Host "SHA256: $($hash.Hash)"
