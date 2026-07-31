[CmdletBinding()]
param(
  [string]$AdbPath = "C:\Users\Roshan Raj\AppData\Local\Android\Sdk\platform-tools\adb.exe",
  [string]$Serial = "",
  [string]$ArtifactDirectory = "",
  [string]$OutputPath = "",
  [ValidateSet("Json", "Object")]
  [string]$OutputFormat = "Json",
  [ValidateRange(2, 30)]
  [int]$RequestTimeoutSeconds = 8,
  [ValidateRange(15, 180)]
  [int]$RestoreTimeoutSeconds = 45,
  [ValidateRange(1, 8)]
  [int]$StreamCaptureSeconds = 4,
  [string]$AppPackage = "",
  [switch]$AllowMutations,
  [switch]$TestBrightness,
  [switch]$TestVolumeAndMute,
  [switch]$TestApprovedAppLifecycle,
  [switch]$TestCamera,
  [switch]$TestMicrophone,
  [switch]$TestRemoteControl,
  [switch]$TestAccessLock,
  [switch]$SelfTest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script:Root = Split-Path $PSScriptRoot -Parent
$script:PackageName = "com.tabletcontrol.companion"
$script:SelectedSerial = ""
$script:LocalPort = 0
$script:CompanionSecret = $null
$script:ArtifactRunDirectory = ""
$script:Artifacts = New-Object System.Collections.Generic.List[object]

# Emergency-restoration state is deliberately held only in this process. Each
# functional check has its own finally block; the outer finally retries any
# state whose first restoration could not be confirmed.
$script:BrightnessTouched = $false
$script:OriginalBrightness = $null
$script:OriginalBrightnessMode = $null
$script:VolumeTouched = $false
$script:OriginalVolume = $null
$script:ApprovalTouched = $false
$script:ApprovalPackage = ""
$script:RemoteTouched = $false
$script:OriginalRemoteEnabled = $null
$script:AccessLockMayBeActive = $false
$script:CameraTouched = $false
$script:OriginalCamera = ""

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

function New-UnprovenCheck {
  param(
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][string]$Summary,
    [AllowNull()][object]$Evidence = $null,
    [bool]$Required = $true
  )

  return [pscustomobject][ordered]@{
    name = $Name
    status = "unproven"
    passed = $null
    required = $Required
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
      "Functional mutations were requested without -AllowMutations. " +
      "No ADB process, credential helper, or tablet endpoint was accessed."
    )
  }
}

function ConvertTo-CompactJson {
  param([Parameter(Mandatory)][object]$Value)
  return $Value | ConvertTo-Json -Compress -Depth 10
}

function Test-ApiSuccess {
  param([AllowNull()][object]$Response)

  if ($null -eq $Response -or $Response.success -ne $true) { return $false }
  if ($null -eq $Response.json) { return $true }
  $okProperty = $Response.json.PSObject.Properties["ok"]
  return $null -eq $okProperty -or $okProperty.Value -eq $true
}

function Get-ApiData {
  param([AllowNull()][object]$Response)

  if (-not (Test-ApiSuccess $Response)) { return $null }
  $dataProperty = $Response.json.PSObject.Properties["data"]
  if ($null -ne $dataProperty) { return $dataProperty.Value }
  return $Response.json
}

function Wait-Until {
  param(
    [Parameter(Mandatory)][scriptblock]$Condition,
    [Parameter(Mandatory)][int]$TimeoutSeconds,
    [ValidateRange(100, 5000)]
    [int]$PollMilliseconds = 500
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    try {
      if (& $Condition) { return $true }
    } catch {
      # A transient poll failure is not a successful observation.
    }
    Start-Sleep -Milliseconds $PollMilliseconds
  } while ((Get-Date) -lt $deadline)
  return $false
}

function Test-JpegBytes {
  param([AllowNull()][byte[]]$Bytes)

  return (
    $null -ne $Bytes -and
    $Bytes.Length -ge 128 -and
    $Bytes[0] -eq 0xff -and
    $Bytes[1] -eq 0xd8 -and
    $Bytes[$Bytes.Length - 2] -eq 0xff -and
    $Bytes[$Bytes.Length - 1] -eq 0xd9
  )
}

function Test-PngBytes {
  param([AllowNull()][byte[]]$Bytes)

  $signature = @(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
  if ($null -eq $Bytes -or $Bytes.Length -lt 64) { return $false }
  for ($index = 0; $index -lt $signature.Count; $index++) {
    if ($Bytes[$index] -ne $signature[$index]) { return $false }
  }
  return $true
}

function Find-JpegFrame {
  param([AllowNull()][byte[]]$Bytes)

  if ($null -eq $Bytes -or $Bytes.Length -lt 4) { return $null }
  $start = -1
  for ($index = 0; $index -lt $Bytes.Length - 1; $index++) {
    if ($Bytes[$index] -eq 0xff -and $Bytes[$index + 1] -eq 0xd8) {
      $start = $index
      break
    }
  }
  if ($start -lt 0) { return $null }
  for ($index = $start + 2; $index -lt $Bytes.Length - 1; $index++) {
    if ($Bytes[$index] -eq 0xff -and $Bytes[$index + 1] -eq 0xd9) {
      $length = $index + 2 - $start
      $frame = New-Object byte[] $length
      [Array]::Copy($Bytes, $start, $frame, 0, $length)
      return $frame
    }
  }
  return $null
}

function Test-WavPcmBytes {
  param([AllowNull()][byte[]]$Bytes)

  $result = [ordered]@{
    valid = $false
    sampleRate = $null
    channels = $null
    bitsPerSample = $null
    pcmBytes = 0
    nonZeroSamples = 0
  }
  if ($null -eq $Bytes -or $Bytes.Length -le 44) {
    return [pscustomobject]$result
  }

  $ascii = [System.Text.Encoding]::ASCII
  if (
    $ascii.GetString($Bytes, 0, 4) -ne "RIFF" -or
    $ascii.GetString($Bytes, 8, 4) -ne "WAVE" -or
    $ascii.GetString($Bytes, 12, 4) -ne "fmt " -or
    $ascii.GetString($Bytes, 36, 4) -ne "data"
  ) {
    return [pscustomobject]$result
  }

  $format = [BitConverter]::ToUInt16($Bytes, 20)
  $channels = [BitConverter]::ToUInt16($Bytes, 22)
  $sampleRate = [BitConverter]::ToUInt32($Bytes, 24)
  $bits = [BitConverter]::ToUInt16($Bytes, 34)
  $pcmBytes = $Bytes.Length - 44
  $nonZero = 0
  for ($index = 44; $index + 1 -lt $Bytes.Length; $index += 2) {
    if ([BitConverter]::ToInt16($Bytes, $index) -ne 0) {
      $nonZero += 1
    }
  }

  $result.valid = (
    $format -eq 1 -and
    $channels -ge 1 -and
    $channels -le 2 -and
    $sampleRate -ge 8000 -and
    $sampleRate -le 96000 -and
    $bits -eq 16 -and
    $pcmBytes -ge 320 -and
    $nonZero -gt 0
  )
  $result.sampleRate = [int]$sampleRate
  $result.channels = [int]$channels
  $result.bitsPerSample = [int]$bits
  $result.pcmBytes = $pcmBytes
  $result.nonZeroSamples = $nonZero
  return [pscustomobject]$result
}

function ConvertFrom-AdbInteger {
  param(
    [AllowEmptyString()][string]$Text,
    [int]$Minimum,
    [int]$Maximum
  )

  $trimmed = $Text.Trim()
  if ($trimmed -notmatch '^-?\d+$') { return $null }
  $value = [int]$trimmed
  if ($value -lt $Minimum -or $value -gt $Maximum) { return $null }
  return $value
}

function ConvertFrom-AdbVolume {
  param([AllowEmptyString()][string]$Text)

  foreach ($pattern in @(
    '(?im)\bvolume\s+is\s+(\d+)\b',
    '(?im)\bcurrent(?:\s+volume)?\s*[:=]\s*(\d+)\b',
    '(?im)\bSTREAM_MUSIC\b[\s\S]{0,1600}?\bCurrent:\s*[^\r\n]*?:\s*(\d+)\b'
  )) {
    if ($Text -match $pattern) {
      $value = [int]$matches[1]
      if ($value -in 0..15) { return $value }
    }
  }
  return $null
}

function ConvertFrom-AdbForegroundPackage {
  param([AllowEmptyString()][string]$Text)

  foreach ($pattern in @(
    '(?im)\btopResumedActivity=.*?\su\d+\s+([A-Za-z][A-Za-z0-9_.]*)/',
    '(?im)\bmResumedActivity:\s+ActivityRecord\{.*?\su\d+\s+([A-Za-z][A-Za-z0-9_.]*)/',
    '(?im)\bmCurrentFocus=.*?\su\d+\s+([A-Za-z][A-Za-z0-9_.]*)/'
  )) {
    if ($Text -match $pattern) { return $matches[1] }
  }
  return $null
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
    "com.android.launcher3",
    "me.phh.treble.app",
    "com.android.systemui",
    "com.android.settings",
    "com.android.shell"
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
    throw "An allowlisted ADB observation or input command failed."
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
  $responseText = $null
  try {
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $responseText = $request |
      & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $helperPath 2>$null
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = $previousPreference
    if ($exitCode -ne 0 -or [string]::IsNullOrWhiteSpace(($responseText -join ""))) {
      throw "The protected companion credential could not be read."
    }

    $response = ($responseText -join "") | ConvertFrom-Json
    $value = [string](Get-PropertyValue $response @("value"))
    if (
      (Get-PropertyValue $response @("ok")) -ne $true -or
      [string]::IsNullOrWhiteSpace($value) -or
      $value.Length -lt 43 -or
      $value.Length -gt 256 -or
      $value -notmatch '^[A-Za-z0-9_-]+$'
    ) {
      throw "The protected companion credential response was invalid."
    }
    return $value
  } catch {
    throw "The protected companion credential could not be loaded."
  } finally {
    $request = $null
    $responseText = $null
  }
}

function New-AdbForward {
  if ($script:LocalPort -gt 0) {
    Invoke-Adb -Arguments @(
      "forward", "--remove", "tcp:$($script:LocalPort)"
    ) -AllowFailure | Out-Null
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
  Invoke-Adb -Arguments @(
    "forward", "--remove", "tcp:$($script:LocalPort)"
  ) -AllowFailure | Out-Null
  $script:LocalPort = 0
}

function Invoke-HttpJson {
  param(
    [Parameter(Mandatory)][string]$Path,
    [ValidateSet("GET", "POST")][string]$Method = "GET",
    [AllowNull()][string]$Body = $null
  )

  $request = $null
  $response = $null
  $requestStream = $null
  $reader = $null
  try {
    $uri = "http://127.0.0.1:$($script:LocalPort)$Path"
    $request = [System.Net.HttpWebRequest]::Create($uri)
    $request.Method = $Method
    $request.Proxy = $null
    $request.AllowAutoRedirect = $false
    $request.Timeout = $RequestTimeoutSeconds * 1000
    $request.ReadWriteTimeout = $RequestTimeoutSeconds * 1000
    $request.Accept = "application/json"
    $request.UserAgent = "RoshanOS-Functional-Acceptance/1"
    $request.Headers["Authorization"] = "Bearer $($script:CompanionSecret)"
    if ($Method -eq "POST") {
      $payload = if ($null -eq $Body) { "{}" } else { $Body }
      $bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
      $request.ContentType = "application/json"
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
      contentType = [string]$response.ContentType
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
      } catch {
        # Error response details are intentionally not emitted.
      }
      $errorResponse.Dispose()
    }
    return [pscustomobject]@{
      success = $false
      statusCode = $statusCode
      contentType = $null
      json = $parsed
      failureKind = [string]$webError.Status
    }
  } catch {
    return [pscustomobject]@{
      success = $false
      statusCode = 0
      contentType = $null
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

function Invoke-HttpBytes {
  param(
    [Parameter(Mandatory)][string]$Path,
    [ValidateSet("GET", "POST")][string]$Method = "GET",
    [ValidateRange(64, 16777216)]
    [int]$MaximumBytes,
    [ValidateRange(1, 15)]
    [int]$CaptureSeconds,
    [ValidateRange(0, 16777216)]
    [int]$MinimumBytes = 1
  )

  $request = $null
  $response = $null
  $stream = $null
  $output = $null
  try {
    $uri = "http://127.0.0.1:$($script:LocalPort)$Path"
    $request = [System.Net.HttpWebRequest]::Create($uri)
    $request.Method = $Method
    $request.Proxy = $null
    $request.AllowAutoRedirect = $false
    $request.Timeout = $RequestTimeoutSeconds * 1000
    $request.ReadWriteTimeout = 2000
    $request.Accept = "*/*"
    $request.UserAgent = "RoshanOS-Functional-Acceptance/1"
    $request.Headers["Authorization"] = "Bearer $($script:CompanionSecret)"
    if ($Method -eq "POST") {
      $request.ContentLength = 0
    }

    $response = [System.Net.HttpWebResponse]$request.GetResponse()
    if ([int]$response.StatusCode -lt 200 -or [int]$response.StatusCode -ge 300) {
      return [pscustomobject]@{
        success = $false
        statusCode = [int]$response.StatusCode
        contentType = [string]$response.ContentType
        bytes = $null
        bounded = $true
        failureKind = "HttpStatus"
      }
    }

    $stream = $response.GetResponseStream()
    $output = New-Object System.IO.MemoryStream
    $buffer = New-Object byte[] 16384
    $deadline = (Get-Date).AddSeconds($CaptureSeconds)
    $bounded = $false
    while ((Get-Date) -lt $deadline -and $output.Length -lt $MaximumBytes) {
      $remaining = $MaximumBytes - [int]$output.Length
      $readLength = [Math]::Min($buffer.Length, $remaining)
      try {
        $count = $stream.Read($buffer, 0, $readLength)
      } catch [System.IO.IOException] {
        break
      } catch [System.Net.WebException] {
        break
      }
      if ($count -le 0) { break }
      $output.Write($buffer, 0, $count)
      if ($output.Length -ge $MaximumBytes) {
        $bounded = $true
        break
      }
    }
    if ((Get-Date) -ge $deadline) { $bounded = $true }
    $captured = $output.ToArray()
    return [pscustomobject]@{
      success = $captured.Length -ge $MinimumBytes
      statusCode = [int]$response.StatusCode
      contentType = [string]$response.ContentType
      bytes = $captured
      bounded = $bounded
      failureKind = if ($captured.Length -ge $MinimumBytes) { $null } else { "TooShort" }
    }
  } catch [System.Net.WebException] {
    $statusCode = 0
    if ($null -ne $_.Exception.Response) {
      $statusCode = [int]([System.Net.HttpWebResponse]$_.Exception.Response).StatusCode
      $_.Exception.Response.Dispose()
    }
    return [pscustomobject]@{
      success = $false
      statusCode = $statusCode
      contentType = $null
      bytes = $null
      bounded = $true
      failureKind = [string]$_.Exception.Status
    }
  } catch {
    return [pscustomobject]@{
      success = $false
      statusCode = 0
      contentType = $null
      bytes = $null
      bounded = $true
      failureKind = "ClientError"
    }
  } finally {
    if ($null -ne $stream) { $stream.Dispose() }
    if ($null -ne $response) { $response.Dispose() }
    if ($null -ne $request) { $request.Abort() }
    if ($null -ne $output) { $output.Dispose() }
  }
}

function Get-CompanionStatus {
  return Get-ApiData (Invoke-HttpJson -Path "/api/v1/companion/status")
}

function Get-CameraStatus {
  return Get-ApiData (Invoke-HttpJson -Path "/api/v1/companion/camera/status")
}

function Get-CameraHealth {
  return Get-ApiData (Invoke-HttpJson -Path "/api/v1/companion/camera/health")
}

function Get-AdbBrightness {
  $result = Invoke-Adb -Arguments @(
    "shell", "settings", "get", "system", "screen_brightness"
  ) -AllowFailure
  if ($result.exitCode -ne 0) { return $null }
  return ConvertFrom-AdbInteger -Text $result.text -Minimum 0 -Maximum 255
}

function Get-AdbBrightnessMode {
  $result = Invoke-Adb -Arguments @(
    "shell", "settings", "get", "system", "screen_brightness_mode"
  ) -AllowFailure
  if ($result.exitCode -ne 0) { return $null }
  $value = ConvertFrom-AdbInteger -Text $result.text -Minimum 0 -Maximum 1
  if ($null -eq $value) { return $null }
  return if ($value -eq 1) { "automatic" } else { "manual" }
}

function Get-AdbVolume {
  $result = Invoke-Adb -Arguments @(
    "shell", "cmd", "media_session", "volume", "--stream", "3", "--get"
  ) -AllowFailure
  if ($result.exitCode -eq 0) {
    $parsed = ConvertFrom-AdbVolume -Text $result.text
    if ($null -ne $parsed) { return $parsed }
  }
  $fallback = Invoke-Adb -Arguments @("shell", "dumpsys", "audio") -AllowFailure
  if ($fallback.exitCode -ne 0) { return $null }
  return ConvertFrom-AdbVolume -Text $fallback.text
}

function Get-AdbForegroundPackage {
  $activity = Invoke-Adb -Arguments @(
    "shell", "dumpsys", "activity", "activities"
  ) -AllowFailure
  if ($activity.exitCode -eq 0) {
    $parsed = ConvertFrom-AdbForegroundPackage -Text $activity.text
    if (-not [string]::IsNullOrWhiteSpace([string]$parsed)) { return $parsed }
  }
  $windows = Invoke-Adb -Arguments @(
    "shell", "dumpsys", "window", "windows"
  ) -AllowFailure
  if ($windows.exitCode -ne 0) { return $null }
  return ConvertFrom-AdbForegroundPackage -Text $windows.text
}

function Get-AdbWindowFocusPackage {
  $windows = Invoke-Adb -Arguments @(
    "shell", "dumpsys", "window", "windows"
  ) -AllowFailure
  if ($windows.exitCode -ne 0) { return $null }
  if (
    $windows.text -match
      '(?im)\bmCurrentFocus=.*?\su\d+\s+([A-Za-z][A-Za-z0-9_.]*)/'
  ) {
    return $matches[1]
  }
  return $null
}

function Get-UiHierarchyText {
  $dump = Invoke-Adb -Arguments @(
    "shell", "uiautomator", "dump", "/dev/tty"
  ) -AllowFailure
  if ($dump.exitCode -ne 0) { return "" }
  $start = $dump.text.IndexOf("<?xml")
  if ($start -lt 0) { return "" }
  $closingTag = "</hierarchy>"
  $end = $dump.text.IndexOf($closingTag, $start)
  if ($end -lt 0) { return "" }
  return $dump.text.Substring(
    $start,
    $end + $closingTag.Length - $start
  )
}

function Test-UiContainsText {
  param(
    [AllowEmptyString()][string]$Hierarchy,
    [Parameter(Mandatory)][string]$Expected
  )

  if ([string]::IsNullOrWhiteSpace($Hierarchy)) { return $false }
  try {
    [xml]$document = $Hierarchy
    foreach ($node in $document.SelectNodes("//*[@text or @content-desc]")) {
      if (
        [string]$node.GetAttribute("text") -eq $Expected -or
        [string]$node.GetAttribute("content-desc") -eq $Expected
      ) {
        return $true
      }
    }
  } catch {
    return $false
  }
  return $false
}

function New-OwnerOnlyAcl {
  $currentIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $acl.SetOwner([System.Security.Principal.NTAccount]$currentIdentity)
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    $currentIdentity,
    [System.Security.AccessControl.FileSystemRights]::FullControl,
    [System.Security.AccessControl.InheritanceFlags]"ContainerInherit, ObjectInherit",
    [System.Security.AccessControl.PropagationFlags]::None,
    [System.Security.AccessControl.AccessControlType]::Allow
  )
  $acl.SetAccessRuleProtection($true, $false)
  $acl.AddAccessRule($rule)
  return $acl
}

function Initialize-ArtifactDirectory {
  if (-not [string]::IsNullOrWhiteSpace($script:ArtifactRunDirectory)) {
    return $script:ArtifactRunDirectory
  }

  $base = if ([string]::IsNullOrWhiteSpace($ArtifactDirectory)) {
    Join-Path $script:Root ".local\functional-acceptance"
  } else {
    [System.IO.Path]::GetFullPath($ArtifactDirectory)
  }
  [System.IO.Directory]::CreateDirectory($base) | Out-Null
  $runTimestamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
  $runSuffix = [Guid]::NewGuid().ToString("N").Substring(0, 8)
  $runName = "run-{0}-{1}-{2}" -f $runTimestamp, $PID, $runSuffix
  $runDirectory = Join-Path $base $runName
  [System.IO.Directory]::CreateDirectory($runDirectory) | Out-Null
  Set-Acl -LiteralPath $runDirectory -AclObject (New-OwnerOnlyAcl)
  $script:ArtifactRunDirectory = $runDirectory
  return $runDirectory
}

function Save-EvidenceArtifact {
  param(
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][byte[]]$Bytes,
    [Parameter(Mandatory)][string]$MediaType
  )

  if ($Name -notmatch '^[A-Za-z0-9._-]+$') {
    throw "Artifact name is invalid."
  }
  $directory = Initialize-ArtifactDirectory
  $path = Join-Path $directory $Name
  if (Test-Path -LiteralPath $path) {
    throw "Artifact collision detected."
  }
  [System.IO.File]::WriteAllBytes($path, $Bytes)
  $hash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
  $artifact = [pscustomobject][ordered]@{
    name = $Name
    path = $path
    mediaType = $MediaType
    bytes = $Bytes.Length
    sha256 = $hash
  }
  $script:Artifacts.Add($artifact)
  return $artifact
}

function Restore-Brightness {
  if (
    -not $script:BrightnessTouched -or
    $null -eq $script:OriginalBrightness -or
    [string]::IsNullOrWhiteSpace([string]$script:OriginalBrightnessMode)
  ) {
    return $true
  }

  $manual = Invoke-HttpJson `
    -Path "/api/v1/companion/brightness/mode" `
    -Method POST `
    -Body '{"mode":"manual"}'
  $value = Invoke-HttpJson `
    -Path "/api/v1/companion/brightness" `
    -Method POST `
    -Body (ConvertTo-CompactJson @{
      value = [int]$script:OriginalBrightness
    })
  $mode = Invoke-HttpJson `
    -Path "/api/v1/companion/brightness/mode" `
    -Method POST `
    -Body (ConvertTo-CompactJson @{
      mode = [string]$script:OriginalBrightnessMode
    })
  if (
    -not (Test-ApiSuccess $manual) -or
    -not (Test-ApiSuccess $value) -or
    -not (Test-ApiSuccess $mode)
  ) {
    return $false
  }

  $restored = Wait-Until -TimeoutSeconds $RestoreTimeoutSeconds -Condition {
    $status = Get-CompanionStatus
    $apiMode = [string](Get-PropertyValue $status @("brightnessMode"))
    $adbMode = Get-AdbBrightnessMode
    if (
      $apiMode -ne [string]$script:OriginalBrightnessMode -or
      $adbMode -ne [string]$script:OriginalBrightnessMode
    ) {
      return $false
    }
    if ([string]$script:OriginalBrightnessMode -eq "automatic") {
      return $true
    }
    return (
      [int](Get-PropertyValue $status @("brightness")) -eq
        [int]$script:OriginalBrightness -and
      (Get-AdbBrightness) -eq [int]$script:OriginalBrightness
    )
  }
  if ($restored) { $script:BrightnessTouched = $false }
  return $restored
}

function Restore-Volume {
  if (-not $script:VolumeTouched -or $null -eq $script:OriginalVolume) {
    return $true
  }

  $response = Invoke-HttpJson `
    -Path "/api/v1/companion/volume" `
    -Method POST `
    -Body (ConvertTo-CompactJson @{
      value = [int]$script:OriginalVolume
    })
  if (-not (Test-ApiSuccess $response)) { return $false }
  $restored = Wait-Until -TimeoutSeconds $RestoreTimeoutSeconds -Condition {
    $status = Get-CompanionStatus
    return (
      [int](Get-PropertyValue $status @("mediaVolume")) -eq
        [int]$script:OriginalVolume -and
      (Get-AdbVolume) -eq [int]$script:OriginalVolume
    )
  }
  if ($restored) { $script:VolumeTouched = $false }
  return $restored
}

function Restore-AppApproval {
  if (
    -not $script:ApprovalTouched -or
    [string]::IsNullOrWhiteSpace($script:ApprovalPackage)
  ) {
    return $true
  }

  $response = Invoke-HttpJson `
    -Path "/api/v1/companion/apps/revoke" `
    -Method POST `
    -Body (ConvertTo-CompactJson @{
      packageName = $script:ApprovalPackage
    })
  Invoke-Adb -Arguments @(
    "shell", "input", "keyevent", "KEYCODE_HOME"
  ) -AllowFailure | Out-Null
  if (-not (Test-ApiSuccess $response)) { return $false }
  $restored = Wait-Until -TimeoutSeconds $RestoreTimeoutSeconds -Condition {
    $apps = @(Get-ApiData (
      Invoke-HttpJson -Path "/api/v1/companion/apps"
    ))
    $candidate = @(
      $apps | Where-Object {
        [string](Get-PropertyValue $_ @("packageName")) -eq
          $script:ApprovalPackage
      }
    ) | Select-Object -First 1
    return (
      $null -ne $candidate -and
      [string](Get-PropertyValue $candidate @("status")) -eq "discovered"
    )
  }
  if ($restored) {
    $script:ApprovalTouched = $false
    $script:ApprovalPackage = ""
  }
  return $restored
}

function Restore-RemoteControl {
  if (-not $script:RemoteTouched -or $null -eq $script:OriginalRemoteEnabled) {
    return $true
  }
  $response = Invoke-HttpJson `
    -Path "/api/v1/companion/remote/enabled" `
    -Method POST `
    -Body (ConvertTo-CompactJson @{
      enabled = [bool]$script:OriginalRemoteEnabled
    })
  if (-not (Test-ApiSuccess $response)) { return $false }
  $restored = Wait-Until -TimeoutSeconds $RestoreTimeoutSeconds -Condition {
    $status = Get-ApiData (
      Invoke-HttpJson -Path "/api/v1/companion/remote/status"
    )
    return (
      (Get-PropertyValue $status @("enabled")) -eq
        [bool]$script:OriginalRemoteEnabled
    )
  }
  if ($restored) { $script:RemoteTouched = $false }
  return $restored
}

function Restore-AccessLock {
  if (-not $script:AccessLockMayBeActive) { return $true }
  $restored = $false
  for ($attempt = 1; $attempt -le 3 -and -not $restored; $attempt++) {
    $response = Invoke-HttpJson `
      -Path "/api/v1/companion/touch_lock" `
      -Method POST `
      -Body '{"on":false}'
    if (Test-ApiSuccess $response) {
      $restored = Wait-Until -TimeoutSeconds 10 -Condition {
        $status = Get-CompanionStatus
        $dpc = Get-ApiData (
          Invoke-HttpJson -Path "/api/v1/companion/dpc/status"
        )
        return (
          (Get-PropertyValue $status @("touchLock")) -eq $false -and
          (Get-PropertyValue $dpc @("statusBarDisabled")) -eq $false
        )
      }
    }
  }
  Invoke-Adb -Arguments @(
    "shell", "cmd", "statusbar", "collapse"
  ) -AllowFailure | Out-Null
  Invoke-Adb -Arguments @(
    "shell", "input", "keyevent", "KEYCODE_HOME"
  ) -AllowFailure | Out-Null
  if ($restored) { $script:AccessLockMayBeActive = $false }
  return $restored
}

function Restore-CameraSelection {
  if (
    -not $script:CameraTouched -or
    $script:OriginalCamera -notin @("front", "rear")
  ) {
    return $true
  }
  $response = Invoke-HttpJson `
    -Path "/api/v1/companion/camera/select" `
    -Method POST `
    -Body (ConvertTo-CompactJson @{
      camera = $script:OriginalCamera
    })
  if (-not (Test-ApiSuccess $response)) { return $false }
  $restored = Wait-Until -TimeoutSeconds $RestoreTimeoutSeconds -Condition {
    $status = Get-CameraStatus
    return (
      [string](Get-PropertyValue $status @("activeCamera")) -eq
        $script:OriginalCamera
    )
  }
  if ($restored) { $script:CameraTouched = $false }
  return $restored
}

function Invoke-EmergencyRestoration {
  $result = [ordered]@{}
  try { $result["accessLock"] = Restore-AccessLock } catch { $result["accessLock"] = $false }
  try { $result["remoteControl"] = Restore-RemoteControl } catch { $result["remoteControl"] = $false }
  try { $result["appApproval"] = Restore-AppApproval } catch { $result["appApproval"] = $false }
  try { $result["volume"] = Restore-Volume } catch { $result["volume"] = $false }
  try { $result["brightness"] = Restore-Brightness } catch { $result["brightness"] = $false }
  try { $result["camera"] = Restore-CameraSelection } catch { $result["camera"] = $false }
  return [pscustomobject]$result
}

function Invoke-BrightnessAcceptance {
  $changed = $false
  $restored = $false
  $target = $null
  $apiObserved = $false
  $adbObserved = $false
  $errorKind = $null
  try {
    $status = Get-CompanionStatus
    $apiBrightness = Get-PropertyValue $status @("brightness")
    $apiMode = [string](Get-PropertyValue $status @("brightnessMode"))
    $adbBrightness = Get-AdbBrightness
    $adbMode = Get-AdbBrightnessMode
    if (
      $null -eq $apiBrightness -or
      $null -eq $adbBrightness -or
      $apiMode -notin @("manual", "automatic") -or
      $adbMode -notin @("manual", "automatic")
    ) {
      return New-UnprovenCheck `
        -Name "brightness.changeAndRestore" `
        -Summary "Brightness telemetry was incomplete, so no brightness mutation was attempted." `
        -Evidence ([pscustomobject]@{
          apiAvailable = $null -ne $apiBrightness
          adbAvailable = $null -ne $adbBrightness
          modesAvailable = (
            $apiMode -in @("manual", "automatic") -and
            $adbMode -in @("manual", "automatic")
          )
        })
    }
    if (
      $apiMode -ne $adbMode -or
      [int]$apiBrightness -ne [int]$adbBrightness
    ) {
      return New-UnprovenCheck `
        -Name "brightness.changeAndRestore" `
        -Summary "API and ADB disagreed about brightness state, so the harness failed closed." `
        -Evidence ([pscustomobject]@{ apiAdbAgreement = $false })
    }

    $script:OriginalBrightness = [int]$adbBrightness
    $script:OriginalBrightnessMode = $adbMode
    $target = if ([int]$adbBrightness -le 191) {
      [Math]::Min(255, [int]$adbBrightness + 32)
    } else {
      [Math]::Max(16, [int]$adbBrightness - 32)
    }
    if ($target -eq [int]$adbBrightness) {
      $target = if ([int]$adbBrightness -gt 16) { 16 } else { 64 }
    }

    $script:BrightnessTouched = $true
    $manual = Invoke-HttpJson `
      -Path "/api/v1/companion/brightness/mode" `
      -Method POST `
      -Body '{"mode":"manual"}'
    $change = Invoke-HttpJson `
      -Path "/api/v1/companion/brightness" `
      -Method POST `
      -Body (ConvertTo-CompactJson @{ value = $target })
    if (-not (Test-ApiSuccess $manual) -or -not (Test-ApiSuccess $change)) {
      $errorKind = "mutationRejected"
    } else {
      $changed = Wait-Until -TimeoutSeconds 15 -Condition {
        $live = Get-CompanionStatus
        $apiMatch = (
          [int](Get-PropertyValue $live @("brightness")) -eq $target -and
          [string](Get-PropertyValue $live @("brightnessMode")) -eq "manual"
        )
        $adbMatch = (
          (Get-AdbBrightness) -eq $target -and
          (Get-AdbBrightnessMode) -eq "manual"
        )
        return $apiMatch -and $adbMatch
      }
      if ($changed) {
        $apiObserved = $true
        $adbObserved = $true
      }
    }
  } catch {
    $errorKind = "harnessError"
  } finally {
    try { $restored = Restore-Brightness } catch { $restored = $false }
  }

  return New-Check `
    -Name "brightness.changeAndRestore" `
    -Passed ($changed -and $restored) `
    -Summary "Brightness changed through RoshanCore, matched API and ADB, and was restored." `
    -Evidence ([pscustomobject]@{
      target = $target
      apiObserved = $apiObserved
      adbObserved = $adbObserved
      restored = $restored
      errorKind = $errorKind
    })
}

function Invoke-VolumeAcceptance {
  $targetObserved = $false
  $mutedObserved = $false
  $unmutedObserved = $false
  $restored = $false
  $target = $null
  $errorKind = $null
  try {
    $status = Get-CompanionStatus
    $apiVolume = Get-PropertyValue $status @("mediaVolume")
    $maxVolume = Get-PropertyValue $status @("mediaVolumeMax")
    $adbVolume = Get-AdbVolume
    if (
      $null -eq $apiVolume -or
      $null -eq $maxVolume -or
      $null -eq $adbVolume -or
      [int]$maxVolume -lt 1 -or
      [int]$maxVolume -gt 15
    ) {
      return New-UnprovenCheck `
        -Name "volume.muteRestore" `
        -Summary "Volume telemetry was incomplete, so no audio setting was changed."
    }
    if ([int]$apiVolume -ne [int]$adbVolume) {
      return New-UnprovenCheck `
        -Name "volume.muteRestore" `
        -Summary "API and ADB disagreed about the media volume, so the harness failed closed." `
        -Evidence ([pscustomobject]@{ apiAdbAgreement = $false })
    }

    $script:OriginalVolume = [int]$adbVolume
    $target = if ([int]$adbVolume -eq 0) {
      [Math]::Min(5, [int]$maxVolume)
    } elseif ([int]$adbVolume -lt [int]$maxVolume) {
      [int]$adbVolume + 1
    } else {
      [Math]::Max(1, [int]$adbVolume - 1)
    }
    $script:VolumeTouched = $true

    $set = Invoke-HttpJson `
      -Path "/api/v1/companion/volume" `
      -Method POST `
      -Body (ConvertTo-CompactJson @{ value = $target })
    if (Test-ApiSuccess $set) {
      $targetObserved = Wait-Until -TimeoutSeconds 10 -Condition {
        $live = Get-CompanionStatus
        return (
          [int](Get-PropertyValue $live @("mediaVolume")) -eq $target -and
          (Get-AdbVolume) -eq $target
        )
      }
    }

    $mute = Invoke-HttpJson `
      -Path "/api/v1/companion/mute" `
      -Method POST `
      -Body '{"muted":true}'
    if (Test-ApiSuccess $mute) {
      $mutedObserved = Wait-Until -TimeoutSeconds 10 -Condition {
        $live = Get-CompanionStatus
        return (
          [int](Get-PropertyValue $live @("mediaVolume")) -eq 0 -and
          (Get-AdbVolume) -eq 0
        )
      }
    }

    $unmute = Invoke-HttpJson `
      -Path "/api/v1/companion/mute" `
      -Method POST `
      -Body '{"muted":false}'
    if (Test-ApiSuccess $unmute) {
      $unmutedObserved = Wait-Until -TimeoutSeconds 10 -Condition {
        $live = Get-CompanionStatus
        return (
          [int](Get-PropertyValue $live @("mediaVolume")) -eq $target -and
          (Get-AdbVolume) -eq $target
        )
      }
    }
  } catch {
    $errorKind = "harnessError"
  } finally {
    try { $restored = Restore-Volume } catch { $restored = $false }
  }

  return New-Check `
    -Name "volume.muteRestore" `
    -Passed (
      $targetObserved -and
      $mutedObserved -and
      $unmutedObserved -and
      $restored
    ) `
    -Summary "Media volume changed, muted, unmuted, and returned to its exact original level." `
    -Evidence ([pscustomobject]@{
      target = $target
      targetObserved = $targetObserved
      mutedObserved = $mutedObserved
      unmutedObserved = $unmutedObserved
      restored = $restored
      errorKind = $errorKind
    })
}

function Invoke-AppLifecycleAcceptance {
  $approvedObserved = $false
  $gridObserved = $false
  $foregroundApiObserved = $false
  $foregroundAdbObserved = $false
  $restored = $false
  $selectedPackage = $null
  $selectedLabel = $null
  $errorKind = $null
  try {
    $apps = @(Get-ApiData (
      Invoke-HttpJson -Path "/api/v1/companion/apps"
    ))
    $candidates = @(
      $apps | Where-Object {
        [string](Get-PropertyValue $_ @("status")) -eq "discovered" -and
        -not (Test-TechnicalPackage -Package (
          [string](Get-PropertyValue $_ @("packageName"))
        ))
      }
    )
    if (-not [string]::IsNullOrWhiteSpace($AppPackage)) {
      $candidates = @(
        $candidates | Where-Object {
          [string](Get-PropertyValue $_ @("packageName")) -eq $AppPackage
        }
      )
    }
    $candidate = $candidates | Sort-Object {
      [string](Get-PropertyValue $_ @("packageName"))
    } | Select-Object -First 1
    if ($null -eq $candidate) {
      return New-UnprovenCheck `
        -Name "apps.approveLaunchRevoke" `
        -Summary "No discovered ordinary launchable app matched the test; approval state was not changed." `
        -Evidence ([pscustomobject]@{
          requestedPackageSpecified = -not [string]::IsNullOrWhiteSpace($AppPackage)
        })
    }

    $selectedPackage = [string](Get-PropertyValue $candidate @("packageName"))
    $selectedLabel = [string](Get-PropertyValue $candidate @("label"))
    $selectedId = [string](Get-PropertyValue $candidate @("id"))
    if (
      [string]::IsNullOrWhiteSpace($selectedPackage) -or
      [string]::IsNullOrWhiteSpace($selectedLabel) -or
      [string]::IsNullOrWhiteSpace($selectedId) -or
      (Test-TechnicalPackage -Package $selectedPackage)
    ) {
      return New-UnprovenCheck `
        -Name "apps.approveLaunchRevoke" `
        -Summary "The discovered app record was incomplete or technical; no approval mutation was attempted."
    }

    $script:ApprovalPackage = $selectedPackage
    $script:ApprovalTouched = $true
    $approve = Invoke-HttpJson `
      -Path "/api/v1/companion/apps/approve" `
      -Method POST `
      -Body (ConvertTo-CompactJson @{ packageName = $selectedPackage })
    if (-not (Test-ApiSuccess $approve)) {
      $errorKind = "approvalRejected"
    } else {
      $approvedObserved = Wait-Until -TimeoutSeconds 10 -Condition {
        $liveApps = @(Get-ApiData (
          Invoke-HttpJson -Path "/api/v1/companion/apps"
        ))
        return @(
          $liveApps | Where-Object {
            [string](Get-PropertyValue $_ @("packageName")) -eq
              $selectedPackage -and
            [string](Get-PropertyValue $_ @("status")) -eq "approved"
          }
        ).Count -eq 1
      }

      Invoke-Adb -Arguments @(
        "shell", "input", "keyevent", "KEYCODE_HOME"
      ) -AllowFailure | Out-Null
      $gridObserved = Wait-Until -TimeoutSeconds 15 -Condition {
        $hierarchy = Get-UiHierarchyText
        return Test-UiContainsText `
          -Hierarchy $hierarchy `
          -Expected $selectedLabel
      }

      $launch = Invoke-HttpJson `
        -Path "/api/v1/companion/apps/launch" `
        -Method POST `
        -Body (ConvertTo-CompactJson @{ appId = $selectedPackage })
      if (Test-ApiSuccess $launch) {
        $foregroundApiObserved = Wait-Until -TimeoutSeconds 15 -Condition {
          $live = Get-CompanionStatus
          return (
            [string](Get-PropertyValue $live @(
              "foregroundApp", "packageName"
            )) -eq $selectedPackage -and
            [string](Get-PropertyValue $live @(
              "foregroundApp", "state"
            )) -eq "approved"
          )
        }
        $foregroundAdbObserved = (
          (Get-AdbForegroundPackage) -eq $selectedPackage
        )
      }
    }
  } catch {
    $errorKind = "harnessError"
  } finally {
    try { $restored = Restore-AppApproval } catch { $restored = $false }
  }

  return New-Check `
    -Name "apps.approveLaunchRevoke" `
    -Passed (
      $approvedObserved -and
      $gridObserved -and
      $foregroundApiObserved -and
      $foregroundAdbObserved -and
      $restored
    ) `
    -Summary "A discovered ordinary app was approved, shown in Home, launched, and revoked back to discovered." `
    -Evidence ([pscustomobject]@{
      packageName = $selectedPackage
      label = $selectedLabel
      approvedObserved = $approvedObserved
      gridObserved = $gridObserved
      foregroundApiObserved = $foregroundApiObserved
      foregroundAdbObserved = $foregroundAdbObserved
      revokedAndHomeRestored = $restored
      errorKind = $errorKind
    })
}

function Invoke-CameraAcceptance {
  $lensResults = New-Object System.Collections.Generic.List[object]
  $videoFrameValid = $false
  $clientReleased = $false
  $cameraIdle = $false
  $restored = $false
  $errorKind = $null
  try {
    $initial = Get-CameraStatus
    $script:OriginalCamera = [string](Get-PropertyValue $initial @("activeCamera"))
    if ($script:OriginalCamera -notin @("front", "rear")) {
      return New-UnprovenCheck `
        -Name "camera.frontRearAndIdleRelease" `
        -Summary "RoshanMedia did not report a restorable initial lens; no camera selection was changed."
    }
    $script:CameraTouched = $true

    foreach ($lens in @("front", "rear")) {
      $selected = $false
      $snapshotValid = $false
      $artifact = $null
      $select = Invoke-HttpJson `
        -Path "/api/v1/companion/camera/select" `
        -Method POST `
        -Body (ConvertTo-CompactJson @{ camera = $lens })
      if (Test-ApiSuccess $select) {
        $selected = Wait-Until -TimeoutSeconds 15 -Condition {
          $status = Get-CameraStatus
          return (
            [string](Get-PropertyValue $status @("activeCamera")) -eq $lens
          )
        }
        if ($selected) {
          $snapshot = Invoke-HttpBytes `
            -Path "/api/v1/companion/camera/snapshot" `
            -MaximumBytes 1048576 `
            -CaptureSeconds ([Math]::Max(2, $StreamCaptureSeconds)) `
            -MinimumBytes 128
          $snapshotValid = (
            $snapshot.success -eq $true -and
            [string]$snapshot.contentType -match '^image/jpeg' -and
            (Test-JpegBytes -Bytes $snapshot.bytes)
          )
          if ($snapshotValid) {
            $artifact = Save-EvidenceArtifact `
              -Name "camera-$lens.jpg" `
              -Bytes $snapshot.bytes `
              -MediaType "image/jpeg"
          }
        }
      }
      $lensResults.Add([pscustomobject]@{
        lens = $lens
        selected = $selected
        jpegValid = $snapshotValid
        artifact = if ($null -eq $artifact) { $null } else { $artifact.name }
      })
    }

    $video = Invoke-HttpBytes `
      -Path "/api/v1/companion/camera/video" `
      -MaximumBytes 1048576 `
      -CaptureSeconds $StreamCaptureSeconds `
      -MinimumBytes 128
    $videoFrame = Find-JpegFrame -Bytes $video.bytes
    $videoFrameValid = (
      $video.success -eq $true -and
      [string]$video.contentType -match 'multipart/x-mixed-replace|image/' -and
      (Test-JpegBytes -Bytes $videoFrame)
    )

    $clientReleased = Wait-Until -TimeoutSeconds 15 -Condition {
      $health = Get-CameraHealth
      $status = Get-CameraStatus
      return (
        [int](Get-PropertyValue $health @("videoClients")) -eq 0 -and
        [int](Get-PropertyValue $status @("streamClients")) -eq 0
      )
    }
    $cameraIdle = Wait-Until -TimeoutSeconds 20 -Condition {
      $status = Get-CameraStatus
      return (
        [int](Get-PropertyValue $status @("streamClients")) -eq 0 -and
        [int](Get-PropertyValue $status @("audioClients")) -eq 0 -and
        (Get-PropertyValue $status @("cameraBound")) -eq $false -and
        [string](Get-PropertyValue $status @("state")) -eq "idle"
      )
    }
  } catch {
    $errorKind = "harnessError"
  } finally {
    try { $restored = Restore-CameraSelection } catch { $restored = $false }
  }

  $bothLenses = (
    $lensResults.Count -eq 2 -and
    @($lensResults | Where-Object {
      $_.selected -eq $true -and $_.jpegValid -eq $true
    }).Count -eq 2
  )
  return New-Check `
    -Name "camera.frontRearAndIdleRelease" `
    -Passed (
      $bothLenses -and
      $videoFrameValid -and
      $clientReleased -and
      $cameraIdle -and
      $restored
    ) `
    -Summary "Front and rear lenses produced valid JPEGs; a bounded video client released and the camera returned idle." `
    -Evidence ([pscustomobject]@{
      lenses = $lensResults.ToArray()
      videoFrameValid = $videoFrameValid
      videoClientReleased = $clientReleased
      cameraResourceIdle = $cameraIdle
      originalLensRestored = $restored
      errorKind = $errorKind
    })
}

function Invoke-MicrophoneAcceptance {
  $wav = $null
  $artifact = $null
  $clientReleased = $false
  $errorKind = $null
  try {
    $audio = Invoke-HttpBytes `
      -Path "/api/v1/companion/camera/audio" `
      -MaximumBytes 196608 `
      -CaptureSeconds $StreamCaptureSeconds `
      -MinimumBytes 1024
    $wav = Test-WavPcmBytes -Bytes $audio.bytes
    if (
      $audio.success -eq $true -and
      [string]$audio.contentType -match '^audio/' -and
      $wav.valid -eq $true
    ) {
      $artifact = Save-EvidenceArtifact `
        -Name "microphone-capture.wav" `
        -Bytes $audio.bytes `
        -MediaType "audio/wav"
    }
  } catch {
    $errorKind = "harnessError"
  } finally {
    try {
      $clientReleased = Wait-Until -TimeoutSeconds 15 -Condition {
        $health = Get-CameraHealth
        $status = Get-CameraStatus
        return (
          [int](Get-PropertyValue $health @("audioClients")) -eq 0 -and
          [int](Get-PropertyValue $status @("audioClients")) -eq 0
        )
      }
    } catch {
      $clientReleased = $false
    }
  }

  $valid = (
    $null -ne $wav -and
    $wav.valid -eq $true -and
    $null -ne $artifact -and
    $clientReleased
  )
  return New-Check `
    -Name "microphone.boundedPcmAndRelease" `
    -Passed $valid `
    -Summary "A bounded WAV contained non-zero PCM and the microphone client released." `
    -Evidence ([pscustomobject]@{
      wavValid = if ($null -eq $wav) { $false } else { $wav.valid }
      sampleRate = if ($null -eq $wav) { $null } else { $wav.sampleRate }
      pcmBytes = if ($null -eq $wav) { 0 } else { $wav.pcmBytes }
      nonZeroSamples = if ($null -eq $wav) { 0 } else { $wav.nonZeroSamples }
      artifact = if ($null -eq $artifact) { $null } else { $artifact.name }
      clientReleased = $clientReleased
      errorKind = $errorKind
    })
}

function Invoke-RemoteAcceptance {
  $screenshotValid = $false
  $tapAccepted = $false
  $swipeAccepted = $false
  $keyAccepted = $false
  $auditObserved = $false
  $restored = $false
  $artifact = $null
  $errorKind = $null
  try {
    $initial = Get-ApiData (
      Invoke-HttpJson -Path "/api/v1/companion/remote/status"
    )
    $enabled = Get-PropertyValue $initial @("enabled")
    $width = Get-PropertyValue $initial @("screenWidth")
    $height = Get-PropertyValue $initial @("screenHeight")
    if (
      $null -eq $enabled -or
      $null -eq $width -or
      $null -eq $height -or
      [int]$width -lt 2 -or
      [int]$height -lt 2
    ) {
      return New-UnprovenCheck `
        -Name "remote.typedActionsAndAudit" `
        -Summary "RoshanRemoteAgent status lacked a restorable enabled state or valid display bounds."
    }
    $script:OriginalRemoteEnabled = [bool]$enabled
    $script:RemoteTouched = $true
    if (-not [bool]$enabled) {
      $enable = Invoke-HttpJson `
        -Path "/api/v1/companion/remote/enabled" `
        -Method POST `
        -Body '{"enabled":true}'
      if (-not (Test-ApiSuccess $enable)) {
        $errorKind = "enableRejected"
        return New-Check `
          -Name "remote.typedActionsAndAudit" `
          -Passed $false `
          -Summary "RoshanRemoteAgent could not be enabled for the explicit functional test."
      }
    }

    $auditBefore = @(Get-ApiData (
      Invoke-HttpJson -Path "/api/v1/companion/remote/audit"
    ))
    $baselineAuditTimestamp = @(
      $auditBefore | ForEach-Object {
        [long](Get-PropertyValue $_ @("timestamp"))
      }
    ) | Measure-Object -Maximum | Select-Object -ExpandProperty Maximum
    if ($null -eq $baselineAuditTimestamp) { $baselineAuditTimestamp = 0L }

    $screenshot = Invoke-HttpBytes `
      -Path "/api/v1/companion/remote/screenshot" `
      -Method POST `
      -MaximumBytes 16777216 `
      -CaptureSeconds ([Math]::Max(2, $StreamCaptureSeconds)) `
      -MinimumBytes 64
    $screenshotValid = (
      $screenshot.success -eq $true -and
      [string]$screenshot.contentType -match '^image/png' -and
      (Test-PngBytes -Bytes $screenshot.bytes)
    )
    if ($screenshotValid) {
      $artifact = Save-EvidenceArtifact `
        -Name "remote-screen.png" `
        -Bytes $screenshot.bytes `
        -MediaType "image/png"
    }

    $x = [Math]::Max(0, [int]$width - 2)
    $middleY = [Math]::Max(0, [Math]::Floor([int]$height / 2))
    $endY = [Math]::Min([int]$height - 1, $middleY + 2)
    $tap = Invoke-HttpJson `
      -Path "/api/v1/companion/remote/tap" `
      -Method POST `
      -Body (ConvertTo-CompactJson @{ x = $x; y = $middleY })
    $tapAccepted = Test-ApiSuccess $tap
    $swipe = Invoke-HttpJson `
      -Path "/api/v1/companion/remote/swipe" `
      -Method POST `
      -Body (ConvertTo-CompactJson @{
        startX = $x
        startY = $middleY
        endX = $x
        endY = $endY
        durationMs = 50
      })
    $swipeAccepted = Test-ApiSuccess $swipe
    $key = Invoke-HttpJson `
      -Path "/api/v1/companion/remote/key" `
      -Method POST `
      -Body '{"key":"HOME"}'
    $keyAccepted = Test-ApiSuccess $key

    $auditObserved = Wait-Until -TimeoutSeconds 10 -Condition {
      $audit = @(Get-ApiData (
        Invoke-HttpJson -Path "/api/v1/companion/remote/audit"
      ))
      $newEvents = @(
        $audit | Where-Object {
          [long](Get-PropertyValue $_ @("timestamp")) -ge
            [long]$baselineAuditTimestamp
        }
      )
      $actions = @(
        $newEvents | Where-Object {
          (Get-PropertyValue $_ @("success")) -eq $true
        } | ForEach-Object {
          [string](Get-PropertyValue $_ @("action"))
        }
      )
      return (
        "screenshot" -in $actions -and
        "tap" -in $actions -and
        "swipe" -in $actions -and
        "key-home" -in $actions
      )
    }
  } catch {
    $errorKind = "harnessError"
  } finally {
    try { $restored = Restore-RemoteControl } catch { $restored = $false }
  }

  return New-Check `
    -Name "remote.typedActionsAndAudit" `
    -Passed (
      $screenshotValid -and
      $tapAccepted -and
      $swipeAccepted -and
      $keyAccepted -and
      $auditObserved -and
      $restored
    ) `
    -Summary "Remote screenshot, bounded tap/swipe, HOME key, and successful audit entries were verified." `
    -Evidence ([pscustomobject]@{
      screenshotValid = $screenshotValid
      screenshotArtifact = if ($null -eq $artifact) { $null } else { $artifact.name }
      tapAccepted = $tapAccepted
      swipeAccepted = $swipeAccepted
      keyAccepted = $keyAccepted
      auditObserved = $auditObserved
      enabledStateRestored = $restored
      errorKind = $errorKind
    })
}

function Invoke-AccessLockAcceptance {
  $activated = $false
  $overlayObserved = $false
  $policyObserved = $false
  $touchBlocked = $false
  $homeBlocked = $false
  $backBlocked = $false
  $recentsBlocked = $false
  $shadeBlocked = $false
  $restored = $false
  $overlayAbsent = $false
  $baselinePackage = $null
  $errorKind = $null
  try {
    Invoke-Adb -Arguments @(
      "shell", "input", "keyevent", "KEYCODE_HOME"
    ) -AllowFailure | Out-Null
    $homeReady = Wait-Until -TimeoutSeconds 15 -Condition {
      return (Get-AdbForegroundPackage) -eq $script:PackageName
    }
    if (-not $homeReady) {
      return New-UnprovenCheck `
        -Name "accessLock.inputAndFailOpenRestore" `
        -Summary "RoshanOS Home was not the foreground baseline, so Access Lock input mutation was not attempted."
    }
    $baselinePackage = Get-AdbForegroundPackage

    $script:AccessLockMayBeActive = $true
    $enable = Invoke-HttpJson `
      -Path "/api/v1/companion/touch_lock" `
      -Method POST `
      -Body '{"on":true}'
    if (Test-ApiSuccess $enable) {
      $activated = Wait-Until -TimeoutSeconds 15 -Condition {
        $status = Get-CompanionStatus
        return (Get-PropertyValue $status @("touchLock")) -eq $true
      }
    }
    if ($activated) {
      $hierarchy = Get-UiHierarchyText
      $overlayObserved = Test-UiContainsText `
        -Hierarchy $hierarchy `
        -Expected "Access Lock"
      $dpc = Get-ApiData (
        Invoke-HttpJson -Path "/api/v1/companion/dpc/status"
      )
      $policyObserved = (
        (Get-PropertyValue $dpc @("deviceOwner")) -eq $true -and
        (Get-PropertyValue $dpc @("statusBarDisabled")) -eq $true
      )

      $status = Get-ApiData (
        Invoke-HttpJson -Path "/api/v1/companion/remote/status"
      )
      $width = [int](Get-PropertyValue $status @("screenWidth"))
      $height = [int](Get-PropertyValue $status @("screenHeight"))
      $touchX = [Math]::Max(1, [Math]::Floor($width / 2))
      $touchY = [Math]::Max(1, [Math]::Floor($height / 2))
      Invoke-Adb -Arguments @(
        "shell", "input", "tap", "$touchX", "$touchY"
      ) -AllowFailure | Out-Null
      Start-Sleep -Milliseconds 750
      $touchBlocked = (
        (Get-AdbForegroundPackage) -eq $baselinePackage -and
        (Get-PropertyValue (Get-CompanionStatus) @("touchLock")) -eq $true
      )

      Invoke-Adb -Arguments @(
        "shell", "input", "keyevent", "KEYCODE_HOME"
      ) -AllowFailure | Out-Null
      Start-Sleep -Milliseconds 750
      $homeBlocked = (
        (Get-AdbForegroundPackage) -eq $baselinePackage -and
        (Get-PropertyValue (Get-CompanionStatus) @("touchLock")) -eq $true
      )

      Invoke-Adb -Arguments @(
        "shell", "input", "keyevent", "KEYCODE_BACK"
      ) -AllowFailure | Out-Null
      Start-Sleep -Milliseconds 750
      $backBlocked = (
        (Get-AdbForegroundPackage) -eq $baselinePackage -and
        (Get-PropertyValue (Get-CompanionStatus) @("touchLock")) -eq $true
      )

      Invoke-Adb -Arguments @(
        "shell", "input", "keyevent", "KEYCODE_APP_SWITCH"
      ) -AllowFailure | Out-Null
      Start-Sleep -Milliseconds 750
      $recentsBlocked = (
        (Get-AdbForegroundPackage) -eq $baselinePackage -and
        (Get-AdbWindowFocusPackage) -ne "com.android.systemui" -and
        (Get-PropertyValue (Get-CompanionStatus) @("touchLock")) -eq $true
      )

      Invoke-Adb -Arguments @(
        "shell", "cmd", "statusbar", "expand-notifications"
      ) -AllowFailure | Out-Null
      Start-Sleep -Milliseconds 750
      $shadeBlocked = (
        (Get-AdbForegroundPackage) -eq $baselinePackage -and
        (Get-AdbWindowFocusPackage) -ne "com.android.systemui" -and
        (Get-PropertyValue (Get-CompanionStatus) @("touchLock")) -eq $true
      )
    }
  } catch {
    $errorKind = "harnessError"
  } finally {
    try { $restored = Restore-AccessLock } catch { $restored = $false }
    if ($restored) {
      try {
        $hierarchyAfter = Get-UiHierarchyText
        $overlayAbsent = -not (
          Test-UiContainsText `
            -Hierarchy $hierarchyAfter `
            -Expected "Access Lock"
        )
      } catch {
        $overlayAbsent = $false
      }
    }
  }

  return New-Check `
    -Name "accessLock.inputAndFailOpenRestore" `
    -Passed (
      $activated -and
      $overlayObserved -and
      $policyObserved -and
      $touchBlocked -and
      $homeBlocked -and
      $backBlocked -and
      $recentsBlocked -and
      $shadeBlocked -and
      $restored -and
      $overlayAbsent
    ) `
    -Summary "Access Lock blocked injected touch/navigation/shade attempts and restored unlocked policy and UI." `
    -Evidence ([pscustomobject]@{
      activated = $activated
      overlayObserved = $overlayObserved
      ownerPolicyObserved = $policyObserved
      touchBlocked = $touchBlocked
      homeBlocked = $homeBlocked
      backBlocked = $backBlocked
      recentsBlocked = $recentsBlocked
      shadeBlocked = $shadeBlocked
      unlockedRestored = $restored
      overlayAbsentAfterRestore = $overlayAbsent
      errorKind = $errorKind
    })
}

function Invoke-OfflineSelfTest {
  $checks = New-Object System.Collections.Generic.List[object]

  $jpeg = New-Object byte[] 128
  $jpeg[0] = 0xff
  $jpeg[1] = 0xd8
  $jpeg[126] = 0xff
  $jpeg[127] = 0xd9
  $checks.Add((New-Check `
    -Name "self.jpegValidator" `
    -Passed (
      (Test-JpegBytes -Bytes $jpeg) -and
      -not (Test-JpegBytes -Bytes ([byte[]]@(0xff, 0xd8, 0x00, 0x00)))
    ) `
    -Summary "JPEG signature validator accepted only a complete bounded fixture."))

  $png = New-Object byte[] 64
  @(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) |
    ForEach-Object -Begin { $index = 0 } -Process {
      $png[$index] = $_
      $index += 1
    }
  $checks.Add((New-Check `
    -Name "self.pngValidator" `
    -Passed (Test-PngBytes -Bytes $png) `
    -Summary "PNG signature validator accepted a complete fixture."))

  $wav = New-Object byte[] 364
  [System.Text.Encoding]::ASCII.GetBytes("RIFF").CopyTo($wav, 0)
  [System.Text.Encoding]::ASCII.GetBytes("WAVEfmt ").CopyTo($wav, 8)
  [BitConverter]::GetBytes([uint32]16).CopyTo($wav, 16)
  [BitConverter]::GetBytes([uint16]1).CopyTo($wav, 20)
  [BitConverter]::GetBytes([uint16]1).CopyTo($wav, 22)
  [BitConverter]::GetBytes([uint32]16000).CopyTo($wav, 24)
  [BitConverter]::GetBytes([uint32]32000).CopyTo($wav, 28)
  [BitConverter]::GetBytes([uint16]2).CopyTo($wav, 32)
  [BitConverter]::GetBytes([uint16]16).CopyTo($wav, 34)
  [System.Text.Encoding]::ASCII.GetBytes("data").CopyTo($wav, 36)
  [BitConverter]::GetBytes([uint32]320).CopyTo($wav, 40)
  [BitConverter]::GetBytes([int16]100).CopyTo($wav, 44)
  $wavResult = Test-WavPcmBytes -Bytes $wav
  $checks.Add((New-Check `
    -Name "self.wavValidator" `
    -Passed (
      $wavResult.valid -eq $true -and
      $wavResult.nonZeroSamples -eq 1
    ) `
    -Summary "WAV validator required PCM format, bounded data, and a non-zero sample."))

  $mjpeg = New-Object byte[] 160
  [Array]::Copy($jpeg, 0, $mjpeg, 16, $jpeg.Length)
  $frame = Find-JpegFrame -Bytes $mjpeg
  $checks.Add((New-Check `
    -Name "self.mjpegParser" `
    -Passed (Test-JpegBytes -Bytes $frame) `
    -Summary "MJPEG parser extracted a complete JPEG frame."))

  $checks.Add((New-Check `
    -Name "self.adbParsers" `
    -Passed (
      (ConvertFrom-AdbInteger -Text "127" -Minimum 0 -Maximum 255) -eq 127 -and
      (ConvertFrom-AdbVolume -Text "volume is 6 in range [0..15]") -eq 6 -and
      (ConvertFrom-AdbForegroundPackage -Text (
        "mResumedActivity: ActivityRecord{1 u0 com.example.notes/.Main t1}"
      )) -eq "com.example.notes"
    ) `
    -Summary "ADB output parsers accepted bounded representative fixtures."))

  $gateRejected = $false
  try {
    Assert-MutationGate -Requested $true -Allowed $false
  } catch {
    $gateRejected = $true
  }
  $checks.Add((New-Check `
    -Name "self.mutationGate" `
    -Passed $gateRejected `
    -Summary "The independent mutation gate rejected an unauthorized request."))

  $failed = @($checks | Where-Object { $_.status -eq "fail" })
  return [pscustomobject][ordered]@{
    schemaVersion = 1
    capturedAt = (Get-Date).ToUniversalTime().ToString("o")
    mode = "offline-self-test"
    readOnly = $true
    tabletTouched = $false
    secretsLoaded = $false
    passed = $failed.Count -eq 0
    checks = $checks.ToArray()
    failedChecks = @($failed | ForEach-Object { $_.name })
  }
}

function Write-Result {
  param([Parameter(Mandatory)][object]$Result)

  if (-not [string]::IsNullOrWhiteSpace($OutputPath)) {
    $fullOutputPath = [System.IO.Path]::GetFullPath($OutputPath)
    $parent = Split-Path $fullOutputPath -Parent
    if (-not [string]::IsNullOrWhiteSpace($parent)) {
      [System.IO.Directory]::CreateDirectory($parent) | Out-Null
    }
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText(
      $fullOutputPath,
      ($Result | ConvertTo-Json -Depth 12),
      $utf8
    )
  }
  if ($OutputFormat -eq "Object") {
    Write-Output $Result
  } else {
    $Result | ConvertTo-Json -Depth 12
  }
}

$requestedTests = [ordered]@{
  brightness = [bool]$TestBrightness
  volumeAndMute = [bool]$TestVolumeAndMute
  approvedAppLifecycle = [bool]$TestApprovedAppLifecycle
  camera = [bool]$TestCamera
  microphone = [bool]$TestMicrophone
  remoteControl = [bool]$TestRemoteControl
  accessLock = [bool]$TestAccessLock
}
$mutationRequested = @(
  $requestedTests.GetEnumerator() | Where-Object { $_.Value -eq $true }
).Count -gt 0

if ($SelfTest) {
  $selfTestResult = Invoke-OfflineSelfTest
  Write-Result $selfTestResult
  if (-not $selfTestResult.passed) { exit 1 }
  exit 0
}

try {
  Assert-MutationGate `
    -Requested $mutationRequested `
    -Allowed ([bool]$AllowMutations)
} catch {
  $guardResult = [pscustomobject][ordered]@{
    schemaVersion = 1
    capturedAt = (Get-Date).ToUniversalTime().ToString("o")
    mode = "functional-live"
    readOnly = $true
    tabletTouched = $false
    secretsLoaded = $false
    mutationsRequested = $mutationRequested
    mutationsAuthorized = $false
    requestedTests = [pscustomobject]$requestedTests
    passed = $false
    checks = @(
      New-Check `
        -Name "mutationAuthorization" `
        -Passed $false `
        -Summary $_.Exception.Message
    )
    failedChecks = @("mutationAuthorization")
    blockingUnprovenChecks = @()
    unprovenChecks = @()
    artifacts = @()
  }
  Write-Result $guardResult
  exit 1
}

if (-not $mutationRequested) {
  $noTestsResult = [pscustomobject][ordered]@{
    schemaVersion = 1
    capturedAt = (Get-Date).ToUniversalTime().ToString("o")
    mode = "functional-live"
    readOnly = $true
    tabletTouched = $false
    secretsLoaded = $false
    mutationsRequested = $false
    mutationsAuthorized = [bool]$AllowMutations
    requestedTests = [pscustomobject]$requestedTests
    passed = $false
    checks = @(
      New-UnprovenCheck `
        -Name "functionalSelection" `
        -Summary "Select at least one individual functional test flag. No tablet access occurred."
    )
    failedChecks = @()
    blockingUnprovenChecks = @("functionalSelection")
    unprovenChecks = @("functionalSelection")
    artifacts = @()
  }
  Write-Result $noTestsResult
  exit 1
}

$checks = New-Object System.Collections.Generic.List[object]
$fatalError = $null
$restoration = $null
$tabletTouched = $false
$secretLoaded = $false
try {
  Select-AdbDevice
  $tabletTouched = $true
  $script:CompanionSecret = Get-ProtectedCompanionSecret
  $secretLoaded = $true
  New-AdbForward

  $health = Invoke-HttpJson -Path "/health"
  if (
    -not (Test-ApiSuccess $health) -or
    (Get-PropertyValue (Get-ApiData $health) @("healthy")) -ne $true
  ) {
    throw "RoshanCore health was not ready through the ADB loopback forward."
  }

  if ($TestBrightness) {
    $checks.Add((Invoke-BrightnessAcceptance))
    $checks.Add((New-UnprovenCheck `
      -Name "brightness.physicalPanelObservation" `
      -Summary "API and ADB prove the setting transition, but a human has not confirmed perceived panel luminance." `
      -Required $false))
  }
  if ($TestVolumeAndMute) {
    $checks.Add((Invoke-VolumeAcceptance))
    $checks.Add((New-UnprovenCheck `
      -Name "volume.physicalAudibility" `
      -Summary "API and ADB prove media-volume state, but a human has not confirmed speaker loudness." `
      -Required $false))
  }
  if ($TestApprovedAppLifecycle) {
    $checks.Add((Invoke-AppLifecycleAcceptance))
  }
  if ($TestCamera) {
    $checks.Add((Invoke-CameraAcceptance))
    $checks.Add((New-UnprovenCheck `
      -Name "camera.sceneIdentity" `
      -Summary "Valid front/rear JPEGs and selected-lens telemetry do not replace a human scene-orientation inspection." `
      -Required $false))
  }
  if ($TestMicrophone) {
    $checks.Add((Invoke-MicrophoneAcceptance))
    $checks.Add((New-UnprovenCheck `
      -Name "microphone.intelligibility" `
      -Summary "Non-zero PCM proves captured signal, but a human has not confirmed speech intelligibility." `
      -Required $false))
  }
  if ($TestRemoteControl) {
    $checks.Add((Invoke-RemoteAcceptance))
    $checks.Add((New-UnprovenCheck `
      -Name "remote.phoneUiObservation" `
      -Summary "The companion transport and audit were verified locally; operation from the physical phone UI remains separate evidence." `
      -Required $false))
  }
  if ($TestAccessLock) {
    $checks.Add((Invoke-AccessLockAcceptance))
    $checks.Add((New-UnprovenCheck `
      -Name "accessLock.physicalButtonsAndCrashFailOpen" `
      -Summary "Injected Android input was checked; physical-button behavior and reboot/process-death fail-open require their dedicated live tests." `
      -Required $false))
  }
} catch {
  $fatalError = $_.Exception.Message
  $checks.Add((New-Check `
    -Name "harnessExecution" `
    -Passed $false `
    -Summary $fatalError))
} finally {
  try {
    $restoration = Invoke-EmergencyRestoration
  } catch {
    $restoration = [pscustomobject]@{ emergencyRestoration = $false }
  }
  Remove-AdbForward
  $script:CompanionSecret = $null
  $secretLoaded = $false
}

$failed = @(
  $checks | Where-Object {
    $_.required -eq $true -and $_.status -eq "fail"
  }
)
$blockingUnproven = @(
  $checks | Where-Object {
    $_.required -eq $true -and $_.status -eq "unproven"
  }
)
$unproven = @($checks | Where-Object { $_.status -eq "unproven" })
$restorationValues = @(
  $restoration.PSObject.Properties | ForEach-Object { [bool]$_.Value }
)
$restorationComplete = (
  $restorationValues.Count -gt 0 -and
  @($restorationValues | Where-Object { $_ -eq $false }).Count -eq 0
)
if (-not $restorationComplete) {
  $failed += @(
    New-Check `
      -Name "emergencyRestoration" `
      -Passed $false `
      -Summary "One or more emergency restoration confirmations failed." `
      -Evidence $restoration
  )
}

$result = [pscustomobject][ordered]@{
  schemaVersion = 1
  capturedAt = (Get-Date).ToUniversalTime().ToString("o")
  mode = "functional-live"
  readOnly = $false
  tabletTouched = $tabletTouched
  secretsLoaded = $secretLoaded
  mutationsRequested = $mutationRequested
  mutationsAuthorized = [bool]$AllowMutations
  requestedTests = [pscustomobject]$requestedTests
  serial = if ([string]::IsNullOrWhiteSpace($script:SelectedSerial)) {
    $null
  } else {
    $script:SelectedSerial
  }
  restorationComplete = $restorationComplete
  restoration = $restoration
  passed = (
    $failed.Count -eq 0 -and
    $blockingUnproven.Count -eq 0 -and
    $restorationComplete
  )
  checks = $checks.ToArray()
  failedChecks = @($failed | ForEach-Object { $_.name } | Select-Object -Unique)
  blockingUnprovenChecks = @(
    $blockingUnproven | ForEach-Object { $_.name } | Select-Object -Unique
  )
  unprovenChecks = @(
    $unproven | ForEach-Object { $_.name } | Select-Object -Unique
  )
  artifacts = $script:Artifacts.ToArray()
}

Write-Result $result
if (-not $result.passed) { exit 1 }
exit 0
