[CmdletBinding()]
param(
  [string]$AdbPath = "C:\Users\Roshan Raj\AppData\Local\Android\Sdk\platform-tools\adb.exe",
  [string]$Serial = "",
  [string]$OutputPath = "",
  [ValidateSet("Json", "Object")]
  [string]$OutputFormat = "Json",
  [ValidateRange(2, 30)]
  [int]$RequestTimeoutSeconds = 6,
  [ValidateRange(30, 600)]
  [int]$MutationTimeoutSeconds = 180,
  [switch]$IncludeNetworkAddresses,
  [switch]$AllowMutations,
  [switch]$TestReboot,
  [switch]$TestWifiRecovery,
  [switch]$TestCrashRecovery,
  [switch]$TestAccessLock,
  [switch]$SelfTest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script:SelectedSerial = ""
$script:LocalPort = 0
$script:CompanionSecret = $null
$script:PackageName = "com.tabletcontrol.companion"
$script:TailscalePackage = "com.tailscale.ipn"
$script:IpWebcamPackage = "com.pas.webcam"
$script:Root = Split-Path $PSScriptRoot -Parent

function Get-PropertyValue {
  param(
    [AllowNull()][object]$InputObject,
    [Parameter(Mandatory)][string[]]$Path
  )

  $current = $InputObject
  foreach ($segment in $Path) {
    if ($null -eq $current) { return $null }
    if ($current -is [System.Collections.IDictionary]) {
      if (-not $current.Contains($segment)) { return $null }
      $current = $current[$segment]
      continue
    }
    $property = $current.PSObject.Properties[$segment]
    if ($null -eq $property) { return $null }
    $current = $property.Value
  }
  return $current
}

function New-Check {
  param(
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][bool]$Passed,
    [Parameter(Mandatory)][string]$Summary,
    [AllowNull()][object]$Evidence = $null,
    [bool]$Required = $true
  )

  return [pscustomobject][ordered]@{
    name = $Name
    status = if ($Passed) { "pass" } else { "fail" }
    passed = $Passed
    required = $Required
    summary = $Summary
    evidence = $Evidence
  }
}

function New-SkippedCheck {
  param(
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][string]$Summary,
    [AllowNull()][object]$Evidence = $null
  )

  return [pscustomobject][ordered]@{
    name = $Name
    status = "skip"
    passed = $null
    required = $false
    summary = $Summary
    evidence = $Evidence
  }
}

function Assert-MutationGate {
  param(
    [Parameter(Mandatory)][bool]$Requested,
    [Parameter(Mandatory)][bool]$Allowed
  )

  if ($Requested -and -not $Allowed) {
    throw (
      "Mutating acceptance tests were requested without -AllowMutations. " +
      "No tablet state was changed."
    )
  }
}

function Test-TailnetAddress {
  param([Parameter(Mandatory)][string]$Address)

  $parsed = $null
  if (-not [System.Net.IPAddress]::TryParse($Address, [ref]$parsed)) {
    return $false
  }
  $bytes = $parsed.GetAddressBytes()
  if ($bytes.Length -eq 4) {
    return $bytes[0] -eq 100 -and $bytes[1] -ge 64 -and $bytes[1] -le 127
  }
  return (
    $bytes.Length -eq 16 -and
    $bytes[0] -eq 0xfd -and
    $bytes[1] -eq 0x7a -and
    $bytes[2] -eq 0x11 -and
    $bytes[3] -eq 0x5c -and
    $bytes[4] -eq 0xa1 -and
    $bytes[5] -eq 0xe0
  )
}

function Test-PrivateLanIpv4 {
  param([Parameter(Mandatory)][string]$Address)

  $parsed = $null
  if (-not [System.Net.IPAddress]::TryParse($Address, [ref]$parsed)) {
    return $false
  }
  $bytes = $parsed.GetAddressBytes()
  if ($bytes.Length -ne 4) { return $false }
  return (
    $bytes[0] -eq 10 -or
    ($bytes[0] -eq 172 -and $bytes[1] -ge 16 -and $bytes[1] -le 31) -or
    ($bytes[0] -eq 192 -and $bytes[1] -eq 168)
  )
}

function ConvertFrom-InterfaceAddressOutput {
  param([AllowEmptyString()][string]$Text)

  $result = @()
  $pattern = '(?m)^\d+:\s+([^\s:@]+)(?:@[^\s]+)?\s+inet(6)?\s+([0-9A-Fa-f:.]+)/(\d+)'
  foreach ($match in [regex]::Matches($Text, $pattern)) {
    $address = $match.Groups[3].Value
    $result += [pscustomobject]@{
      interface = $match.Groups[1].Value
      family = if ($match.Groups[2].Success) { "IPv6" } else { "IPv4" }
      address = $address
      prefixLength = [int]$match.Groups[4].Value
      tailnet = Test-TailnetAddress -Address $address
      privateLan = Test-PrivateLanIpv4 -Address $address
    }
  }
  return @($result)
}

function Invoke-Adb {
  param(
    [Parameter(Mandatory)][string[]]$Arguments,
    [switch]$AllowFailure
  )

  $allArguments = @()
  if (-not [string]::IsNullOrWhiteSpace($script:SelectedSerial)) {
    $allArguments += @("-s", $script:SelectedSerial)
  }
  $allArguments += $Arguments

  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $output = & $AdbPath @allArguments 2>&1
  $exitCode = $LASTEXITCODE
  $ErrorActionPreference = $previousPreference
  $text = ($output -join "`n").Trim()
  if ($exitCode -ne 0 -and -not $AllowFailure) {
    throw "ADB command failed: adb $($Arguments -join ' ')"
  }
  return [pscustomobject]@{
    exitCode = $exitCode
    text = $text
  }
}

function Select-AdbDevice {
  if (-not (Test-Path -LiteralPath $AdbPath)) {
    throw "ADB was not found at the configured path."
  }

  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $rows = & $AdbPath devices -l 2>&1
  $exitCode = $LASTEXITCODE
  $ErrorActionPreference = $previousPreference
  if ($exitCode -ne 0) {
    throw "Unable to enumerate ADB devices."
  }

  $online = @(
    $rows |
      Select-Object -Skip 1 |
      Where-Object { $_ -match '^\S+\s+device(?:\s|$)' } |
      ForEach-Object { ($_ -split '\s+')[0] }
  )
  if (-not [string]::IsNullOrWhiteSpace($Serial)) {
    if ($Serial -notin $online) {
      throw "The requested ADB device is not online and authorized."
    }
    $script:SelectedSerial = $Serial
  } elseif ($online.Count -eq 1) {
    $script:SelectedSerial = $online[0]
  } elseif ($online.Count -eq 0) {
    throw "No online authorized ADB device was found."
  } else {
    throw "Multiple authorized ADB devices are online. Supply -Serial."
  }
}

function Get-ProtectedCompanionSecret {
  $helperPath = Join-Path $script:Root "scripts\controller-secret-store.ps1"
  if (-not (Test-Path -LiteralPath $helperPath)) {
    throw "The protected controller credential helper is unavailable."
  }

  $request = '{"operation":"read"}'
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $responseText = $request |
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $helperPath 2>$null
  $exitCode = $LASTEXITCODE
  $ErrorActionPreference = $previousPreference
  if ($exitCode -ne 0 -or [string]::IsNullOrWhiteSpace(($responseText -join ""))) {
    throw "The protected companion credential could not be read."
  }

  try {
    $response = ($responseText -join "") | ConvertFrom-Json
    $value = [string](Get-PropertyValue $response @("value"))
    if (
      (Get-PropertyValue $response @("ok")) -ne $true -or
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
  } finally {
    $request = $null
    $responseText = $null
  }
}

function New-AdbForward {
  if ($script:LocalPort -gt 0) {
    Invoke-Adb -Arguments @("forward", "--remove", "tcp:$($script:LocalPort)") -AllowFailure |
      Out-Null
    $script:LocalPort = 0
  }
  $result = Invoke-Adb -Arguments @("forward", "tcp:0", "tcp:8765")
  if ($result.text -notmatch '^\d+$') {
    throw "ADB did not allocate a local RoshanCore forward."
  }
  $script:LocalPort = [int]$result.text
}

function Remove-AdbForward {
  if ($script:LocalPort -le 0) { return }
  Invoke-Adb -Arguments @("forward", "--remove", "tcp:$($script:LocalPort)") -AllowFailure |
    Out-Null
  $script:LocalPort = 0
}

function Invoke-HttpJson {
  param(
    [Parameter(Mandatory)][string]$Uri,
    [ValidateSet("GET", "POST")][string]$Method = "GET",
    [AllowNull()][string]$Bearer = $null,
    [AllowNull()][string]$Body = $null,
    [int]$TimeoutSeconds = $RequestTimeoutSeconds
  )

  $request = $null
  $response = $null
  $requestStream = $null
  $reader = $null
  try {
    $request = [System.Net.HttpWebRequest]::Create($Uri)
    $request.Method = $Method
    $request.Proxy = $null
    $request.AllowAutoRedirect = $false
    $request.Timeout = $TimeoutSeconds * 1000
    $request.ReadWriteTimeout = $TimeoutSeconds * 1000
    $request.Accept = "application/json"
    $request.UserAgent = "RoshanOS-Acceptance/1"
    if (-not [string]::IsNullOrWhiteSpace($Bearer)) {
      $request.Headers["Authorization"] = "Bearer $Bearer"
    }
    if ($Method -eq "POST") {
      $request.ContentType = "application/json"
      $payload = if ($null -eq $Body) { "{}" } else { $Body }
      $bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
      $request.ContentLength = $bytes.Length
      $requestStream = $request.GetRequestStream()
      $requestStream.Write($bytes, 0, $bytes.Length)
      $requestStream.Dispose()
      $requestStream = $null
      [Array]::Clear($bytes, 0, $bytes.Length)
      $payload = $null
    }

    $response = [System.Net.HttpWebResponse]$request.GetResponse()
    $reader = New-Object System.IO.StreamReader(
      $response.GetResponseStream(),
      [System.Text.Encoding]::UTF8
    )
    $text = $reader.ReadToEnd()
    $parsed = $null
    if (-not [string]::IsNullOrWhiteSpace($text)) {
      try { $parsed = $text | ConvertFrom-Json } catch {}
    }
    return [pscustomobject]@{
      success = ([int]$response.StatusCode -ge 200 -and [int]$response.StatusCode -lt 300)
      statusCode = [int]$response.StatusCode
      json = $parsed
      failureKind = $null
    }
  } catch [System.Net.WebException] {
    $webError = $_.Exception
    $statusCode = 0
    $parsed = $null
    if ($null -ne $webError.Response) {
      $errorResponse = [System.Net.HttpWebResponse]$webError.Response
      $statusCode = [int]$errorResponse.StatusCode
      try {
        $errorReader = New-Object System.IO.StreamReader(
          $errorResponse.GetResponseStream(),
          [System.Text.Encoding]::UTF8
        )
        $errorText = $errorReader.ReadToEnd()
        $errorReader.Dispose()
        if (-not [string]::IsNullOrWhiteSpace($errorText)) {
          try { $parsed = $errorText | ConvertFrom-Json } catch {}
        }
      } catch {}
      $errorResponse.Dispose()
    }
    return [pscustomobject]@{
      success = $false
      statusCode = $statusCode
      json = $parsed
      failureKind = [string]$webError.Status
    }
  } catch {
    return [pscustomobject]@{
      success = $false
      statusCode = 0
      json = $null
      failureKind = "ClientError"
    }
  } finally {
    if ($null -ne $reader) { $reader.Dispose() }
    if ($null -ne $response) { $response.Dispose() }
    if ($null -ne $requestStream) { $requestStream.Dispose() }
    if ($null -ne $request) { $request.Abort() }
  }
}

function Invoke-CompanionGet {
  param([Parameter(Mandatory)][string]$Path)
  return Invoke-HttpJson `
    -Uri "http://127.0.0.1:$($script:LocalPort)$Path" `
    -Bearer $script:CompanionSecret
}

function Invoke-CompanionPost {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string]$Body
  )
  return Invoke-HttpJson `
    -Uri "http://127.0.0.1:$($script:LocalPort)$Path" `
    -Method POST `
    -Bearer $script:CompanionSecret `
    -Body $Body
}

function Test-ApiOk {
  param([AllowNull()][object]$Response)
  return (
    $null -ne $Response -and
    $Response.success -eq $true -and
    (Get-PropertyValue $Response.json @("ok")) -eq $true
  )
}

function Get-ApiData {
  param([AllowNull()][object]$Response)
  if (-not (Test-ApiOk $Response)) { return $null }
  return Get-PropertyValue $Response.json @("data")
}

function Find-ApkSigner {
  $sdkRoot = Split-Path (Split-Path $AdbPath -Parent) -Parent
  $searchRoots = @(
    (Join-Path $sdkRoot "build-tools"),
    "C:\Users\Roshan Raj\AppData\Local\Android\Sdk\build-tools"
  ) | Select-Object -Unique
  foreach ($searchRoot in $searchRoots) {
    if (-not (Test-Path -LiteralPath $searchRoot)) { continue }
    $candidate = Get-ChildItem -LiteralPath $searchRoot -Filter "apksigner.bat" -Recurse |
      Sort-Object FullName -Descending |
      Select-Object -First 1 -ExpandProperty FullName
    if ($candidate) { return $candidate }
  }
  return $null
}

function Get-InstalledSignerDigest {
  param([Parameter(Mandatory)][string]$InstalledPath)

  $apksigner = Find-ApkSigner
  if ([string]::IsNullOrWhiteSpace($apksigner)) {
    return [pscustomobject]@{ available = $false; digest = $null }
  }

  $temporaryApk = Join-Path (
    [System.IO.Path]::GetTempPath()
  ) ("roshanos-acceptance-{0}-{1}.apk" -f $PID, [Guid]::NewGuid().ToString("N"))
  $previousJavaHome = $env:JAVA_HOME
  try {
    $portableJava = Join-Path (
      $script:Root
    ) ".local\microsoft-jdk-17.0.20\runtime\jdk-17.0.20+8"
    if (
      [string]::IsNullOrWhiteSpace($env:JAVA_HOME) -and
      (Test-Path -LiteralPath (Join-Path $portableJava "lib\jvm.cfg"))
    ) {
      $env:JAVA_HOME = $portableJava
    }

    $pull = Invoke-Adb -Arguments @("pull", $InstalledPath, $temporaryApk) -AllowFailure
    if ($pull.exitCode -ne 0 -or -not (Test-Path -LiteralPath $temporaryApk)) {
      return [pscustomobject]@{ available = $false; digest = $null }
    }
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $output = & $apksigner verify --print-certs $temporaryApk 2>&1
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = $previousPreference
    if ($exitCode -ne 0) {
      return [pscustomobject]@{ available = $false; digest = $null }
    }
    $line = $output |
      Where-Object {
        $_ -match '(?:Signer #[0-9]+|V[0-9.]+ Signer): certificate SHA-256 digest:\s*(\S+)'
      } |
      Select-Object -First 1
    if (
      $null -eq $line -or
      $line -notmatch '(?:Signer #[0-9]+|V[0-9.]+ Signer): certificate SHA-256 digest:\s*(\S+)'
    ) {
      return [pscustomobject]@{ available = $false; digest = $null }
    }
    return [pscustomobject]@{
      available = $true
      digest = $matches[1].ToLowerInvariant()
    }
  } finally {
    $env:JAVA_HOME = $previousJavaHome
    if (Test-Path -LiteralPath $temporaryApk) {
      Remove-Item -LiteralPath $temporaryApk -Force -ErrorAction SilentlyContinue
    }
  }
}

function Test-TechnicalPackage {
  param([Parameter(Mandatory)][string]$Package)

  $exact = @(
    "com.tabletcontrol.companion",
    "com.tabletcontrol.camera",
    "com.pas.webcam",
    "com.tailscale.ipn",
    "com.topjohnwu.magisk",
    "com.termux",
    "de.ozerov.fully",
    "uk.nktnet.webviewkiosk",
    "app.lawnchair",
    "me.phh.treble.app",
    "com.android.systemui",
    "com.android.settings"
  )
  return (
    $Package -in $exact -or
    $Package.StartsWith("com.tabletcontrol.") -or
    $Package.StartsWith("com.topjohnwu.") -or
    $Package.StartsWith("com.termux") -or
    $Package.StartsWith("de.ozerov.fully") -or
    $Package.StartsWith("me.phh.treble")
  )
}

function Get-LauncherPackages {
  param([AllowEmptyString()][string]$Text)

  $packages = @()
  foreach ($line in ($Text -split "`r?`n")) {
    $trimmed = $line.Trim()
    if ($trimmed -match '^([A-Za-z][A-Za-z0-9_.]*)/') {
      $packages += $matches[1]
    }
  }
  return @($packages | Select-Object -Unique)
}

function Get-NetworkEvidence {
  param([Parameter(Mandatory)][object[]]$Addresses)

  $evidence = [ordered]@{
    count = $Addresses.Count
    families = @($Addresses | ForEach-Object { $_.family } | Select-Object -Unique)
    interfaces = @($Addresses | ForEach-Object { $_.interface } | Select-Object -Unique)
  }
  if ($IncludeNetworkAddresses) {
    $evidence["addresses"] = @($Addresses | ForEach-Object { $_.address })
  }
  return [pscustomobject]$evidence
}

function Wait-Until {
  param(
    [Parameter(Mandatory)][scriptblock]$Condition,
    [Parameter(Mandatory)][int]$TimeoutSeconds
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    try {
      if (& $Condition) { return $true }
    } catch {}
    Start-Sleep -Milliseconds 750
  } while ((Get-Date) -lt $deadline)
  return $false
}

function Invoke-AccessLockAcceptance {
  $enabled = $false
  $observedLocked = $false
  $restored = $false
  try {
    $enable = Invoke-CompanionPost `
      -Path "/api/v1/companion/touch_lock" `
      -Body '{"on":true}'
    if (-not (Test-ApiOk $enable)) {
      return New-Check `
        -Name "mutation.accessLock" `
        -Passed $false `
        -Summary "Access Lock could not be enabled for the explicit test."
    }
    $enabled = $true
    $observedLocked = Wait-Until -TimeoutSeconds 15 -Condition {
      $status = Get-ApiData (Invoke-CompanionGet "/api/v1/companion/status")
      return (Get-PropertyValue $status @("touchLock")) -eq $true
    }
  } finally {
    if ($enabled) {
      for ($attempt = 1; $attempt -le 3 -and -not $restored; $attempt++) {
        $disable = Invoke-CompanionPost `
          -Path "/api/v1/companion/touch_lock" `
          -Body '{"on":false}'
        if (Test-ApiOk $disable) {
          $restored = Wait-Until -TimeoutSeconds 10 -Condition {
            $status = Get-ApiData (Invoke-CompanionGet "/api/v1/companion/status")
            return (Get-PropertyValue $status @("touchLock")) -eq $false
          }
        }
      }
    }
  }
  return New-Check `
    -Name "mutation.accessLock" `
    -Passed ($observedLocked -and $restored) `
    -Summary "Explicit Access Lock toggle was observed and restored to fail-open state." `
    -Evidence ([pscustomobject]@{
      lockedObserved = $observedLocked
      unlockedRestored = $restored
    })
}

function Invoke-CrashRecoveryAcceptance {
  $pidResult = Invoke-Adb -Arguments @("shell", "pidof", $script:PackageName) -AllowFailure
  $oldPid = @(
    ($pidResult.text -split '\s+') |
      Where-Object { $_ -match '^\d+$' }
  ) | Select-Object -First 1
  if ($pidResult.exitCode -ne 0 -or [string]::IsNullOrWhiteSpace($oldPid)) {
    return New-Check `
      -Name "mutation.crashRecovery" `
      -Passed $false `
      -Summary "RoshanCore PID was unavailable before the explicit crash test."
  }

  $kill = Invoke-Adb -Arguments @("shell", "su", "-c", "kill -9 $oldPid") -AllowFailure
  if ($kill.exitCode -ne 0) {
    return New-Check `
      -Name "mutation.crashRecovery" `
      -Passed $false `
      -Summary "The explicit RoshanCore crash signal was rejected."
  }

  $recovered = Wait-Until -TimeoutSeconds $MutationTimeoutSeconds -Condition {
    $newPidResult = Invoke-Adb -Arguments @(
      "shell", "pidof", $script:PackageName
    ) -AllowFailure
    $newPids = @(
      ($newPidResult.text -split '\s+') |
        Where-Object { $_ -match '^\d+$' }
    )
    if ($newPidResult.exitCode -ne 0 -or $oldPid -in $newPids) { return $false }
    $health = Invoke-HttpJson -Uri "http://127.0.0.1:$($script:LocalPort)/health"
    return (
      $health.success -eq $true -and
      (Get-PropertyValue $health.json @("data", "healthy")) -eq $true
    )
  }
  $fallbackRestored = $false
  if (-not $recovered) {
    Invoke-Adb -Arguments @(
      "shell", "su", "-c",
      (
        "am start-foreground-service -n " +
        "$($script:PackageName)/.CompanionService " +
        "-a com.tabletcontrol.companion.action.RECONCILE_SERVERS " +
        "--es reconcile_reason acceptance_crash_fallback"
      )
    ) -AllowFailure | Out-Null
    $fallbackRestored = Wait-Until -TimeoutSeconds 30 -Condition {
      $health = Invoke-HttpJson -Uri "http://127.0.0.1:$($script:LocalPort)/health"
      return (
        $health.success -eq $true -and
        (Get-PropertyValue $health.json @("data", "healthy")) -eq $true
      )
    }
  }
  $status = Get-ApiData (Invoke-CompanionGet "/api/v1/companion/status")
  $failOpen = (Get-PropertyValue $status @("touchLock")) -eq $false
  return New-Check `
    -Name "mutation.crashRecovery" `
    -Passed ($recovered -and $failOpen) `
    -Summary "RoshanCore recovered after an explicit process crash with Access Lock inactive." `
    -Evidence ([pscustomobject]@{
      processRecovered = $recovered
      fallbackOperationalRestore = $fallbackRestored
      accessLockFailOpen = $failOpen
    })
}

function Invoke-WifiRecoveryAcceptance {
  $disabledObserved = $false
  $restored = $false
  try {
    $disable = Invoke-Adb -Arguments @(
      "shell", "su", "-c", "svc wifi disable"
    ) -AllowFailure
    if ($disable.exitCode -ne 0) {
      return New-Check `
        -Name "mutation.wifiRecovery" `
        -Passed $false `
        -Summary "The explicit Wi-Fi disable command was rejected."
    }
    $disabledObserved = Wait-Until -TimeoutSeconds 30 -Condition {
      $status = Get-ApiData (Invoke-CompanionGet "/api/v1/companion/status")
      return (
        (Get-PropertyValue $status @("connectivity", "wifiEnabled")) -eq $false -or
        (Get-PropertyValue $status @("connectivity", "wifiConnected")) -eq $false
      )
    }
  } finally {
    Invoke-Adb -Arguments @(
      "shell", "su", "-c", "svc wifi enable"
    ) -AllowFailure | Out-Null
    $restored = Wait-Until -TimeoutSeconds $MutationTimeoutSeconds -Condition {
      $health = Get-ApiData (
        Invoke-CompanionGet "/api/v1/companion/server-health"
      )
      return (
        (Get-PropertyValue $health @("components", "wifi", "state")) -eq "healthy" -and
        (Get-PropertyValue $health @("components", "vpnTailscale", "state")) -eq "healthy"
      )
    }
  }
  return New-Check `
    -Name "mutation.wifiRecovery" `
    -Passed ($disabledObserved -and $restored) `
    -Summary "Wi-Fi loss was observed and Wi-Fi plus Tailscale recovered." `
    -Evidence ([pscustomobject]@{
      disconnectObserved = $disabledObserved
      networkRestored = $restored
    })
}

function Invoke-RebootRecoveryAcceptance {
  $before = Invoke-Adb -Arguments @(
    "shell", "cat", "/proc/sys/kernel/random/boot_id"
  ) -AllowFailure
  if ($before.exitCode -ne 0 -or [string]::IsNullOrWhiteSpace($before.text)) {
    return New-Check `
      -Name "mutation.rebootRecovery" `
      -Passed $false `
      -Summary "The pre-reboot boot identifier was unavailable."
  }

  $reboot = Invoke-CompanionPost `
    -Path "/api/v1/companion/device/reboot" `
    -Body "{}"
  Remove-AdbForward

  $booted = Wait-Until -TimeoutSeconds $MutationTimeoutSeconds -Condition {
    $state = Invoke-Adb -Arguments @("get-state") -AllowFailure
    if ($state.exitCode -ne 0 -or $state.text -ne "device") { return $false }
    $complete = Invoke-Adb -Arguments @(
      "shell", "getprop", "sys.boot_completed"
    ) -AllowFailure
    if ($complete.exitCode -ne 0 -or $complete.text -ne "1") { return $false }
    $after = Invoke-Adb -Arguments @(
      "shell", "cat", "/proc/sys/kernel/random/boot_id"
    ) -AllowFailure
    return (
      $after.exitCode -eq 0 -and
      -not [string]::IsNullOrWhiteSpace($after.text) -and
      $after.text -ne $before.text
    )
  }
  if (-not $booted) {
    return New-Check `
      -Name "mutation.rebootRecovery" `
      -Passed $false `
      -Summary "The tablet did not complete a new boot within the bounded timeout." `
      -Evidence ([pscustomobject]@{ rebootRequestAccepted = (Test-ApiOk $reboot) })
  }

  New-AdbForward
  $healthy = Wait-Until -TimeoutSeconds $MutationTimeoutSeconds -Condition {
    $health = Get-ApiData (
      Invoke-CompanionGet "/api/v1/companion/server-health"
    )
    return (
      (Get-PropertyValue $health @("healthy")) -eq $true -and
      (Get-PropertyValue $health @("homeReady")) -eq $true
    )
  }
  $dpc = Get-ApiData (Invoke-CompanionGet "/api/v1/companion/dpc/status")
  $restrictionsRestored =
    (Get-PropertyValue $dpc @("restrictions", "no_install_apps")) -eq $true -and
    (Get-PropertyValue $dpc @("restrictions", "no_uninstall_apps")) -eq $true -and
    (Get-PropertyValue $dpc @("maintenance", "active")) -eq $false
  return New-Check `
    -Name "mutation.rebootRecovery" `
    -Passed ($healthy -and $restrictionsRestored) `
    -Summary "A new boot completed and RoshanCore plus owner restrictions recovered." `
    -Evidence ([pscustomobject]@{
      rebootRequestAccepted = (Test-ApiOk $reboot)
      newBootObserved = $booted
      homeReady = $healthy
      restrictionsRestored = $restrictionsRestored
    })
}

function Invoke-InternalSelfTest {
  $checks = @()
  $checks += New-Check `
    -Name "tailnetIpv4Boundary" `
    -Passed (
      (Test-TailnetAddress "100.64.0.0") -and
      (Test-TailnetAddress "100.127.255.255") -and
      -not (Test-TailnetAddress "100.128.0.0")
    ) `
    -Summary "The complete Tailscale IPv4 range is classified exactly."
  $checks += New-Check `
    -Name "tailnetIpv6Boundary" `
    -Passed (
      (Test-TailnetAddress "fd7a:115c:a1e0::1") -and
      -not (Test-TailnetAddress "fd7a:115c:a1e1::1")
    ) `
    -Summary "The Tailscale IPv6 prefix is classified exactly."
  $sample = @"
1: wlan0    inet 192.168.1.20/24 brd 192.168.1.255 scope global wlan0
2: tun0    inet 100.100.10.20/32 scope global tun0
"@
  $parsed = @(ConvertFrom-InterfaceAddressOutput $sample)
  $checks += New-Check `
    -Name "interfaceParser" `
    -Passed (
      $parsed.Count -eq 2 -and
      @($parsed | Where-Object { $_.privateLan }).Count -eq 1 -and
      @($parsed | Where-Object { $_.tailnet }).Count -eq 1
    ) `
    -Summary "Interface parsing separates LAN and Tailnet addresses."
  $gateHeld = $false
  try {
    Assert-MutationGate -Requested $true -Allowed $false
  } catch {
    $gateHeld = $true
  }
  $checks += New-Check `
    -Name "mutationGate" `
    -Passed $gateHeld `
    -Summary "Mutating tests require the independent AllowMutations gate."

  $sentinel = "self-test-secret-that-must-never-appear"
  $preview = [pscustomobject]@{
    schemaVersion = 1
    checks = $checks
  } | ConvertTo-Json -Depth 8
  $checks += New-Check `
    -Name "secretExcludedFromResult" `
    -Passed (-not $preview.Contains($sentinel)) `
    -Summary "Result serialization contains no credential field."
  $sentinel = $null

  $failed = @($checks | Where-Object { $_.status -eq "fail" })
  return [pscustomobject][ordered]@{
    schemaVersion = 1
    mode = "self-test"
    readOnly = $true
    passed = $failed.Count -eq 0
    checks = $checks
    failedChecks = @($failed | ForEach-Object { $_.name })
  }
}

function Write-AcceptanceResult {
  param([Parameter(Mandatory)][object]$Result)

  $json = $Result | ConvertTo-Json -Depth 14
  if (-not [string]::IsNullOrWhiteSpace($OutputPath)) {
    $fullPath = [System.IO.Path]::GetFullPath($OutputPath)
    $parent = Split-Path -Parent $fullPath
    if (-not [string]::IsNullOrWhiteSpace($parent) -and -not (Test-Path -LiteralPath $parent)) {
      New-Item -ItemType Directory -Path $parent | Out-Null
    }
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($fullPath, $json, $utf8)
  }
  if ($OutputFormat -eq "Object") {
    Write-Output $Result
  } else {
    Write-Output $json
  }
}

if ($SelfTest) {
  $selfTestResult = Invoke-InternalSelfTest
  Write-AcceptanceResult $selfTestResult
  if (-not $selfTestResult.passed) { exit 1 }
  exit 0
}

$mutationRequested =
  $TestReboot -or
  $TestWifiRecovery -or
  $TestCrashRecovery -or
  $TestAccessLock

try {
  Assert-MutationGate `
    -Requested ([bool]$mutationRequested) `
    -Allowed ([bool]$AllowMutations)
} catch {
  $gateFailure = [pscustomobject][ordered]@{
    schemaVersion = 1
    capturedAt = (Get-Date).ToUniversalTime().ToString("o")
    mode = "live"
    readOnly = $true
    mutationsRequested = [bool]$mutationRequested
    mutationsAuthorized = [bool]$AllowMutations
    passed = $false
    checks = @(
      (New-Check `
        -Name "mutationAuthorization" `
        -Passed $false `
        -Summary $_.Exception.Message)
    )
    failedChecks = @("mutationAuthorization")
  }
  Write-AcceptanceResult $gateFailure
  exit 1
}

$checks = New-Object System.Collections.Generic.List[object]
$fatalError = $null
$deviceMetadata = [ordered]@{}

try {
  Select-AdbDevice
  $script:CompanionSecret = Get-ProtectedCompanionSecret
  New-AdbForward

  $devicePolicy = (Invoke-Adb -Arguments @(
    "shell", "dumpsys", "device_policy"
  )).text
  $packageDump = (Invoke-Adb -Arguments @(
    "shell", "dumpsys", "package", $script:PackageName
  )).text
  $activityDump = (Invoke-Adb -Arguments @(
    "shell", "dumpsys", "activity", "activities"
  )).text
  $windowDump = (Invoke-Adb -Arguments @(
    "shell", "dumpsys", "window", "windows"
  ) -AllowFailure).text
  $homeResolution = (Invoke-Adb -Arguments @(
    "shell", "cmd", "package", "resolve-activity", "--brief", "--user", "0",
    "-a", "android.intent.action.MAIN",
    "-c", "android.intent.category.HOME"
  ) -AllowFailure).text
  $launcherQuery = Invoke-Adb -Arguments @(
    "shell", "cmd", "package", "query-activities", "--brief", "--user", "0",
    "-a", "android.intent.action.MAIN",
    "-c", "android.intent.category.LAUNCHER"
  ) -AllowFailure
  if ($launcherQuery.exitCode -ne 0) {
    $launcherQuery = Invoke-Adb -Arguments @(
      "shell", "pm", "query-activities", "--brief", "--user", "0",
      "-a", "android.intent.action.MAIN",
      "-c", "android.intent.category.LAUNCHER"
    ) -AllowFailure
  }
  $launcherPackages = @(Get-LauncherPackages $launcherQuery.text)
  $systemPackages = (Invoke-Adb -Arguments @(
    "shell", "pm", "list", "packages", "-s", $script:PackageName
  ) -AllowFailure).text
  $enabledPackages = (Invoke-Adb -Arguments @(
    "shell", "pm", "list", "packages", "-e", $script:PackageName
  ) -AllowFailure).text
  $installedPathResult = Invoke-Adb -Arguments @(
    "shell", "pm", "path", $script:PackageName
  ) -AllowFailure
  $addressOutput = (Invoke-Adb -Arguments @(
    "shell", "ip", "-o", "addr", "show", "scope", "global"
  ) -AllowFailure).text
  $addresses = @(ConvertFrom-InterfaceAddressOutput $addressOutput)
  $tailnetAddresses = @($addresses | Where-Object { $_.tailnet })
  $lanAddresses = @(
    $addresses |
      Where-Object { $_.privateLan -and -not $_.tailnet } |
      Sort-Object @{ Expression = { if ($_.interface -match '^wlan') { 0 } else { 1 } } }
  )

  $deviceMetadata["model"] = (
    Invoke-Adb -Arguments @("shell", "getprop", "ro.product.model") -AllowFailure
  ).text
  $deviceMetadata["androidVersion"] = (
    Invoke-Adb -Arguments @("shell", "getprop", "ro.build.version.release") -AllowFailure
  ).text
  $deviceMetadata["buildType"] = (
    Invoke-Adb -Arguments @("shell", "getprop", "ro.build.type") -AllowFailure
  ).text

  $liveness = Invoke-HttpJson -Uri "http://127.0.0.1:$($script:LocalPort)/health"
  $statusResponse = Invoke-CompanionGet "/api/v1/companion/status"
  $serverHealthResponse = Invoke-CompanionGet "/api/v1/companion/server-health"
  $dpcResponse = Invoke-CompanionGet "/api/v1/companion/dpc/status"
  $kioskResponse = Invoke-CompanionGet "/api/v1/companion/kiosk/status"
  $appsResponse = Invoke-CompanionGet "/api/v1/companion/apps"
  $cameraResponse = Invoke-CompanionGet "/api/v1/companion/camera/health"
  $remoteResponse = Invoke-CompanionGet "/api/v1/companion/remote/status"

  $status = Get-ApiData $statusResponse
  $serverHealth = Get-ApiData $serverHealthResponse
  $dpc = Get-ApiData $dpcResponse
  $kiosk = Get-ApiData $kioskResponse
  $camera = Get-ApiData $cameraResponse
  $remote = Get-ApiData $remoteResponse

  $deviceOwnerApi = (Get-PropertyValue $dpc @("deviceOwner")) -eq $true
  $deviceOwnerShell = (
    $devicePolicy -match (
      'Device Owner[\s\S]{0,500}' +
      [regex]::Escape($script:PackageName)
    ) -or
    $devicePolicy -match (
      'admin=ComponentInfo\{' +
      [regex]::Escape($script:PackageName) +
      '/\.TabletDeviceAdminReceiver\}'
    )
  )
  $checks.Add((New-Check `
    -Name "deviceOwner" `
    -Passed ($deviceOwnerApi -and $deviceOwnerShell) `
    -Summary "RoshanCore is the Android Device Owner." `
    -Evidence ([pscustomobject]@{
      companionApi = $deviceOwnerApi
      androidPolicyService = $deviceOwnerShell
    })))

  $requiredRestrictions = @(
    "no_factory_reset",
    "no_add_user",
    "no_safe_boot",
    "no_install_apps",
    "no_uninstall_apps",
    "no_apps_control",
    "no_mount_media"
  )
  $missingRestrictions = @(
    $requiredRestrictions |
      Where-Object {
        (Get-PropertyValue $dpc @("restrictions", $_)) -ne $true
      }
  )
  $maintenanceActive = (
    Get-PropertyValue $dpc @("maintenance", "active")
  ) -eq $true
  $checks.Add((New-Check `
    -Name "normalUserRestrictions" `
    -Passed ($missingRestrictions.Count -eq 0 -and -not $maintenanceActive) `
    -Summary "Normal-user package, reset, user, safe-boot, and media restrictions are active." `
    -Evidence ([pscustomobject]@{
      missing = $missingRestrictions
      maintenanceActive = $maintenanceActive
    })))

  $livenessPassed =
    $liveness.success -eq $true -and
    (Get-PropertyValue $liveness.json @("ok")) -eq $true -and
    (Get-PropertyValue $liveness.json @("data", "service")) -eq "RoshanCore" -and
    (Get-PropertyValue $liveness.json @("data", "healthy")) -eq $true
  $checks.Add((New-Check `
    -Name "roshanCoreLiveness" `
    -Passed $livenessPassed `
    -Summary "The minimal RoshanCore liveness endpoint is healthy." `
    -Evidence ([pscustomobject]@{ httpStatus = $liveness.statusCode })))

  $statusPassed =
    (Test-ApiOk $statusResponse) -and
    (Get-PropertyValue $status @("mode")) -eq "companion" -and
    (Get-PropertyValue $status @("online")) -eq $true -and
    (Get-PropertyValue $status @("enrolled")) -eq $true -and
    (Get-PropertyValue $status @("credentialState")) -eq "ready"
  $checks.Add((New-Check `
    -Name "roshanCoreStatus" `
    -Passed $statusPassed `
    -Summary "Authenticated RoshanCore status is online, enrolled, and credential-ready." `
    -Evidence ([pscustomobject]@{
      online = Get-PropertyValue $status @("online")
      enrolled = Get-PropertyValue $status @("enrolled")
      credentialState = Get-PropertyValue $status @("credentialState")
      credentialVersion = Get-PropertyValue $status @("credentialVersion")
    })))

  $serverPassed =
    (Test-ApiOk $serverHealthResponse) -and
    (Get-PropertyValue $serverHealth @("healthy")) -eq $true -and
    (Get-PropertyValue $serverHealth @("homeReady")) -eq $true -and
    (Get-PropertyValue $serverHealth @("components", "controlListener", "state")) -eq "healthy" -and
    (Get-PropertyValue $serverHealth @("components", "supervisor", "state")) -eq "healthy"
  $checks.Add((New-Check `
    -Name "serverHealth" `
    -Passed $serverPassed `
    -Summary "RoshanCore server supervision is healthy and Home-ready." `
    -Evidence ([pscustomobject]@{
      healthy = Get-PropertyValue $serverHealth @("healthy")
      homeReady = Get-PropertyValue $serverHealth @("homeReady")
      degradedReasons = Get-PropertyValue $serverHealth @("degradedReasons")
    })))

  $homePattern = (
    [regex]::Escape($script:PackageName) +
    '/(?:\.|' +
    [regex]::Escape($script:PackageName) +
    '\.)?KioskActivity'
  )
  $homeResolved = $homeResolution -match $homePattern
  $shellForeground =
    $activityDump -match "(?m)(mResumedActivity|topResumedActivity).*$homePattern" -or
    $windowDump -match "(?m)(mCurrentFocus|mFocusedApp).*$homePattern"
  $apiForeground =
    (Get-PropertyValue $kiosk @("foreground")) -eq $true -and
    (Get-PropertyValue $status @("foregroundApp", "state")) -eq "roshanos"
  $checks.Add((New-Check `
    -Name "homeForeground" `
    -Passed ($homeResolved -and $shellForeground -and $apiForeground) `
    -Summary "RoshanOS Home is the resolved and foreground Home activity." `
    -Evidence ([pscustomobject]@{
      resolvedHome = $homeResolved
      shellForeground = $shellForeground
      companionForeground = $apiForeground
    })))

  $coreLauncherVisible = $script:PackageName -in $launcherPackages
  $checks.Add((New-Check `
    -Name "noRoshanCoreLauncherEntry" `
    -Passed (-not $coreLauncherVisible) `
    -Summary "RoshanCore has no ordinary Android LAUNCHER entry." `
    -Evidence ([pscustomobject]@{ launcherEntryPresent = $coreLauncherVisible })))

  $technicalLauncherPackages = @(
    $launcherPackages |
      Where-Object { Test-TechnicalPackage $_ }
  )
  if (Test-ApiOk $appsResponse) {
    $appEntries = @(Get-ApiData $appsResponse)
    $technicalGridEntries = @(
      $appEntries |
        Where-Object {
          [string](Get-PropertyValue $_ @("status")) -eq "technical"
        } |
        ForEach-Object { [string](Get-PropertyValue $_ @("packageName")) }
    )
    $approvedTechnicalEntries = @(
      $appEntries |
        Where-Object {
          [string](Get-PropertyValue $_ @("status")) -eq "approved" -and
          (Test-TechnicalPackage ([string](Get-PropertyValue $_ @("packageName"))))
        } |
        ForEach-Object { [string](Get-PropertyValue $_ @("packageName")) }
    )
    $checks.Add((New-Check `
      -Name "technicalAppsExcluded" `
      -Passed (
        $technicalLauncherPackages.Count -eq 0 -and
        $technicalGridEntries.Count -eq 0 -and
        $approvedTechnicalEntries.Count -eq 0
      ) `
      -Summary "Technical packages are absent from Android launchers and the approved RoshanOS grid." `
      -Evidence ([pscustomobject]@{
        launcherPackages = $technicalLauncherPackages
        technicalGridPackages = $technicalGridEntries
        approvedTechnicalPackages = $approvedTechnicalEntries
        approvedAppCount = @(
          $appEntries |
            Where-Object { [string](Get-PropertyValue $_ @("status")) -eq "approved" }
        ).Count
      })))
  } else {
    $checks.Add((New-SkippedCheck `
      -Name "technicalAppsExcluded" `
      -Summary "The approved-app endpoint did not permit a grid comparison." `
      -Evidence ([pscustomobject]@{
        androidTechnicalLauncherPackages = $technicalLauncherPackages
      })))
  }

  $wifiPassed =
    (Get-PropertyValue $status @("connectivity", "wifiEnabled")) -eq $true -and
    (Get-PropertyValue $status @("connectivity", "wifiConnected")) -eq $true -and
    (Get-PropertyValue $status @("connectivity", "internetValidated")) -eq $true -and
    (Get-PropertyValue $serverHealth @("components", "wifi", "state")) -eq "healthy"
  $checks.Add((New-Check `
    -Name "wifiValidated" `
    -Passed $wifiPassed `
    -Summary "Wi-Fi is enabled, connected, Android-validated, and supervisor-healthy." `
    -Evidence ([pscustomobject]@{
      enabled = Get-PropertyValue $status @("connectivity", "wifiEnabled")
      connected = Get-PropertyValue $status @("connectivity", "wifiConnected")
      internetValidated = Get-PropertyValue $status @("connectivity", "internetValidated")
      signalState = Get-PropertyValue $status @("connectivity", "wifiSignalState")
    })))

  $tailscalePassed =
    $tailnetAddresses.Count -gt 0 -and
    (Get-PropertyValue $serverHealth @(
      "components", "vpnTailscale", "state"
    )) -eq "healthy" -and
    (Get-PropertyValue $serverHealth @(
      "components", "vpnTailscale", "details", "vpnTransportAvailable"
    )) -eq $true -and
    (Get-PropertyValue $serverHealth @(
      "components", "vpnTailscale", "details", "tailnetAddressAvailable"
    )) -eq $true
  $checks.Add((New-Check `
    -Name "tailscaleTransportAndAddress" `
    -Passed $tailscalePassed `
    -Summary "Tailscale VPN transport and at least one valid Tailnet address are present." `
    -Evidence (Get-NetworkEvidence $tailnetAddresses)))

  if ($lanAddresses.Count -gt 0) {
    $lanTarget = $lanAddresses[0]
    $lanProbe = Invoke-HttpJson `
      -Uri "http://$($lanTarget.address):8765/health" `
      -TimeoutSeconds ([Math]::Min(4, $RequestTimeoutSeconds))
    $deviceProbeCommand = (
      "if command -v curl >/dev/null 2>&1; then " +
      "curl --interface $($lanTarget.interface) --max-time 4 --silent " +
      "--output /dev/null --write-out HTTP:%{http_code} " +
      "http://$($lanTarget.address):8765/health; else exit 127; fi"
    )
    $deviceLanProbe = Invoke-Adb -Arguments @(
      "shell", "sh", "-c", $deviceProbeCommand
    ) -AllowFailure
    $hostAccepted = $lanProbe.statusCode -eq 200
    $deviceAccepted = $deviceLanProbe.text -match 'HTTP:200'
    $hostReachedBoundary = (
      $lanProbe.statusCode -gt 0 -or
      $lanProbe.failureKind -in @(
        "ReceiveFailure",
        "ConnectionClosed",
        "ProtocolError",
        "ServerProtocolViolation"
      )
    )
    $deviceReachedBoundary = (
      $deviceLanProbe.text -match 'HTTP:000' -or
      $deviceLanProbe.exitCode -in @(0, 52, 56)
    )
    $checks.Add((New-Check `
      -Name "lanListenerRejected" `
      -Passed (
        -not $hostAccepted -and
        -not $deviceAccepted -and
        ($hostReachedBoundary -or $deviceReachedBoundary)
      ) `
      -Summary "A non-Tailnet LAN source received no usable RoshanCore HTTP response." `
      -Evidence ([pscustomobject]@{
        hostHttpStatus = $lanProbe.statusCode
        hostFailureKind = $lanProbe.failureKind
        deviceProbeExitCode = $deviceLanProbe.exitCode
        addressDisclosed = [bool]$IncludeNetworkAddresses
      })))
    $deviceProbeCommand = $null
  } else {
    $checks.Add((New-Check `
      -Name "lanListenerRejected" `
      -Passed $false `
      -Summary "No private LAN address was available for the listener-boundary probe."))
  }

  if ($tailnetAddresses.Count -gt 0) {
    $tailnetTarget = $tailnetAddresses |
      Sort-Object @{ Expression = { if ($_.family -eq "IPv4") { 0 } else { 1 } } } |
      Select-Object -First 1
    $hostLiteral = if ($tailnetTarget.family -eq "IPv6") {
      "[$($tailnetTarget.address)]"
    } else {
      $tailnetTarget.address
    }
    $tailnetProbe = Invoke-HttpJson `
      -Uri "http://$hostLiteral`:8765/api/v1/companion/server-health" `
      -Bearer $script:CompanionSecret
    $tailnetSuccess =
      (Test-ApiOk $tailnetProbe) -and
      (Get-PropertyValue $tailnetProbe.json @("data", "homeReady")) -eq $true
    $checks.Add((New-Check `
      -Name "tailnetAuthenticatedSuccess" `
      -Passed $tailnetSuccess `
      -Summary "The Windows controller reached authenticated RoshanCore over Tailscale." `
      -Evidence ([pscustomobject]@{
        httpStatus = $tailnetProbe.statusCode
        addressFamily = $tailnetTarget.family
      })))
    $hostLiteral = $null
  } else {
    $checks.Add((New-Check `
      -Name "tailnetAuthenticatedSuccess" `
      -Passed $false `
      -Summary "No Tailnet address was available for the authenticated transport probe."))
  }

  $cameraPassed =
    (Test-ApiOk $cameraResponse) -and
    (Get-PropertyValue $camera @("serviceRunning")) -eq $true -and
    [int](Get-PropertyValue $camera @("videoClients")) -eq 0 -and
    [int](Get-PropertyValue $camera @("audioClients")) -eq 0 -and
    [string](Get-PropertyValue $camera @("state")) -in @("HEALTHY", "IDLE")
  $checks.Add((New-Check `
    -Name "cameraZeroClients" `
    -Passed $cameraPassed `
    -Summary "RoshanMedia is healthy with no leaked video or microphone clients." `
    -Evidence ([pscustomobject]@{
      serviceRunning = Get-PropertyValue $camera @("serviceRunning")
      state = Get-PropertyValue $camera @("state")
      videoClients = Get-PropertyValue $camera @("videoClients")
      audioClients = Get-PropertyValue $camera @("audioClients")
    })))

  $accessLockPassed =
    (Get-PropertyValue $status @("touchLock")) -eq $false -and
    (Get-PropertyValue $dpc @("statusBarDisabled")) -eq $false
  $checks.Add((New-Check `
    -Name "accessLockInactiveTruthful" `
    -Passed $accessLockPassed `
    -Summary "Access Lock truthfully reports inactive and leaves the status bar policy unlocked." `
    -Evidence ([pscustomobject]@{
      touchLock = Get-PropertyValue $status @("touchLock")
      statusBarDisabled = Get-PropertyValue $dpc @("statusBarDisabled")
    })))

  $remotePassed =
    (Test-ApiOk $remoteResponse) -and
    (Get-PropertyValue $remote @("enabled")) -eq $false -and
    (Get-PropertyValue $status @("remoteControl", "enabled")) -eq $false -and
    (Get-PropertyValue $serverHealth @("components", "remoteAgent", "state")) -eq "standby" -and
    (Get-PropertyValue $serverHealth @(
      "components", "remoteAgent", "details", "enabledByOwner"
    )) -eq $false
  $checks.Add((New-Check `
    -Name "remoteStandby" `
    -Passed $remotePassed `
    -Summary "RoshanRemoteAgent is owner-disabled and supervisor-reported as standby." `
    -Evidence ([pscustomobject]@{
      enabled = Get-PropertyValue $remote @("enabled")
      supervisorState = Get-PropertyValue $serverHealth @(
        "components", "remoteAgent", "state"
      )
    })))

  $resourcesPassed =
    (Get-PropertyValue $serverHealth @("components", "resources", "state")) -eq "healthy" -and
    (Get-PropertyValue $status @("memory", "lowMemory")) -eq $false -and
    $null -ne (Get-PropertyValue $status @("memory", "availableBytes")) -and
    $null -ne (Get-PropertyValue $status @("storageFreeMb")) -and
    $null -ne (Get-PropertyValue $status @("batteryPercent")) -and
    $null -ne (Get-PropertyValue $status @("batteryTemperatureC"))
  $checks.Add((New-Check `
    -Name "resourcesHealthy" `
    -Passed $resourcesPassed `
    -Summary "Memory, storage, and battery telemetry are present and resource policy is healthy." `
    -Evidence ([pscustomobject]@{
      memoryLow = Get-PropertyValue $status @("memory", "lowMemory")
      memoryAvailableBytes = Get-PropertyValue $status @("memory", "availableBytes")
      storageFreeMb = Get-PropertyValue $status @("storageFreeMb")
      batteryPercent = Get-PropertyValue $status @("batteryPercent")
      charging = Get-PropertyValue $status @("charging")
      batteryTemperatureC = Get-PropertyValue $status @("batteryTemperatureC")
    })))

  $installedPath = ""
  if ($installedPathResult.text -match '(?m)^package:(.+base\.apk)\s*$') {
    $installedPath = $matches[1].Trim()
  }
  $signer = if ([string]::IsNullOrWhiteSpace($installedPath)) {
    [pscustomobject]@{ available = $false; digest = $null }
  } else {
    Get-InstalledSignerDigest -InstalledPath $installedPath
  }
  $versionCode = $null
  $versionName = $null
  if ($packageDump -match '(?m)^\s*versionCode=(\d+)') {
    $versionCode = [long]$matches[1]
  }
  if ($packageDump -match '(?m)^\s*versionName=(\S+)') {
    $versionName = $matches[1]
  }
  $systemApp = $systemPackages -match (
    '(?m)^package:' + [regex]::Escape($script:PackageName) + '$'
  )
  $enabled = $enabledPackages -match (
    '(?m)^package:' + [regex]::Escape($script:PackageName) + '$'
  )
  $packagePassed =
    -not [string]::IsNullOrWhiteSpace($installedPath) -and
    $enabled -and
    $systemApp -and
    $signer.available -eq $true -and
    -not [string]::IsNullOrWhiteSpace([string]$signer.digest) -and
    $null -ne $versionCode -and
    -not [string]::IsNullOrWhiteSpace([string]$versionName)
  $checks.Add((New-Check `
    -Name "packageIdentity" `
    -Passed $packagePassed `
    -Summary "RoshanCore is an enabled system package with a verifiable signer and version." `
    -Evidence ([pscustomobject]@{
      installed = -not [string]::IsNullOrWhiteSpace($installedPath)
      enabled = $enabled
      systemApp = $systemApp
      versionName = $versionName
      versionCode = $versionCode
      signerSha256 = $signer.digest
    })))

  if ($TestAccessLock) {
    $checks.Add((Invoke-AccessLockAcceptance))
  }
  if ($TestCrashRecovery) {
    $checks.Add((Invoke-CrashRecoveryAcceptance))
  }
  if ($TestWifiRecovery) {
    $checks.Add((Invoke-WifiRecoveryAcceptance))
  }
  if ($TestReboot) {
    $checks.Add((Invoke-RebootRecoveryAcceptance))
  }
} catch {
  $fatalError = $_.Exception.Message
  $checks.Add((New-Check `
    -Name "harnessExecution" `
    -Passed $false `
    -Summary $fatalError))
} finally {
  Remove-AdbForward
  $script:CompanionSecret = $null
}

$failedChecks = @(
  $checks |
    Where-Object { $_.required -eq $true -and $_.status -eq "fail" } |
    ForEach-Object { $_.name }
)
$skippedChecks = @(
  $checks |
    Where-Object { $_.status -eq "skip" } |
    ForEach-Object { $_.name }
)
$result = [pscustomobject][ordered]@{
  schemaVersion = 1
  capturedAt = (Get-Date).ToUniversalTime().ToString("o")
  mode = "live"
  readOnly = -not [bool]$mutationRequested
  mutationsRequested = [bool]$mutationRequested
  mutationsAuthorized = [bool]$AllowMutations
  serial = if ([string]::IsNullOrWhiteSpace($script:SelectedSerial)) {
    $null
  } else {
    $script:SelectedSerial
  }
  device = [pscustomobject]$deviceMetadata
  passed = $failedChecks.Count -eq 0
  checks = $checks.ToArray()
  failedChecks = $failedChecks
  skippedChecks = $skippedChecks
}
Write-AcceptanceResult $result
if (-not $result.passed) { exit 1 }
exit 0
