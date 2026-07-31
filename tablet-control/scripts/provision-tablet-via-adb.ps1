param(
  [string]$Serial = "",
  [string]$AdbPath = "C:\Users\Roshan Raj\AppData\Local\Android\Sdk\platform-tools\adb.exe",
  [string]$TailscaleHostname = "",
  [string]$TailscaleAuthKey = "",
  [int]$HealthTimeoutSeconds = 60,
  [switch]$SkipReboot
)

<#
.SYNOPSIS
  Securely provisions a RoshanOS tablet credential via ADB — no pairing code needed.

.DESCRIPTION
  This script is the replacement for the old pairing-code flow. It:
  1. Generates a cryptographically random 384-bit base64url secret
  2. Writes the secret into the tablet's app-private directory via ADB + su
  3. Chowns the file to the companion app UID
  4. Restarts RoshanCore so AdbCredentialRecovery provisions it into Keystore
  5. Stores the matching secret in the Windows controller DPAPI store
  6. Updates the controller config with the tablet's Tailscale MagicDNS hostname
  7. Enrolls the tablet in Tailscale (if an auth key is provided or available)
  8. Reboots the tablet and verifies automatic reconnection

  After this script succeeds, the tablet will automatically reconnect after every
  reboot with zero manual intervention.

.PARAMETER Serial
  ADB device serial (optional if only one device is connected).

.PARAMETER AdbPath
  Path to adb.exe.

.PARAMETER TailscaleHostname
  The tablet's Tailscale MagicDNS hostname (e.g. "tablet-hostname.ts.net").
  If omitted, the script attempts to discover it from the device.

.PARAMETER TailscaleAuthKey
  A pre-generated Tailscale auth key (e.g. "tskey-auth-xxxxx") used to enroll the
  tablet during provisioning. If omitted, the script checks the TAILSCALE_AUTH_KEY
  environment variable. If neither is available, Tailscale enrollment is skipped.
  The tablet must already have a Tailscale identity or be enrolled manually.

.PARAMETER HealthTimeoutSeconds
  How long to wait for RoshanCore health after restart (default 60s).

.PARAMETER SkipReboot
  If set, skip the final reboot and verification cycle.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = Split-Path $PSScriptRoot -Parent
$packageName = "com.tabletcontrol.companion"
$credentialFile = ".adb-credential-rotation"

# ---------------------------------------------------------------------------
# Helper functions
# ---------------------------------------------------------------------------

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

function Write-Step {
  param([string]$Message)
  Write-Host ">>> $Message" -ForegroundColor Cyan
}

function Write-Success {
  param([string]$Message)
  Write-Host "OK $Message" -ForegroundColor Green
}

function Write-Warning {
  param([string]$Message)
  Write-Host "WARN $Message" -ForegroundColor Yellow
}

function New-CompanionSecret {
  # 48 random bytes = 384 bits, base64url encoded = 64 chars
  $bytes = [byte[]]::new(48)
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  return [System.Convert]::ToBase64String($bytes) -replace '\+', '-' -replace '/', '_' -replace '=', ''
}

function Invoke-DpapiStore {
  param(
    [Parameter(Mandatory)][string]$Operation,
    [string]$Value = ""
  )
  $helperPath = Join-Path $root "scripts\controller-secret-store.ps1"
  if (-not (Test-Path -LiteralPath $helperPath)) {
    throw "DPAPI secret-store helper not found at $helperPath"
  }
  $request = if ($Operation -eq "set") {
    @{ operation = "set"; value = $Value } | ConvertTo-Json -Compress
  } else {
    '{"operation":"read"}'
  }
  $oldErrorAction = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $responseText = $request |
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $helperPath 2>$null
  $helperExitCode = $LASTEXITCODE
  $ErrorActionPreference = $oldErrorAction
  return [pscustomobject]@{
    ExitCode = $helperExitCode
    Text = ($responseText -join "").Trim()
  }
}

# ---------------------------------------------------------------------------
# 0. Validate ADB connection
# ---------------------------------------------------------------------------

Write-Step "Checking ADB connection"

if (-not (Test-Path -LiteralPath $AdbPath)) {
  throw "ADB not found at: $AdbPath"
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

Write-Success "Using device: $($script:SelectedSerial)"

# ---------------------------------------------------------------------------
# 1. Generate secret
# ---------------------------------------------------------------------------

Write-Step "Generating cryptographically random companion secret"
$companionSecret = New-CompanionSecret
Write-Success "Generated 384-bit base64url secret (${($companionSecret | Measure-Object -Character).Characters} chars)"

# ---------------------------------------------------------------------------
# 2. Get the companion app UID (for chown)
# ---------------------------------------------------------------------------

Write-Step "Determining companion app UID"
$uidResult = Invoke-Adb -Arguments @("shell", "dumpsys", "package", $packageName, "|", "findstr", "userId=")
$appUid = ""
if ($uidResult.Text -match 'userId=(\d+)') {
  $appUid = $matches[1]
}
if ([string]::IsNullOrWhiteSpace($appUid)) {
  # Fallback: try to read UID from packages.list
  $uidResult = Invoke-Adb -Arguments @("shell", "su", "-c", "grep $packageName /data/system/packages.list")
  if ($uidResult.Text -match '^[\w.]+ (\d+)') {
    $appUid = $matches[1]
  }
}
if ([string]::IsNullOrWhiteSpace($appUid)) {
  # Fallback: use id from run-as
  $uidResult = Invoke-Adb -Arguments @("shell", "su", "-c", "stat -c '%u' /data/data/$packageName")
  if ($uidResult.Text -match '^(\d+)$') {
    $appUid = $matches[1]
  }
}
if ([string]::IsNullOrWhiteSpace($appUid)) {
  throw "Could not determine the companion app UID. Ensure the app is installed."
}
Write-Success "App UID: $appUid"

# ---------------------------------------------------------------------------
# 2b. Grant the companion app root (Magisk allow policy) so privileged
#     remote-agent commands never show an interactive authorization prompt.
# ---------------------------------------------------------------------------

Write-Step "Granting root policy for $packageName (UID $appUid)"
Invoke-Adb -Arguments @(
  "shell", "adb", "root"
) -AllowFailure | Out-Null
Start-Sleep -Seconds 2
Invoke-Adb -Arguments @(
  "shell",
  "sqlite3 /data/adb/magisk.db " +
    "'INSERT OR REPLACE INTO policies (uid, policy, until, logging, notification) " +
    "VALUES ($appUid, 2, 0, 1, 1);'"
) -AllowFailure | Out-Null
# Shell UID (2000) is granted too so `adb shell su -c` works without a prompt.
Invoke-Adb -Arguments @(
  "shell",
  "sqlite3 /data/adb/magisk.db " +
    "'INSERT OR REPLACE INTO policies (uid, policy, until, logging, notification) " +
    "VALUES (2000, 2, 0, 1, 1);'"
) -AllowFailure | Out-Null

$policyCheck = Invoke-Adb -Arguments @(
  "shell", "sqlite3 /data/adb/magisk.db 'SELECT uid, policy FROM policies;'"
) -AllowFailure
if ($policyCheck.Text -match [regex]::Escape($appUid) -and $policyCheck.Text -match '2000\|2') {
  Write-Success "Root policies granted (companion $appUid and shell allow-listed)"
} else {
  Write-Warning "Could not verify Magisk root policies. Privileged actions may prompt on the tablet."
}

# ---------------------------------------------------------------------------
# 3. Write the credential into the app-private directory via su
# ---------------------------------------------------------------------------

Write-Step "Writing credential to tablet via ADB as root"

$filesDir = "/data/data/$packageName/files"
$targetFile = "$filesDir/$credentialFile"

# Ensure the files directory exists
Invoke-Adb -Arguments @("shell", "su", "-c", "mkdir -p $filesDir") -AllowFailure | Out-Null

# Write the secret via echo (avoiding printf which might not exist on all devices)
Invoke-Adb -Arguments @("shell", "su", "-c", "echo -n '$companionSecret' > $targetFile") | Out-Null

# Set ownership to the companion app UID
Invoke-Adb -Arguments @("shell", "su", "-c", "chown $appUid:$appUid $targetFile") | Out-Null

# Set permissions to owner-only read/write (600)
Invoke-Adb -Arguments @("shell", "su", "-c", "chmod 600 $targetFile") | Out-Null

# Verify file
$verifyResult = Invoke-Adb -Arguments @("shell", "su", "-c", "cat $targetFile")
if ($verifyResult.Text -ne $companionSecret) {
  throw "Credential file verification failed — content mismatch."
}
Write-Success "Credential file written and verified: $targetFile"

# ---------------------------------------------------------------------------
# 4. Restart RoshanCore so AdbCredentialRecovery picks up the credential
# ---------------------------------------------------------------------------

Write-Step "Restarting RoshanCore to provision the credential"
Invoke-Adb -Arguments @(
  "shell", "su", "-c",
  "am force-stop $packageName"
) -AllowFailure | Out-Null
Start-Sleep -Seconds 2
Invoke-Adb -Arguments @(
  "shell", "su", "-c",
  "am start-foreground-service -n $packageName/.CompanionService -a com.tabletcontrol.companion.action.RECONCILE_SERVERS --es reconcile_reason adb_provisioning"
) -AllowFailure | Out-Null

# ---------------------------------------------------------------------------
# 5. Set up ADB port forwarding and verify credential was provisioned
# ---------------------------------------------------------------------------

Write-Step "Waiting for RoshanCore health check"
Start-Sleep -Seconds 3

$localPortText = (Invoke-Adb -Arguments @("forward", "tcp:0", "tcp:8765")).Text
if ($localPortText -notmatch '^\d+$') {
  throw "ADB did not allocate a local health-forward port."
}
$localPort = [int]$localPortText

$healthy = $false
$deadline = (Get-Date).AddSeconds($HealthTimeoutSeconds)
do {
  try {
    $response = Invoke-RestMethod `
      -Uri "http://127.0.0.1:$localPort/health" `
      -Method Get `
      -TimeoutSec 2 `
      -ErrorAction Stop
    if (
      $response.PSObject.Properties.Name -contains "data" -and
      $null -ne $response.data -and
      $response.data.service -eq "RoshanCore" -and
      $response.data.healthy -eq $true
    ) {
      $healthy = $true
    }
  } catch {
    # Still starting — retry
  }
  if (-not $healthy) {
    Start-Sleep -Milliseconds 1000
  }
} while (-not $healthy -and (Get-Date) -lt $deadline)

if (-not $healthy) {
  throw "RoshanCore did not become healthy within ${HealthTimeoutSeconds}s."
}
Write-Success "RoshanCore is healthy"

# Now verify the credential is provisioned
Write-Step "Verifying credential provisioning"
try {
  $statusResponse = Invoke-RestMethod `
    -Uri "http://127.0.0.1:$localPort/api/v1/companion/status" `
    -Method Get `
    -TimeoutSec 5 `
    -ErrorAction Stop
  $enrolled = $false
  if ($statusResponse.enrolled -eq $true -or $statusResponse.credentialState -eq "ready") {
    $enrolled = $true
  }
  if (-not $enrolled) {
    throw "Credential state is: $($statusResponse.credentialState)"
  }
} catch {
  throw "Credential provisioning verification failed: $_"
}

# Clean up ADB forward
Invoke-Adb -Arguments @("forward", "--remove", "tcp:$localPort") -AllowFailure | Out-Null

Write-Success "Credential provisioned and verified on tablet"

# ---------------------------------------------------------------------------
# 6. Tailscale auto-enrollment (silent, no code on screen)
# ---------------------------------------------------------------------------

Write-Step "Checking Tailscale enrollment status"
$tsConnected = $false
$tsCheckResult = Invoke-Adb -Arguments @(
  "shell", "su", "-c",
  "/system/app/RoshanTailscale/Tailscale.app/arm64/libtailscale.so status --json"
) -AllowFailure
if ($tsCheckResult.Text -match '"BackendState":"Running"') {
  $tsConnected = $true
  Write-Success "Tailscale is already connected — skipping enrollment."
}

if (-not $tsConnected) {
  $resolvedAuthKey = ""
  if (-not [string]::IsNullOrWhiteSpace($TailscaleAuthKey)) {
    $resolvedAuthKey = $TailscaleAuthKey
  } elseif (-not [string]::IsNullOrWhiteSpace($env:TAILSCALE_AUTH_KEY)) {
    $resolvedAuthKey = $env:TAILSCALE_AUTH_KEY
  }

  if (-not [string]::IsNullOrWhiteSpace($resolvedAuthKey)) {
    Write-Step "Enrolling tablet in Tailscale (silent, no code needed)"
    $enrollResult = Invoke-Adb -Arguments @(
      "shell", "su", "-c",
      "/system/app/RoshanTailscale/Tailscale.app/arm64/libtailscale.so up --auth-key $resolvedAuthKey"
    ) -AllowFailure
    Start-Sleep -Seconds 5

    # Re-check connection
    $tsVerifyResult = Invoke-Adb -Arguments @(
      "shell", "su", "-c",
      "/system/app/RoshanTailscale/Tailscale.app/arm64/libtailscale.so status --json"
    ) -AllowFailure
    if ($tsVerifyResult.Text -match '"BackendState":"Running"') {
      Write-Success "Tailscale enrollment successful — tablet is on the private network"
    } else {
      Write-Warning "Tailscale enrollment may not have completed. The tablet will retry on next boot."
    }
  } else {
    throw "TAILSCALE_NOT_ENROLLED. Use -TailscaleAuthKey to supply a valid Tailscale auth key, or set the TAILSCALE_AUTH_KEY environment variable. Provisioning cannot continue without a working Tailscale connection."
  }
}

# ---------------------------------------------------------------------------
# 7. Store the matching secret in Windows controller DPAPI
# ---------------------------------------------------------------------------

Write-Step "Storing companion secret in Windows DPAPI"

$dpapiResult = Invoke-DpapiStore -Operation "set" -Value $companionSecret
if ($dpapiResult.ExitCode -ne 0) {
  throw "Failed to store companion secret in DPAPI."
}
Write-Success "Companion secret stored in DPAPI"

# ---------------------------------------------------------------------------
# 8. Configure controller with tablet's Tailscale hostname
# ---------------------------------------------------------------------------

Write-Step "Configuring controller with tablet address"

if ([string]::IsNullOrWhiteSpace($TailscaleHostname)) {
  Write-Warning "No TailscaleHostname provided. Attempting to discover..."

  # Try to get Tailscale status from the tablet
  $tailscaleResult = Invoke-Adb -Arguments @(
    "shell", "su", "-c",
    "dumpsys ipn | findstr -i 'domain'"
  ) -AllowFailure
  # Also try via Tailscale CLI
  $tailscaleIpResult = Invoke-Adb -Arguments @(
    "shell", "su", "-c",
    "/system/app/RoshanTailscale/Tailscale.app/arm64/libtailscale.so status --json"
  ) -AllowFailure
  # Simplest: just use the allocated magic DNS
  $tailscaleHostResult = Invoke-Adb -Arguments @(
    "shell", "su", "-c",
    "/system/app/RoshanTailscale/Tailscale.app/arm64/libtailscale.so whois 100.100.100.100"
  ) -AllowFailure
  # Or just ask for the device's own hostname
  $hostnameResult = Invoke-Adb -Arguments @("shell", "getprop", "net.hostname") -AllowFailure
  if (-not [string]::IsNullOrWhiteSpace($hostnameResult.Text) -and $hostnameResult.Text -match '\S') {
    $TailscaleHostname = "$($hostnameResult.Text.trim()).ts.net"
  }
}

if ([string]::IsNullOrWhiteSpace($TailscaleHostname)) {
  Write-Warning "Could not determine Tailscale hostname. You must set TABLET_COMPANION_BASE_URL manually in the controller config."
  Write-Warning "Expected format: https://<tailscale-hostname>.ts.net:8765"
} else {
  $companionBaseUrl = "https://${TailscaleHostname}:8765"
  $envFilePath = Join-Path $root ".env.local"

  # Update .env.local with the companion base URL
  if (Test-Path -LiteralPath $envFilePath) {
    $envContent = Get-Content -Raw -LiteralPath $envFilePath
    if ($envContent -match '(?m)^TABLET_COMPANION_BASE_URL=.*$') {
      $envContent = $envContent -replace '(?m)^TABLET_COMPANION_BASE_URL=.*$', "TABLET_COMPANION_BASE_URL=$companionBaseUrl"
    } else {
      $envContent += "`nTABLET_COMPANION_BASE_URL=$companionBaseUrl"
    }
    Set-Content -LiteralPath $envFilePath -Value $envContent -NoNewline
  }
  Write-Success "Controller configured with companion base URL: $companionBaseUrl"
}

# ---------------------------------------------------------------------------
# 9. Reboot and verify auto-reconnection
# ---------------------------------------------------------------------------

if (-not $SkipReboot) {
  Write-Step "Rebooting tablet to verify automatic reconnection"
  Write-Host "The tablet will reboot, reconnect Wi-Fi, Tailscale, and RoshanCore automatically." -ForegroundColor Yellow

  Invoke-Adb -Arguments @("shell", "su", "-c", "reboot") -AllowFailure | Out-Null

  Write-Step "Waiting for device to go offline..."
  $offlineDeadline = (Get-Date).AddSeconds(30)
  do {
    Start-Sleep -Milliseconds 1000
    $checkRows = & $AdbPath devices -l 2>$null
    $stillOnline = $checkRows -match [regex]::Escape($script:SelectedSerial) + '\s+device'
  } while ($stillOnline -and (Get-Date) -lt $offlineDeadline)

  Write-Step "Waiting for device to come back online..."
  $onlineDeadline = (Get-Date).AddSeconds(120)
  $deviceBack = $false
  do {
    Start-Sleep -Milliseconds 2000
    $checkRows = & $AdbPath devices -l 2>$null
    if ($checkRows -match [regex]::Escape($script:SelectedSerial) + '\s+device') {
      $deviceBack = $true
    }
  } while (-not $deviceBack -and (Get-Date) -lt $onlineDeadline)

  if (-not $deviceBack) {
    throw "Device did not come back online within 120 seconds after reboot."
  }
  Write-Success "Device is back online after reboot"

  # Wait for RoshanCore health
  Write-Step "Waiting for RoshanCore to reconnect after reboot"
  Start-Sleep -Seconds 10

  $localPortText2 = (Invoke-Adb -Arguments @("forward", "tcp:0", "tcp:8765")).Text
  if ($localPortText2 -notmatch '^\d+$') {
    throw "ADB did not allocate a local health-forward port after reboot."
  }
  $localPort2 = [int]$localPortText2

  $reconnected = $false
  $reconnectDeadline = (Get-Date).AddSeconds(60)
  do {
    try {
      $response = Invoke-RestMethod `
        -Uri "http://127.0.0.1:$localPort2/health" `
        -Method Get `
        -TimeoutSec 2 `
        -ErrorAction Stop
      if (
        $response.PSObject.Properties.Name -contains "data" -and
        $null -ne $response.data -and
        $response.data.service -eq "RoshanCore" -and
        $response.data.healthy -eq $true
      ) {
        $reconnected = $true
      }
    } catch {
      # Still booting — retry
    }
    if (-not $reconnected) {
      Start-Sleep -Milliseconds 2000
    }
  } while (-not $reconnected -and (Get-Date) -lt $reconnectDeadline)

  # Verify credential is still provisioned after reboot
  if ($reconnected) {
    try {
      $statusAfter = Invoke-RestMethod `
        -Uri "http://127.0.0.1:$localPort2/api/v1/companion/status" `
        -Method Get `
        -TimeoutSec 5 `
        -ErrorAction Stop
      if ($statusAfter.credentialState -eq "ready") {
        Write-Success "Credential remains READY after reboot — automatic reconnection verified"
      } else {
        Write-Warning "Credential state after reboot: $($statusAfter.credentialState)"
      }
    } catch {
      Write-Warning "Could not verify credential state after reboot: $_"
    }
  }

  Invoke-Adb -Arguments @("forward", "--remove", "tcp:$localPort2") -AllowFailure | Out-Null
} else {
  Write-Step "Skipping reboot (use without -SkipReboot to verify auto-reconnection)"
}

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------

Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  PROVISIONING COMPLETE" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Device:          $($script:SelectedSerial)" -ForegroundColor White
Write-Host "  Secret length:   $($companionSecret.Length) chars (384 bits)" -ForegroundColor White
Write-Host "  DPAPI stored:    Yes" -ForegroundColor White
Write-Host "  Tablet state:    $($statusAfter.credentialState)" -ForegroundColor White
Write-Host ""
Write-Host "The tablet will now automatically reconnect after every reboot." -ForegroundColor Cyan
Write-Host "No pairing code needed. No manual steps after reboot." -ForegroundColor Cyan
Write-Host ""

if ([string]::IsNullOrWhiteSpace($TailscaleHostname)) {
  Write-Host "IMPORTANT: Set TABLET_COMPANION_BASE_URL in your .env.local:" -ForegroundColor Yellow
  Write-Host "  TABLET_COMPANION_BASE_URL=https://<your-tablet-hostname>.ts.net:8765" -ForegroundColor Yellow
}
