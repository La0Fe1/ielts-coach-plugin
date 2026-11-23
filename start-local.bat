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
echo.
echo 网页练习： http://localhost:3000
echo MCP 端点： http://localhost:3000/mcp   （豆包 / dsh / Codex 等 AI 工具接入用）
echo AI 定制课：先在另一个窗口双击 连接我的AI工具.bat 接入，再让 AI 开课（链接形如 /?lesson=xxx）
echo 关闭这个窗口即停止服务。
start "" http://localhost:3000
call npm start
pause
