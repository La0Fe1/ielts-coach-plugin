"""Build the split release: app zip + large-models zip.

GitHub caps a release asset at 2 GB, so the "one package" build caps the ASR model
at small.en. Users who want distil-large-v3 download a second archive that unpacks
into the same folder:

    IELTS-Coach/            <- extract both zips here
      app/                  (app zip)
      python/               (app zip)
      models/gop-int8/      (app zip)
      models/vad/           (app zip)
      models/hf/            (models zip: distil-large-v3 + Kokoro)
      启动口语教练.bat        (app zip)

No staging copy: entries are read straight from the already-built trees.
"""

from __future__ import annotations

import shutil
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / "build" / "portable"
LARGE = ROOT / "models-large" / "hf"
DIST = ROOT / "dist"
KOKORO_PATTERN = "models--hexgrad--Kokoro-82M"
DISTIL_PATTERN = "models--Systran--faster-distil-whisper-large-v3"
LAUNCHER = "启动口语教练.bat"


def log(message: str) -> None:
    print(f"[split] {message}", flush=True)


def add_tree(archive: zipfile.ZipFile, source: Path, prefix: str) -> int:
    count = 0
    if not source.exists():
        log(f"跳过缺失目录 {source}")
        return 0
    for path in source.rglob("*"):
        if path.is_file():
            archive.write(path, f"{prefix}/{path.relative_to(source).as_posix()}")
            count += 1
    return count


def human(path: Path) -> str:
    return f"{path.stat().st_size / 1024 / 1024:.0f} MB"


def build_app_zip() -> Path:
    target = DIST / "IELTS-Coach-app.zip"
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        target.unlink()
    log("打包 app（程序 + 运行时 + 发音模型）…")
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        add_tree(archive, BUILD / "app", "app")
        add_tree(archive, BUILD / "python", "python")
        add_tree(archive, BUILD / "models" / "gop-int8", "models/gop-int8")
        add_tree(archive, BUILD / "models" / "vad", "models/vad")
        for name in (LAUNCHER, "README.txt"):
            candidate = BUILD / name
            if candidate.is_file():
                archive.write(candidate, name)
    log(f"app: {human(target)}")
    return target


def build_models_zip() -> Path:
    target = DIST / "IELTS-Coach-models-large.zip"
    if target.exists():
        target.unlink()
    log("打包 models-large（distil-large-v3 + Kokoro）…")
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED, compresslevel=1) as archive:
        add_tree(archive, LARGE / DISTIL_PATTERN, f"models/hf/{DISTIL_PATTERN}")
        add_tree(
            archive,
            BUILD / "models" / "hf" / KOKORO_PATTERN,
            f"models/hf/{KOKORO_PATTERN}",
        )
    log(f"models: {human(target)}")
    return target


def main() -> int:
    for required in [BUILD / "app", BUILD / "python", BUILD / "models" / "gop-int8"]:
        if not required.exists():
            log(f"缺少 {required}，先运行 build_portable.py")
            return 1
    if not (LARGE / DISTIL_PATTERN).exists():
        log(f"缺少 {LARGE / DISTIL_PATTERN}，先下载 distil-large-v3")
        return 1
    app = build_app_zip()
    models = build_models_zip()
    if app.stat().st_size > 2 * 1024**3 or models.stat().st_size > 2 * 1024**3:
        log("警告：有附件超过 GitHub 的 2 GB 单文件上限")
        return 1
    log("完成：两个附件都小于 2 GB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
