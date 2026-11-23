#!/usr/bin/env bash
# ===========================================================================
#  IELTS Speaking Coach - MCP STDIO launcher (macOS / Linux)
#
#  Spawned by MCP clients: DeepSeek Harness / OpenAI Codex CLI / Cursor /
#  Claude Code / 豆包. Works from ANY current directory: every path below is
#  absolute and relative to this script file.
#
#  HARD RULE: stdout is reserved for JSON-RPC. All diagnostics go to stderr.
# ===========================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
ROOT="$SCRIPT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "[ielts-mcp] ERROR: Node.js not found in PATH." >&2
  echo "[ielts-mcp] Install Node.js 20+ from https://nodejs.org and run this script again." >&2
  exit 1
fi

if [ ! -f "$ROOT/node_modules/tsx/dist/cli.mjs" ]; then
  echo "[ielts-mcp] ERROR: dependencies are missing: $ROOT/node_modules/tsx/dist/cli.mjs" >&2
  echo "[ielts-mcp] Run \"npm install\" once inside $ROOT and retry." >&2
  exit 1
fi

if [ -z "${IELTS_COACH_DATA_DIR:-}" ]; then
  export IELTS_COACH_DATA_DIR="${HOME:-$ROOT}/.ielts-coach"
fi

cd "$ROOT"
exec node "$ROOT/node_modules/tsx/dist/cli.mjs" "$ROOT/server/src/mcp-stdio.ts" "$@"
