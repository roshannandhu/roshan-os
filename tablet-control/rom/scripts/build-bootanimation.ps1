param(
  [string]$ChromePath = "C:\Program Files\Google\Chrome\Application\chrome.exe",
  [string]$SourceSvg = "",
  [string]$OutputZip = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-Crc32 {
  param([byte[]]$Bytes)
  [uint32]$crc = [uint32]::MaxValue
  foreach ($value in $Bytes) {
    $crc = $crc -bxor [uint32]$value
    for ($bit = 0; $bit -lt 8; $bit++) {
      if (($crc -band 1) -ne 0) {
        $crc = ($crc -shr 1) -bxor [uint32]3988292384
      } else {
        $crc = $crc -shr 1
      }
    }
  }
  return [uint32]($crc -bxor [uint32]::MaxValue)
}

function Write-StoredZip {
  param(
    [string]$Path,
    [System.Collections.IDictionary]$Entries
  )
  $stream = [IO.File]::Open(
    $Path,
    [IO.FileMode]::CreateNew,
    [IO.FileAccess]::ReadWrite,
    [IO.FileShare]::None
  )
  $writer = [IO.BinaryWriter]::new($stream, [Text.Encoding]::UTF8, $true)
  try {
    $centralRecords = @()
    foreach ($item in $Entries.GetEnumerator()) {
      $nameBytes = [Text.Encoding]::UTF8.GetBytes([string]$item.Key)
      [byte[]]$data = $item.Value
      [uint32]$crc = Get-Crc32 -Bytes $data
      [uint32]$size = $data.Length
      [uint32]$localOffset = $stream.Position

      $writer.Write([uint32]0x04034b50)
      $writer.Write([uint16]20)
      $writer.Write([uint16]0)
      $writer.Write([uint16]0)
      $writer.Write([uint16]0)
      $writer.Write([uint16]0x2821)
      $writer.Write($crc)
      $writer.Write($size)
      $writer.Write($size)
      $writer.Write([uint16]$nameBytes.Length)
      $writer.Write([uint16]0)
      $writer.Write($nameBytes)
      $writer.Write($data)

      $centralRecords += [pscustomobject]@{
        NameBytes = $nameBytes
        Data = $data
        Crc = $crc
        Size = $size
        LocalOffset = $localOffset
      }
    }

    [uint32]$centralOffset = $stream.Position
    foreach ($record in $centralRecords) {
      $writer.Write([uint32]0x02014b50)
      $writer.Write([uint16]20)
      $writer.Write([uint16]20)
      $writer.Write([uint16]0)
      $writer.Write([uint16]0)
      $writer.Write([uint16]0)
      $writer.Write([uint16]0x2821)
      $writer.Write([uint32]$record.Crc)
      $writer.Write([uint32]$record.Size)
      $writer.Write([uint32]$record.Size)
      $writer.Write([uint16]$record.NameBytes.Length)
      $writer.Write([uint16]0)
      $writer.Write([uint16]0)
      $writer.Write([uint16]0)
      $writer.Write([uint16]0)
      $writer.Write([uint32]0)
      $writer.Write([uint32]$record.LocalOffset)
      $writer.Write([byte[]]$record.NameBytes)
    }
    [uint32]$centralSize = $stream.Position - $centralOffset

    $writer.Write([uint32]0x06054b50)
    $writer.Write([uint16]0)
    $writer.Write([uint16]0)
    $writer.Write([uint16]$centralRecords.Count)
    $writer.Write([uint16]$centralRecords.Count)
    $writer.Write($centralSize)
    $writer.Write($centralOffset)
    $writer.Write([uint16]0)
    $writer.Flush()
  } finally {
    $writer.Dispose()
    $stream.Dispose()
  }
}

$repositoryRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
if ([string]::IsNullOrWhiteSpace($SourceSvg)) {
  $SourceSvg = Join-Path $repositoryRoot "rom\branding\roshanos-boot.svg"
}
if ([string]::IsNullOrWhiteSpace($OutputZip)) {
  $OutputZip = Join-Path $repositoryRoot "rom\staging\system\media\bootanimation.zip"
}

$sourcePath = (Resolve-Path -LiteralPath $SourceSvg).Path
if (-not (Test-Path -LiteralPath $ChromePath -PathType Leaf)) {
  throw "Chrome is required to render the deterministic boot frame: $ChromePath"
}

$runRoot = Join-Path $repositoryRoot ".local\run"
if (-not (Test-Path -LiteralPath $runRoot)) {
  New-Item -ItemType Directory -Path $runRoot | Out-Null
}
$workDirectory = Join-Path $runRoot ("bootanimation-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $workDirectory | Out-Null

try {
  $framePath = Join-Path $workDirectory "00000.png"
  $svgUri = ([Uri]$sourcePath).AbsoluteUri
  $chromeArguments = @(
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    "--window-size=800,1280",
    "--screenshot=`"$framePath`"",
    $svgUri
  )
  $render = Start-Process -FilePath $ChromePath -ArgumentList $chromeArguments `
    -Wait -PassThru -WindowStyle Hidden
  if ($render.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $framePath)) {
    throw "Chrome failed to render the RoshanOS boot frame."
  }

  $png = [IO.File]::ReadAllBytes($framePath)
  if ($png.Length -lt 33 -or
      $png[0] -ne 0x89 -or $png[1] -ne 0x50 -or
      $png[2] -ne 0x4e -or $png[3] -ne 0x47) {
    throw "Rendered boot frame is not a valid PNG."
  }
  $width = [Net.IPAddress]::NetworkToHostOrder(
    [BitConverter]::ToInt32($png, 16)
  )
  $height = [Net.IPAddress]::NetworkToHostOrder(
    [BitConverter]::ToInt32($png, 20)
  )
  if ($width -ne 800 -or $height -ne 1280) {
    throw "Rendered boot frame must be exactly 800x1280; got ${width}x${height}."
  }

  $outputParent = Split-Path $OutputZip -Parent
  if (-not (Test-Path -LiteralPath $outputParent)) {
    New-Item -ItemType Directory -Path $outputParent | Out-Null
  }
  $outputPath = [IO.Path]::GetFullPath($OutputZip)
  $temporaryZip = Join-Path $workDirectory "bootanimation.zip"

  $entries = [ordered]@{
    "desc.txt" = [Text.Encoding]::UTF8.GetBytes("800 1280 30`np 0 0 part0`n")
    "part0/00000.png" = $png
  }
  Write-StoredZip -Path $temporaryZip -Entries $entries

  [IO.File]::Copy($temporaryZip, $outputPath, $true)
  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $outputPath).Hash
  Write-Output "RoshanOS boot animation built: $outputPath"
  Write-Output "SHA256: $hash"
} finally {
  if (Test-Path -LiteralPath $workDirectory) {
    Remove-Item -LiteralPath $workDirectory -Recurse -Force
  }
}
