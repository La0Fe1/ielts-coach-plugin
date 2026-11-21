"""One-shot installer: register the IELTS Coach MCP server + skill everywhere.

Targets
  * DeepSeek Harness (dsh)  -> ~/.dsh/profiles/<profile>/cordis.patch.yml  (+ skills)
  * Claude Code             -> ~/.claude.json  (mcpServers)
  * Claude Desktop          -> %APPDATA%/Claude/claude_desktop_config.json
  * Cursor                  -> ~/.cursor/mcp.json
  * Generic agent skills    -> ~/.agents/skills/<name>/SKILL.md

Usage
    python scripts/install.py                # register everything it can find
    python scripts/install.py --print-only   # show what would change
    python scripts/install.py --skip dsh     # selective targets
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
SKILL_NAME = "ielts-speaking-coach"
SERVER_NAME = "ielts-coach"
VENV_PYTHON = PROJECT_ROOT / ".venv" / "Scripts" / "python.exe"
VENV_EXE = PROJECT_ROOT / ".venv" / "Scripts" / "ielts-mcp.exe"

DSH_ENTRY = """# IELTS Speaking Coach MCP Server (local, self-installed)
- insert:
    - id: mcp-ielts-coach
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: stdio
        serverName: ielts-coach
        command: '{command}'
        args: []
        toolCallTimeoutMs: 180000
        failOnStartupError: false
        reconnect:
          enabled: true
"""


def log(*parts: object) -> None:
    print(*parts, flush=True)


def installer_python() -> str:
    if VENV_PYTHON.is_file():
        return str(VENV_PYTHON)
    return sys.executable


def mcp_command() -> str:
    return str(VENV_EXE) if VENV_EXE.is_file() else installer_python()


def server_entry() -> dict:
    """Generic mcpServers entry (Claude Code / Desktop / Cursor)."""
    return {
        "command": mcp_command(),
        "args": [],
        "env": {"PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"},
    }


def ensure_package_installed(print_only: bool) -> bool:
    if print_only:
        log("[plan] pip install -e . (into .venv)")
        return True
    log("-> 安装 Python 包（editable）到 .venv …")
    python = installer_python()
    completed = subprocess.run(
        [python, "-m", "pip", "install", "-e", ".", "--no-deps", "-q"],
        cwd=str(PROJECT_ROOT),
        capture_output=True,
        text=True,
    )
    if completed.returncode != 0:
        log("   警告: editable 安装失败，退回到直接运行模块。")
        log((completed.stderr or completed.stdout).strip()[-800:])
        return False
    log("   ok ->", VENV_EXE)
    return True


# --------------------------------------------------------------------------- #
# Skills
# --------------------------------------------------------------------------- #
def install_skill(target_root: Path, print_only: bool) -> Path | None:
    source = PROJECT_ROOT / "skills" / SKILL_NAME / "SKILL.md"
    if not source.is_file():
        log("   ! 找不到 SKILL.md:", source)
        return None
    destination = target_root / SKILL_NAME / "SKILL.md"
    log(("[plan] " if print_only else "-> ") + "skill ->", destination)
    if print_only:
        return destination
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)
    return destination


# --------------------------------------------------------------------------- #
# dsh
# --------------------------------------------------------------------------- #
def install_dsh(print_only: bool) -> list[str]:
    home = Path.home()
    dsh_root = home / ".dsh"
    written: list[str] = []
    if not dsh_root.exists():
        log("   - 未检测到 ~/.dsh，跳过 dsh 注册（安装 dsh 后重新运行本脚本即可）")
        return written

    skill_target = install_skill(dsh_root / "skills", print_only)
    if skill_target:
        written.append(str(skill_target))

    profiles_dir = dsh_root / "profiles"
    profiles = [p for p in profiles_dir.iterdir() if p.is_dir()] if profiles_dir.is_dir() else []
    if not profiles:
        log("   - 未发现 ~/.dsh/profiles/*，跳过 MCP 注册")
        return written

    command = mcp_command()
    for profile in profiles:
        patch = profile / "cordis.patch.yml"
        if not patch.exists():
            continue
        text = patch.read_text(encoding="utf-8")
        label = str(patch)
        if "mcp-ielts-coach" in text or "ielts-coach" in text and "dsh-mcp-client" in text:
            log("   = 已存在，跳过:", label)
            continue
        block = DSH_ENTRY.format(command=command.replace("'", "''"))
        if print_only:
            log("[plan] 向", label, "追加 MCP 入口：")
            log(block)
            continue
        backup = patch.with_name(patch.name + ".bak." + time.strftime("%Y%m%d-%H%M%S"))
        shutil.copy2(patch, backup)
        with patch.open("a", encoding="utf-8") as handle:
            handle.write("\n" + block)
        log("-> 已写入 dsh MCP 配置:", label)
        log("   备份:", backup.name)
        written.append(label)
    return written


# --------------------------------------------------------------------------- #
# JSON based hosts
# --------------------------------------------------------------------------- #
def merge_json_config(path: Path, key: str, entry: dict, print_only: bool) -> bool:
    data: dict = {}
    if path.is_file():
        try:
            data = json.loads(path.read_text(encoding="utf-8") or "{}")
        except json.JSONDecodeError:
            log("   ! 无法解析 JSON（已跳过）:", path)
            return False
    servers = data.setdefault(key, {})
    if SERVER_NAME in servers:
        log("   = 已存在，跳过:", path)
        return False
    servers[SERVER_NAME] = entry
    if print_only:
        log("[plan] 写入", path, "->", key + "." + SERVER_NAME)
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    log("-> 已写入:", path)
    return True


def install_claude_code(print_only: bool) -> bool:
    path = Path.home() / ".claude.json"
    return merge_json_config(path, "mcpServers", server_entry(), print_only)


def install_claude_desktop(print_only: bool) -> bool:
    appdata = os.environ.get("APPDATA")
    if not appdata:
        return False
    path = Path(appdata) / "Claude" / "claude_desktop_config.json"
    if not path.parent.exists():
        log("   - 未安装 Claude Desktop，跳过")
        return False
    return merge_json_config(path, "mcpServers", server_entry(), print_only)


def install_cursor(print_only: bool) -> bool:
    path = Path.home() / ".cursor" / "mcp.json"
    if not path.parent.exists():
        log("   - 未安装 Cursor，跳过（仍需时创建 ~/.cursor/mcp.json 即可）")
        return False
    return merge_json_config(path, "mcpServers", server_entry(), print_only)


def install_agents_skills(print_only: bool) -> bool:
    target = install_skill(Path.home() / ".agents" / "skills", print_only)
    return target is not None


def install_vscode_extension(print_only: bool) -> bool:
    """Install the bundled .vsix with whichever VS Code compatible CLI exists."""
    vsix_dir = PROJECT_ROOT / "editors" / "vscode"
    candidates = sorted(vsix_dir.glob("*.vsix"))
    if not candidates:
        log("   - 未找到 .vsix（先在 editors/vscode 里 npm run build 并 package）")
        return False
    vsix = candidates[-1]
    cli = None
    for name in ("code", "cursor", "code-insiders", "windsurf"):
        found = shutil.which(name)
        if found:
            cli = (name, found)
            break
    if cli is None:
        log("   - 未检测到 VS Code / Cursor CLI，跳过（手动安装：" + str(vsix) + "）")
        return False
    if print_only:
        log("[plan] " + cli[0] + " --install-extension " + vsix.name)
        return False
    completed = subprocess.run(
        [cli[1], "--install-extension", str(vsix), "--force"],
        capture_output=True,
        text=True,
    )
    if completed.returncode != 0:
        log("   ! 安装扩展失败:", (completed.stderr or completed.stdout).strip()[-300:])
        return False
    log("-> 已安装 " + cli[0] + " 扩展: " + vsix.name)
    return True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Install the IELTS Coach MCP server + skill")
    parser.add_argument("--print-only", action="store_true", help="只打印计划，不写文件")
    parser.add_argument(
        "--skip",
        nargs="*",
        default=[],
        choices=["dsh", "claude-code", "claude-desktop", "cursor", "agents", "package", "vscode"],
        help="跳过的安装目标",
    )
    args = parser.parse_args(argv)

    log("IELTS Coach installer")
    log("  项目目录:", PROJECT_ROOT)
    log("  venv python:", installer_python())
    log("  MCP 命令:", mcp_command())
    log("")

    if "package" not in args.skip:
        ensure_package_installed(args.print_only)

    changed: list[str] = []
    if "dsh" not in args.skip:
        log("[DeepSeek Harness]")
        changed += install_dsh(args.print_only)

    if "claude-code" not in args.skip:
        log("[Claude Code]")
        if install_claude_code(args.print_only):
            changed.append(str(Path.home() / ".claude.json"))

    if "claude-desktop" not in args.skip:
        log("[Claude Desktop]")
        if install_claude_desktop(args.print_only):
            changed.append("claude_desktop_config.json")

    if "cursor" not in args.skip:
        log("[Cursor]")
        if install_cursor(args.print_only):
            changed.append(str(Path.home() / ".cursor" / "mcp.json"))

    if "agents" not in args.skip:
        log("[通用 agent skills]")
        if install_agents_skills(args.print_only):
            changed.append(str(Path.home() / ".agents" / "skills" / SKILL_NAME))

    if "vscode" not in args.skip:
        log("[VS Code / Cursor 扩展]")
        if install_vscode_extension(args.print_only):
            changed.append("ielts-speaking-coach.vsix")

    log("")
    log("完成。改动 " + str(len(changed)) + " 处。")
    log("重启 dsh（或重新打开一个任务）后，在会话里说：'开始练 IELTS Part 1' 即可。")
    log("伴生面板地址: http://127.0.0.1:8765/?session=<id>")
    return 0


if __name__ == "__main__":
    sys.exit(main())
