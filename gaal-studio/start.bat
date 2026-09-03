@echo off
chcp 65001 >nul
title gaal-studio
cd /d "%~dp0"

echo ==========================================
echo  gaal-studio 启动中...
echo  面板地址: http://127.0.0.1:7788
echo  按 Ctrl+C 或关闭本窗口即可停止服务
echo ==========================================
echo.

REM 服务启动成功后由 server.js 自动打开浏览器（设 GAAL_STUDIO_NO_OPEN=1 可关闭）
node server.js

echo.
echo 服务已停止。
pause
