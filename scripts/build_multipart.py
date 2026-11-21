"""Build the full package as a multi-part archive that fits GitHub's 2 GB cap.

The product the user wants is ONE package with the best models (distil-large-v3),
but a single asset may not exceed 2 GB. So the archive is split into numbered parts
and a tiny batch file merges + extracts them with tools every Windows 10/11 already
has: copy /b and tar.exe (bsdtar understands zip).

    IELTS-Coach-full.zip.001
    IELTS-Coach-full.zip.002
    合并并解压.bat
"""

from __future__ import annotations

import hashlib
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / "build" / "portable"
LARGE = ROOT / "models-large" / "hf"
DIST = ROOT / "dist"
ZIP_NAME = "IELTS-Coach-full.zip"
PART_BYTES = 1800 * 1024 * 1024
DISTIL = "models--Systran--faster-distil-whisper-large-v3"
KOKORO = "models--hexgrad--Kokoro-82M"
LAUNCHER = "启动口语教练.bat"

MERGE_BAT = """@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在合并分卷…
if not exist "IELTS-Coach-full.zip" (
  copy /b "IELTS-Coach-full.zip.001"+"IELTS-Coach-full.zip.002" "IELTS-Coach-full.zip" >nul
)
if not exist "IELTS-Coach-full.zip" (
  echo 合并失败：请确认两个分卷都在本目录。
  pause
  exit /b 1
)
echo 正在解压…
tar -xf "IELTS-Coach-full.zip"
if errorlevel 1 (
  echo 解压失败。可以手动用 7-Zip 打开 IELTS-Coach-full.zip。
  pause
  exit /b 1
)
del "IELTS-Coach-full.zip"
echo.
echo 完成。双击 启动口语教练.bat 开始使用。
pause
"""


def log(message: str) -> None:
    print(f"[full] {message}", flush=True)


def add_tree(archive: zipfile.ZipFile, source: Path, prefix: str) -> int:
    if not source.exists():
        log(f"缺少 {source}")
        return 0
    count = 0
    for path in source.rglob("*"):
        if path.is_file():
            archive.write(path, f"{prefix}/{path.relative_to(source).as_posix()}")
            count += 1
    return count


def build_zip() -> Path:
    target = DIST / ZIP_NAME
    if target.exists():
        target.unlink()
    log("打包完整版（distil-large-v3 + Kokoro + int8 发音模型）…")
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED, compresslevel=1) as archive:
        add_tree(archive, BUILD / "app", "app")
        add_tree(archive, BUILD / "python", "python")
        add_tree(archive, BUILD / "models" / "gop-int8", "models/gop-int8")
        add_tree(archive, BUILD / "models" / "vad", "models/vad")
        add_tree(archive, LARGE / DISTIL, f"models/hf/{DISTIL}")
        add_tree(archive, BUILD / "models" / "hf" / KOKORO, f"models/hf/{KOKORO}")
    log(f"zip: {target.stat().st_size / 1024 / 1024:.0f} MB")
    return target


def split_zip(source: Path) -> list[Path]:
    for old in DIST.glob(ZIP_NAME + ".*"):
        old.unlink()
    parts: list[Path] = []
    with source.open("rb") as handle:
        index = 1
        while True:
            chunk = handle.read(PART_BYTES)
            if not chunk:
                break
            part = DIST / f"{ZIP_NAME}.{index:03d}"
            part.write_bytes(chunk)
            parts.append(part)
            log(f"{part.name}: {len(chunk) / 1024 / 1024:.0f} MB")
            index += 1
    return parts


def verify(source: Path, parts: list[Path]) -> bool:
    digest = hashlib.sha256()
    for part in parts:
        digest.update(part.read_bytes())
    merged = digest.hexdigest()
    original = hashlib.sha256(source.read_bytes()).hexdigest()
    log(f"分卷合并校验: {'一致' if merged == original else '不一致'}")
    return merged == original


def main() -> int:
    for required in [BUILD / "app", BUILD / "python", LARGE / DISTIL, BUILD / "models" / "gop-int8"]:
        if not required.exists():
            log(f"缺少 {required}")
            return 1
    (BUILD / LAUNCHER).write_text((BUILD / LAUNCHER).read_text(encoding="utf-8"), encoding="utf-8")
    source = build_zip()
    parts = split_zip(source)
    for part in parts:
        if part.stat().st_size > 2 * 1024**3:
            log(f"{part.name} 超过 2 GB")
            return 1
    (DIST / "合并并解压.bat").write_text(MERGE_BAT, encoding="utf-8")
    ok = verify(source, parts)
    source.unlink()  # parts are the deliverable
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
