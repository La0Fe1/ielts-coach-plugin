"""One-click agent hookup for the portable build.

Runs on the bundled interpreter, so it may only use the standard library.

What it does
  * finds the AI tools installed on this machine
  * registers the local MCP server (this package's python.exe + mcp_bridge.server)
  * copies SKILL.md into the skill folders those tools read
  * prints the two-minute manual steps for hosts without a config file (Doubao)

Everything is idempotent: a correct entry is left alone, a file is backed up before
its first modification, and --dry-run prints the plan without touching anything.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "app"
PYTHON = ROOT / "python" / "python.exe"
MODELS = ROOT / "models"
SKILL_SRC = APP / "skills" / "ielts-speaking-coach" / "SKILL.md"

SERVER_NAME = "ielts-coach"
SKILL_NAME = "ielts-speaking-coach"

DSH_BLOCK = """# IELTS Speaking Coach (portable build, added by 连接我的AI工具.bat)
- insert:
    - id: mcp-ielts-coach
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: ielts-coach
        transport: stdio
        command: '{python}'
        args: ['-m', 'mcp_bridge.server']
        env:
          PYTHONPATH: '{app}'
          IELTS_COACH_MODELS: '{models}'
          PYTHONUTF8: '1'
        cwd: '{app}'
        toolCallTimeoutMs: 180000
        failOnStartupError: false
        reconnect:
          enabled: true
"""

DOUBAO = """
--------------------------------------------------------------
豆包工作（没有配置文件，手动两步，2 分钟）

插件：左侧「插件·技能·伙伴」→ 插件 → 右上角 + 添加 → 新建自定义连接器
  服务器名称：ielts-coach
  传输类型：  STDIO
  运行命令：  {bat}
  环境变量：  PYTHONUTF8 = 1

技能：同一个面板 → 技能 → + 添加 → 上传技能 → 选这个文件夹：
  {skill_dir}

然后在豆包里说「开始练雅思 Part 1」。
（如果豆包只支持 HTTP 连接器，填 http://127.0.0.1:8765/mcp，需要先启动 启动口语教练.bat）
--------------------------------------------------------------
"""


def log(message: str = "") -> None:
    print(message, flush=True)


def fail(message: str) -> int:
    log("")
    log("出错了：" + message)
    log("可以把这段截图发给开发者。")
    return 1


def mcp_entry() -> dict:
    """Generic mcpServers entry used by Cursor / Claude Code / Claude Desktop."""
    return {
        "command": str(PYTHON),
        "args": ["-m", "mcp_bridge.server"],
        "env": {
            "PYTHONPATH": str(APP),
            "IELTS_COACH_MODELS": str(MODELS),
            "PYTHONUTF8": "1",
        },
    }


def backup(path: Path) -> None:
    if path.exists():
        stamp = time.strftime("%Y%m%d-%H%M%S")
        shutil.copy2(path, path.with_name(path.name + f".bak-{stamp}"))


def merge_json(path: Path, key: str | None, entry: dict, dry_run: bool) -> str:
    """Insert entry under root[key]['mcpServers'] (key=None means root)."""
    data: dict = {}
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8") or "{}")
        except json.JSONDecodeError as exc:
            return f"跳过（现有文件不是合法 JSON：{exc}）"
    holder = data if key is None else data.setdefault(key, {})
    servers = holder.setdefault("mcpServers", {})
    if servers.get(SERVER_NAME) == entry:
        return "已配置，无需修改"
    servers[SERVER_NAME] = entry
    if dry_run:
        return "会写入 " + str(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    backup(path)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return "已写入 " + str(path)


def install_dsh(dry_run: bool) -> list[str]:
    home = Path.home()
    patch_root = home / ".dsh" / "profiles"
    results: list[str] = []
    if not patch_root.is_dir():
        return results
    block = DSH_BLOCK.format(python=PYTHON, app=APP, models=MODELS)
    for profile in sorted(patch_root.iterdir()):
        patch = profile / "cordis.patch.yml"
        if not patch.is_dir() and not profile.is_dir():
            continue
        if not patch.exists():
            continue
        text = patch.read_text(encoding="utf-8")
        if "mcp-ielts-coach" in text:
            results.append(f"dsh/{profile.name}: 已配置")
            continue
        if dry_run:
            results.append(f"dsh/{profile.name}: 会追加注册")
            continue
        backup(patch)
        if not text.endswith("\n"):
            text += "\n"
        patch.write_text(text + "\n" + block, encoding="utf-8")
        results.append(f"dsh/{profile.name}: 已注册（重启 dsh 生效）")
    return results


def install_skill(target_root: Path, dry_run: bool) -> str | None:
    if not SKILL_SRC.is_file():
        return None
    destination = target_root / SKILL_NAME / "SKILL.md"
    if dry_run:
        return "会复制到 " + str(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(SKILL_SRC, destination)
    return "已复制到 " + str(destination)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="把口语教练接入本机的 AI 工具")
    parser.add_argument("--dry-run", action="store_true", help="只看计划，不改文件")
    args = parser.parse_args(argv)

    log("=" * 62)
    log(" IELTS 口语教练 · 接入本机 AI 工具")
    log("=" * 62)
    log("")
    log(f"安装目录: {ROOT}")
    log(f"Python:   {PYTHON}")
    log("")

    for required, label in (
        (PYTHON, "python/python.exe"),
        (APP / "mcp_bridge" / "server.py", "app/mcp_bridge/server.py"),
    ):
        if not required.exists():
            return fail(f"缺少 {label}，请确认是完整解压后的目录。")

    entry = mcp_entry()
    home = Path.home()
    changed = 0
    log("逐个检查你的工具：")

    # Cursor
    cursor_cfg = home / ".cursor" / "mcp.json"
    if (home / ".cursor").is_dir():
        log("  Cursor      : " + merge_json(cursor_cfg, None, entry, args.dry_run))
        changed += 1
    else:
        log("  Cursor      : 未安装，跳过")

    # Claude Code
    claude_cfg = home / ".claude.json"
    if claude_cfg.exists():
        log("  Claude Code : " + merge_json(claude_cfg, None, entry, args.dry_run))
        changed += 1
    else:
        log("  Claude Code : 未安装，跳过")

    # Claude Desktop
    appdata = Path(os.environ.get("APPDATA", home / "AppData" / "Roaming"))
    desktop_cfg = appdata / "Claude" / "claude_desktop_config.json"
    if desktop_cfg.parent.is_dir():
        log("  Claude 桌面 : " + merge_json(desktop_cfg, None, entry, args.dry_run))
        changed += 1
    else:
        log("  Claude 桌面 : 未安装，跳过")

    # dsh
    dsh_results = install_dsh(args.dry_run)
    if dsh_results:
        for line in dsh_results:
            log("  DeepSeek Harness: " + line)
        changed += len(dsh_results)
    else:
        log("  DeepSeek Harness: 未安装，跳过")

    # skills
    skill_lines = [install_skill(home / ".dsh" / "skills", args.dry_run),
                   install_skill(home / ".agents" / "skills", args.dry_run)]
    for line in [s for s in skill_lines if s]:
        log("  技能: " + line)
        changed += 1

    log("")
    if changed == 0:
        log("没找到能自动配置的工具。别急——用豆包的话，看下面的手动步骤；")
        log("用 Cursor / Claude Code 的话，先打开一次那个软件，再回来运行本脚本。")
    else:
        log("完成。重启对应的 AI 工具，然后说「开始练雅思 Part 1」。")
        if not args.dry_run:
            log("")
            log("提示：第一次调用会等 15-20 秒（本机模型加载），之后都是秒回。")

    log(DOUBAO.format(
        bat=ROOT / "ielts-mcp.bat",
        skill_dir=APP / "skills" / SKILL_NAME,
    ))
    if args.dry_run:
        log("（--dry-run：以上都没有真的写入）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
