"""FastMCP stdio bridge for the IELTS Speaking Coach.

This process is deliberately thin: it starts in milliseconds, makes sure the
resident daemon is alive (spawning it in the background on first use), and
forwards every tool call over HTTP. That is why opening a brand-new chat task
never pays the 3-8 second Whisper/Kokoro cold start again.

Run standalone with:  ielts-mcp     (or)  python -m mcp_bridge.server
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import subprocess
import sys
import time
import webbrowser
from pathlib import Path
from typing import Any

import httpx

try:  # MCP SDK >= 2.0 renamed FastMCP to MCPServer (same decorator API).
    from mcp.server.mcpserver import MCPServer  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover - MCP SDK 1.x
    from mcp.server.fastmcp import FastMCP as MCPServer  # type: ignore[no-redef]

PROJECT_ROOT = Path(__file__).resolve().parent.parent
LOG_DIR = Path(os.environ.get("IELTS_COACH_HOME", str(Path.home() / ".ielts-coach"))) / "logs"
DEFAULT_PORT = int(os.environ.get("IELTS_COACH_PORT", "8765"))
MAX_WAIT = int(os.environ.get("IELTS_COACH_MAX_WAIT", "40"))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s ielts.mcp: %(message)s",
    stream=sys.stderr,
)
logger = logging.getLogger("ielts.mcp")

INSTRUCTIONS = (
    "Local IELTS Speaking Coach. ALWAYS call get_learner_context() first, then "
    "start_lesson(), then drive every speaking turn through "
    "respond_with_feedback_and_wait() / wait_for_learner_turn(). Finish with "
    "get_lesson_aggregation() + save_lesson_report()."
)

mcp = MCPServer("ielts-coach", instructions=INSTRUCTIONS)

_client: httpx.AsyncClient | None = None
_spawn_lock = asyncio.Lock()
_spawned_proc: subprocess.Popen | None = None


# --------------------------------------------------------------------------- #
# Daemon discovery / lifecycle
# --------------------------------------------------------------------------- #
def daemon_url() -> str:
    raw = os.environ.get("IELTS_COACH_DAEMON_URL", "").strip()
    if raw:
        return raw.rstrip("/")
    return f"http://127.0.0.1:{DEFAULT_PORT}"


def get_client() -> httpx.AsyncClient:
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient(
            base_url=daemon_url(),
            timeout=httpx.Timeout(connect=3.0, read=70.0, write=30.0, pool=5.0),
        )
    return _client


async def daemon_alive(timeout: float = 1.5) -> dict[str, Any] | None:
    try:
        async with httpx.AsyncClient(timeout=timeout) as probe:
            response = await probe.get(f"{daemon_url()}/health")
            if response.status_code == 200:
                return response.json()
    except Exception:  # noqa: BLE001 - daemon simply is not up yet
        return None
    return None


def _daemon_log_path() -> Path:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    return LOG_DIR / "daemon.log"


def spawn_daemon() -> subprocess.Popen | None:
    """Launch the daemon detached from this MCP session."""
    global _spawned_proc
    log_path = _daemon_log_path()
    env = os.environ.copy()
    env.setdefault("PYTHONUTF8", "1")
    env.setdefault("PYTHONIOENCODING", "utf-8")
    env.setdefault("IELTS_COACH_PORT", str(DEFAULT_PORT))
    python = sys.executable
    creationflags = 0
    kwargs: dict[str, Any] = {}
    if os.name == "nt":
        creationflags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0) | getattr(
            subprocess, "DETACHED_PROCESS", 0
        )
    else:
        kwargs["start_new_session"] = True

    log_handle = open(log_path, "a", encoding="utf-8", errors="replace")
    log_handle.write(f"\n===== daemon spawn {time.strftime('%Y-%m-%d %H:%M:%S')} =====\n")
    log_handle.flush()
    try:
        proc = subprocess.Popen(
            [python, "-m", "daemon.main", "--port", str(DEFAULT_PORT)],
            cwd=str(PROJECT_ROOT),
            env=env,
            stdout=log_handle,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            creationflags=creationflags,
            **kwargs,
        )
    except Exception as exc:  # noqa: BLE001
        logger.error("拉起 daemon 失败: %s", exc)
        return None
    _spawned_proc = proc
    logger.info("已于后台拉起 ielts-daemon (pid=%s)，日志: %s", proc.pid, log_path)
    return proc


def launch_desktop_window(session_id: int | None) -> bool:
    """Open the standalone desktop window.

    The product is a companion app, so the panel must be a real window, never a
    browser tab: pywebview hosts the UI through WebView2 and the process keeps
    running on its own, independent of this MCP session.
    """
    if os.environ.get("IELTS_COACH_NO_WINDOW") == "1":
        return False
    creation = 0
    if os.name == "nt":
        creation = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0) | getattr(
            subprocess, "DETACHED_PROCESS", 0
        )
    args = [sys.executable, "-m", "desktop.app"]
    if session_id:
        args += ["--session", str(session_id)]
    try:
        subprocess.Popen(
            args,
            cwd=str(PROJECT_ROOT),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=creation,
            env={**os.environ, "PYTHONUTF8": "1"},
        )
        return True
    except Exception as exc:  # noqa: BLE001
        logger.warning("无法打开桌面窗口: %s", exc)
        return False


async def ensure_daemon(auto_spawn: bool = True, wait_seconds: float = 90.0) -> dict[str, Any]:
    """Return daemon health, starting the daemon if necessary."""
    health = await daemon_alive()
    if health:
        return health
    async with _spawn_lock:
        health = await daemon_alive()
        if health:
            return health
        if not auto_spawn:
            raise RuntimeError(
                f"本地 daemon 未运行（{daemon_url()}）。请先启动: python -m daemon.main"
            )
        spawn_daemon()
        deadline = time.monotonic() + wait_seconds
        while time.monotonic() < deadline:
            await asyncio.sleep(0.6)
            health = await daemon_alive(timeout=1.5)
            if health:
                logger.info("daemon 就绪: %s", health.get("version"))
                return health
        log_path = _daemon_log_path()
        tail = ""
        try:
            tail = log_path.read_text(encoding="utf-8", errors="replace")[-1200:]
        except OSError:
            pass
        raise RuntimeError(
            f"daemon 启动超时（{wait_seconds:.0f}s）。请查看日志 {log_path}\n{tail}"
        )


# --------------------------------------------------------------------------- #
# Generic request helpers
# --------------------------------------------------------------------------- #
async def _request(
    method: str,
    path: str,
    *,
    json_body: dict[str, Any] | None = None,
    params: dict[str, Any] | None = None,
    timeout: float | None = None,
) -> dict[str, Any]:
    await ensure_daemon()
    client = get_client()
    try:
        response = await client.request(
            method,
            path,
            json=json_body,
            params=params,
            timeout=timeout if timeout is not None else httpx.Timeout(connect=3.0, read=70.0, write=30.0, pool=5.0),
        )
    except httpx.HTTPError as exc:
        return {"ok": False, "error": f"无法访问本地 daemon: {exc}", "daemon_url": daemon_url()}
    if response.status_code >= 400:
        detail: Any = response.text
        try:
            detail = response.json().get("detail", response.text)
        except Exception:  # noqa: BLE001
            pass
        return {"ok": False, "status": response.status_code, "error": detail}
    try:
        return response.json()
    except json.JSONDecodeError:
        return {"ok": True, "raw": response.text}


async def _wait_for_turn(session_id: int, timeout_sec: int) -> dict[str, Any]:
    capped = max(1, min(int(timeout_sec or MAX_WAIT), MAX_WAIT))
    result = await _request(
        "GET",
        f"/api/internal/sessions/{session_id}/wait",
        params={"timeout_sec": capped},
        timeout=httpx.Timeout(connect=3.0, read=capped + 25.0, write=30.0, pool=5.0),
    )
    if "status" not in result:
        return result
    result.setdefault("session_id", session_id)
    result["waited_timeout_sec"] = capped
    return result


# --------------------------------------------------------------------------- #
# Tool 1: long-term memory
# --------------------------------------------------------------------------- #
@mcp.tool()
async def get_learner_context() -> dict[str, Any]:
    """Load long-term memory before a lesson: profile, top grammar weaknesses,
    weak phonemes, existing Part 2 stories and the previous lesson's prescription."""
    try:
        await ensure_daemon()
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}
    return await _request("GET", "/api/learner/context")


# --------------------------------------------------------------------------- #
# Tool 2: start a lesson
# --------------------------------------------------------------------------- #
@mcp.tool()
async def start_lesson(
    part_mode: str = "part1",
    topic_hint: str = "",
    feedback_style: str = "instant_card_plus_voice",
    target_band: float | None = None,
    open_browser: bool = True,
    accent: str | None = None,
) -> dict[str, Any]:
    """Create a lesson, auto-pick its questions from the local bank, and open the desktop window.

    Never ask the learner to choose a topic: leave topic_hint empty and the daemon
    plans the lesson itself (random topic that avoids recent ones, plus a review
    block built from long-term memory). The returned "plan" holds the exact
    questions to ask, in order.

    Args:
        part_mode: part1 | part2 | part3 | full_mock | free_drill
        topic_hint: optional override, e.g. "technology"; empty = auto-pick
        feedback_style: instant_card_plus_voice (default) or instant_card_only
        target_band: desired band score, e.g. 7.0
        open_browser: open the standalone desktop window for this lesson (never a browser tab)
    """
    health = await ensure_daemon()
    body: dict[str, Any] = {
        "part_mode": part_mode,
        "topic_hint": topic_hint or "",
        "feedback_style": feedback_style,
        "auto_plan": True,
    }
    if target_band:
        body["target_band"] = target_band
    result = await _request("POST", "/api/sessions", json_body=body)
    if result.get("ok") is False:
        return result
    if accent:
        await _request("PATCH", "/api/profile", json_body={"accent_preference": accent})
    url = result.get("companion_url")
    session_id = result.get("session_id")
    launched = bool(open_browser) and launch_desktop_window(session_id)
    result["window"] = {
        "mode": "desktop",
        "launched": launched,
        "note": "桌面窗口已自动打开；已在运行时会把窗口切到本节课程。"
        if launched
        else "桌面窗口未能自动打开，可运行 ielts-coach 手动打开。",
    }
    result["ok"] = True
    result["daemon"] = {
        "url": daemon_url(),
        "version": health.get("version"),
        "device": health.get("device_name"),
    }
    plan = result.get("plan") or {}
    questions = plan.get("questions") or []
    first_question = questions[0]["text"] if questions else None
    result["next_step"] = (
        "题库已出好题单，不要问用户想聊什么话题。按 plan.questions 顺序逐个提问，题干原样使用；"
        "若有 plan.review 内容，开头用一句话回顾上次的薄弱点。"
        + ("" if first_question else "（题单为空，请自行出第一题）")
    )
    return result


@mcp.tool()
async def open_window(session_id: int | None = None) -> dict[str, Any]:
    """Open (or re-focus) the standalone desktop window for the current lesson.

    Use this when the learner says "打开口语教练" / "把窗口调出来" mid-lesson, or when
    start_lesson reported that the window could not be launched. Never tell the
    learner to open a browser: this product is a desktop app.

    Args:
        session_id: optional lesson id; omit to attach to the newest active lesson
    """
    await ensure_daemon()
    if session_id is None:
        try:
            listing = await _request("GET", "/api/sessions", params={"limit": 5})
            active = next(
                (item for item in listing.get("sessions", []) if item.get("status") == "active"),
                None,
            )
            session_id = active.get("id") if active else None
        except Exception:  # noqa: BLE001 - a window with no lesson still works
            session_id = None
    launched = launch_desktop_window(session_id)
    return {
        "ok": launched,
        "session_id": session_id,
        "window": "desktop",
        "note": "桌面窗口已打开（若已在运行会切到该课程）。"
        if launched
        else "无法打开窗口，请检查 pywebview 是否已安装：pip install pywebview",
    }


@mcp.tool()
async def get_lesson_plan(session_id: int) -> dict[str, Any]:
    """Fetch the lesson plan (questions + review block) the daemon generated.

    Use it if you need to re-read the question list mid-lesson, or to check which
    weak points this lesson is supposed to revisit.
    """
    session = await _request("GET", f"/api/sessions/{session_id}")
    if session.get("ok") is False:
        return session
    plan = session.get("plan") or await _request("GET", f"/api/sessions/{session_id}/plan")
    return {"session_id": session_id, "plan": plan, "session": session.get("session")}


# --------------------------------------------------------------------------- #
# Tool 3: the core per-turn tool
# --------------------------------------------------------------------------- #
@mcp.tool()
async def respond_with_feedback_and_wait(
    session_id: int,
    examiner_text: str,
    part: str = "part1",
    turn_id_for_feedback: int | None = None,
    feedback_payload: dict[str, Any] | None = None,
    timeout_sec: int = MAX_WAIT,
    accent: str | None = None,
) -> dict[str, Any]:
    """Push the previous turn's correction card, speak the next examiner question,
    then wait (max 40 s) for the learner's reply.

    Returns status:
      - learner_replied: the learner answered; read transcript/wpm/pauses.
      - recording_in_progress / waiting_for_learner: still going; immediately call
        wait_for_learner_turn again (no chat output!).
      - lesson_ended_by_user: build the end-of-lesson report.

    Args:
        session_id: id from start_lesson
        examiner_text: what the examiner says now (acknowledgement + next question)
        part: part1 | part2 | part3 | drill
        turn_id_for_feedback: learner turn the feedback_payload describes (usually the
            turn_id returned by the previous call); omit to target the last learner turn
        feedback_payload: {quick_praise, corrected_text, upgraded_text,
            grammar_mistakes[], pronunciation_tips}
        timeout_sec: long-poll budget, capped at 40 s to stay under MCP client timeouts
    """
    body: dict[str, Any] = {"text": examiner_text, "part": part}
    if turn_id_for_feedback:
        body["turn_id_for_feedback"] = turn_id_for_feedback
    if feedback_payload:
        body["feedback_payload"] = feedback_payload
    if accent:
        body["accent"] = accent

    turn = await _request("POST", f"/api/sessions/{session_id}/examiner_turn", json_body=body)
    if turn.get("ok") is False:
        return turn
    if turn.get("status") == "lesson_ended_by_user":
        return turn

    result = await _wait_for_turn(session_id, timeout_sec)
    result["examiner"] = {
        "turn_id": turn.get("turn_id"),
        "turn_index": turn.get("turn_index"),
        "part": turn.get("part"),
        "text": examiner_text,
        "audio_url": (turn.get("audio") or {}).get("url"),
        "audio_duration": (turn.get("audio") or {}).get("duration_sec"),
    }
    result["feedback_saved"] = turn.get("feedback_saved")
    return result


# --------------------------------------------------------------------------- #
# Tool 4: keep waiting without timing out
# --------------------------------------------------------------------------- #
@mcp.tool()
async def wait_for_learner_turn(session_id: int, timeout_sec: int = MAX_WAIT) -> dict[str, Any]:
    """Continue waiting for the learner without emitting any chat output.

    Call this whenever the previous call returned recording_in_progress or
    waiting_for_learner. Each call blocks at most 40 s.
    """
    return await _wait_for_turn(session_id, timeout_sec)


# --------------------------------------------------------------------------- #
# Tool 5: push a correction card on its own
# --------------------------------------------------------------------------- #
@mcp.tool()
async def push_turn_feedback(
    session_id: int,
    feedback_payload: dict[str, Any],
    turn_id: int | None = None,
) -> dict[str, Any]:
    """Push one instant-correction card to the UI + SQLite without asking a question.

    Use it to correct the learner's final answer before ending the lesson.
    """
    body: dict[str, Any] = {"feedback_payload": feedback_payload}
    if turn_id:
        body["turn_id"] = turn_id
    return await _request("POST", f"/api/sessions/{session_id}/feedback", json_body=body)


# --------------------------------------------------------------------------- #
# Tool 6: long-term memory update
# --------------------------------------------------------------------------- #
@mcp.tool()
async def update_learner_memory(memory_items: list[dict[str, Any]]) -> dict[str, Any]:
    """Persist recurring weaknesses, personal facts, Part 2 stories or next-lesson plans.

    Each item: {memory_type: weakness_grammar|weakness_phoneme|personal_fact|
    part2_story|next_lesson_plan, memory_key, title, content, mastery_delta}.
    """
    return await _request("POST", "/api/memory", json_body={"memory_items": memory_items})


# --------------------------------------------------------------------------- #
# Tool 7: post-lesson aggregation
# --------------------------------------------------------------------------- #
@mcp.tool()
async def get_lesson_aggregation(session_id: int) -> dict[str, Any]:
    """Aggregate every turn, grammar mistake and fluency metric of the lesson,
    plus the learner's recent band history, so bands can be scored honestly."""
    return await _request("GET", f"/api/sessions/{session_id}/aggregation")


# --------------------------------------------------------------------------- #
# Tool 8: save the learning report
# --------------------------------------------------------------------------- #
@mcp.tool()
async def save_lesson_report(
    session_id: int,
    bands_json: dict[str, Any],
    report_markdown: str,
    next_lesson_plan: str = "",
) -> dict[str, Any]:
    """Persist the end-of-lesson report (DB + ~/.ielts-coach/reports/*.md) and
    switch the companion panel to the report view.

    bands_json: {overall, fc, lr, gra, pr}
    """
    return await _request(
        "POST",
        f"/api/sessions/{session_id}/report",
        json_body={
            "bands_json": bands_json,
            "report_markdown": report_markdown,
            "next_lesson_plan": next_lesson_plan,
        },
    )


# --------------------------------------------------------------------------- #
# Bonus tool: explicit lesson end (voice command "stop the lesson")
# --------------------------------------------------------------------------- #
@mcp.tool()
async def end_lesson(session_id: int, reason: str = "learner_asked_to_stop") -> dict[str, Any]:
    """Mark the lesson finished (equivalent to the red button in the web UI).
    Afterwards call get_lesson_aggregation + save_lesson_report."""
    return await _request(
        "POST", f"/api/sessions/{session_id}/end", json_body={"reason": reason}
    )


@mcp.tool()
async def daemon_status() -> dict[str, Any]:
    """Check whether the local daemon is running, which models are loaded, and
    where the companion UI lives. Useful for troubleshooting."""
    health = await daemon_alive()
    if not health:
        try:
            health = await ensure_daemon()
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": str(exc), "daemon_url": daemon_url()}
    health["ok"] = True
    health["daemon_url"] = daemon_url()
    return health


def main() -> int:
    transport = os.environ.get("IELTS_COACH_MCP_TRANSPORT", "stdio").strip() or "stdio"
    logger.info("ielts-coach MCP bridge starting (transport=%s, daemon=%s)", transport, daemon_url())
    mcp.run(transport=transport)  # type: ignore[arg-type]
    return 0


if __name__ == "__main__":
    sys.exit(main())
