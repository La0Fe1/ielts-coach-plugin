#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "没有检测到 Node.js，请先安装 Node.js LTS：https://nodejs.org/zh-cn"
  exit 1
fi
[ -d node_modules ] || npm install --no-audit --no-fund
[ -f web/dist/index.html ] || npm run build
( sleep 1; command -v open >/dev/null && open http://localhost:3000 || true ) &
npm start
