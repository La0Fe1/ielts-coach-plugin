@echo off
rem ===========================================================================
rem  IELTS Speaking Coach - MCP STDIO launcher (Windows)
rem
rem  Spawned by MCP clients: DeepSeek Harness / OpenAI Codex CLI / Cursor /
rem  Claude Code / Doubao. It works from ANY current directory because every
rem  path below is script-relative and absolute (%~dp0 = this file's folder).
rem
rem  HARD RULE: stdout is reserved for JSON-RPC. All diagnostics go to stderr.
rem ===========================================================================
setlocal
chcp 65001 >nul

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

where node >nul 2>nul
if errorlevel 1 (
  >&2 echo [ielts-mcp] ERROR: Node.js not found in PATH.
  >&2 echo [ielts-mcp] Install Node.js 20+ from https://nodejs.org and run this script again.
  exit /b 1
)

if not exist "%ROOT%\node_modules\tsx\dist\cli.mjs" (
  >&2 echo [ielts-mcp] ERROR: dependencies are missing: "%ROOT%\node_modules\tsx\dist\cli.mjs"
  >&2 echo [ielts-mcp] Run "npm install" once inside "%ROOT%" and retry.
  exit /b 1
)

if not defined IELTS_COACH_DATA_DIR (
  if defined USERPROFILE (
    set "IELTS_COACH_DATA_DIR=%USERPROFILE%\.ielts-coach"
  ) else (
    set "IELTS_COACH_DATA_DIR=%HOMEDRIVE%%HOMEPATH%\.ielts-coach"
  )
)

cd /d "%ROOT%"
node "%ROOT%\node_modules\tsx\dist\cli.mjs" "%ROOT%\server\src\mcp-stdio.ts" %*
exit /b %errorlevel%
