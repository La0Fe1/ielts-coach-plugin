#!/usr/bin/env bash
# IELTS Speaking Coach - macOS / Linux bootstrap
set -euo pipefail
cd "$(dirname "$0")"

echo '== 1/4 创建虚拟环境 =='
[ -d .venv ] || python3 -m venv .venv
PY=.venv/bin/python

echo '== 2/4 安装依赖（首次较慢） =='
$PY -m pip install -U pip --quiet
$PY -m pip install -e '.[models,phase2]' --quiet

echo '== 3/4 检查 espeak-ng =='
command -v espeak-ng >/dev/null 2>&1 || echo '  未检测到 espeak-ng：macOS 用 brew install espeak-ng；Debian/Ubuntu 用 sudo apt install espeak-ng'

echo '== 4/4 注册到各开发工具 =='
$PY scripts/install.py

echo ''
echo '安装完成。'
echo '  打开桌面窗口:  .venv/bin/python -m desktop.app'
echo '  在你的 AI 工具里说: 开始练雅思 Part 1'
