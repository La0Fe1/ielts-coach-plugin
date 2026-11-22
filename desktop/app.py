"""Standalone desktop window for the IELTS speaking coach.

Why this exists: the product is a *companion app*, not a web page. The daemon owns
the models, the audio pipeline and the memory; this module gives it a window that
starts from a plain desktop shortcut, sits next to the editor, and survives the
agent session that started the lesson.

Design notes
  * pywebview + WebView2 (already on Windows 10/11): a real window with a native
    title bar - no address bar, no tabs, no browser chrome.
  * Single instance: a second launch (for example the agent starting a new lesson)
    exits immediately; the running window notices the new active session by polling
    the daemon and switches to it, which is what "开始上课" should feel like.
  * The window is independent of the host that spawned it, so closing the editor or
    ending the agent session does not take the lesson away.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

logger = logging.getLogger("ielts.desktop")

LOCK_NAME = "desktop.lock"
SPLASH = """<!doctype html><html><head><meta charset="utf-8" />
<style>
  html, body { height: 100%; margin: 0; background: #f5f4f0; color: #242720;
    font-family: -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif; }
  .wrap { height: 100%; display: grid; place-content: center; gap: 14px; text-align: center; }
  .dot { width: 42px; height: 42px; border-radius: 50%; margin: 0 auto;
    background: #4b5f92; opacity: .18; animation: breathe 1.6s ease-in-out infinite; }
  @keyframes breathe { 0%,100% { transform: scale(.86); opacity: .14 } 50% { transform: scale(1); opacity: .34 } }
  p { font-size: 13px; color: #60665c; margin: 0 }
  strong { font-size: 15px; font-weight: 600; color: #242720 }
</style></head><body><div class="wrap">
  <div class="dot"></div>
  <strong>正在启动本地语音服务</strong>
  <p>首次启动要加载语音模型，大约 15 秒</p>
</div></body></html>"""


def home_dir() -> Path:
    override = os.environ.get("IELTS_COACH_HOME")
    if override:
        return Path(override).expanduser()
    return Path.home() / ".ielts-coach"


def lock_path() -> Path:
    return home_dir() / LOCK_NAME


_MUTEX_HANDLE = None


def acquire_single_instance() -> bool:
    """Return False when a desktop window is already running.

    A PID file is not enough on Windows: os.kill(pid, 0) is not a liveness probe
    there (it tries to terminate the process). A named mutex is the supported way
    and is released automatically when the process dies.
    """
    global _MUTEX_HANDLE
    if os.name == "nt":
        import ctypes

        kernel32 = ctypes.windll.kernel32
        _MUTEX_HANDLE = kernel32.CreateMutexW(None, False, "Local\\IeltsCoachDesktop")
        return kernel32.GetLastError() != 183  # ERROR_ALREADY_EXISTS
    path = lock_path()
    try:
        fd = os.open(str(path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        # Stale lock from a crash: treat as free if the PID is gone.
        try:
            pid = int(path.read_text(encoding="utf-8").strip() or 0)
        except (OSError, ValueError):
            pid = 0
        if pid and pid_alive(pid):
            return False
        try:
            path.unlink()
        except OSError:
            return False
        return acquire_single_instance()
    os.write(fd, str(os.getpid()).encode("utf-8"))
    os.close(fd)
    return True


def pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def write_lock() -> None:
    path = lock_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(str(os.getpid()), encoding="utf-8")


def clear_lock() -> None:
    try:
        lock_path().unlink()
    except OSError:
        pass


def probe(base: str, timeout: float = 1.5) -> dict | None:
    try:
        with urllib.request.urlopen(base + "/health", timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError):
        return None


def active_session(base: str) -> int | None:
    try:
        with urllib.request.urlopen(base + "/api/sessions?limit=5", timeout=2.0) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError):
        return None
    for item in payload.get("sessions") or []:
        if item.get("status") == "active":
            return int(item["id"])
    return None


def ensure_daemon(base: str, wait_seconds: float = 90.0) -> bool:
    """Start the daemon in the background when it is not listening yet."""
    if probe(base):
        return True
    root = Path(__file__).resolve().parents[1]
    log_dir = home_dir() / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = open(log_dir / "desktop-daemon.log", "a", encoding="utf-8")
    creation = 0
    if os.name == "nt":
        creation = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0) | getattr(
            subprocess, "DETACHED_PROCESS", 0
        )
    try:
        subprocess.Popen(
            [sys.executable, "-m", "daemon.main"],
            cwd=str(root),
            stdin=subprocess.DEVNULL,
            stdout=log_file,
            stderr=subprocess.STDOUT,
            creationflags=creation,
            env={**os.environ, "PYTHONUTF8": "1"},
        )
    except Exception as exc:  # noqa: BLE001
        logger.error("无法启动 daemon: %s", exc)
        return False
    deadline = time.monotonic() + wait_seconds
    while time.monotonic() < deadline:
        if probe(base):
            return True
        time.sleep(0.8)
    return False


def build_url(base: str, session_id: int | None) -> str:
    query = "embed=1&desktop=1"
    if session_id:
        query += "&session=%d" % session_id
    return base + "/?" + query


def run(session_id: int | None, base: str, on_top: bool, width: int, height: int) -> int:
    try:
        import webview
    except Exception as exc:  # noqa: BLE001
        print("缺少 pywebview，无法打开桌面窗口：", exc)
        print("请执行: pip install pywebview")
        return 2

    healthy = ensure_daemon(base)
    window_kwargs = (
        {"html": SPLASH}
        if not healthy
        else {"url": build_url(base, session_id)}
    )
    window = webview.create_window(
        "IELTS 口语教练",
        width=width,
        height=height,
        min_size=(360, 560),
        background_color="#f5f4f0",
        on_top=on_top,
        easy_drag=False,
        text_select=True,
        **window_kwargs,
    )

    current = {"session": session_id, "loaded": healthy}
    permission_subscribed = False

    def grant_microphone_permission() -> None:
        nonlocal permission_subscribed
        if permission_subscribed:
            return
        edge = getattr(window, "gui", None)
        webview_control = getattr(edge, "webview", None)
        core = getattr(webview_control, "CoreWebView2", None)
        if core is None:
            return

        import clr

        clr.AddReference("Microsoft.Web.WebView2.Core")
        from Microsoft.Web.WebView2.Core import (
            CoreWebView2PermissionKind,
            CoreWebView2PermissionState,
        )

        def on_permission_requested(_sender, args) -> None:
            if args.PermissionKind == CoreWebView2PermissionKind.Microphone:
                args.State = CoreWebView2PermissionState.Allow
                args.Handled = True

        core.add_PermissionRequested(on_permission_requested)
        permission_subscribed = True

    def watch() -> None:
        """Follow the lesson the agent just created, without a second window."""
        while True:
            time.sleep(2.0)
            try:
                grant_microphone_permission()
                if getattr(window, "closed", False):
                    return
                if not current["loaded"]:
                    # The daemon was still starting when the window was created (first
                    # run downloads models): swap the splash for the real UI as soon as
                    # it answers, instead of leaving the user on a static page.
                    if not probe(base):
                        continue
                    current["loaded"] = True
                    wanted = active_session(base)
                    current["session"] = wanted
                    window.load_url(build_url(base, wanted))
                    continue
                wanted = active_session(base)
                if not wanted or wanted == current["session"]:
                    continue
                # The UI updates ?session= itself when the learner opens a lesson,
                # so only reload when the page really shows a different session.
                # Reloading here would drop the microphone grant and AudioContext
                # unlocked by the user's click.
                try:
                    on_page = window.evaluate_js(
                        "new URLSearchParams(window.location.search).get('session')"
                    )
                except Exception:  # noqa: BLE001 - page not ready yet
                    on_page = None
                if on_page and str(on_page).strip() == str(wanted):
                    current["session"] = wanted
                    continue
                current["session"] = wanted
                window.load_url(build_url(base, wanted))
            except Exception:  # noqa: BLE001 - keep the window alive
                logger.debug("桌面窗口轮询失败", exc_info=True)

    def start_watcher() -> None:
        import threading

        threading.Thread(target=watch, name="session-watcher", daemon=True).start()

    # Only open the DevTools port when debugging: leaving 9222 listening in a
    # shipped desktop app is both a security smell and a port-conflict source.
    if os.environ.get("IELTS_COACH_DEBUG") == "1":
        webview.settings['REMOTE_DEBUGGING_PORT'] = 9222
    webview.start(
        start_watcher,
        private_mode=False,
        storage_path=str(home_dir() / 'webview-data'),
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="ielts-coach", description="IELTS 口语教练桌面窗口")
    parser.add_argument("--session", type=int, default=None, help="要打开的课程 id")
    parser.add_argument("--port", type=int, default=int(os.environ.get("IELTS_COACH_PORT", "8765")))
    parser.add_argument("--on-top", action="store_true", help="窗口置顶")
    # Wide enough for the two-column workbench on a normal desktop; still narrow
    # enough for a side panel (min_size keeps it usable there).
    parser.add_argument("--width", type=int, default=1120)
    parser.add_argument("--height", type=int, default=780)
    parser.add_argument("--replace", action="store_true", help="忽略已有窗口，强制新开")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=os.environ.get("IELTS_COACH_LOG", "INFO"),
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
    )

    if not args.replace and not acquire_single_instance():
        # The running window picks up the new session on its own; nothing to do.
        print("IELTS 口语教练已在运行，窗口会自动切换到最新课程。")
        return 0

    write_lock()
    base = "http://127.0.0.1:%d" % args.port
    try:
        return run(args.session, base, args.on_top, args.width, args.height)
    finally:
        clear_lock()


if __name__ == "__main__":
    raise SystemExit(main())
