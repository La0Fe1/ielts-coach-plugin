"""Shared pytest fixtures: isolated data home + in-process daemon."""

from __future__ import annotations

import os
import sys
import threading
import time
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))


@pytest.fixture()
def temp_home(tmp_path, monkeypatch):
    """Point every daemon path at a throw-away directory with stub models."""
    home = tmp_path / "ielts-home"
    home.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("IELTS_COACH_HOME", str(home))
    monkeypatch.setenv("IELTS_COACH_STUB_MODELS", "1")
    monkeypatch.setenv("IELTS_COACH_NO_PREWARM", "1")
    monkeypatch.setenv("IELTS_COACH_TTS_DISABLED", "0")
    monkeypatch.delenv("IELTS_COACH_DAEMON_URL", raising=False)
    # daemon.config caches the hardware probe only; paths are re-read each call.
    yield home


@pytest.fixture()
def db(temp_home):
    from daemon.db import Database

    database = Database()
    yield database
    database.close()


def _free_port() -> int:
    import socket

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


class DaemonThread:
    """Run the FastAPI app under uvicorn in a background thread."""

    def __init__(self, app, port: int, host: str = "127.0.0.1"):
        import uvicorn

        self.config = uvicorn.Config(app, host=host, port=port, log_level="warning", access_log=False)
        self.server = uvicorn.Server(self.config)
        self.port = port
        self.host = host
        self.thread = threading.Thread(target=self.server.run, name="uvicorn-test", daemon=True)
        self.url = f"http://{host}:{port}"

    def start(self, timeout: float = 30.0):
        self.thread.start()
        deadline = time.monotonic() + timeout
        import httpx

        while time.monotonic() < deadline:
            try:
                response = httpx.get(f"{self.url}/health", timeout=1.0)
                if response.status_code == 200:
                    return self
            except Exception:  # noqa: BLE001
                time.sleep(0.1)
        raise RuntimeError("测试 daemon 未能启动")

    def stop(self):
        self.server.should_exit = True
        self.thread.join(timeout=10)


@pytest.fixture()
def daemon_server(temp_home, monkeypatch):
    """Live daemon on a random port with stub models, wired into the MCP bridge."""
    from daemon import config

    settings = config.load_settings()
    settings.stub_models = True
    settings.prewarm = False
    settings.port = _free_port()

    from daemon.main import create_app

    app = create_app(settings)
    server = DaemonThread(app, settings.port).start()

    monkeypatch.setenv("IELTS_COACH_DAEMON_URL", server.url)
    monkeypatch.setenv("IELTS_COACH_NO_BROWSER", "1")  # never pop a browser during tests
    monkeypatch.setenv("IELTS_COACH_MAX_WAIT", "40")

    import mcp_bridge.server as bridge

    bridge._client = None  # force a fresh client bound to this event loop
    bridge.DEFAULT_PORT = settings.port
    yield server
    bridge._client = None
    server.stop()


def make_wav_bytes(
    duration_sec: float = 2.4,
    sample_rate: int = 16000,
    freq: float = 180.0,
    leading_silence: float = 0.25,
    trailing_silence: float = 0.25,
) -> bytes:
    """Render a deterministic speech-like WAV for upload tests."""
    import numpy as np

    from daemon.audio import processor

    total = int(sample_rate * duration_sec)
    t = np.arange(total, dtype=np.float32) / sample_rate
    signal = 0.3 * np.sin(2 * np.pi * freq * t) * (0.6 + 0.4 * np.sin(2 * np.pi * 3.0 * t))
    lead = np.zeros(int(sample_rate * leading_silence), dtype=np.float32)
    tail = np.zeros(int(sample_rate * trailing_silence), dtype=np.float32)
    return processor.write_wav_bytes(np.concatenate([lead, signal, tail]), sample_rate)
