@echo off
rem ===========================================================================
rem  连接我的AI工具 - 一键把雅思口语教练 MCP 接进本机 AI 工具
rem  双击本文件即可（Windows）。也可以带参数运行，例如：
rem    "连接我的AI工具.bat" --dry-run
rem    "连接我的AI工具.bat" --url https://你的域名/mcp --token 你的token
rem ===========================================================================
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   没有检测到 Node.js，请先安装 Node.js LTS（20 以上）：https://nodejs.org/zh-cn
  echo.
  pause
  exit /b 1
)

if not exist "%~dp0scripts\connect-agent.mjs" (
  echo.
  echo   找不到 scripts\connect-agent.mjs，请确认项目文件完整。
  echo.
  pause
  exit /b 1
)

node "%~dp0scripts\connect-agent.mjs" %*
set "RC=%errorlevel%"

if "%~1"=="" (
  echo.
  echo 按任意键关闭窗口。
  pause >nul
)
exit /b %RC%
