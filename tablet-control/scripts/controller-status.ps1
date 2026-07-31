Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = Split-Path $PSScriptRoot -Parent
$pidFile = Join-Path $root ".local\run\controller.pid"
$envFile = Join-Path $root ".env.local"

$port = "3001"
$bindHost = "127.0.0.1"

# Basic parsing for status output, not perfect but safe
if (Test-Path $envFile) {
  $envContent = Get-Content $envFile
  foreach ($line in $envContent) {
    if ($line -match '^CONTROLLER_PORT=(.+)$') { $port = $matches[1].Trim() }
    if ($line -match '^CONTROLLER_BIND_HOST=(.+)$') { $bindHost = $matches[1].Trim() }
  }
}

$listener = Get-NetTCPConnection -LocalPort ([int]$port) -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
$pidFromFile = if (Test-Path $pidFile) { (Get-Content $pidFile -Raw).Trim() } else { "" }
if ($listener) {
  $process = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
  $health = $false
  try { $health = (Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/v1/health" -Method Get -TimeoutSec 3 -ErrorAction Stop).ok -eq $true } catch {}
  if ($process -ne $null -and $process.Name -match "node" -and $health) {
    $listener.OwningProcess | Out-File $pidFile -Encoding ascii -Force
    Write-Host "Status: RUNNING"
    Write-Host "PID: $($listener.OwningProcess)"
    Write-Host "URL: http://${bindHost}:${port}/"
    exit 0
  }
  Write-Host "Status: PORT_CONFLICT"
  exit 2
}
if ($pidFromFile) {
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
  Write-Host "Status: STOPPED (stale pid file removed)"
  exit 1
}
Write-Host "Status: STOPPED"
exit 0
