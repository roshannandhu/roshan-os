Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = Split-Path $PSScriptRoot -Parent
$start = Join-Path $PSScriptRoot "start-controller.ps1"
$stop = Join-Path $PSScriptRoot "stop-controller.ps1"
$status = Join-Path $PSScriptRoot "controller-status.ps1"

& $start
& $status

# A second start must discover the existing healthy listener rather than creating a duplicate.
& $start
& $status

$envFile = Join-Path $root ".env.local"
$port = 3001
if (Test-Path -LiteralPath $envFile) {
  foreach ($line in Get-Content -LiteralPath $envFile) {
    if ($line -match '^\s*CONTROLLER_PORT\s*=\s*(\d+)\s*$') { $port = [int]$matches[1] }
  }
}
$health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/v1/health" -Method Get -TimeoutSec 5
if ($health.ok -ne $true) { throw "Controller health endpoint did not report success." }

Write-Host "Controller lifecycle self-test passed. The controller remains running."
