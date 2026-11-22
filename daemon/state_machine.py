"""Lesson state machine and the timeout-safe learner-turn coordinator.

Design constraints that shaped this module:
  * MCP clients kill a tool call at ~60 s, so no daemon wait may block longer
    than max_wait_sec (40 s by default). Waiters therefore return *the current
    status* on timeout instead of raising, and the SKILL instructs the agent to
    silently call wait_for_learner_turn again.
  * The MCP bridge runs in a different process than the daemon, so the wait is
    an HTTP long-poll. All shared state lives inside the daemon event loop and
    every mutation notifies any parked waiter immediately (no polling).
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)

# -- status vocabulary ------------------------------------------------------ #
STATUS_IDLE = "idle"
STATUS_WAITING = "waiting_for_learner"
STATUS_RECORDING = "recording_in_progress"
STATUS_PROCESSING = "processing"
STATUS_REPLIED = "learner_replied"
STATUS_ENDED = "lesson_ended_by_user"

#: Statuses exposed to MCP callers (processing is folded into recording_in_progress).
MCP_STATUS = {
    STATUS_IDLE: STATUS_WAITING,
    STATUS_WAITING: STATUS_WAITING,
    STATUS_RECORDING: STATUS_RECORDING,
    STATUS_PROCESSING: STATUS_RECORDING,
    STATUS_REPLIED: STATUS_REPLIED,
    STATUS_ENDED: STATUS_ENDED,
}

BUSY_STATUSES = {STATUS_RECORDING, STATUS_PROCESSING}


@dataclass
class SessionState:
    """Mutable per-lesson state (lives only in daemon memory)."""

    session_id: int
    status: str = STATUS_IDLE
    current_turn_id: int | None = None
    current_part: str = "part1"
    examiner_text: str | None = None
    examiner_audio_url: str | None = None
    examiner_audio_duration: float | None = None
    pending_reply: dict[str, Any] | None = None
    ended: bool = False
    started_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    turn_count: int = 0
    last_error: str | None = None
    _version: int = 0

    def __post_init__(self) -> None:
        self._event = asyncio.Event()
        self._event.set()
        self._lock = asyncio.Lock()

    # -- notification --------------------------------------------------------
    def _notify(self) -> None:
        self._version += 1
        self.updated_at = time.time()
        self._event.set()
        self._event = asyncio.Event()

    def set_status(self, status: str, **fields: Any) -> None:
        self.status = status
        for key, value in fields.items():
            if hasattr(self, key) and value is not None:
                setattr(self, key, value)
        self._notify()

    async def wait_change(self, timeout: float) -> bool:
        """Block until the state mutates or the timeout expires."""
        event = self._event
        if event.is_set():
            return True
        try:
            await asyncio.wait_for(event.wait(), timeout=max(0.01, timeout))
            return True
        except asyncio.TimeoutError:
            return False

    # -- serialisation -------------------------------------------------------
    def snapshot(self) -> dict[str, Any]:
        return {
            "session_id": self.session_id,
            "status": self.status,
            "mcp_status": MCP_STATUS.get(self.status, self.status),
            "current_turn_id": self.current_turn_id,
            "current_part": self.current_part,
            "examiner_text": self.examiner_text,
            "examiner_audio_url": self.examiner_audio_url,
            "examiner_audio_duration": self.examiner_audio_duration,
            "has_pending_reply": self.pending_reply is not None,
            "ended": self.ended,
            "turn_count": self.turn_count,
            "updated_at": self.updated_at,
            "last_error": self.last_error,
        }


class TurnResult(dict):
    """dict subclass kept for symmetry with the JSON payloads returned to MCP."""


class LessonRegistry:
    """Owns all SessionState objects plus WebSocket fan-out."""

    def __init__(self) -> None:
        self._sessions: dict[int, SessionState] = {}
        self._subscribers: dict[int, set[asyncio.Queue]] = {}
        self._lock = asyncio.Lock()

    # -- lifecycle -----------------------------------------------------------
    def get(self, session_id: int) -> SessionState:
        state = self._sessions.get(int(session_id))
        if state is None:
            state = SessionState(session_id=int(session_id))
            self._sessions[int(session_id)] = state
        return state

    def peek(self, session_id: int) -> SessionState | None:
        return self._sessions.get(int(session_id))

    def exists(self, session_id: int) -> bool:
        return int(session_id) in self._sessions

    def remove(self, session_id: int) -> None:
        self._sessions.pop(int(session_id), None)
        self._subscribers.pop(int(session_id), None)

    def all_snapshots(self) -> list[dict[str, Any]]:
        return [state.snapshot() for state in self._sessions.values()]

    def prune(self, older_than_sec: float = 6 * 3600) -> int:
        now = time.time()
        stale = [
            sid
            for sid, st in self._sessions.items()
            if (st.ended or st.status == STATUS_IDLE) and now - st.updated_at > older_than_sec
        ]
        for sid in stale:
            self.remove(sid)
        return len(stale)

    # -- pub/sub -------------------------------------------------------------
    def subscribe(self, session_id: int) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=200)
        self._subscribers.setdefault(int(session_id), set()).add(queue)
        return queue

    def unsubscribe(self, session_id: int, queue: asyncio.Queue) -> None:
        subscribers = self._subscribers.get(int(session_id))
        if subscribers:
            subscribers.discard(queue)
            if not subscribers:
                self._subscribers.pop(int(session_id), None)

    def publish(self, session_id: int, event: dict[str, Any]) -> None:
        for queue in list(self._subscribers.get(int(session_id), set())):
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:  # pragma: no cover - slow consumer
                logger.warning("WebSocket 队列已满 session=%s，丢弃事件 %s", session_id, event.get("type"))

    # -- transitions ---------------------------------------------------------
    def start_waiting(
        self,
        session_id: int,
        turn_id: int | None,
        examiner_text: str | None,
        part: str = "part1",
        audio_url: str | None = None,
        audio_duration: float | None = None,
    ) -> SessionState:
        state = self.get(session_id)
        state.current_turn_id = turn_id
        state.examiner_text = examiner_text
        state.examiner_audio_url = audio_url
        state.examiner_audio_duration = audio_duration
        state.current_part = part or state.current_part
        state.turn_count += 1
        state.set_status(STATUS_WAITING)
        self.publish(
            session_id,
            {
                "type": "examiner_turn",
                "session_id": session_id,
                "turn_id": turn_id,
                "part": state.current_part,
                "text": examiner_text,
                "audio_url": audio_url,
                "audio_duration": audio_duration,
                "status": state.status,
                "ts": time.time(),
            },
        )
        return state

    def mark_recording(self, session_id: int) -> SessionState:
        state = self.get(session_id)
        if state.ended:
            return state
        state.set_status(STATUS_RECORDING)
        self.publish(session_id, {"type": "state", "status": state.status, "ts": time.time()})
        return state

    def mark_processing(self, session_id: int, message: str = "声学分析中…") -> SessionState:
        state = self.get(session_id)
        if state.ended:
            return state
        state.set_status(STATUS_PROCESSING)
        self.publish(
            session_id,
            {"type": "state", "status": state.status, "message": message, "ts": time.time()},
        )
        return state

    def mark_cancel(self, session_id: int) -> SessionState:
        state = self.get(session_id)
        if state.ended:
            return state
        state.set_status(STATUS_WAITING)
        self.publish(
            session_id, {"type": "state", "status": state.status, "message": "本轮已取消", "ts": time.time()}
        )
        return state

    def deliver_reply(self, session_id: int, payload: dict[str, Any]) -> SessionState:
        state = self.get(session_id)
        state.pending_reply = payload
        state.set_status(STATUS_REPLIED)
        self.publish(session_id, {"type": "state", "status": state.status, "ts": time.time()})
        self.publish(session_id, {"type": "turn_ready", "payload": payload, "ts": time.time()})
        return state

    def end_lesson(self, session_id: int, reason: str = "user_clicked_end") -> SessionState:
        state = self.get(session_id)
        state.ended = True
        state.set_status(STATUS_ENDED, last_error=None)
        self.publish(
            session_id,
            {"type": "lesson_ended", "status": state.status, "reason": reason, "ts": time.time()},
        )
        return state

    def push_feedback(self, session_id: int, feedback: dict[str, Any]) -> None:
        self.publish(
            session_id, {"type": "feedback", "feedback": feedback, "ts": time.time()}
        )

    def push_report(self, session_id: int, report: dict[str, Any]) -> None:
        self.publish(session_id, {"type": "report", "report": report, "ts": time.time()})

    def push_plan_completed(self, session_id: int) -> None:
        """Every planned question has been asked: prompt the learner to finish."""
        self.publish(
            session_id,
            {"type": "plan_completed", "session_id": session_id, "ts": time.time()},
        )

    def push_error(self, session_id: int, message: str, stage: str = "") -> None:
        """Surface a driver failure to the UI instead of leaving it waiting forever."""
        state = self.get(session_id)
        state.last_error = message
        self.publish(
            session_id,
            {"type": "error", "message": message, "stage": stage, "ts": time.time()},
        )

    # -- the long poll -------------------------------------------------------
    async def wait_for_reply(self, session_id: int, timeout_sec: float) -> dict[str, Any]:
        """Wait (bounded) for the learner's next turn.

        Returns a payload whose 'status' is one of the four MCP statuses. On
        timeout the *current* status is returned unchanged - never an exception -
        so the agent can simply keep waiting.
        """
        state = self.get(session_id)
        timeout = max(0.0, min(float(timeout_sec or 0), 120.0))
        deadline = time.monotonic() + timeout
        await asyncio.sleep(0)  # let the caller's request settle first

        while True:
            if state.pending_reply is not None:
                payload = state.pending_reply
                state.pending_reply = None
                state._notify()
                await self._log_wait(session_id, payload.get("turn", {}).get("turn_id"))
                return payload

            if state.ended or state.status == STATUS_ENDED:
                return {
                    "status": STATUS_ENDED,
                    "session_id": session_id,
                    "message": "学习者已结束本课，请调用 get_lesson_aggregation 并生成课后报告。",
                }

            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return {
                    "status": MCP_STATUS.get(state.status, STATUS_WAITING),
                    "session_id": session_id,
                    "detail_status": state.status,
                    "turn_id": state.current_turn_id,
                    "waited_sec": round(timeout, 2),
                    "message": {
                        STATUS_WAITING: "学习者尚未开始录音。",
                        STATUS_RECORDING: "学习者正在录音/思考中。",
                        STATUS_PROCESSING: "正在做语音识别与流利度分析。",
                    }.get(state.status, "继续等待学习者。"),
                }
            await state.wait_change(min(remaining, 1.0))

    async def _log_wait(self, session_id: int, turn_id: Any) -> None:
        logger.debug("session %s 收到学习者回复 turn=%s", session_id, turn_id)


registry = LessonRegistry()
