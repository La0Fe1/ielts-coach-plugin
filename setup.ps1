# IELTS Speaking Coach - Windows bootstrap
# Usage: powershell -ExecutionPolicy Bypass -File setup.ps1
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSCommandPath)

Write-Host '== 1/4 创建虚拟环境 ==' -ForegroundColor Cyan
if (-not (Test-Path '.venv')) { python -m venv .venv }
$py = Join-Path (Get-Location) '.venv\Scripts\python.exe'

Write-Host '== 2/4 安装依赖（首次较慢，含语音模型库） ==' -ForegroundColor Cyan
& $py -m pip install -U pip --quiet
& $py -m pip install -e '.[models,phase2]' --quiet

Write-Host '== 3/4 检查 espeak-ng（发音评分的音素转换需要） ==' -ForegroundColor Cyan
$espeak = Get-Command espeak-ng -ErrorAction SilentlyContinue
if (-not $espeak) {
  Write-Host '  未检测到 espeak-ng。Windows 请安装后重试: https://github.com/espeak-ng/espeak-ng/releases' -ForegroundColor Yellow
}

Write-Host '== 4/4 注册到各开发工具 ==' -ForegroundColor Cyan
& $py scripts\install.py

Write-Host ''
Write-Host '安装完成。' -ForegroundColor Green
Write-Host '  打开桌面窗口:  .venv\Scripts\python.exe -m desktop.app'
Write-Host '  在你的 AI 工具里说: 开始练雅思 Part 1'
