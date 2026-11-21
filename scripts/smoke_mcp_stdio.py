"""Protocol-level smoke test: speak MCP stdio to the bridge like dsh does.

Run:  python scripts/smoke_mcp_stdio.py
Exits 0 when the handshake, tool listing and a real tool call all succeed.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VENV_EXE = ROOT / ".venv" / "Scripts" / "ielts-mcp.exe"


async def main() -> int:
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client

    if VENV_EXE.is_file():
        command, args = str(VENV_EXE), []
    else:
        command, args = sys.executable, ["-m", "mcp_bridge.server"]

    env = os.environ.copy()
    env.setdefault("PYTHONUTF8", "1")
    env.setdefault("PYTHONIOENCODING", "utf-8")
    env.setdefault("IELTS_COACH_NO_BROWSER", "1")

    print("launching:", command, args)
    params = StdioServerParameters(command=command, args=args, env=env)

    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            info = await session.initialize()
            print("server:", info.serverInfo.name, info.serverInfo.version)
            listed = await session.list_tools()
            names = [tool.name for tool in listed.tools]
            print("tools:", ", ".join(names))
            required = [
                "get_learner_context",
                "start_lesson",
                "respond_with_feedback_and_wait",
                "wait_for_learner_turn",
                "push_turn_feedback",
                "update_learner_memory",
                "get_lesson_aggregation",
                "save_lesson_report",
            ]
            missing = [name for name in required if name not in names]
            if missing:
                print("MISSING TOOLS:", missing)
                return 2

            result = await session.call_tool("daemon_status", {})
            text = result.content[0].text if result.content else ""
            print("daemon_status:", text[:400])
            try:
                payload = json.loads(text)
            except json.JSONDecodeError:
                payload = {}
            if not payload.get("ok"):
                print("daemon not reachable through the bridge")
                return 3

            context = await session.call_tool("get_learner_context", {})
            body = context.content[0].text if context.content else ""
            data = json.loads(body)
            print("profile:", data.get("profile", {}).get("target_band"), "| has_history:", data.get("has_history"))
            return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
