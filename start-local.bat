@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   没有检测到 Node.js。
  echo   请先安装 Node.js LTS（https://nodejs.org/zh-cn），装完再双击本文件。
  echo.
  pause
  exit /b 1
)
if not exist node_modules (
  echo 第一次运行，正在安装依赖（约 1-2 分钟）...
  call npm install --no-audit --no-fund
)
if not exist web\dist\index.html (
  echo 正在构建前端...
  call npm run build
)
start "" http://localhost:3000
echo 服务已启动：http://localhost:3000
echo 关闭这个窗口即停止服务。
call npm start
pause
