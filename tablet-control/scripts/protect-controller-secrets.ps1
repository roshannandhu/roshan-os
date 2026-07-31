param(
  [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = Split-Path $PSScriptRoot -Parent
$envFile = Join-Path $root ".env.local"
$localDir = Join-Path $root ".local"
$secretFile = Join-Path $localDir "controller-secrets.dpapi.json"

$secretKeys = @(
  "CONTROLLER_ADMIN_PASSWORD",
  "SESSION_SECRET",
  "TABLET_COMPANION_SECRET",
  "KIOSK_EXIT_PIN",
  "TABLET_IP_WEBCAM_PASSWORD"
)

if (-not (Test-Path -LiteralPath $envFile)) {
  throw ".env.local was not found."
}
if ((Test-Path -LiteralPath $secretFile) -and -not $Force) {
  throw "The protected secret store already exists. Use -Force only for an intentional rotation."
}
if (-not (Test-Path -LiteralPath $localDir)) {
  New-Item -ItemType Directory -Path $localDir | Out-Null
}

$protected = [ordered]@{}
$remaining = New-Object System.Collections.Generic.List[string]

foreach ($line in Get-Content -LiteralPath $envFile) {
  $matched = $false
  foreach ($key in $secretKeys) {
    if ($line -match ("^\s*" + [regex]::Escape($key) + "\s*=(.*)$")) {
      $value = $matches[1].Trim()
      if (
        ($value.StartsWith('"') -and $value.EndsWith('"')) -or
        ($value.StartsWith("'") -and $value.EndsWith("'"))
      ) {
        $value = $value.Substring(1, $value.Length - 2)
      }
      if ([string]::IsNullOrWhiteSpace($value)) {
        throw "$key is empty; refusing to create an incomplete protected store."
      }

      $secure = ConvertTo-SecureString -String $value -AsPlainText -Force
      $protected[$key] = ConvertFrom-SecureString -SecureString $secure
      $remaining.Add("# $key is loaded from the current-user DPAPI store.")
      $value = $null
      $secure = $null
      $matched = $true
      break
    }
  }
  if (-not $matched) {
    $remaining.Add($line)
  }
}

foreach ($key in $secretKeys) {
  if (-not $protected.Contains($key)) {
    throw "$key was not found in .env.local; no files were changed."
  }
}

$protected | ConvertTo-Json | Set-Content -LiteralPath $secretFile -Encoding UTF8
$remaining | Set-Content -LiteralPath $envFile -Encoding UTF8

# DPAPI already binds ciphertext to this Windows user. Restrict the file ACL as
# defense in depth without placing any plaintext value in a process argument.
$currentIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$acl = New-Object System.Security.AccessControl.FileSecurity
$acl.SetOwner([System.Security.Principal.NTAccount]$currentIdentity)
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
  $currentIdentity,
  [System.Security.AccessControl.FileSystemRights]::FullControl,
  [System.Security.AccessControl.AccessControlType]::Allow
)
$acl.SetAccessRuleProtection($true, $false)
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $secretFile -AclObject $acl

Write-Host "Controller secrets moved to a current-user DPAPI-protected store."
Write-Host "Plaintext secret assignments were removed from .env.local."
