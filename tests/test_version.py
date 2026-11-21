"""The daemon's reported version must match the packaged project version."""

from __future__ import annotations

import tomllib
from pathlib import Path

from daemon import config

PYPROJECT = Path(__file__).resolve().parents[1] / "pyproject.toml"


def test_version_matches_pyproject():
    data = tomllib.loads(PYPROJECT.read_text(encoding="utf-8"))
    assert config.VERSION == data["project"]["version"], (
        "daemon/config.py VERSION 与 pyproject.toml 不一致："
        f"{config.VERSION} != {data['project']['version']}"
    )
