Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = Split-Path $PSScriptRoot -Parent
$stopScript = Join-Path $root "scripts\stop-controller.ps1"
$startScript = Join-Path $root "scripts\start-controller.ps1"

& $stopScript
Start-Sleep -Seconds 1
& $startScript
