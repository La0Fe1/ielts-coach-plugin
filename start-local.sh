#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "没有检测到 Node.js，请先安装 Node.js LTS：https://nodejs.org/zh-cn"
  exit 1
fi
[ -d node_modules ] || npm install --no-audit --no-fund
[ -f web/dist/index.html ] || npm run build
echo ""
echo "网页练习： http://localhost:3000"
echo "MCP 端点： http://localhost:3000/mcp  （豆包 / dsh / Codex 等 AI 工具接入用）"
echo "AI 定制课：先在另一个终端运行 ./连接我的AI工具.sh 接入，再让 AI 开课（链接形如 /?lesson=xxx）"
( sleep 1; command -v open >/dev/null && open http://localhost:3000 || true ) &
npm start
