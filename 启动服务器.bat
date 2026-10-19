@echo off
chcp 65001 >nul
title TMH-谁是队友扑克游戏 · 服务器启动器
cd /d "%~dp0"

echo.
echo   ============================================
echo    TMH-谁是队友扑克游戏 · 服务器
echo   ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   [X] 未检测到 Node.js
  echo.
  echo   请先安装 Node.js 18 或更高版本： https://nodejs.org
  echo   安装完成后重新双击本文件即可。
  echo.
  pause
  exit /b 1
)

echo   [1/3] 正在启动服务器（端口 8080）...
start "TMH-谁是队友 · 服务器（关闭本窗口即停止）" cmd /c "node server\index.js & echo. & echo 服务器已退出，按任意键关闭窗口。 & pause"

echo   [2/3] 等待服务就绪...
set /a _try=0
:wait
timeout /t 1 >nul
set /a _try+=1
curl -s -o nul --max-time 2 http://127.0.0.1:8080/api/status >nul 2>nul
if not errorlevel 1 goto ready
if %_try% lss 8 goto wait

:ready
echo   [3/3] 打开游戏页面...
start "" http://127.0.0.1:8080/

echo.
echo   本机游戏：  http://127.0.0.1:8080/
echo   管理控制台：http://127.0.0.1:8080/admin
echo   局域网里的手机 / 其他电脑：用「启动服务器」窗口里打印的 192.168.x.x 地址
echo.
echo   服务器正在另一个窗口运行，关闭那个窗口即停止服务。
echo   本窗口可以直接关掉。
echo.
pause
