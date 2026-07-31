# Re-establish ADB port forwards after tablet reboot.
# Run this once after the tablet boots and ADB reconnects.
$adb = "C:\Users\Roshan Raj\AppData\Local\Android\Sdk\platform-tools\adb.exe"

Write-Host "Waiting for device..."
& $adb wait-for-device

Write-Host "Device ready. Setting up port forwards..."
& $adb forward tcp:8080 tcp:8080   # IP Webcam
& $adb forward tcp:2323 tcp:2323   # Fully Kiosk Remote Admin
& $adb forward tcp:8765 tcp:8765   # Companion Agent

Write-Host "Port forwards active:"
& $adb forward --list
