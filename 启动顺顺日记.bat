@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo   顺顺日记正在启动...
echo   浏览器会自动打开，也可以手动访问 http://localhost:5173
echo.
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:5173'"
node --env-file-if-exists=.env server.mjs
pause
