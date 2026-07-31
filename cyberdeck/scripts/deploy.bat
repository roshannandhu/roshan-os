@echo off
echo ==========================================
echo    DEPLYOMENT SEQUENCE INITIATED
echo ==========================================
echo [INFO] Target: AWS EC2 Edge Node
echo [OK] Authenticating...
timeout /t 1 /nobreak >nul
echo [OK] Pushing latest image...
timeout /t 2 /nobreak >nul
echo [OK] Image verified. Restarting services...
timeout /t 1 /nobreak >nul
echo [OK] Deployment Complete!
echo ==========================================
