Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = Split-Path $PSScriptRoot -Parent
$signingDir = Join-Path $root ".local\signing"
$keyStore = Join-Path $signingDir "roshanos-release-v1.p12"
$secretFile = Join-Path $signingDir "roshanos-signing.dpapi.json"
$keyAlias = "roshanos-release-v1"

if ((Test-Path -LiteralPath $keyStore) -or (Test-Path -LiteralPath $secretFile)) {
  throw "RoshanOS signing material already exists. Refusing to overwrite the update identity."
}
if (-not (Test-Path -LiteralPath $signingDir)) {
  New-Item -ItemType Directory -Path $signingDir | Out-Null
}

$javaHomes = @(
  $env:JAVA_HOME,
  "C:\Program Files\Android\Android Studio1\jbr",
  "C:\Users\Roshan Raj\jdk-17\jdk-17.0.2"
) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
$keytool = $javaHomes |
  ForEach-Object { Join-Path $_ "bin\keytool.exe" } |
  Where-Object { Test-Path -LiteralPath $_ } |
  Select-Object -First 1
if (-not $keytool) {
  throw "A Java 17 keytool executable was not found."
}

function New-RandomPassword {
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  return [Convert]::ToBase64String($bytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
}

$storePassword = New-RandomPassword
$keyPassword = $storePassword
$env:ROSHAN_KEYSTORE_PASS = $storePassword
$env:ROSHAN_KEY_PASS = $keyPassword

try {
  & $keytool `
    -genkeypair `
    -keystore $keyStore `
    -storetype PKCS12 `
    -storepass:env ROSHAN_KEYSTORE_PASS `
    -keypass:env ROSHAN_KEY_PASS `
    -alias $keyAlias `
    -keyalg RSA `
    -keysize 4096 `
    -sigalg SHA256withRSA `
    -validity 9125 `
    -dname "CN=RoshanOS Release, OU=Device Platform, O=RoshanOS, C=IN" `
    -noprompt
  if ($LASTEXITCODE -ne 0) {
    throw "keytool failed with exit code $LASTEXITCODE."
  }

  $protected = [ordered]@{
    keyAlias = $keyAlias
    storePassword = ConvertFrom-SecureString (
      ConvertTo-SecureString -String $storePassword -AsPlainText -Force
    )
    # PKCS#12 uses the store password for private-key access. Keep one protected
    # value so Gradle and apksigner use the identity key consistently.
    keyPassword = ConvertFrom-SecureString (
      ConvertTo-SecureString -String $storePassword -AsPlainText -Force
    )
  }
  $protected | ConvertTo-Json | Set-Content -LiteralPath $secretFile -Encoding UTF8

  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  foreach ($protectedPath in @($keyStore, $secretFile)) {
    $acl = New-Object System.Security.AccessControl.FileSecurity
    $acl.SetOwner([System.Security.Principal.NTAccount]$identity)
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
      $identity,
      [System.Security.AccessControl.FileSystemRights]::FullControl,
      [System.Security.AccessControl.AccessControlType]::Allow
    )
    $acl.SetAccessRuleProtection($true, $false)
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $protectedPath -AclObject $acl
  }
} finally {
  Remove-Item Env:ROSHAN_KEYSTORE_PASS -ErrorAction SilentlyContinue
  Remove-Item Env:ROSHAN_KEY_PASS -ErrorAction SilentlyContinue
  $storePassword = $null
  $keyPassword = $null
}

Write-Host "Created the RoshanOS release signing identity."
Write-Host "The private key and DPAPI ciphertext are restricted to the current Windows user."
Write-Host "Back up the .local\signing directory securely; losing it prevents trusted updates."
