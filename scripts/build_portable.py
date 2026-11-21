"""Build a self-contained Windows portable build (no Python on the user's machine).

Layout produced in dist/IELTS-Coach-portable-win64.zip:

    app/
      python/          embeddable CPython (11 MB) + all site-packages
      daemon/          local service (models, audio, DB, question bank)
      desktop/         the window
      mcp_bridge/      MCP server for dsh / Cursor / Claude Code
      start.bat        启动口语教练.bat
      README.txt

Why an embeddable interpreter instead of PyInstaller: torch + transformers +
kokoro need data files and dynamic imports that PyInstaller hooks frequently miss;
a real interpreter with a real site-packages is far more predictable, and it still
needs nothing pre-installed on the target machine.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / "build" / "portable"
DIST = ROOT / "dist"
PY_VERSION = "3.12.10"
EMBED_URL = f"https://www.python.org/ftp/python/{PY_VERSION}/python-{PY_VERSION}-embed-amd64.zip"
TORCH_CPU = "https://download.pytorch.org/whl/cpu"
MIRROR = "https://pypi.tuna.tsinghua.edu.cn/simple"

CODE_DIRS = ["daemon", "desktop", "mcp_bridge", "skills"]
CODE_FILES = ["pyproject.toml", "README.md", "LICENSE"]

STARTER = """@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "IELTS_COACH_MODELS=%~dp0..\\models"
start "" "..\\python\\pythonw.exe" -m desktop.app
"""

#: Root launcher: the documented way in, shared by the one-file and split builds.
ROOT_LAUNCHER = """@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "IELTS_COACH_MODELS=%CD%\\models"
if not exist "models\\gop-int8\\config.json" (
  echo.
  echo   缺少模型文件。
  echo   如果你下载的是分体版，请把 IELTS-Coach-models-large.zip 解压到本目录。
  echo.
  pause
  exit /b 1
)
cd app
start "" "..\\python\\pythonw.exe" -m desktop.app
"""

README_TXT = "IELTS 口语教练（便携版）\n\n不需要安装 Python。解压后双击「启动口语教练.bat」即可。\n\n语音模型已内置（识别 / 发音评分 / 离线合成 / 断句），首次启动无需联网。\n题库在程序里，主界面点「开始语音连麦上课」直接开课。\n\n完整教练体验（语法纠错、逐题追问、课后报告）：\n  在 dsh / Cursor / Claude Code 里说「开始上课」，\n  由你本地开发工具里的大模型当老师，每次上课消耗你自己的 token。\n\n数据都在 %USERPROFILE%\\.ielts-coach ，删除该目录即清空所有记忆。\n"


def log(message: str) -> None:
    # Chinese Windows consoles default to GBK; a stray replacement char must not
    # abort a 20-minute build.
    try:
        print(f"[portable] {message}", flush=True)
    except UnicodeEncodeError:
        print(f"[portable] {message.encode('ascii', 'replace').decode()}", flush=True)


def download(url: str, dest: Path) -> Path:
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    log(f"下载 {url}")
    urllib.request.urlretrieve(url, dest)
    return dest


def prepare_python(force: bool) -> Path:
    py_dir = BUILD / "python"
    if py_dir.exists() and not force:
        return py_dir / "python.exe"
    if py_dir.exists():
        shutil.rmtree(py_dir)
    zip_path = download(EMBED_URL, BUILD / f"python-{PY_VERSION}-embed-amd64.zip")
    with zipfile.ZipFile(zip_path) as archive:
        archive.extractall(py_dir)
    # The embeddable build ships an isolated ._pth: without site, pip cannot work.
    for candidate in py_dir.glob("python*._pth"):
        candidate.write_text(
            "python312.zip\n.\n..\\app\nLib\\site-packages\nimport site\n",
            encoding="utf-8",
        )
        log(f"写入 {candidate.name}")
    return py_dir / "python.exe"


def pip(python: Path, *args: str, index: str | None = None) -> None:
    command = [str(python), "-m", "pip", "install", "--no-warn-script-location", *args]
    if index:
        command += ["-i", index]
    log("$ " + " ".join(command[-6:]))
    subprocess.run(command, check=True)


def ensure_pip(python: Path) -> None:
    probe = subprocess.run([str(python), "-m", "pip", "--version"], capture_output=True, text=True)
    if probe.returncode == 0:
        return
    get_pip = download("https://bootstrap.pypa.io/get-pip.py", BUILD / "get-pip.py")
    log("安装 pip")
    subprocess.run([str(python), str(get_pip), "--no-warn-script-location"], check=True)


def install_deps(python: Path) -> None:
    # CPU wheels first: the CUDA build is 3.8 GB and would be useless to most users.
    # torch and torchaudio must be the SAME version or torchaudio fails to import its
    # native extension; resolve to a pair that is known to exist on the CPU index.
    pip(python, "torch==2.11.0", "torchaudio==2.11.0", index=TORCH_CPU)
    pip(python, ".[models,phase2]", index=MIRROR)


def copy_code(app_dir: Path) -> None:
    for name in CODE_DIRS:
        source = ROOT / name
        target = app_dir / name
        if target.exists():
            shutil.rmtree(target)
        shutil.copytree(
            source,
            target,
            ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "node_modules"),
        )
    for name in CODE_FILES:
        source = ROOT / name
        if source.exists():
            shutil.copy2(source, app_dir / name)
    (app_dir / "start.bat").write_text(STARTER, encoding="utf-8")
    (app_dir / "启动口语教练.bat").write_text(STARTER, encoding="utf-8")
    (app_dir / "README.txt").write_text(README_TXT, encoding="utf-8")


def zip_dir(source: Path, target: Path) -> Path:
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        target.unlink()
    log(f"打包 {target.name}（可能几分钟）")
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for path in source.rglob("*"):
            if path.is_file():
                archive.write(path, path.relative_to(source))
    size = target.stat().st_size / (1024 * 1024)
    log(f"完成: {target} ({size:.0f} MB)")
    return target


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--force", action="store_true", help="重新解压 Python")
    parser.add_argument("--skip-deps", action="store_true", help="复用已装好的依赖")
    parser.add_argument("--with-models", action="store_true", help="把 models/ 一起打进安装包（离线可用）")
    parser.add_argument("--no-zip", action="store_true")
    args = parser.parse_args()

    app_dir = BUILD / "app"
    app_dir.mkdir(parents=True, exist_ok=True)
    python = prepare_python(args.force)
    ensure_pip(python)
    copy_code(app_dir)
    # Models live next to app/ (not inside it) so the one-file and split builds share
    # exactly the same layout:  <root>/{app,python,models}
    models_target = BUILD / "models"
    if args.with_models:
        source = ROOT / "models"
        if not source.is_dir():
            log("models/ 不存在，先运行 scripts/prepare_models.py")
            return 1
        if models_target.exists():
            shutil.rmtree(models_target)
        log("复制模型（体积大，可能需要几分钟）…")
        shutil.copytree(source, models_target)
    (BUILD / "启动口语教练.bat").write_text(ROOT_LAUNCHER, encoding="utf-8")
    # site-packages live inside app/python so the whole folder is relocatable
    if not args.skip_deps:
        install_deps(python)
    copy_code(app_dir)  # second pass: pip may have created __pycache__ in cwd

    probe = subprocess.run(
        [str(python), "-c",
         "import daemon.main, desktop.app, mcp_bridge.server;"
         "from daemon import config; s = config.load_settings();"
         "print('ok', s.asr_model, s.pronounce_model)"],
        cwd=app_dir,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env={**os.environ, "IELTS_COACH_MODELS": str(models_target)}
        if args.with_models
        else os.environ,
    )
    log("import probe: " + (probe.stdout.strip() or probe.stderr.strip()[-400:]))
    if probe.returncode != 0:
        log("依赖不完整，打包中止")
        return 1
    if args.no_zip:
        return 0
    # Zip the portable root, not just app/: the interpreter (python/) must travel
    # with the code, they are siblings.
    zip_dir(BUILD, DIST / "IELTS-Coach-portable-win64.zip")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
