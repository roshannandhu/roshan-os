param(
  [string]$ApkPath = "",
  [string]$PrivappPermissionsPath = "",
  [string]$SysconfigPath = "",
  [string]$BootAnimationPath = "",
  [string]$AdbPath = "C:\Users\Roshan Raj\AppData\Local\Android\Sdk\platform-tools\adb.exe",
  [string]$Serial = "",
  [int]$BootTimeoutSeconds = 180,
  [int]$HealthTimeoutSeconds = 60,
  [switch]$ConfirmDevelopmentOverlay
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$packageName = "com.tabletcontrol.companion"
$targetDirectory = "/system/priv-app/RoshanCore"
$targetPath = "$targetDirectory/RoshanCore.apk"
$stagingPath = "/data/local/tmp/RoshanCore-system-stage.apk"
$permissionsTargetPath = "/system/etc/permissions/privapp-permissions-roshan.xml"
$permissionsStagingPath = "/data/local/tmp/privapp-permissions-roshan.xml"
$sysconfigTargetPath = "/system/etc/sysconfig/roshan-sysconfig.xml"
$sysconfigStagingPath = "/data/local/tmp/roshan-sysconfig.xml"
$bootAnimationTargetPath = "/system/media/bootanimation.zip"
$bootAnimationStagingPath = "/data/local/tmp/roshanos-bootanimation.zip"
$root = Split-Path $PSScriptRoot -Parent

if (-not $ConfirmDevelopmentOverlay) {
  throw @"
This command writes to adb-remount's development overlay and reboots the tablet.
It does not create a production ROM and does not prove factory-reset persistence.
Re-run with -ConfirmDevelopmentOverlay after reviewing that limitation.
"@
}
if ([string]::IsNullOrWhiteSpace($ApkPath)) {
  $ApkPath = Join-Path $root "apps\tablet-agent\app\build\outputs\apk\debug\app-debug.apk"
}
if ([string]::IsNullOrWhiteSpace($PrivappPermissionsPath)) {
  $PrivappPermissionsPath = Join-Path (
    $root
  ) "rom\staging\system\etc\permissions\privapp-permissions-roshan.xml"
}
if ([string]::IsNullOrWhiteSpace($SysconfigPath)) {
  $SysconfigPath = Join-Path (
    $root
  ) "rom\staging\system\etc\sysconfig\roshan-sysconfig.xml"
}
if ([string]::IsNullOrWhiteSpace($BootAnimationPath)) {
  $BootAnimationPath = Join-Path (
    $root
  ) "rom\staging\system\media\bootanimation.zip"
}
$ApkPath = [IO.Path]::GetFullPath($ApkPath)
$PrivappPermissionsPath = [IO.Path]::GetFullPath($PrivappPermissionsPath)
$SysconfigPath = [IO.Path]::GetFullPath($SysconfigPath)
$BootAnimationPath = [IO.Path]::GetFullPath($BootAnimationPath)
if (-not (Test-Path -LiteralPath $ApkPath)) {
  throw "APK not found: $ApkPath"
}
if (-not (Test-Path -LiteralPath $PrivappPermissionsPath)) {
  throw "Privileged-permission allowlist not found: $PrivappPermissionsPath"
}
if (-not (Test-Path -LiteralPath $SysconfigPath)) {
  throw "RoshanOS sysconfig not found: $SysconfigPath"
}
if (-not (Test-Path -LiteralPath $BootAnimationPath)) {
  throw "RoshanOS boot animation not found: $BootAnimationPath"
}
if (-not (Test-Path -LiteralPath $AdbPath)) {
  throw "ADB not found: $AdbPath"
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
    throw "ADB failed (exit $exitCode): adb $($Arguments -join ' ')`n$($output -join "`n")"
  }
  return [pscustomobject]@{
    ExitCode = $exitCode
    Text = ($output -join "`n").Trim()
  }
}

function Get-LatestBuildTool {
  param([Parameter(Mandatory)][string]$Name)
  $sdkRoot = Split-Path (Split-Path $AdbPath -Parent) -Parent
  $candidate = Get-ChildItem `
    -Path (Join-Path $sdkRoot "build-tools") `
    -Filter $Name `
    -Recurse `
    -ErrorAction SilentlyContinue |
      Sort-Object FullName -Descending |
      Select-Object -First 1 -ExpandProperty FullName
  if (-not $candidate) {
    throw "Android build tool '$Name' was not found."
  }
  return $candidate
}

function Get-CertificateDigest {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string]$ApkSignerPath
  )
  $output = & $ApkSignerPath verify --print-certs $Path 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "APK signature verification failed for $Path."
  }
  $line = $output |
    Where-Object {
      $_ -match '(?:Signer #[0-9]+|V[0-9.]+ Signer): certificate SHA-256 digest:\s*(\S+)'
    } |
    Select-Object -First 1
  if (
    -not $line -or
    $line -notmatch '(?:Signer #[0-9]+|V[0-9.]+ Signer): certificate SHA-256 digest:\s*(\S+)'
  ) {
    throw "Could not read the APK signer digest for $Path."
  }
  return $matches[1].ToLowerInvariant()
}

function Wait-ForBoot {
  param([int]$TimeoutSeconds)
  Invoke-Adb -Arguments @("wait-for-device") | Out-Null
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    $completed = Invoke-Adb -Arguments @("shell", "getprop", "sys.boot_completed") -AllowFailure
    if ($completed.ExitCode -eq 0 -and $completed.Text.Trim() -eq "1") {
      return
    }
    Start-Sleep -Seconds 1
  } while ((Get-Date) -lt $deadline)
  throw "Android did not finish booting within $TimeoutSeconds seconds."
}

function Wait-ForHealth {
  param([int]$TimeoutSeconds)
  $portResult = Invoke-Adb -Arguments @("forward", "tcp:0", "tcp:8765")
  if ($portResult.Text -notmatch '^\d+$') {
    throw "ADB did not allocate a health-forward port."
  }
  $localPort = [int]$portResult.Text
  try {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
      try {
        $response = Invoke-RestMethod `
          -Uri "http://127.0.0.1:$localPort/health" `
          -Method Get `
          -TimeoutSec 2 `
          -ErrorAction Stop
        if (
          $response.ok -eq $true -and
          $response.data.service -eq "RoshanCore" -and
          $response.data.healthy -eq $true
        ) {
          return
        }
      } catch {
        # Package Manager and the boot receiver recover asynchronously.
      }
      Start-Sleep -Milliseconds 750
    } while ((Get-Date) -lt $deadline)
  } finally {
    Invoke-Adb -Arguments @("forward", "--remove", "tcp:$localPort") -AllowFailure | Out-Null
  }
  throw "RoshanCore did not become healthy within $TimeoutSeconds seconds."
}

function Enable-AdbRemount {
  $rootResult = Invoke-Adb -Arguments @("root") -AllowFailure
  if (
    $rootResult.ExitCode -ne 0 -or
    $rootResult.Text -match '(?i)cannot run as root|production builds'
  ) {
    throw "This tablet build does not permit the required adb root development workflow."
  }
  Invoke-Adb -Arguments @("wait-for-device") | Out-Null
  $identity = Invoke-Adb -Arguments @("shell", "id")
  if ($identity.Text -notmatch '\buid=0\(root\)') {
    throw "adbd did not restart as root."
  }
  $remount = Invoke-Adb -Arguments @("remount") -AllowFailure
  if ($remount.ExitCode -ne 0) {
    throw "adb remount failed. No system path was changed.`n$($remount.Text)"
  }
}

function Restore-SystemTargets {
  param(
    [string]$ApkBackupPath,
    [bool]$ApkPreviouslyExisted,
    [string]$PermissionsBackupPath,
    [bool]$PermissionsPreviouslyExisted,
    [string]$SysconfigBackupPath,
    [bool]$SysconfigPreviouslyExisted,
    [string]$BootAnimationBackupPath,
    [bool]$BootAnimationPreviouslyExisted
  )
  Write-Warning "Validation failed. Restoring the previous development-overlay state."
  Enable-AdbRemount
  if ($ApkPreviouslyExisted) {
    Invoke-Adb -Arguments @("push", $ApkBackupPath, $stagingPath) | Out-Null
    Invoke-Adb -Arguments @("shell", "mkdir", "-p", $targetDirectory) | Out-Null
    Invoke-Adb -Arguments @("shell", "cp", $stagingPath, $targetPath) | Out-Null
    Invoke-Adb -Arguments @("shell", "chmod", "0644", $targetPath) | Out-Null
    Invoke-Adb -Arguments @("shell", "restorecon", $targetPath) -AllowFailure | Out-Null
  } else {
    Invoke-Adb -Arguments @("shell", "rm", "-f", $targetPath) -AllowFailure | Out-Null
    Invoke-Adb -Arguments @("shell", "rmdir", $targetDirectory) -AllowFailure | Out-Null
  }
  if ($PermissionsPreviouslyExisted) {
    Invoke-Adb `
      -Arguments @("push", $PermissionsBackupPath, $permissionsStagingPath) |
      Out-Null
    Invoke-Adb `
      -Arguments @("shell", "cp", $permissionsStagingPath, $permissionsTargetPath) |
      Out-Null
    Invoke-Adb `
      -Arguments @("shell", "chmod", "0644", $permissionsTargetPath) |
      Out-Null
    Invoke-Adb `
      -Arguments @("shell", "restorecon", $permissionsTargetPath) `
      -AllowFailure |
      Out-Null
  } else {
    Invoke-Adb `
      -Arguments @("shell", "rm", "-f", $permissionsTargetPath) `
      -AllowFailure |
      Out-Null
  }
  if ($SysconfigPreviouslyExisted) {
    Invoke-Adb -Arguments @("push", $SysconfigBackupPath, $sysconfigStagingPath) |
      Out-Null
    Invoke-Adb -Arguments @("shell", "cp", $sysconfigStagingPath, $sysconfigTargetPath) |
      Out-Null
    Invoke-Adb -Arguments @("shell", "chmod", "0644", $sysconfigTargetPath) |
      Out-Null
    Invoke-Adb `
      -Arguments @("shell", "restorecon", $sysconfigTargetPath) `
      -AllowFailure |
      Out-Null
  } else {
    Invoke-Adb `
      -Arguments @("shell", "rm", "-f", $sysconfigTargetPath) `
      -AllowFailure |
      Out-Null
  }
  if ($BootAnimationPreviouslyExisted) {
    Invoke-Adb `
      -Arguments @("push", $BootAnimationBackupPath, $bootAnimationStagingPath) |
      Out-Null
    Invoke-Adb `
      -Arguments @("shell", "cp", $bootAnimationStagingPath, $bootAnimationTargetPath) |
      Out-Null
    Invoke-Adb `
      -Arguments @("shell", "chmod", "0644", $bootAnimationTargetPath) |
      Out-Null
    Invoke-Adb `
      -Arguments @("shell", "restorecon", $bootAnimationTargetPath) `
      -AllowFailure |
      Out-Null
  } else {
    Invoke-Adb `
      -Arguments @("shell", "rm", "-f", $bootAnimationTargetPath) `
      -AllowFailure |
      Out-Null
  }
  Invoke-Adb `
    -Arguments @(
      "shell",
      "rm",
      "-f",
      $stagingPath,
      $permissionsStagingPath,
      $sysconfigStagingPath,
      $bootAnimationStagingPath
    ) `
    -AllowFailure |
    Out-Null
  Invoke-Adb -Arguments @("reboot") | Out-Null
  Wait-ForBoot -TimeoutSeconds $BootTimeoutSeconds
  Wait-ForHealth -TimeoutSeconds $HealthTimeoutSeconds
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

$buildType = (Invoke-Adb -Arguments @("shell", "getprop", "ro.build.type")).Text.Trim()
if ($buildType -notin @("userdebug", "eng")) {
  throw "Refusing to alter system paths on build type '$buildType'. Use a signed production image."
}

$apksigner = Get-LatestBuildTool -Name "apksigner.bat"
$aapt2 = Get-LatestBuildTool -Name "aapt2.exe"
$candidatePackage = (& $aapt2 dump packagename $ApkPath 2>&1).Trim()
if ($LASTEXITCODE -ne 0 -or $candidatePackage -ne $packageName) {
  throw "Candidate APK package '$candidatePackage' does not match '$packageName'."
}
$candidateSigner = Get-CertificateDigest -Path $ApkPath -ApkSignerPath $apksigner
$candidateHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $ApkPath).Hash.ToLowerInvariant()
$permissionsHash = (
  Get-FileHash -Algorithm SHA256 -LiteralPath $PrivappPermissionsPath
).Hash.ToLowerInvariant()
$sysconfigHash = (
  Get-FileHash -Algorithm SHA256 -LiteralPath $SysconfigPath
).Hash.ToLowerInvariant()
$bootAnimationHash = (
  Get-FileHash -Algorithm SHA256 -LiteralPath $BootAnimationPath
).Hash.ToLowerInvariant()
try {
  [xml]$permissionsXml = Get-Content -Raw -LiteralPath $PrivappPermissionsPath
  $matchingAllowlist = @(
    $permissionsXml.permissions.'privapp-permissions' |
      Where-Object { [string]$_.package -eq $packageName }
  )
  if ($matchingAllowlist.Count -ne 1) {
    throw "invalid"
  }
} catch {
  throw (
    "Privileged-permission allowlist must be valid XML with exactly one " +
    "<privapp-permissions package=`"$packageName`"> entry."
  )
}
try {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $bootZip = [System.IO.Compression.ZipFile]::OpenRead($BootAnimationPath)
  try {
    $entries = @($bootZip.Entries)
    $descriptor = $entries |
      Where-Object { $_.FullName -eq "desc.txt" } |
      Select-Object -First 1
    $frame = $entries |
      Where-Object { $_.FullName -match '^part0/[0-9]{5}\.png$' } |
      Select-Object -First 1
    if (
      $null -eq $descriptor -or
      $null -eq $frame -or
      $descriptor.Length -le 0 -or
      $frame.Length -le 0 -or
      $descriptor.CompressedLength -ne $descriptor.Length -or
      $frame.CompressedLength -ne $frame.Length
    ) {
      throw "invalid"
    }
  } finally {
    $bootZip.Dispose()
  }
} catch {
  throw (
    "RoshanOS bootanimation.zip must contain stored desc.txt and " +
    "part0/NNNNN.png entries."
  )
}
try {
  [xml]$sysconfigXml = Get-Content -Raw -LiteralPath $SysconfigPath
  $powerSavePackages = @(
    $sysconfigXml.config.'allow-in-power-save' |
      ForEach-Object { [string]$_.package }
  )
  $dataSavePackages = @(
    $sysconfigXml.config.'allow-in-data-usage-save' |
      ForEach-Object { [string]$_.package }
  )
  if (
    $packageName -notin $powerSavePackages -or
    $packageName -notin $dataSavePackages
  ) {
    throw "invalid"
  }
} catch {
  throw (
    "RoshanOS sysconfig must be valid XML and allow '$packageName' in " +
    "power-save and data-usage-save modes."
  )
}

$installedPathResult = Invoke-Adb -Arguments @("shell", "pm", "path", $packageName) -AllowFailure
$installedPath = ""
if (
  $installedPathResult.ExitCode -eq 0 -and
  $installedPathResult.Text -match '(?m)^package:(.+base\.apk)\s*$'
) {
  $installedPath = $matches[1].Trim()
}
if ([string]::IsNullOrWhiteSpace($installedPath)) {
  throw "RoshanCore is not currently installed. Provision Device Owner before testing a system overlay."
}

$backupDirectory = Join-Path $root ".local\system-overlay-backup"
if (-not (Test-Path -LiteralPath $backupDirectory)) {
  New-Item -ItemType Directory -Path $backupDirectory | Out-Null
}
$installedApkBackup = Join-Path $backupDirectory (
  "installed-{0}-{1}.apk" -f $script:SelectedSerial, (Get-Date -Format "yyyyMMdd-HHmmss")
)
Invoke-Adb -Arguments @("pull", $installedPath, $installedApkBackup) | Out-Null
$installedSigner = Get-CertificateDigest -Path $installedApkBackup -ApkSignerPath $apksigner
if ($installedSigner -ne $candidateSigner) {
  throw (
    "Signer mismatch. Refusing to alter a Device Owner installation. " +
    "Installed=$installedSigner Candidate=$candidateSigner"
  )
}

$devicePolicyDump = (Invoke-Adb -Arguments @("shell", "dumpsys", "device_policy") -AllowFailure).Text
if (
  $devicePolicyDump -notmatch (
    '(?s)Device Owner:\s+.*?package=' + [regex]::Escape($packageName)
  )
) {
  throw "RoshanCore is not the active Android Device Owner. System-overlay validation was not started."
}

Enable-AdbRemount
$mounts = (Invoke-Adb -Arguments @("shell", "mount")).Text
$overlayBacked = $mounts -match '(?m)^overlay on /system '
if (-not $overlayBacked) {
  Write-Warning "The remounted system is not reported as overlayfs; this is still treated as a development-only operation."
}

$targetProbe = Invoke-Adb -Arguments @("shell", "test", "-f", $targetPath) -AllowFailure
$targetPreviouslyExisted = $targetProbe.ExitCode -eq 0
$systemTargetBackup = ""
if ($targetPreviouslyExisted) {
  $systemTargetBackup = Join-Path $backupDirectory (
    "system-target-{0}-{1}.apk" -f $script:SelectedSerial, (Get-Date -Format "yyyyMMdd-HHmmss")
  )
  Invoke-Adb -Arguments @("pull", $targetPath, $systemTargetBackup) | Out-Null
}
$permissionsProbe = Invoke-Adb `
  -Arguments @("shell", "test", "-f", $permissionsTargetPath) `
  -AllowFailure
$permissionsPreviouslyExisted = $permissionsProbe.ExitCode -eq 0
$permissionsTargetBackup = ""
if ($permissionsPreviouslyExisted) {
  $permissionsTargetBackup = Join-Path $backupDirectory (
    "privapp-permissions-{0}-{1}.xml" -f (
      $script:SelectedSerial,
      (Get-Date -Format "yyyyMMdd-HHmmss")
    )
  )
  Invoke-Adb `
    -Arguments @("pull", $permissionsTargetPath, $permissionsTargetBackup) |
    Out-Null
}
$sysconfigProbe = Invoke-Adb `
  -Arguments @("shell", "test", "-f", $sysconfigTargetPath) `
  -AllowFailure
$sysconfigPreviouslyExisted = $sysconfigProbe.ExitCode -eq 0
$sysconfigTargetBackup = ""
if ($sysconfigPreviouslyExisted) {
  $sysconfigTargetBackup = Join-Path $backupDirectory (
    "sysconfig-{0}-{1}.xml" -f (
      $script:SelectedSerial,
      (Get-Date -Format "yyyyMMdd-HHmmss")
    )
  )
  Invoke-Adb -Arguments @("pull", $sysconfigTargetPath, $sysconfigTargetBackup) |
    Out-Null
}
$bootAnimationProbe = Invoke-Adb `
  -Arguments @("shell", "test", "-f", $bootAnimationTargetPath) `
  -AllowFailure
$bootAnimationPreviouslyExisted = $bootAnimationProbe.ExitCode -eq 0
$bootAnimationTargetBackup = ""
if ($bootAnimationPreviouslyExisted) {
  $bootAnimationTargetBackup = Join-Path $backupDirectory (
    "bootanimation-{0}-{1}.zip" -f (
      $script:SelectedSerial,
      (Get-Date -Format "yyyyMMdd-HHmmss")
    )
  )
  Invoke-Adb `
    -Arguments @("pull", $bootAnimationTargetPath, $bootAnimationTargetBackup) |
    Out-Null
}

$changed = $false
try {
  Invoke-Adb -Arguments @("push", $ApkPath, $stagingPath) | Out-Null
  Invoke-Adb `
    -Arguments @("push", $PrivappPermissionsPath, $permissionsStagingPath) |
    Out-Null
  Invoke-Adb -Arguments @("push", $SysconfigPath, $sysconfigStagingPath) |
    Out-Null
  Invoke-Adb `
    -Arguments @("push", $BootAnimationPath, $bootAnimationStagingPath) |
    Out-Null
  $deviceStageHashText = (Invoke-Adb -Arguments @("shell", "sha256sum", $stagingPath)).Text
  $deviceStageHash = ($deviceStageHashText -split '\s+')[0].ToLowerInvariant()
  if ($deviceStageHash -ne $candidateHash) {
    throw "The staged APK hash does not match the host artifact."
  }
  $devicePermissionsStageHashText = (
    Invoke-Adb -Arguments @("shell", "sha256sum", $permissionsStagingPath)
  ).Text
  $devicePermissionsStageHash = (
    $devicePermissionsStageHashText -split '\s+'
  )[0].ToLowerInvariant()
  if ($devicePermissionsStageHash -ne $permissionsHash) {
    throw "The staged privileged-permission allowlist hash does not match the host artifact."
  }
  $deviceSysconfigStageHashText = (
    Invoke-Adb -Arguments @("shell", "sha256sum", $sysconfigStagingPath)
  ).Text
  $deviceSysconfigStageHash = (
    $deviceSysconfigStageHashText -split '\s+'
  )[0].ToLowerInvariant()
  if ($deviceSysconfigStageHash -ne $sysconfigHash) {
    throw "The staged RoshanOS sysconfig hash does not match the host artifact."
  }
  $deviceBootStageHashText = (
    Invoke-Adb -Arguments @("shell", "sha256sum", $bootAnimationStagingPath)
  ).Text
  $deviceBootStageHash = (
    $deviceBootStageHashText -split '\s+'
  )[0].ToLowerInvariant()
  if ($deviceBootStageHash -ne $bootAnimationHash) {
    throw "The staged RoshanOS boot animation hash does not match the host artifact."
  }

  # From this point onward a target path may change. Any later exception must
  # restore every captured system-overlay file before returning control.
  $changed = $true
  Invoke-Adb -Arguments @("shell", "mkdir", "-p", $targetDirectory) | Out-Null
  Invoke-Adb -Arguments @("shell", "cp", $stagingPath, $targetPath) | Out-Null
  Invoke-Adb -Arguments @("shell", "chmod", "0644", $targetPath) | Out-Null
  Invoke-Adb -Arguments @("shell", "restorecon", $targetPath) -AllowFailure | Out-Null
  Invoke-Adb `
    -Arguments @("shell", "cp", $permissionsStagingPath, $permissionsTargetPath) |
    Out-Null
  Invoke-Adb `
    -Arguments @("shell", "chmod", "0644", $permissionsTargetPath) |
    Out-Null
  Invoke-Adb `
    -Arguments @("shell", "restorecon", $permissionsTargetPath) `
    -AllowFailure |
    Out-Null
  Invoke-Adb -Arguments @("shell", "cp", $sysconfigStagingPath, $sysconfigTargetPath) |
    Out-Null
  Invoke-Adb -Arguments @("shell", "chmod", "0644", $sysconfigTargetPath) |
    Out-Null
  Invoke-Adb `
    -Arguments @("shell", "restorecon", $sysconfigTargetPath) `
    -AllowFailure |
    Out-Null
  Invoke-Adb `
    -Arguments @("shell", "cp", $bootAnimationStagingPath, $bootAnimationTargetPath) |
    Out-Null
  Invoke-Adb `
    -Arguments @("shell", "chmod", "0644", $bootAnimationTargetPath) |
    Out-Null
  Invoke-Adb `
    -Arguments @("shell", "restorecon", $bootAnimationTargetPath) `
    -AllowFailure |
    Out-Null
  Invoke-Adb `
    -Arguments @(
      "shell",
      "rm",
      "-f",
      $stagingPath,
      $permissionsStagingPath,
      $sysconfigStagingPath,
      $bootAnimationStagingPath
    ) |
    Out-Null
  $deviceTargetHashText = (Invoke-Adb -Arguments @("shell", "sha256sum", $targetPath)).Text
  $deviceTargetHash = ($deviceTargetHashText -split '\s+')[0].ToLowerInvariant()
  if ($deviceTargetHash -ne $candidateHash) {
    throw "The installed system-overlay APK hash does not match the host artifact."
  }
  $devicePermissionsHashText = (
    Invoke-Adb -Arguments @("shell", "sha256sum", $permissionsTargetPath)
  ).Text
  $devicePermissionsHash = ($devicePermissionsHashText -split '\s+')[0].ToLowerInvariant()
  if ($devicePermissionsHash -ne $permissionsHash) {
    throw "The installed privileged-permission allowlist hash does not match the host artifact."
  }
  $deviceSysconfigHashText = (
    Invoke-Adb -Arguments @("shell", "sha256sum", $sysconfigTargetPath)
  ).Text
  $deviceSysconfigHash = ($deviceSysconfigHashText -split '\s+')[0].ToLowerInvariant()
  if ($deviceSysconfigHash -ne $sysconfigHash) {
    throw "The installed RoshanOS sysconfig hash does not match the host artifact."
  }
  $deviceBootAnimationHashText = (
    Invoke-Adb -Arguments @("shell", "sha256sum", $bootAnimationTargetPath)
  ).Text
  $deviceBootAnimationHash = (
    $deviceBootAnimationHashText -split '\s+'
  )[0].ToLowerInvariant()
  if ($deviceBootAnimationHash -ne $bootAnimationHash) {
    throw "The installed RoshanOS boot animation hash does not match the host artifact."
  }

  Invoke-Adb -Arguments @("reboot") | Out-Null
  Wait-ForBoot -TimeoutSeconds $BootTimeoutSeconds
  Wait-ForHealth -TimeoutSeconds $HealthTimeoutSeconds

  $postBootDevicePolicy = (
    Invoke-Adb -Arguments @("shell", "dumpsys", "device_policy") -AllowFailure
  ).Text
  if (
    $postBootDevicePolicy -notmatch (
      '(?s)Device Owner:\s+.*?package=' + [regex]::Escape($packageName)
    )
  ) {
    throw "Device Owner was not preserved after reboot."
  }
  $packageDump = (Invoke-Adb -Arguments @("shell", "dumpsys", "package", $packageName)).Text
  if ($packageDump -notmatch '(?s)pkgFlags=\[[^\]]*\bSYSTEM\b') {
    throw "Package Manager did not recognize the RoshanCore base as a system package."
  }
  $postBootTargetHashText = (Invoke-Adb -Arguments @("shell", "sha256sum", $targetPath)).Text
  $postBootTargetHash = ($postBootTargetHashText -split '\s+')[0].ToLowerInvariant()
  if ($postBootTargetHash -ne $candidateHash) {
    throw "The system-overlay APK did not survive the validation reboot."
  }
  $postBootPermissionsHashText = (
    Invoke-Adb -Arguments @("shell", "sha256sum", $permissionsTargetPath)
  ).Text
  $postBootPermissionsHash = (
    $postBootPermissionsHashText -split '\s+'
  )[0].ToLowerInvariant()
  if ($postBootPermissionsHash -ne $permissionsHash) {
    throw "The privileged-permission allowlist did not survive the validation reboot."
  }
  $postBootSysconfigHashText = (
    Invoke-Adb -Arguments @("shell", "sha256sum", $sysconfigTargetPath)
  ).Text
  $postBootSysconfigHash = (
    $postBootSysconfigHashText -split '\s+'
  )[0].ToLowerInvariant()
  if ($postBootSysconfigHash -ne $sysconfigHash) {
    throw "The RoshanOS sysconfig did not survive the validation reboot."
  }
  $postBootAnimationHashText = (
    Invoke-Adb -Arguments @("shell", "sha256sum", $bootAnimationTargetPath)
  ).Text
  $postBootAnimationHash = (
    $postBootAnimationHashText -split '\s+'
  )[0].ToLowerInvariant()
  if ($postBootAnimationHash -ne $bootAnimationHash) {
    throw "The RoshanOS boot animation did not survive the validation reboot."
  }
} catch {
  $failure = $_
  if ($changed) {
    Restore-SystemTargets `
      -ApkBackupPath $systemTargetBackup `
      -ApkPreviouslyExisted $targetPreviouslyExisted `
      -PermissionsBackupPath $permissionsTargetBackup `
      -PermissionsPreviouslyExisted $permissionsPreviouslyExisted `
      -SysconfigBackupPath $sysconfigTargetBackup `
      -SysconfigPreviouslyExisted $sysconfigPreviouslyExisted `
      -BootAnimationBackupPath $bootAnimationTargetBackup `
      -BootAnimationPreviouslyExisted $bootAnimationPreviouslyExisted
  } else {
    Invoke-Adb `
      -Arguments @(
        "shell",
        "rm",
        "-f",
        $stagingPath,
        $permissionsStagingPath,
        $sysconfigStagingPath,
        $bootAnimationStagingPath
      ) `
      -AllowFailure |
      Out-Null
  }
  throw $failure
}

Write-Host "RoshanCore development-overlay preinstall validated."
Write-Host "Serial: $($script:SelectedSerial)"
Write-Host "Target: $targetPath"
Write-Host "Priv-app allowlist: $permissionsTargetPath"
Write-Host "Power/data-save sysconfig: $sysconfigTargetPath"
Write-Host "Boot animation: $bootAnimationTargetPath"
Write-Host "APK SHA256: $candidateHash"
Write-Host "Signer SHA256: $candidateSigner"
Write-Host "Device Owner and app data were preserved; no package uninstall was performed."
Write-Warning (
  "This adb-remount overlay is a development test only. " +
  "Factory-reset persistence requires the APK and allowlists in a signed production system image."
)
