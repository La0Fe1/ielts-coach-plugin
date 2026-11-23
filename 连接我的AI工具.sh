#!/usr/bin/env bash
# ===========================================================================
#  连接我的AI工具 - 一键把雅思口语教练 MCP 接进本机 AI 工具（macOS / Linux）
#  在终端执行：./连接我的AI工具.sh [--dry-run] [--url https://…/mcp] [--token …]
# ===========================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
cd "$SCRIPT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "没有检测到 Node.js，请先安装 Node.js LTS（20 以上）：https://nodejs.org/zh-cn" >&2
  exit 1
fi

if [ ! -f "$SCRIPT_DIR/scripts/connect-agent.mjs" ]; then
  echo "找不到 scripts/connect-agent.mjs，请确认项目文件完整。" >&2
  exit 1
fi

exec node "$SCRIPT_DIR/scripts/connect-agent.mjs" "$@"
