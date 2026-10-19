@echo off
chcp 65001 >nul
cd /d "%~dp0"
netstat -ano | findstr ":5173" | findstr "LISTENING" >nul
if not errorlevel 1 (
  echo 服务已经在运行：
  echo https://shunshun.tailf49132.ts.net
  pause
  exit /b
)
echo.
echo   正在启动顺顺日记公开版...
echo   固定地址：https://shunshun.tailf49132.ts.net
echo   请保持这个窗口运行；关闭窗口后本地服务会停止。
echo.
node server.mjs --public --trust-proxy
pause
