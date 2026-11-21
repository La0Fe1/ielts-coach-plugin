"""Smoke-test the portable bundle: no system Python, no install step.

Extracts the zip to a scratch directory and runs the bundled interpreter.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ZIP = ROOT / "dist" / "IELTS-Coach-portable-win64.zip"


def main() -> int:
    if not ZIP.exists():
        print("缺少", ZIP)
        return 1
    work = Path(tempfile.mkdtemp(prefix="ielts-portable-"))
    try:
        with zipfile.ZipFile(ZIP) as archive:
            archive.extractall(work)
        app = work / "app"
        python = work / "python" / "python.exe"
        print("python:", python, "exists:", python.exists())
        print("files:", sum(1 for _ in app.rglob("*") if _.is_file()))
        for required in ["daemon/main.py", "daemon/static/index.html", "desktop/app.py", "start.bat", "启动口语教练.bat"]:
            target = app / required
            print(("  ok  " if target.exists() else "  MISSING ") + required)

        env = {k: v for k, v in os.environ.items() if k.upper() != "PYTHONPATH"}
        env["PYTHONUTF8"] = "1"
        env["IELTS_COACH_HOME"] = str(work / "home")
        probe = subprocess.run(
            [str(python), "-c",
             "import sys, daemon.main, desktop.app, mcp_bridge.server, webview;"
             "print(sys.executable); print('imports ok')"],
            cwd=str(app), capture_output=True, text=True, encoding="utf-8",
            errors="replace", env=env,
        )
        print("probe rc:", probe.returncode)
        print((probe.stdout or "").strip())
        if probe.returncode != 0:
            print(probe.stderr.strip()[-1200:])
            return 1
        runtime = subprocess.run(
            [str(python), "-c", "import torch, faster_whisper, transformers; print('torch', torch.__version__, 'cuda', torch.version.cuda)"],
            cwd=str(app), capture_output=True, text=True, encoding="utf-8",
            errors="replace", env=env,
        )
        print("runtime:", (runtime.stdout or "").strip() or (runtime.stderr or "")[-400:])
        return 0
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
