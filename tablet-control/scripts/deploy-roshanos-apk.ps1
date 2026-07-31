param(
  [string]$ApkPath = "",
  [string]$Serial = "",
  [string]$AdbPath = "C:\Users\Roshan Raj\AppData\Local\Android\Sdk\platform-tools\adb.exe",
  [int]$HealthTimeoutSeconds = 45
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = Split-Path $PSScriptRoot -Parent
if ([string]::IsNullOrWhiteSpace($ApkPath)) {
  $ApkPath = Join-Path $root "apps\tablet-agent\app\build\outputs\apk\debug\app-debug.apk"
}
$ApkPath = [IO.Path]::GetFullPath($ApkPath)
if (-not (Test-Path -LiteralPath $ApkPath)) {
  throw "APK not found: $ApkPath"
}
if (-not (Test-Path -LiteralPath $AdbPath)) {
  throw "ADB not found: $AdbPath"
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
  throw "A Java 17 runtime was not found for apksigner."
}
$env:JAVA_HOME = $javaHome

$sdkRoot = Split-Path (Split-Path $AdbPath -Parent) -Parent
$apksigner = Get-ChildItem -Path (Join-Path $sdkRoot "build-tools") -Filter "apksigner.bat" -Recurse |
  Sort-Object FullName -Descending |
  Select-Object -First 1 -ExpandProperty FullName
if (-not $apksigner) {
  $fallbackSdk = "C:\Users\Roshan Raj\AppData\Local\Android\Sdk"
  $apksigner = Get-ChildItem -Path (Join-Path $fallbackSdk "build-tools") -Filter "apksigner.bat" -Recurse |
    Sort-Object FullName -Descending |
    Select-Object -First 1 -ExpandProperty FullName
}
if (-not $apksigner) {
  throw "Android apksigner was not found."
}

function Invoke-Adb {
  param(
    [Parameter(Mandatory)][string[]]$Arguments,
    [switch]$AllowFailure
  )
  $argsWithSerial = @()
  if (-not [string]::IsNullOrWhiteSpace($script:SelectedSerial)) {
    $argsWithSerial += @("-s", $script:SelectedSerial)
  }
  $argsWithSerial += $Arguments
  $oldErrorAction = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $output = & $AdbPath @argsWithSerial 2>&1
  $ErrorActionPreference = $oldErrorAction
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0 -and -not $AllowFailure) {
    throw "ADB failed: adb $($Arguments -join ' ')`n$($output -join "`n")"
  }
  return [pscustomobject]@{
    ExitCode = $exitCode
    Text = ($output -join "`n").Trim()
  }
}

function Get-CertificateDigest {
  param([Parameter(Mandatory)][string]$Path)
  $output = & $apksigner verify --print-certs $Path 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "APK signature verification failed for $Path`n$($output -join "`n")"
  }
  $line = $output | Where-Object { $_ -match '(?:Signer #[0-9]+|V[0-9.]+ Signer): certificate SHA-256 digest:\s*(\S+)' } |
    Select-Object -First 1
  if (-not $line -or $line -notmatch '(?:Signer #[0-9]+|V[0-9.]+ Signer): certificate SHA-256 digest:\s*(\S+)') {
    throw "Could not read the APK signer digest for $Path`nOutput was:`n$($output -join "`n")"
  }
  return $matches[1].ToLowerInvariant()
}

function Wait-CompanionHealth {
  param(
    [int]$LocalPort,
    [int]$TimeoutSeconds,
    [switch]$AllowLegacyHealth
  )
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    try {
      $response = Invoke-RestMethod `
        -Uri "http://127.0.0.1:$LocalPort/health" `
        -Method Get `
        -TimeoutSec 2 `
        -ErrorAction Stop
      $listenerState = $null
      if (
        $response.PSObject.Properties.Name -contains "data" -and
        $null -ne $response.data -and
        $response.data.PSObject.Properties.Name -contains "components" -and
        $null -ne $response.data.components -and
        $response.data.components.PSObject.Properties.Name -contains "controlListener" -and
        $null -ne $response.data.components.controlListener -and
        $response.data.components.controlListener.PSObject.Properties.Name -contains "state"
      ) {
        $listenerState = [string]$response.data.components.controlListener.state
      }
      $minimalCoreHealthy =
        $response.PSObject.Properties.Name -contains "data" -and
        $null -ne $response.data -and
        $response.data.PSObject.Properties.Name -contains "service" -and
        $response.data.PSObject.Properties.Name -contains "healthy" -and
        [string]$response.data.service -eq "RoshanCore" -and
        $response.data.healthy -eq $true
      if (
        $response.ok -eq $true -and
        (
          $listenerState -eq "healthy" -or
          $minimalCoreHealthy -or
          ($AllowLegacyHealth -and [string]::IsNullOrWhiteSpace($listenerState))
        )
      ) {
        return $true
      }
    } catch {
      # Service/package startup is asynchronous; retry until the bounded deadline.
    }
    Start-Sleep -Milliseconds 750
  } while ((Get-Date) -lt $deadline)
  return $false
}

function Get-ProtectedCompanionSecret {
  $helperPath = Join-Path $root "scripts\controller-secret-store.ps1"
  if (-not (Test-Path -LiteralPath $helperPath)) {
    throw "Protected controller credential helper is unavailable."
  }
  $request = '{"operation":"read"}'
  $oldErrorAction = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $responseText = $request |
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $helperPath 2>$null
  $helperExitCode = $LASTEXITCODE
  $ErrorActionPreference = $oldErrorAction
  if ($helperExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($responseText)) {
    throw "The protected companion credential could not be read."
  }
  try {
    $response = ($responseText -join "") | ConvertFrom-Json
    $value = [string]$response.value
    if (
      $response.ok -ne $true -or
      [string]::IsNullOrWhiteSpace($value) -or
      $value.Length -lt 43 -or
      $value.Length -gt 256 -or
      $value -notmatch '^[A-Za-z0-9_-]+$'
    ) {
      throw "invalid"
    }
    return $value
  } catch {
    throw "The protected companion credential response was invalid."
  }
}

function Invoke-ProtectedMaintenance {
  param(
    [Parameter(Mandatory)][int]$LocalPort,
    [Parameter(Mandatory)][string]$Secret,
    [Parameter(Mandatory)][ValidateSet("enter", "exit")][string]$Action,
    [switch]$AllowFailure
  )
  try {
    $body = if ($Action -eq "enter") {
      @{ action = "enter"; durationMinutes = 15 } | ConvertTo-Json -Compress
    } else {
      @{ action = "exit" } | ConvertTo-Json -Compress
    }
    $response = Invoke-RestMethod `
      -Uri "http://127.0.0.1:$LocalPort/api/v1/companion/dpc/maintenance" `
      -Method Post `
      -Headers @{ Authorization = "Bearer $Secret" } `
      -ContentType "application/json" `
      -Body $body `
      -TimeoutSec 5 `
      -ErrorAction Stop
    if ($response.ok -eq $true) {
      return $true
    }
  } catch {
    if (-not $AllowFailure) {
      throw "Protected maintenance action '$Action' failed."
    }
  }
  return $false
}

$deviceRows = & $AdbPath devices -l
if ($LASTEXITCODE -ne 0) {
  throw "Unable to enumerate ADB devices."
}
$onlineSerials = @(
  $deviceRows |
    Select-Object -Skip 1 |
    Where-Object { $_ -match '^\S+\s+device(?:\s|$)' } |
    ForEach-Object { ($_ -split '\s+')[0] }
)
if (-not [string]::IsNullOrWhiteSpace($Serial)) {
  if ($Serial -notin $onlineSerials) {
    throw "Requested serial '$Serial' is not an authorized online ADB device."
  }
  $script:SelectedSerial = $Serial
} elseif ($onlineSerials.Count -eq 1) {
  $script:SelectedSerial = $onlineSerials[0]
} elseif ($onlineSerials.Count -eq 0) {
  throw "No authorized Android ADB device is online."
} else {
  throw "Multiple ADB devices are online. Supply -Serial."
}

$packageName = "com.tabletcontrol.companion"
$newSigner = Get-CertificateDigest -Path $ApkPath
$newHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $ApkPath).Hash
$installedPathResult = Invoke-Adb -Arguments @("shell", "pm", "path", $packageName) -AllowFailure
$installedPath = if ($installedPathResult.ExitCode -eq 0 -and
  $installedPathResult.Text -match '(?m)^package:(.+base\.apk)\s*$'
) {
  $matches[1].Trim()
} else {
  ""
}

$rollbackApk = ""
if (-not [string]::IsNullOrWhiteSpace($installedPath)) {
  $rollbackDir = Join-Path $root ".local\rollback"
  if (-not (Test-Path -LiteralPath $rollbackDir)) {
    New-Item -ItemType Directory -Path $rollbackDir | Out-Null
  }
  $rollbackApk = Join-Path $rollbackDir (
    "RoshanCore-{0}-{1}.apk" -f $script:SelectedSerial, (Get-Date -Format "yyyyMMdd-HHmmss")
  )
  $pull = Invoke-Adb -Arguments @("pull", $installedPath, $rollbackApk)
  if (-not (Test-Path -LiteralPath $rollbackApk)) {
    throw "The installed rollback APK could not be captured."
  }
  $installedSigner = Get-CertificateDigest -Path $rollbackApk
  if ($installedSigner -ne $newSigner) {
    throw (
      "Signer mismatch. Refusing to uninstall or overwrite the existing Device Owner app. " +
      "Installed=$installedSigner Candidate=$newSigner"
    )
  }
}

$localPortText = (Invoke-Adb -Arguments @("forward", "tcp:0", "tcp:8765")).Text
if ($localPortText -notmatch '^\d+$') {
  throw "ADB did not allocate a local health-forward port."
}
$localPort = [int]$localPortText
$maintenanceSecret = ""
$maintenanceEntered = $false

try {
  $devicePolicy = (Invoke-Adb -Arguments @("shell", "dumpsys", "device_policy") -AllowFailure).Text
  $installRestricted = $devicePolicy -match '(?m)^\s+no_install_apps\s*$'
  if ($installRestricted) {
    if (-not (Wait-CompanionHealth -LocalPort $localPort -TimeoutSeconds 15)) {
      throw "RoshanCore must be healthy before protected maintenance can be entered."
    }
    $maintenanceSecret = Get-ProtectedCompanionSecret
    if (-not (
        Invoke-ProtectedMaintenance `
          -LocalPort $localPort `
          -Secret $maintenanceSecret `
          -Action "enter"
      )
    ) {
      throw "Protected maintenance could not be entered."
    }
    $maintenanceEntered = $true
  }

  Write-Host "Installing RoshanCore with Android Package Manager (data and Device Owner are preserved)."
  $install = Invoke-Adb -Arguments @("install", "-r", $ApkPath)
  if ($install.Text -notmatch '(?im)\bSuccess\b') {
    throw "Package Manager did not report a successful install."
  }

  # Android delivers MY_PACKAGE_REPLACED to RoshanCore after an in-place
  # update. Give that silent path time to recover before using the rooted
  # development-tablet fallback; the service remains unexported.
  $initialWait = [Math]::Min(10, $HealthTimeoutSeconds)
  $healthy = Wait-CompanionHealth -LocalPort $localPort -TimeoutSeconds $initialWait
  if (-not $healthy) {
    Invoke-Adb -Arguments @(
      "shell", "su", "-c",
      "am start-foreground-service -n $packageName/.CompanionService -a com.tabletcontrol.companion.action.RECONCILE_SERVERS --es reconcile_reason host_update_validation"
    ) -AllowFailure | Out-Null
    $remainingWait = [Math]::Max(5, $HealthTimeoutSeconds - $initialWait)
    $healthy = Wait-CompanionHealth -LocalPort $localPort -TimeoutSeconds $remainingWait
  }

  if (-not $healthy) {
    if ([string]::IsNullOrWhiteSpace($rollbackApk)) {
      throw "RoshanCore did not become healthy and no previous APK exists for rollback."
    }

    Write-Warning "The updated package did not become healthy; restoring the captured APK."
    $rollback = Invoke-Adb -Arguments @("install", "-r", "-d", $rollbackApk)
    if ($rollback.Text -notmatch '(?im)\bSuccess\b') {
      throw "Rollback installation failed."
    }
    Invoke-Adb -Arguments @(
      "shell", "su", "-c",
      "am start-foreground-service -n $packageName/.CompanionService -a com.tabletcontrol.companion.action.RECONCILE_SERVERS --es reconcile_reason host_update_rollback"
    ) -AllowFailure | Out-Null
    if (-not (
        Wait-CompanionHealth `
          -LocalPort $localPort `
          -TimeoutSeconds $HealthTimeoutSeconds `
          -AllowLegacyHealth
      )
    ) {
      throw "Rollback APK was restored, but RoshanCore health did not recover."
    }
    throw "Update rolled back because RoshanCore health validation failed."
  }
} finally {
  if ($maintenanceEntered) {
    $maintenanceExited = $false
    for ($attempt = 1; $attempt -le 3 -and -not $maintenanceExited; $attempt++) {
      if (Wait-CompanionHealth -LocalPort $localPort -TimeoutSeconds 15) {
        $maintenanceExited = Invoke-ProtectedMaintenance `
          -LocalPort $localPort `
          -Secret $maintenanceSecret `
          -Action "exit" `
          -AllowFailure
      }
    }
    if (-not $maintenanceExited) {
      Write-Error (
        "RoshanCore update finished without confirmation that protected maintenance exited. " +
        "The bounded 15-minute expiry remains active; verify Device Owner restrictions immediately."
      )
    }
  }
  $maintenanceSecret = $null
  Invoke-Adb -Arguments @("forward", "--remove", "tcp:$localPort") -AllowFailure | Out-Null
}

Write-Host "RoshanCore update verified."
Write-Host "Serial: $($script:SelectedSerial)"
Write-Host "APK SHA256: $newHash"
Write-Host "Signer SHA256: $newSigner"
if (-not [string]::IsNullOrWhiteSpace($rollbackApk)) {
  Write-Host "Rollback APK: $rollbackApk"
}
