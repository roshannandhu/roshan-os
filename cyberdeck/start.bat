@echo off
echo =========================================
echo    ROSHAN CYBERDECK M8 - INITIALIZING
echo =========================================

echo [1/4] Starting CYBERDECK Server (Background)...
start /b python app.py

echo [2/4] Waiting for server to initialize...
timeout /t 3 /nobreak >nul

echo [3/4] Bridging USB connection (adb reverse)...
C:\platform-tools\platform-tools\adb.exe reverse tcp:8080 tcp:8080

echo [4/4] Launching Dashboard on Tablet...
C:\platform-tools\platform-tools\adb.exe shell am start -a android.intent.action.VIEW -d "http://127.0.0.1:8080"

echo.
echo =========================================
echo    SYSTEM ONLINE. PRESS ANY KEY TO EXIT.
echo =========================================
pause >nul
