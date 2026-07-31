Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = Split-Path $PSScriptRoot -Parent
$pidFile = Join-Path $root ".local\run\controller.pid"

$port = 3001
$envFile = Join-Path $root ".env.local"
if (Test-Path -LiteralPath $envFile) {
  foreach ($line in Get-Content -LiteralPath $envFile) {
    if ($line -match '^\s*CONTROLLER_PORT\s*=\s*(\d+)\s*$') { $port = [int]$matches[1] }
  }
}
$listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
  $process = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
  if ($process -ne $null -and $process.Name -match "node") {
    Write-Host "Stopping controller (PID $($listener.OwningProcess))..."
    Stop-Process -Id $listener.OwningProcess -ErrorAction Stop
    if (-not $process.WaitForExit(10000)) {
      Stop-Process -Id $listener.OwningProcess -Force -ErrorAction SilentlyContinue
    }
  }
}
Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
Write-Host "Controller stopped."
