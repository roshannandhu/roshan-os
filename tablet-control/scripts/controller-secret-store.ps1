Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# All requests arrive over stdin. No credential is accepted in an argument,
# environment variable, URL, or temporary plaintext file.
$requestText = [Console]::In.ReadToEnd()
$temporaryPath = $null
$backupPath = $null

function New-OwnerOnlyAcl {
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
  return $acl
}

try {
  if ([string]::IsNullOrWhiteSpace($requestText) -or $requestText.Length -gt 4096) {
    throw "Invalid request."
  }

  $request = $requestText | ConvertFrom-Json
  $operation = [string]$request.operation
  if ($operation -notin @("read", "set", "remove")) {
    throw "Invalid operation."
  }

  $root = Split-Path $PSScriptRoot -Parent
  $localDirectory = Join-Path $root ".local"
  $secretPath = Join-Path $localDirectory "controller-secrets.dpapi.json"
  $credentialKey = "TABLET_COMPANION_SECRET"

  if ($operation -eq "read") {
    if (-not (Test-Path -LiteralPath $secretPath)) {
      throw "Protected secret store is unavailable."
    }
    $protectedProperties = Get-Content -Raw -LiteralPath $secretPath | ConvertFrom-Json
    $property = $protectedProperties.PSObject.Properties[$credentialKey]
    if ($null -eq $property -or [string]::IsNullOrWhiteSpace([string]$property.Value)) {
      throw "Protected companion credential is unavailable."
    }

    $secureValue = ConvertTo-SecureString -String ([string]$property.Value)
    $plainValue = ([System.Net.NetworkCredential]::new("", $secureValue)).Password
    if ([string]::IsNullOrWhiteSpace($plainValue)) {
      throw "Protected companion credential could not be decrypted."
    }

    # stdout is a private pipe captured by the controller process. The caller
    # never forwards this response to a terminal, browser, log, or environment.
    [Console]::Out.Write(
      (@{ ok = $true; value = $plainValue } | ConvertTo-Json -Compress)
    )
    $plainValue = $null
    $secureValue = $null
    exit 0
  }

  if (-not (Test-Path -LiteralPath $localDirectory)) {
    New-Item -ItemType Directory -Path $localDirectory | Out-Null
  }

  $properties = [ordered]@{}
  if (Test-Path -LiteralPath $secretPath) {
    $existing = Get-Content -Raw -LiteralPath $secretPath | ConvertFrom-Json
    foreach ($property in $existing.PSObject.Properties) {
      $properties[$property.Name] = [string]$property.Value
    }
  }

  if ($operation -eq "set") {
    $plainValue = [string]$request.value
    if (
      [string]::IsNullOrWhiteSpace($plainValue) -or
      $plainValue.Length -lt 43 -or
      $plainValue.Length -gt 256 -or
      $plainValue -notmatch '^[A-Za-z0-9_-]+$'
    ) {
      throw "Companion credential format is invalid."
    }
    $secureValue = ConvertTo-SecureString -String $plainValue -AsPlainText -Force
    $properties[$credentialKey] = ConvertFrom-SecureString -SecureString $secureValue
    $plainValue = $null
    $secureValue = $null
  } else {
    [void]$properties.Remove($credentialKey)
  }

  $temporaryPath = Join-Path (
    $localDirectory
  ) (".controller-secrets.{0}.{1}.tmp" -f $PID, [Guid]::NewGuid().ToString("N"))
  $utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText(
    $temporaryPath,
    ($properties | ConvertTo-Json),
    $utf8WithoutBom
  )
  Set-Acl -LiteralPath $temporaryPath -AclObject (New-OwnerOnlyAcl)

  # Replace on the same volume so readers observe either the complete old
  # store or the complete new store, never a partially written JSON document.
  if (Test-Path -LiteralPath $secretPath) {
    # Windows PowerShell 5.1 converts a null backup argument into an illegal
    # empty path. An explicit same-directory backup keeps File.Replace atomic;
    # it contains only the already-DPAPI-protected previous store.
    $backupPath = Join-Path (
      $localDirectory
    ) (".controller-secrets.{0}.{1}.bak" -f $PID, [Guid]::NewGuid().ToString("N"))
    [System.IO.File]::Replace($temporaryPath, $secretPath, $backupPath, $true)
    Remove-Item -LiteralPath $backupPath -Force -ErrorAction SilentlyContinue
    $backupPath = $null
  } else {
    [System.IO.File]::Move($temporaryPath, $secretPath)
  }
  $temporaryPath = $null

  [Console]::Out.Write('{"ok":true}')
  exit 0
} catch {
  # Do not print exception details: request data can include the credential.
  [Console]::Error.WriteLine("Protected controller credential operation failed.")
  exit 1
} finally {
  $requestText = $null
  if ($null -ne $temporaryPath -and (Test-Path -LiteralPath $temporaryPath)) {
    Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
  }
  if ($null -ne $backupPath -and (Test-Path -LiteralPath $backupPath)) {
    Remove-Item -LiteralPath $backupPath -Force -ErrorAction SilentlyContinue
  }
}
