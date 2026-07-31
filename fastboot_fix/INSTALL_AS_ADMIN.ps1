# INSTALL_AS_ADMIN.ps1
# Run in ELEVATED PowerShell: right-click PowerShell -> Run as Administrator
#
# ROOT CAUSE:
#   fastboot.exe uses AdbWinApi.dll -> SetupDiGetClassDevs({F72FE0D4...}).
#   The libwdi installer set DeviceInterfaceGUIDs = {1340F924...} -> wrong GUID -> device invisible.
#
# FIX:
#   Write the correct GUID directly to Device Parameters.
#   BUILTIN\Administrators has FullControl on this key (confirmed by ACL read).
#   Requires elevation (High Integrity token); our session at Medium Integrity was blocked by UAC split-token.
#   No driver installation, no Test Signing mode, no WDK tools required.

$devParams   = "HKLM:\SYSTEM\CurrentControlSet\Enum\USB\VID_0E8D&PID_201C\HNP06KSC\Device Parameters"
$deviceId    = "USB\VID_0E8D&PID_201C\HNP06KSC"
$wrongGuid   = "{1340F924-2874-4E1E-938D-5AE391575915}"
$correctGuid = "{F72FE0D4-CBCB-407D-8814-9ED673D0DD6B}"
$fastbootExe = "C:\platform-tools\platform-tools\fastboot.exe"

# ── elevation check ───────────────────────────────────────────────────────────
$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "ERROR: Not elevated. Right-click PowerShell -> Run as Administrator." -ForegroundColor Red
    Read-Host "Press Enter to exit"; exit 1
}
Write-Host "Elevation: OK (High Integrity token)" -ForegroundColor Green

# ── confirm device is present ─────────────────────────────────────────────────
Write-Host ""
Write-Host "=== Step 1: Confirming device and current GUID ===" -ForegroundColor Cyan
$current = (Get-ItemProperty $devParams -ErrorAction SilentlyContinue).DeviceInterfaceGUIDs
if (-not $current) {
    Write-Host "ERROR: Device Parameters key not found." -ForegroundColor Red
    Write-Host "Confirm tablet is in Fastboot mode and USB cable is connected." -ForegroundColor Yellow
    Read-Host "Press Enter to exit"; exit 1
}
Write-Host "Current GUID: $current"
if ($current -like "*F72FE0D4*") {
    Write-Host "GUID is already correct. Running fastboot test..." -ForegroundColor Green
    & $fastbootExe devices
    Read-Host "Press Enter to exit"; exit 0
}
if ($current -notlike "*1340F924*") {
    Write-Host "WARNING: Unexpected GUID ($current). Expected the libwdi GUID." -ForegroundColor Yellow
    Write-Host "Proceeding will overwrite it. Ctrl+C to abort, or Enter to continue."
    Read-Host
}

# ── write correct GUID ────────────────────────────────────────────────────────
Write-Host ""
Write-Host "=== Step 2: Writing correct DeviceInterfaceGUID ===" -ForegroundColor Cyan
Write-Host "Before: $current"
try {
    Set-ItemProperty $devParams -Name "DeviceInterfaceGUIDs" -Value @($correctGuid) -Type MultiString -ErrorAction Stop
    $verify = (Get-ItemProperty $devParams).DeviceInterfaceGUIDs
    Write-Host "After:  $verify" -ForegroundColor Green
    if ($verify -notlike "*F72FE0D4*") {
        Write-Host "ERROR: Write appeared to succeed but value did not change." -ForegroundColor Red
        Read-Host "Press Enter to exit"; exit 1
    }
} catch {
    Write-Host "ERROR writing registry: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "This should not happen from an elevated session. ACL verified as Administrators=FullControl."
    Read-Host "Press Enter to exit"; exit 1
}

# ── cycle device so WinUSB re-reads the GUID and re-registers under {F72FE0D4} ──
Write-Host ""
Write-Host "=== Step 3: Cycling device (disable -> enable) ===" -ForegroundColor Cyan
Write-Host "WinUSB will re-register under the new GUID on enable."
pnputil /disable-device $deviceId 2>&1 | ForEach-Object { Write-Host "  $_" }
Start-Sleep -Seconds 2
pnputil /enable-device  $deviceId 2>&1 | ForEach-Object { Write-Host "  $_" }
Start-Sleep -Seconds 4

# ── verify DeviceClasses registration ─────────────────────────────────────────
Write-Host ""
Write-Host "=== Step 4: Verifying DeviceClasses registration ===" -ForegroundColor Cyan
$dcRoot = "HKLM:\SYSTEM\CurrentControlSet\Control\DeviceClasses\{F72FE0D4-CBCB-407D-8814-9ED673D0DD6B}"
$entry  = Get-ChildItem $dcRoot -ErrorAction SilentlyContinue | Where-Object { $_.PSChildName -match "0E8D.*201C" }
if ($entry) {
    Write-Host "VID_0E8D&PID_201C registered under {F72FE0D4...}: YES" -ForegroundColor Green
} else {
    Write-Host "Device not yet visible under {F72FE0D4...}" -ForegroundColor Yellow
    Write-Host "Unplug USB cable, wait 5 seconds, replug, then run:" -ForegroundColor Yellow
    Write-Host "  & '$fastbootExe' devices" -ForegroundColor Yellow
}

# ── fastboot test ─────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "=== Step 5: Testing fastboot devices ===" -ForegroundColor Cyan
$result = & $fastbootExe devices 2>&1
if ($result -and ($result -like "*HNP06KSC*")) {
    Write-Host ""
    Write-Host "████████████████████████████████████████" -ForegroundColor Green
    Write-Host "  SUCCESS: $result" -ForegroundColor Green
    Write-Host "████████████████████████████████████████" -ForegroundColor Green
} elseif ($result) {
    Write-Host "fastboot output: $result"
    Write-Host "If serial is present but different, check the output above."
} else {
    Write-Host "fastboot devices: no output" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "If device cycle did not re-register under new GUID:" -ForegroundColor Yellow
    Write-Host "  1. Unplug USB, wait 5 sec, replug"
    Write-Host "  2. Run: & '$fastbootExe' devices"
    Write-Host "  3. Or check DeviceClasses manually:"
    Write-Host "     Get-ChildItem 'HKLM:\SYSTEM\CurrentControlSet\Control\DeviceClasses\{F72FE0D4-CBCB-407D-8814-9ED673D0DD6B}'"
}

Write-Host ""
Read-Host "Press Enter to exit"
