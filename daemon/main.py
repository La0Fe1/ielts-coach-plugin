"""IELTS Coach local daemon: FastAPI REST + WebSocket + companion UI host.

The daemon is the single writer for SQLite and the single owner of the resident
ASR/TTS models. The MCP bridge (a separate, short-lived stdio process) talks to
it over HTTP on 127.0.0.1:8765, which is what keeps new chat tasks from paying a
10-second model cold start.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import re
import sys
import time
import uuid

import numpy as np
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import (
    Body,
    FastAPI,
    File,
    Form,
    HTTPException,
    Query,
    Request,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import config
from .audio import processor
from .audio.asr import ASRService
from .audio.pronunciation import build_service as build_pronunciation
from .audio.tts import TTSService
from .audio.vad import FRAME_SAMPLES, StreamingVAD, VADService, pcm16_to_float
from .completeness import analyze as analyze_completeness
from .completeness import is_stop_command
from .db import Database
from .hints import HintBook, analyze_stuck, used_words
from .llm_coach import LLMConfigStore, StandaloneExaminer
from .planner import LessonPlanner, QuestionBank
from .state_machine import STATUS_ENDED, STATUS_WAITING, LessonRegistry

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
)
logger = logging.getLogger("ielts.daemon")

STATIC_DIR = Path(__file__).resolve().parent / "static"


def _configure_model_env(settings: config.Settings) -> None:
    """Point HuggingFace + espeak + TEMP at reachable/ASCII local resources."""
    tempdir = config.ensure_ascii_tempdir()
    if tempdir:
        logger.info("TEMP 已切换为 ASCII 路径: %s", tempdir)
    if not os.environ.get("HF_ENDPOINT") and not settings.stub_models:
        mirror = os.environ.get("IELTS_COACH_HF_MIRROR", "https://hf-mirror.com").strip()
        if mirror and not _hf_reachable():
            os.environ["HF_ENDPOINT"] = mirror
            logger.info("检测到 huggingface.co 不可直连，已切到镜像 %s", mirror)
    library = config.find_espeak_library()
    if library:
        dll, data = library
        os.environ.setdefault("PHONEMIZER_ESPEAK_LIBRARY", dll)
        if data and Path(data).exists():
            os.environ.setdefault("ESPEAK_DATA_PATH", data)
        espeak_exe = config.find_espeak_ng()
        if espeak_exe:
            os.environ.setdefault("ESPEAK_NG_PATH", espeak_exe)
        logger.info("espeak-ng 使用 %s", dll)
    else:
        logger.warning(config.espeak_install_hint())


_HF_PROBE: bool | None = None


def _hf_reachable(timeout: float = 3.0) -> bool:
    """True when the HuggingFace Hub answers over HTTPS.

    A bare TCP connect is not enough: on this network the socket connects and the
    TLS/HTTP layer is reset (WinError 10054), which made huggingface_hub retry a
    cached lookup five times (~45 s) during warm-up.
    """
    global _HF_PROBE
    if _HF_PROBE is not None:
        return _HF_PROBE
    try:
        import httpx

        with httpx.Client(timeout=timeout, follow_redirects=True) as client:
            response = client.get("https://huggingface.co/api/models?limit=1")
            _HF_PROBE = response.status_code < 500
    except Exception:  # noqa: BLE001
        _HF_PROBE = False
    return _HF_PROBE


class DaemonContext:
    """Holds all long-lived objects (models, db, registry)."""

    def __init__(self, settings: config.Settings | None = None):
        self.settings = settings or config.load_settings()
        self.paths = self.settings.paths.ensure()
        self.db = Database(self.paths.db_path)
        # A dedicated registry per app instance keeps state leaking between
        # daemon instances (e.g. successive test servers, or a restarted app).
        self.registry: LessonRegistry = LessonRegistry()
        self.asr = ASRService(self.settings)
        self.tts = TTSService(self.settings)
        self.vad = VADService(self.settings)
        self.pron = build_pronunciation(self.settings)
        self.bank = QuestionBank()
        self.planner = LessonPlanner(self.bank, self.db)
        self.hints = HintBook()
        # Standalone mode: the desktop window can drive a lesson without an agent.
        self.llm_store = LLMConfigStore(self.paths.home / "llm_config.json")
        self.llm = StandaloneExaminer(
            self.llm_store,
            Path(__file__).resolve().parents[1] / "skills" / "ielts-speaking-coach" / "SKILL.md",
        )
        self.started_at = time.time()
        self.warmup_state: dict[str, Any] = {
            "asr": "pending",
            "tts": "pending",
            "vad": "pending",
            "pronounce": "pending",
        }

    # -- helpers -------------------------------------------------------------
    def companion_url(self, session_id: int | None = None) -> str:
        base = f"http://{self.settings.host}:{self.settings.port}/"
        return f"{base}?session={session_id}" if session_id else base

    def save_user_audio(self, data: bytes, session_id: int, turn_index: int) -> tuple[Any, Any]:
        stamp = time.strftime("%Y%m%d-%H%M%S")
        dest = self.paths.user_audio_dir / f"s{session_id}-t{turn_index}-{stamp}.wav"
        return processor.process_upload(data, dest)

    def resolve_tts(self, text: str, accent: str, speed: float | None = None) -> dict[str, Any]:
        if not self.settings.tts_enabled:
            return {"url": None, "duration_sec": None, "voice": None, "accent": accent, "cached": False}
        if speed is None:
            # The settings drawer's speed slider must affect the examiner's voice.
            try:
                speed = float(self.llm_store.load().get("voice_speed", 1.0))
            except (TypeError, ValueError):
                speed = 1.0
        try:
            return self.tts.synth(text, accent=accent, speed=speed)
        except Exception as exc:  # noqa: BLE001 - never block the turn on TTS
            logger.warning("TTS 合成失败（本轮降级为纯文本）: %s", exc)
            return {
                "url": None,
                "duration_sec": None,
                "voice": self.tts.voice_for(accent),
                "accent": accent,
                "cached": False,
                "error": str(exc),
            }

    async def warmup(self) -> None:
        loop = asyncio.get_running_loop()
        if self.settings.stub_models:
            self.warmup_state = {
                "asr": "stub",
                "tts": "stub",
                "vad": "stub",
                "pronounce": "stub",
            }
            return

        async def run_asr() -> None:
            try:
                result = await loop.run_in_executor(None, self.asr.warmup)
                self.warmup_state["asr"] = "ready" if result.get("ok") else f"error: {result.get('error')}"
            except Exception as exc:  # noqa: BLE001
                self.warmup_state["asr"] = f"error: {exc}"

        async def run_tts() -> None:
            try:
                result = await loop.run_in_executor(None, self.tts.warmup)
                self.warmup_state["tts"] = "ready" if result.get("ok") else f"error: {result.get('error')}"
            except Exception as exc:  # noqa: BLE001
                self.warmup_state["tts"] = f"error: {exc}"

        async def run_vad() -> None:
            try:
                result = await loop.run_in_executor(None, self.vad.warmup)
                self.warmup_state["vad"] = "ready" if result.get("ok") else f"error: {result.get('error')}"
            except Exception as exc:  # noqa: BLE001
                self.warmup_state["vad"] = f"error: {exc}"

        async def run_pron() -> None:
            if not self.settings.pronounce_enabled:
                self.warmup_state["pronounce"] = "disabled"
                return
            try:
                result = await loop.run_in_executor(None, self.pron.warmup)
                self.warmup_state["pronounce"] = (
                    "ready" if result.get("ok") else f"error: {result.get('error')}"
                )
            except Exception as exc:  # noqa: BLE001
                self.warmup_state["pronounce"] = f"error: {exc}"

        # ASR/TTS/VAD share the disk and GPU during load; the phoneme model is the
        # largest checkpoint, so it loads after the first three settle (staggering
        # keeps total warm-up time down and avoids 40 s+ contention stalls).
        await asyncio.gather(run_asr(), run_tts(), run_vad())
        await run_pron()
        logger.info("模型预热完成: %s", self.warmup_state)


#: The MCP bridge object, when mounted over HTTP in this process.
_MCP_HTTP = None

#: probe_id -> {asr, duration, ts}. The live turn-taking probe already transcribed
#: the sentence, so the final upload can skip ASR when the audio is the same length.
_MODEL_DOWNLOADS: dict[str, dict[str, Any]] = {}
_PROBE_CACHE: dict[str, dict[str, Any]] = {}
_PROBE_TTL_SEC = 180.0


def _prune_probe_cache() -> None:
    cutoff = time.time() - _PROBE_TTL_SEC
    for key in [k for k, v in _PROBE_CACHE.items() if v.get("ts", 0) < cutoff]:
        _PROBE_CACHE.pop(key, None)


def create_app(settings: config.Settings | None = None) -> FastAPI:
    ctx = DaemonContext(settings)
    _configure_model_env(ctx.settings)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        logger.info(
            "IELTS Coach daemon 启动: %s:%s device=%s asr=%s",
            ctx.settings.host,
            ctx.settings.port,
            ctx.settings.device,
            ctx.settings.asr_model,
        )
        app.state.ctx = ctx
        task = None
        if ctx.settings.prewarm:
            task = asyncio.create_task(ctx.warmup())
        # Mounted sub-apps do not get their lifespan run by Starlette, so the MCP
        # session manager is entered here; without it /mcp answers 500.
        mcp_cm = None
        if _MCP_HTTP is not None:
            try:
                mcp_cm = _MCP_HTTP.session_manager.run()
                await mcp_cm.__aenter__()
                logger.info("MCP over HTTP 已就绪: /mcp")
            except Exception as exc:  # noqa: BLE001 - HTTP MCP is optional
                logger.warning("MCP over HTTP 启动失败: %s", exc)
                mcp_cm = None
        try:
            yield
        finally:
            if mcp_cm is not None:
                await mcp_cm.__aexit__(None, None, None)
            if task:
                task.cancel()
            ctx.db.close()
            logger.info("IELTS Coach daemon 已停止")

    app = FastAPI(title="IELTS Speaking Coach Daemon", version=config.VERSION, lifespan=lifespan)
    app.state.ctx = ctx

    # MCP over HTTP: hosts that cannot spawn a local stdio process (Doubao Work,
    # Coze, any URL-based MCP client) can point at http://127.0.0.1:<port>/mcp .
    global _MCP_HTTP
    try:
        from mcp_bridge.server import mcp as bridge_mcp

        app.mount(
            "/mcp",
            bridge_mcp.streamable_http_app(streamable_http_path="/", host="127.0.0.1"),
        )
        _MCP_HTTP = bridge_mcp
    except Exception as exc:  # noqa: BLE001
        _MCP_HTTP = None
        logger.warning("MCP over HTTP 挂载失败（stdio 仍可用）: %s", exc)

    @app.middleware("http")
    async def _mcp_canonical_path(request, call_next):
        """Serve /mcp without the trailing-slash redirect.

        Starlette mounts answer /mcp with a 307 to /mcp/, and MCP clients do not
        replay a POST across a redirect, so rewrite the path before routing.
        """
        if request.scope.get("path") == "/mcp":
            request.scope["path"] = "/mcp/"
            request.scope["raw_path"] = b"/mcp/"
        return await call_next(request)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # ------------------------------------------------------------------ #
    # System
    # ------------------------------------------------------------------ #
    @app.get("/health")
    async def health() -> dict[str, Any]:
        return {
            "ok": True,
            "service": "ielts-coach-daemon",
            "app": config.APP_NAME,
            "version": config.VERSION,
            "device": ctx.settings.device,
            "device_name": ctx.settings.device_name,
            "uptime_sec": round(time.time() - ctx.started_at, 1),
            "models": {
                "asr": ctx.asr.status(),
                "tts": ctx.tts.status(),
                "vad": ctx.vad.status(),
                "pronounce": ctx.pron.status(),
            },
            "warmup": ctx.warmup_state,
            "espeak_ng": config.find_espeak_ng(),
            "question_bank": ctx.bank.question_count(),
            "hint_book": ctx.hints.stats(),
            "mcp_http": (
                f"http://{ctx.settings.host}:{ctx.settings.port}/mcp" if _MCP_HTTP else None
            ),
            "db": ctx.db.stats(),
            "active_sessions": [s for s in ctx.registry.all_snapshots() if not s["ended"]],
            "companion_url": ctx.companion_url(),
        }

    @app.get("/api/doctor")
    async def doctor() -> dict[str, Any]:
        report = config.environment_report()
        report["services"] = {"asr": ctx.asr.status(), "tts": ctx.tts.status()}
        return report

    # ------------------------------------------------------------------ #
    # Profile & memory
    # ------------------------------------------------------------------ #
    @app.get("/api/profile")
    async def get_profile() -> dict[str, Any]:
        profile = ctx.db.get_profile()
        profile.update(ctx.llm_store.public_view())
        return profile

    @app.patch("/api/profile")
    async def patch_profile(payload: dict[str, Any] = Body(default={})) -> dict[str, Any]:
        llm_patch = {
            key: value
            for key, value in (payload or {}).items()
            if key.startswith("llm_") or key == "voice_speed"
        }
        rest = {key: value for key, value in (payload or {}).items() if key not in llm_patch}
        profile = ctx.db.update_profile(**rest) if rest else ctx.db.get_profile()
        if llm_patch:
            ctx.llm_store.save(llm_patch)
        profile.update(ctx.llm_store.public_view())
        return profile

    @app.post("/api/llm/test")
    async def llm_test(payload: dict[str, Any] = Body(default={})) -> dict[str, Any]:
        override = {
            key: (payload or {}).get(key)
            for key in ("llm_provider", "llm_base_url", "llm_model", "llm_api_key")
            if (payload or {}).get(key)
        }
        stored = ctx.llm_store.load()
        if not override.get("llm_api_key") and stored["llm_provider"] != "ollama" and not stored["llm_api_key"]:
            return {"ok": False, "message": "还没有填 API Key", "latency_ms": None}
        result = await ctx.llm.test(override or None)
        return result

    @app.get("/api/learner/context")
    async def learner_context() -> dict[str, Any]:
        return ctx.db.get_learner_context()

    @app.get("/api/memory")
    async def list_memory(memory_type: str | None = None, limit: int = 50) -> dict[str, Any]:
        return {"items": ctx.db.list_memory_notes(memory_type, limit)}

    @app.post("/api/memory")
    async def upsert_memory(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
        items = payload.get("memory_items") or payload.get("items") or [payload]
        saved = []
        for item in items:
            saved.append(
                ctx.db.upsert_memory_note(
                    memory_type=item.get("memory_type", "personal_fact"),
                    memory_key=item.get("memory_key", "unspecified"),
                    title=item.get("title", ""),
                    content=item.get("content", ""),
                    mastery_delta=float(item.get("mastery_delta") or 0.0),
                )
            )
        return {"saved": saved, "count": len(saved)}

    # ------------------------------------------------------------------ #
    # Sessions
    # ------------------------------------------------------------------ #
    @app.get("/api/plan")
    async def preview_plan(
        part_mode: str = Query(default="part1"),
        topic_hint: str = Query(default=""),
        seed: int | None = Query(default=None),
    ) -> dict[str, Any]:
        """Preview the next lesson plan without creating a session."""
        plan = ctx.planner.plan(part_mode=part_mode, topic_hint=topic_hint or None, seed=seed)
        return plan.as_dict()

    # ------------------------------------------------------------------ #
    # Standalone driver (no external agent)
    # ------------------------------------------------------------------ #
    async def _push_examiner(
        session_id: int,
        text: str,
        part: str,
        accent: str,
        feedback_payload: dict[str, Any] | None = None,
        turn_id_for_feedback: int | None = None,
    ) -> dict[str, Any]:
        """Speak a question and start waiting for the learner (shared by both modes)."""
        if feedback_payload:
            _apply_feedback(ctx, session_id, turn_id_for_feedback, feedback_payload)
        loop = asyncio.get_running_loop()
        tts_result = await loop.run_in_executor(None, ctx.resolve_tts, text, accent)
        turn = ctx.db.create_turn(
            session_id=session_id,
            part=part,
            examiner_question=text,
            examiner_tts_path=tts_result.get("path"),
        )
        ctx.registry.start_waiting(
            session_id=session_id,
            turn_id=turn["id"],
            examiner_text=text,
            part=part,
            audio_url=tts_result.get("url"),
            audio_duration=tts_result.get("duration_sec"),
        )
        return turn

    async def _standalone_open(session_id: int) -> None:
        """Generate and speak the opening question right after the session exists."""
        try:
            session = ctx.db.get_session(session_id)
            plan = ctx.db.get_lesson_plan(session_id)
            profile = ctx.db.get_profile()
            result = await ctx.llm.first_turn(plan, profile)
            accent = profile.get("accent_preference", "uk")
            await _push_examiner(
                session_id, result["examiner_text"], session.get("part_mode", "part1"), accent
            )
        except Exception as exc:  # noqa: BLE001 - never leave the learner in a dead room
            logger.exception("standalone 开场失败 session=%s", session_id)
            ctx.registry.push_error(
                session_id,
                "开场题生成失败：" + str(exc)[:160] + "。检查设置里的模型与 Key。",
                "open",
            )

    async def _standalone_after(session_id: int, reply: dict[str, Any]) -> None:
        """Feedback card + next question, driven by the configured model."""
        try:
            session = ctx.db.get_session(session_id)
            plan = ctx.db.get_lesson_plan(session_id)
            profile = ctx.db.get_profile()
            accent = profile.get("accent_preference", "uk")
            part = session.get("part_mode", "part1")

            # A spoken stop command ends the lesson immediately.
            if reply.get("intent") == "end_lesson":
                ctx.registry.end_lesson(session_id, reason="voice_stop_command")
                await _standalone_report(session_id)
                return

            turns = ctx.db.list_turns(session_id)
            answered_turns = [
                turn for turn in turns if (turn.get("learner_transcript") or "").strip()
            ]
            history = [
                {"q": turn.get("examiner_question") or "", "a": turn.get("learner_transcript") or ""}
                for turn in answered_turns[-6:]
            ]
            language = str(reply.get("language") or "en")
            # A Chinese question must not burn a planned question.
            question_index = len(answered_turns) if language.lower() in {"en", ""} else max(
                0, len(answered_turns) - 1
            )
            pronunciation = reply.get("pronunciation") or {}
            flagged = [
                word.get("word")
                for word in (pronunciation.get("words") or [])
                if word.get("color") in {"red", "amber"}
            ][:5]
            brief = {
                "overall_score": pronunciation.get("overall_score"),
                "flagged_words": [w for w in flagged if w],
            }
            hints = (reply.get("stuck") or {}).get("hint_words") or []
            result = await ctx.llm.next_turn(
                plan,
                str(reply.get("transcript") or ""),
                reply.get("wpm"),
                brief,
                hints,
                question_index,
                str(session.get("feedback_style") or profile.get("feedback_style") or "instant_card_plus_voice"),
                history=history,
                language=language,
            )
            await _push_examiner(
                session_id,
                result["examiner_text"],
                part,
                accent,
                result.get("feedback_payload"),
                reply.get("turn_id"),
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("standalone 下一轮失败 session=%s", session_id)
            ctx.registry.push_error(
                session_id,
                "这一轮生成失败：" + str(exc)[:160] + "。可以重说，或检查设置。",
                "turn",
            )

    async def _standalone_report(session_id: int) -> None:
        """Score the lesson and persist the report without the agent."""
        try:
            session = ctx.db.get_session(session_id)
            plan = ctx.db.get_lesson_plan(session_id)
            turns = ctx.db.list_turns(session_id)
            context = ctx.db.get_learner_context()
            result = await ctx.llm.report(session, plan, turns, context)
            markdown = result.get("report_markdown") or "本课没有产生可评分的回答。"
            _persist_report(
                session,
                markdown,
                result.get("bands_json") or {},
                result.get("next_lesson_plan") or "",
            )
            # Durable memory: the next lesson's review block is built from this.
            for item in result.get("memory_updates") or []:
                try:
                    title = str(item.get("title") or "")[:120] or "课堂记录"
                    key = str(item.get("memory_key") or "").strip()[:80]
                    if not key:
                        key = re.sub(r"[^a-z0-9]+", "_", title.lower()).strip("_")[:60] or "note"
                    ctx.db.upsert_memory_note(
                        memory_type=str(item.get("memory_type") or "weakness_grammar"),
                        memory_key=key,
                        title=title,
                        content=str(item.get("content") or "")[:600],
                        mastery_delta=float(item.get("mastery_delta") or 0.0),
                    )
                except Exception:  # noqa: BLE001 - memory is best-effort
                    logger.debug("写入记忆失败: %s", item, exc_info=True)
        except Exception as exc:  # noqa: BLE001
            logger.exception("standalone 报告失败 session=%s", session_id)
            ctx.registry.push_error(
                session_id,
                "报告生成失败：" + str(exc)[:160] + "。可以重试结束课程。",
                "report",
            )

    def _persist_report(
        session: dict[str, Any],
        markdown: str,
        bands: dict[str, Any],
        next_plan: str,
    ) -> dict[str, Any]:
        session_id = int(session["id"])
        ctx.registry.end_lesson(session_id, reason="report_saved")
        slug = re.sub(r"[^A-Za-z0-9._-]+", "-", (session.get("topic_title") or "lesson")).strip("-")[:40]
        stamp = time.strftime("%Y%m%d-%H%M%S")
        md_path = ctx.paths.reports_dir / f"{stamp}-s{session_id}-{slug or 'lesson'}.md"
        header = (
            f"# IELTS Speaking Lesson Report\n\n"
            f"- Session ID: {session_id}\n"
            f"- Topic: {session.get('topic_title')}\n"
            f"- Mode: {session.get('part_mode')}\n"
            f"- Started: {session.get('started_at')}\n\n---\n\n"
        )
        md_path.write_text(header + markdown, encoding="utf-8")
        report = ctx.db.save_lesson_report(
            session_id=session_id,
            report_markdown=markdown,
            report_json={"bands": bands, "next_lesson_plan": next_plan},
            markdown_file_path=str(md_path),
            bands=bands,
            next_lesson_plan=next_plan,
            summary={"bands": bands},
        )
        ctx.registry.push_report(
            session_id,
            {
                "report_id": report.get("id"),
                "markdown": markdown,
                "markdown_file_path": str(md_path),
                "bands": bands,
            },
        )
        return {
            "ok": True,
            "report_id": report.get("id"),
            "markdown_file_path": str(md_path),
            "report_url": f"/api/sessions/{session_id}/report",
            "bands": bands,
        }

    @app.post("/api/sessions")
    async def create_session(payload: dict[str, Any] = Body(default={})) -> dict[str, Any]:
        part_mode = payload.get("part_mode", "part1")
        hint = (payload.get("topic_hint") or payload.get("topic_title") or "").strip()
        auto_plan = bool(payload.get("auto_plan", True))
        feedback_style = payload.get("feedback_style") or ctx.db.get_profile().get(
            "feedback_style", "instant_card_plus_voice"
        )
        drive_mode = str(payload.get("drive_mode") or "").strip().lower()
        if drive_mode not in {"mcp", "standalone"}:
            # Explicit value wins; otherwise a configured standalone engine drives.
            drive_mode = "standalone" if ctx.llm.configured() else "mcp"
        accent = str(payload.get("accent") or "").strip().lower()
        if accent in {"uk", "us"}:
            ctx.db.update_profile(accent_preference=accent)

        plan: dict[str, Any] | None = None
        topic_title = hint or "Free practice"
        if auto_plan:
            try:
                lesson = ctx.planner.plan(
                    part_mode=part_mode,
                    topic_hint=hint or None,
                    seed=payload.get("seed"),
                    record_usage=True,
                )
                plan = lesson.as_dict()
                topic_title = (
                    lesson.topic.get("title_zh")
                    or lesson.topic.get("title")
                    or topic_title
                )
            except Exception as exc:  # noqa: BLE001 - never block lesson creation
                logger.warning("生成课程计划失败，退回自由出题: %s", exc)

        session = ctx.db.create_session(
            part_mode=part_mode,
            topic_title=topic_title,
            feedback_style=feedback_style,
            target_band=payload.get("target_band"),
            drive_mode=drive_mode,
        )
        if plan:
            ctx.db.save_lesson_plan(session["id"], plan)
        ctx.registry.get(session["id"])
        if drive_mode == "standalone":
            asyncio.create_task(_standalone_open(session["id"]))
        profile = ctx.db.get_profile()
        profile.update(ctx.llm_store.public_view())
        return {
            "session": session,
            "session_id": session["id"],
            "companion_url": ctx.companion_url(session["id"]),
            "profile": profile,
            "plan": plan,
            "drive_mode": drive_mode,
        }

    @app.get("/api/sessions")
    async def list_sessions(limit: int = 20) -> dict[str, Any]:
        return {"sessions": ctx.db.list_sessions(limit)}

    @app.get("/api/sessions/{session_id}")
    async def get_session(session_id: int) -> dict[str, Any]:
        session = ctx.db.get_session(session_id)
        if not session:
            raise HTTPException(404, f"session {session_id} 不存在")
        state = ctx.registry.peek(session_id)
        return {
            "session": session,
            "turns": ctx.db.list_turns(session_id),
            "state": state.snapshot() if state else None,
            "report": ctx.db.get_lesson_report(session_id),
            "plan": ctx.db.get_lesson_plan(session_id),
            "companion_url": ctx.companion_url(session_id),
        }

    @app.get("/api/sessions/{session_id}/plan")
    async def get_session_plan(session_id: int) -> dict[str, Any]:
        plan = ctx.db.get_lesson_plan(session_id)
        if plan is None:
            return {"ok": False, "error": "该课程没有计划（可能是 Phase 2.5 之前创建的会话）"}
        return plan

    @app.get("/api/sessions/{session_id}/state")
    async def get_state(session_id: int) -> dict[str, Any]:
        state = ctx.registry.get(session_id)
        return state.snapshot()

    def _enrich_turns(turns: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Attach playable URLs; the raw rows only carry file paths."""
        for turn in turns:
            if turn.get("learner_audio_path"):
                turn["learner_audio_url"] = "/api/audio/user/" + Path(
                    turn["learner_audio_path"]
                ).name
            if turn.get("examiner_tts_path"):
                turn["examiner_audio_url"] = "/api/audio/tts/" + Path(
                    turn["examiner_tts_path"]
                ).name
        return turns

    @app.get("/api/sessions/{session_id}/turns")
    async def get_turns(session_id: int) -> dict[str, Any]:
        return {"turns": _enrich_turns(ctx.db.list_turns(session_id))}

    @app.get("/api/sessions/{session_id}/aggregation")
    async def aggregation(session_id: int) -> dict[str, Any]:
        data = ctx.db.get_lesson_aggregation(session_id)
        if not data.get("session"):
            raise HTTPException(404, f"session {session_id} 不存在")
        return data

    @app.get("/api/sessions/{session_id}/bootstrap")
    async def bootstrap(session_id: int) -> dict[str, Any]:
        session = ctx.db.get_session(session_id)
        if not session:
            raise HTTPException(404, f"session {session_id} 不存在")
        state = ctx.registry.get(session_id)
        turns = _enrich_turns(ctx.db.list_turns(session_id))
        profile = ctx.db.get_profile()
        profile.update(ctx.llm_store.public_view())
        return {
            "session": session,
            "state": state.snapshot(),
            "turns": turns,
            "profile": profile,
            "context": ctx.db.get_learner_context(),
            "report": ctx.db.get_lesson_report(session_id),
            "plan": ctx.db.get_lesson_plan(session_id),
            "audio_base": "/api/audio",
        }

    # ------------------------------------------------------------------ #
    # Examiner turn (called by the MCP bridge, not by the learner)
    # ------------------------------------------------------------------ #
    @app.post("/api/sessions/{session_id}/examiner_turn")
    async def examiner_turn(session_id: int, payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
        session = ctx.db.get_session(session_id)
        if not session:
            raise HTTPException(404, f"session {session_id} 不存在")
        state = ctx.registry.get(session_id)
        if state.ended:
            return {
                "status": STATUS_ENDED,
                "session_id": session_id,
                "message": "本课已结束，请生成课后报告。",
            }

        text = (payload.get("text") or "").strip()
        if not text:
            raise HTTPException(400, "examiner_text 不能为空")
        part = payload.get("part") or session.get("part_mode") or "part1"
        if part == "full_mock":
            part = "part1"
        accent = payload.get("accent") or ctx.db.get_profile().get("accent_preference", "uk")

        # 1) persist feedback for the previous learner turn (merged round-trip).
        feedback_summary = None
        feedback_payload = payload.get("feedback_payload")
        turn_id_for_feedback = payload.get("turn_id_for_feedback")
        if feedback_payload:
            feedback_summary = _apply_feedback(
                ctx, session_id, turn_id_for_feedback, feedback_payload
            )

        # 2) create the new examiner turn + narrate it (TTS may hit the network,
        # so keep it off the event loop).
        loop = asyncio.get_running_loop()
        tts_result = await loop.run_in_executor(None, ctx.resolve_tts, text, accent)
        turn = ctx.db.create_turn(
            session_id=session_id,
            part=part,
            examiner_question=text,
            examiner_tts_path=tts_result.get("path"),
        )
        ctx.registry.start_waiting(
            session_id=session_id,
            turn_id=turn["id"],
            examiner_text=text,
            part=part,
            audio_url=tts_result.get("url"),
            audio_duration=tts_result.get("duration_sec"),
        )
        return {
            "status": STATUS_WAITING,
            "session_id": session_id,
            "turn_id": turn["id"],
            "turn_index": turn["turn_index"],
            "part": part,
            "text": text,
            "audio": tts_result,
            "feedback_saved": feedback_summary,
            "max_wait_sec": ctx.settings.max_wait_sec,
        }

    @app.get("/api/internal/sessions/{session_id}/wait")
    async def wait_for_turn(
        session_id: int,
        timeout_sec: int = Query(default=40, ge=1, le=120),
    ) -> dict[str, Any]:
        session = ctx.db.get_session(session_id)
        if not session:
            raise HTTPException(404, f"session {session_id} 不存在")
        capped = min(int(timeout_sec), ctx.settings.max_wait_sec)
        result = await ctx.registry.wait_for_reply(session_id, capped)
        return result

    # ------------------------------------------------------------------ #
    # Recording lifecycle (browser)
    # ------------------------------------------------------------------ #
    @app.post("/api/sessions/{session_id}/recording_start")
    async def recording_start(session_id: int) -> dict[str, Any]:
        state = ctx.registry.mark_recording(session_id)
        return state.snapshot()

    @app.post("/api/sessions/{session_id}/recording_cancel")
    async def recording_cancel(session_id: int) -> dict[str, Any]:
        state = ctx.registry.mark_cancel(session_id)
        return state.snapshot()

    @app.post("/api/sessions/{session_id}/audio")
    async def upload_audio(
        session_id: int,
        request: Request,
        file: UploadFile | None = File(default=None),
        probe_id: str = Form(default=""),
    ) -> dict[str, Any]:
        session = ctx.db.get_session(session_id)
        if not session:
            raise HTTPException(404, f"session {session_id} 不存在")
        state = ctx.registry.get(session_id)
        if state.ended:
            raise HTTPException(409, "本课已结束，无法继续录音")

        if file is None:
            data = await request.body()
        else:
            data = await file.read()
        if not data:
            raise HTTPException(400, "没有收到音频数据")

        loop = asyncio.get_running_loop()
        ctx.registry.mark_processing(session_id, "正在识别语音…")
        try:
            info, _samples = await loop.run_in_executor(
                None, lambda: ctx.save_user_audio(data, session_id, state.current_turn_id or 0)
            )
        except processor.InvalidAudioError as exc:
            ctx.registry.mark_cancel(session_id)
            raise HTTPException(400, str(exc)) from exc
        except Exception as exc:  # noqa: BLE001
            ctx.registry.mark_cancel(session_id)
            raise HTTPException(400, f"音频处理失败: {exc}") from exc

        state.set_status("processing", last_error=None)
        # ASR and the acoustic phoneme forward pass are independent: run both at once,
        # then only the cheap forced alignment has to wait for the transcript.
        # The live probe already transcribed this sentence; reuse it when the audio
        # is the same length, which saves one ASR pass (~300 ms) per turn.
        _prune_probe_cache()
        cached = _PROBE_CACHE.get(probe_id) if probe_id else None
        pron_future = loop.run_in_executor(None, ctx.pron.prepare, info.path)
        if cached and abs(float(cached.get("duration", 0.0)) - info.duration_sec) <= 1.8:
            asr_result = dict(cached["asr"])
            asr_result["reused_from_probe"] = True
            try:
                await pron_future
            except Exception:  # noqa: BLE001 - pronunciation stays best-effort
                pass
        else:
            asr_future = loop.run_in_executor(None, ctx.asr.transcribe, info.path)
            try:
                asr_result = await asr_future
            except Exception as exc:  # noqa: BLE001
                logger.exception("ASR 失败")
                try:
                    await pron_future
                except Exception:  # noqa: BLE001
                    pass
                ctx.registry.mark_cancel(session_id)
                raise HTTPException(500, f"语音识别失败: {exc}") from exc

        pron_prepared = None
        try:
            pron_prepared = await pron_future
        except Exception as exc:  # noqa: BLE001 - pronunciation is best-effort
            logger.warning("音素前向推理失败（本轮跳过发音评分）: %s", exc)

        # Did the learner visibly stall? Hints come from the current topic's tags.
        stuck = None
        try:
            plan = ctx.db.get_lesson_plan(session_id) or {}
            tags = (plan.get("topic") or {}).get("tags") or []
            transcripts = [row.get("learner_transcript") or "" for row in ctx.db.list_turns(session_id)]
            candidates = ctx.hints.words_for(tags, exclude=used_words(transcripts), limit=3)
            stuck = analyze_stuck(asr_result, candidates)
        except Exception as exc:  # noqa: BLE001 - never block the turn
            logger.debug("卡壳分析失败: %s", exc)

        turn_id = state.current_turn_id
        if turn_id is None:
            turn = ctx.db.create_turn(
                session_id=session_id,
                part=state.current_part,
                examiner_question="(未记录考官问题)",
            )
            turn_id = turn["id"]
            state.current_turn_id = turn_id

        ctx.db.update_turn(
            turn_id,
            learner_audio_path=info.path,
            learner_duration_sec=info.duration_sec,
            learner_transcript=asr_result.get("text", ""),
            wpm=asr_result.get("wpm"),
            pause_count=asr_result.get("pause_count", 0),
            long_pauses_json={
                "pauses": asr_result.get("long_pauses", []),
                "stuck": stuck,
                "filler_words": asr_result.get("filler_words", {}),
                "filler_total": asr_result.get("filler_total", 0),
                "effective_duration_sec": asr_result.get("effective_duration_sec"),
                "word_count": asr_result.get("word_count"),
                "asr_elapsed_sec": asr_result.get("asr_elapsed_sec"),
            },
        )

        pronunciation = None
        language = str(asr_result.get("language") or "en").lower()
        if pron_prepared is not None and language not in {"en", ""}:
            logger.info("检测到 %s 语音，跳过英文音素评分", language)
            pron_prepared = None
        if pron_prepared is not None:
            try:
                accent = ctx.db.get_profile().get("accent_preference", "uk")
                pronunciation = await loop.run_in_executor(
                    None,
                    ctx.pron.score_prepared,
                    pron_prepared,
                    asr_result.get("text", ""),
                    asr_result.get("words", []),
                    accent,
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning("GOP 评分失败: %s", exc)
                pronunciation = None
        if pronunciation:
            ctx.db.update_turn(
                turn_id,
                pronunciation_score=pronunciation.get("overall_score"),
                pronunciation_json=pronunciation,
            )
            for flagged in pronunciation.get("flagged_words", []):
                for issue in flagged.get("issues", []) or []:
                    ctx.db.add_pronunciation_issue(
                        session_id,
                        turn_id,
                        word=flagged.get("word", ""),
                        expected_ipa=flagged.get("ipa"),
                        phoneme=issue.get("phoneme", ""),
                        issue_type=issue.get("issue_type", "phoneme_distortion"),
                        gop_score=issue.get("gop_score"),
                        word_score=flagged.get("score"),
                        audio_start_sec=issue.get("start_sec"),
                        audio_end_sec=issue.get("end_sec"),
                    )

        payload = {
            "status": "learner_replied",
            "session_id": session_id,
            "phase": 2,
            "turn": {
                "turn_id": turn_id,
                "turn_index": ctx.db.get_turn(turn_id).get("turn_index") if ctx.db.get_turn(turn_id) else None,
                "part": state.current_part,
                "examiner_question": state.examiner_text,
                "transcript": asr_result.get("text", ""),
                "audio_path": info.path,
                "audio_url": "/api/audio/user/" + Path(info.path).name,
                "duration_sec": info.duration_sec,
                "duration_raw_sec": asr_result.get("duration_sec"),
                "wpm": asr_result.get("wpm"),
                "word_count": asr_result.get("word_count"),
                "pause_count": asr_result.get("pause_count"),
                "pauses": asr_result.get("long_pauses"),
                "filler_words": asr_result.get("filler_words"),
                "filler_total": asr_result.get("filler_total"),
                "effective_duration_sec": asr_result.get("effective_duration_sec"),
                "speech_ratio": asr_result.get("speech_ratio"),
                "asr_elapsed_sec": asr_result.get("asr_elapsed_sec"),
                "pronunciation_score": (pronunciation or {}).get("overall_score"),
                "pronunciation_elapsed_sec": (pronunciation or {}).get("elapsed_sec"),
                "warning": info.warning,
            },
            "stuck": stuck,
            "pronunciation": pronunciation,
            "pronunciation_note": None
            if pronunciation
            else "本轮声学音素评测不可用（模型未加载或无对齐结果），仅返回文本与流利度分析。",
        }
        # convenience aliases for agents that read the payload flat
        payload.update(
            {
                "turn_id": turn_id,
                "transcript": asr_result.get("text", ""),
                "duration_sec": info.duration_sec,
                "wpm": asr_result.get("wpm"),
                "pauses": asr_result.get("long_pauses"),
                "asr_reused": bool(asr_result.get("reused_from_probe")),
                "language": language,
                "intent": "end_lesson" if is_stop_command(asr_result.get("text", "")) else None,
            }
        )
        ctx.registry.deliver_reply(session_id, payload)
        if (session.get("drive_mode") or "mcp") == "standalone":
            # The lesson keeps going without an agent: feedback card, then next question.
            asyncio.create_task(_standalone_after(session_id, payload))
        return {"status": "processed", **payload}

    # ------------------------------------------------------------------ #
    # Turn-taking probe: "is this sentence finished, or is the learner stuck?"
    # ------------------------------------------------------------------ #
    @app.post("/api/sessions/{session_id}/probe")
    async def probe_turn(
        session_id: int,
        request: Request,
        file: UploadFile | None = File(default=None),
        pause_sec: float = 0.0,
    ) -> dict[str, Any]:
        """Transcribe the audio so far and judge sentence completeness.

        Called on short pauses while the learner is still recording. It never
        creates or updates a turn: the answer is only "keep listening" or "this
        sentence can stand alone, submit it".
        """
        session = ctx.db.get_session(session_id)
        if not session:
            raise HTTPException(404, f"session {session_id} 不存在")
        data = await (file.read() if file is not None else request.body())
        if not data:
            raise HTTPException(400, "没有收到音频数据")

        loop = asyncio.get_running_loop()

        def _work() -> dict[str, Any]:
            info, _samples = processor.process_upload(
                data, ctx.settings.paths.user_audio_dir / f"probe-{session_id}.wav"
            )
            asr_result = ctx.asr.transcribe(info.path)
            transcript = (asr_result.get("text") or "").strip()
            verdict = analyze_completeness(
                transcript,
                pause_sec=pause_sec,
                language=str(asr_result.get("language") or "en"),
            )
            hints: list[str] = []
            if verdict["stuck"]:
                try:
                    plan = ctx.db.get_lesson_plan(session_id) or {}
                    tags = (plan.get("topic") or {}).get("tags") or []
                    rows = ctx.db.list_turns(session_id)
                    used = used_words([row.get("learner_transcript") or "" for row in rows])
                    hints = ctx.hints.words_for(tags, exclude=used, limit=3)
                except Exception:  # noqa: BLE001
                    hints = []
            return {
                "transcript": transcript,
                "word_count": len(transcript.split()),
                "language": str(asr_result.get("language") or "en"),
                **verdict,
                "hint_words": hints,
                "_asr": asr_result,
                "_duration": info.duration_sec,
            }

        outcome = await loop.run_in_executor(None, _work)
        asr_payload = outcome.pop("_asr", None)
        duration = outcome.pop("_duration", 0.0)
        if asr_payload is not None:
            _prune_probe_cache()
            probe_id = uuid.uuid4().hex
            _PROBE_CACHE[probe_id] = {
                "asr": asr_payload,
                "duration": float(duration or 0.0),
                "ts": time.time(),
            }
            outcome["probe_id"] = probe_id
        return outcome

    # ------------------------------------------------------------------ #
    # Shadowing: score one sentence against the text the learner MEANT to say
    # ------------------------------------------------------------------ #
    @app.post("/api/sessions/{session_id}/practice_sentence")
    async def practice_sentence(
        session_id: int,
        request: Request,
        file: UploadFile | None = File(default=None),
        target_text: str = Form(default=""),
        accent: str = Form(default=""),
    ) -> dict[str, Any]:
        """Force-align the recording against target_text (not the ASR guess).

        In free conversation the ASR can "hear" the wrong word and then GOP scores
        the wrong pronunciation highly. Here the target is known, so a learner who
        says /sɪŋk/ for "think" gets a low /θ/ score and the right hint.

        Deliberately does not create a turn: shadowing must not skew the lesson
        report's turn count or fluency stats.
        """
        session = ctx.db.get_session(session_id)
        if not session:
            raise HTTPException(404, f"session {session_id} 不存在")
        target = (target_text or "").strip()
        if not target:
            raise HTTPException(400, "target_text 不能为空")
        data = await (file.read() if file is not None else request.body())
        if not data:
            raise HTTPException(400, "没有收到音频数据")

        loop = asyncio.get_running_loop()

        def _work() -> dict[str, Any]:
            accent_used = (accent or ctx.db.get_profile().get("accent_preference") or "uk").strip()
            info, _ = processor.process_upload(
                data, ctx.paths.user_audio_dir / f"practice-{session_id}-{uuid.uuid4().hex[:8]}.wav"
            )
            prepared = ctx.pron.prepare(info.path)
            pronunciation = ctx.pron.score_prepared(
                prepared, target, words=None, accent=accent_used
            )
            asr_result = ctx.asr.transcribe(info.path)
            return {
                "ok": pronunciation is not None,
                "target_text": target,
                "transcript": asr_result.get("text", ""),
                "language": str(asr_result.get("language") or "en"),
                "audio_url": "/api/audio/user/" + Path(info.path).name,
                "duration_sec": info.duration_sec,
                "pronunciation": pronunciation,
                "wpm": asr_result.get("wpm"),
            }

        return await loop.run_in_executor(None, _work)

    # ------------------------------------------------------------------ #
    # Feedback / end / report
    # ------------------------------------------------------------------ #
    @app.post("/api/sessions/{session_id}/feedback")
    async def push_feedback(session_id: int, payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
        feedback = payload.get("feedback_payload") or payload.get("feedback") or payload
        turn_id = payload.get("turn_id")
        saved = _apply_feedback(ctx, session_id, turn_id, feedback)
        return {"ok": True, "saved": saved}

    @app.post("/api/sessions/{session_id}/end")
    async def end_lesson(session_id: int, payload: dict[str, Any] = Body(default={})) -> dict[str, Any]:
        session = ctx.db.get_session(session_id)
        if not session:
            raise HTTPException(404, f"session {session_id} 不存在")
        state = ctx.registry.end_lesson(session_id, reason=payload.get("reason", "user_clicked_end"))
        if (session.get("drive_mode") or "mcp") == "standalone":
            asyncio.create_task(_standalone_report(session_id))
        return {"status": STATUS_ENDED, "state": state.snapshot(), "session_id": session_id}

    @app.post("/api/sessions/{session_id}/report")
    async def save_report(session_id: int, payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
        session = ctx.db.get_session(session_id)
        if not session:
            raise HTTPException(404, f"session {session_id} 不存在")
        markdown = payload.get("report_markdown") or ""
        if not markdown.strip():
            raise HTTPException(400, "report_markdown 不能为空")
        bands = payload.get("bands_json") or {}
        next_plan = payload.get("next_lesson_plan") or ""
        return _persist_report(session, markdown, bands, next_plan)

    @app.get("/api/sessions/{session_id}/report")
    async def get_report(session_id: int) -> dict[str, Any]:
        report = ctx.db.get_lesson_report(session_id)
        if not report:
            raise HTTPException(404, "该课程还没有生成报告")
        return report

    # ------------------------------------------------------------------ #
    # Microphone / pipeline self-test (no session, no database writes)
    # ------------------------------------------------------------------ #
    @app.post("/api/selftest/audio")
    async def selftest_audio(
        request: Request,
        file: UploadFile | None = File(default=None),
        accent: str = Query(default="uk"),
    ) -> dict[str, Any]:
        """One-shot mic check: 16k WAV -> ASR -> fluency -> GOP, with timings.

        Deliberately stateless so the user can verify the microphone, Whisper and
        the phoneme engine before starting a lesson (or without an agent at all).
        """
        data = await file.read() if file is not None else await request.body()
        if not data:
            raise HTTPException(400, "没有收到音频数据")

        stamp = time.strftime("%Y%m%d-%H%M%S")
        dest = ctx.paths.user_audio_dir / f"selftest-{stamp}.wav"
        loop = asyncio.get_running_loop()
        try:
            info, _samples = await loop.run_in_executor(
                None, lambda: processor.process_upload(data, dest)
            )
        except processor.InvalidAudioError as exc:
            raise HTTPException(400, str(exc)) from exc

        asr_started = time.time()
        asr_future = loop.run_in_executor(None, ctx.asr.transcribe, info.path)
        pron_future = loop.run_in_executor(None, ctx.pron.prepare, info.path)
        asr_result = await asr_future
        asr_sec = round(time.time() - asr_started, 2)
        prepared = await pron_future

        pronunciation = None
        gop_sec = 0.0
        if prepared is not None:
            started = time.time()
            pronunciation = await loop.run_in_executor(
                None,
                ctx.pron.score_prepared,
                prepared,
                asr_result.get("text", ""),
                asr_result.get("words", []),
                accent,
            )
            gop_sec = round(time.time() - started, 2)

        return {
            "ok": True,
            "transcript": asr_result.get("text", ""),
            "wpm": asr_result.get("wpm"),
            "word_count": asr_result.get("word_count"),
            "pause_count": asr_result.get("pause_count"),
            "pauses": asr_result.get("long_pauses", []),
            "filler_words": asr_result.get("filler_words", {}),
            "duration_sec": info.duration_sec,
            "audio_url": "/api/audio/user/" + Path(info.path).name,
            "pronunciation": pronunciation,
            "timings": {
                "asr_sec": asr_sec,
                "gop_sec": gop_sec,
                "acoustic_forward_sec": (prepared or {}).get("forward_sec"),
                "total_sec": round(asr_sec + gop_sec, 2),
            },
            "models": {
                "asr": ctx.asr.model_name,
                "pronounce": ctx.settings.pronounce_model,
                "device": ctx.settings.device,
            },
        }

    # ------------------------------------------------------------------ #
    # TTS helper endpoints
    # ------------------------------------------------------------------ #
    @app.get("/api/tts/word")
    async def tts_word(
        text: str = Query(..., min_length=1, max_length=120),
        accent: str = Query(default="uk"),
    ) -> dict[str, Any]:
        loop = asyncio.get_running_loop()
        try:
            return await loop.run_in_executor(None, lambda: ctx.resolve_tts(text, accent))
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(500, f"示范音合成失败: {exc}") from exc

    @app.get("/api/tts/say")
    async def tts_say(
        text: str = Query(..., min_length=1, max_length=800),
        accent: str = Query(default="uk"),
    ) -> dict[str, Any]:
        loop = asyncio.get_running_loop()
        try:
            return await loop.run_in_executor(None, lambda: ctx.resolve_tts(text, accent))
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(500, f"语音合成失败: {exc}") from exc

    # ------------------------------------------------------------------ #
    # Model management (bundled models are optional, never forced)
    # ------------------------------------------------------------------ #
    @app.get("/api/models/status")
    async def models_status() -> dict[str, Any]:
        bundled = bool(os.environ.get("IELTS_COACH_MODELS", "").strip())
        return {
            "bundled": bundled,
            "models_dir": str(ctx.paths.models_dir),
            "models": {
                "asr": {
                    "name": ctx.asr.model_name,
                    "ready": ctx.asr.is_ready(),
                    "language": ctx.settings.asr_language,
                },
                "tts": {
                    "name": ctx.settings.tts_engine,
                    "ready": ctx.tts.resolved_engine in {"edge", "kokoro"},
                },
                "pronunciation": {
                    "name": ctx.settings.pronounce_model,
                    "ready": ctx.pron.is_ready(),
                },
            },
            "downloads": _MODEL_DOWNLOADS,
        }

    @app.post("/api/models/download")
    async def models_download(payload: dict[str, Any] = Body(default={})) -> dict[str, Any]:
        """Download a missing model into the user models dir (never into git)."""
        kind = str(payload.get("kind") or "asr").lower()
        repos = {
            "asr": str(payload.get("model") or "Systran/faster-whisper-small"),
        }
        if kind not in repos:
            raise HTTPException(400, "kind 只支持 asr（语音模型）")
        repo_id = repos[kind]
        current = _MODEL_DOWNLOADS.get(kind)
        if current and current.get("state") == "running":
            return {"ok": True, "already_running": True, **current}
        target = ctx.paths.models_dir
        job = {"state": "running", "repo": repo_id, "started_at": time.time()}
        _MODEL_DOWNLOADS[kind] = job

        def _download() -> None:
            try:
                from huggingface_hub import snapshot_download

                path = snapshot_download(repo_id, cache_dir=str(target))
                job.update({"state": "done", "path": path, "finished_at": time.time()})
            except Exception as exc:  # noqa: BLE001
                job.update({"state": "error", "error": str(exc), "finished_at": time.time()})

        asyncio.get_running_loop().run_in_executor(None, _download)
        return {"ok": True, "started": True, **job}

    @app.get("/api/audio/tts/{filename}")
    async def serve_tts(filename: str) -> FileResponse:
        path = (ctx.paths.tts_cache_dir / filename).resolve()
        if not str(path).startswith(str(ctx.paths.tts_cache_dir.resolve())) or not path.is_file():
            raise HTTPException(404, "音频不存在")
        return FileResponse(path, media_type="audio/wav", filename=filename)

    @app.get("/api/audio/user/{filename}")
    async def serve_user_audio(filename: str) -> FileResponse:
        path = (ctx.paths.user_audio_dir / filename).resolve()
        if not str(path).startswith(str(ctx.paths.user_audio_dir.resolve())) or not path.is_file():
            raise HTTPException(404, "录音不存在")
        return FileResponse(path, media_type="audio/wav", filename=filename)

    # ------------------------------------------------------------------ #
    # WebSocket fan-out
    # ------------------------------------------------------------------ #
    @app.websocket("/ws/{session_id}")
    async def websocket_endpoint(websocket: WebSocket, session_id: int) -> None:
        await websocket.accept()
        queue = ctx.registry.subscribe(session_id)
        state = ctx.registry.get(session_id)
        try:
            await websocket.send_json(
                {"type": "hello", "state": state.snapshot(), "server_time": time.time()}
            )
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=20.0)
                    await websocket.send_json(event)
                except asyncio.TimeoutError:
                    await websocket.send_json({"type": "ping", "ts": time.time()})
        except WebSocketDisconnect:
            pass
        except Exception as exc:  # noqa: BLE001
            logger.debug("WebSocket 关闭 session=%s: %s", session_id, exc)
        finally:
            ctx.registry.unsubscribe(session_id, queue)

    # ------------------------------------------------------------------ #
    # Live VAD socket: hands-free end-of-utterance detection
    # ------------------------------------------------------------------ #
    @app.websocket("/ws/live/{session_id}")
    async def live_vad_socket(websocket: WebSocket, session_id: int) -> None:
        """Browser streams 32 ms int16 frames; Silero VAD decides when to cut.

        Server-side detection keeps one source of truth for the "done speaking"
        threshold: the same model also runs on file uploads for diagnostics.
        """
        await websocket.accept()
        detector = StreamingVAD.from_settings(ctx.vad)
        available = ctx.vad.available
        try:
            await websocket.send_json(
                {
                    "type": "ready",
                    "session_id": session_id,
                    "available": available,
                    "frame_samples": FRAME_SAMPLES,
                    "silence_sec": detector.silence_sec,
                    "threshold": detector.threshold,
                    "fallback": None if available else "client_energy_vad",
                }
            )
            buffer = np.zeros(0, dtype=np.float32)
            tick = 0
            while True:
                message = await websocket.receive()
                if message.get("type") == "websocket.disconnect":
                    break
                if message.get("text"):
                    try:
                        command = json.loads(message["text"])
                    except json.JSONDecodeError:
                        continue
                    kind = command.get("type")
                    if kind == "reset":
                        detector.reset()
                        buffer = np.zeros(0, dtype=np.float32)
                        await websocket.send_json({"type": "reset", "ok": True})
                    elif kind == "flush":
                        await websocket.send_json(detector.flush())
                    elif kind == "config":
                        if command.get("silence_sec"):
                            detector.silence_sec = max(0.5, float(command["silence_sec"]))
                        # V1.1: the learner ends the answer, not a timer. The detector
                        # still reports "stuck" so the UI can offer hints.
                        if "manual" in command:
                            detector.cut_on_silence = not bool(command["manual"])
                        if "cut_on_silence" in command:
                            detector.cut_on_silence = bool(command["cut_on_silence"])
                        await websocket.send_json(
                            {
                                "type": "config",
                                "silence_sec": detector.silence_sec,
                                "cut_on_silence": detector.cut_on_silence,
                            }
                        )
                    continue

                raw = message.get("bytes")
                if not raw:
                    continue
                buffer = np.concatenate([buffer, pcm16_to_float(raw)])
                events: list[dict[str, Any]] = []
                while buffer.size >= FRAME_SAMPLES:
                    frame = buffer[:FRAME_SAMPLES]
                    buffer = buffer[FRAME_SAMPLES:]
                    event = detector.push(frame)
                    tick += 1
                    if event["should_stop"] or tick % 4 == 0:
                        events.append(event)
                    if event["should_stop"]:
                        detector.reset()
                        tick = 0
                for event in events:
                    await websocket.send_json(event)
        except WebSocketDisconnect:
            pass
        except Exception as exc:  # noqa: BLE001
            logger.debug("live VAD socket closed session=%s: %s", session_id, exc)
        finally:
            try:
                await websocket.close()
            except RuntimeError:
                pass

    # ------------------------------------------------------------------ #
    # Companion UI (built assets live in daemon/static)
    # ------------------------------------------------------------------ #
    if (STATIC_DIR / "assets").is_dir():
        app.mount("/assets", StaticFiles(directory=str(STATIC_DIR / "assets")), name="assets")
    if STATIC_DIR.is_dir():
        app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

    @app.get("/", response_class=HTMLResponse)
    async def index() -> Any:
        index_file = STATIC_DIR / "index.html"
        if index_file.is_file():
            return HTMLResponse(index_file.read_text(encoding="utf-8"))
        return HTMLResponse(
            "<h1>IELTS Coach daemon is running</h1>"
            "<p>伴生网页尚未构建。请在项目根目录执行 <code>npm --prefix web_src install && "
            "npm --prefix web_src run build</code>。</p>",
            status_code=200,
        )

    @app.exception_handler(processor.InvalidAudioError)
    async def _invalid_audio(_request: Request, exc: processor.InvalidAudioError) -> JSONResponse:
        return JSONResponse(status_code=400, content={"detail": str(exc)})

    return app


def _apply_feedback(
    ctx: DaemonContext,
    session_id: int,
    turn_id: int | None,
    feedback: dict[str, Any],
) -> dict[str, Any]:
    """Persist an instant-correction card (and its grammar mistakes)."""
    if not isinstance(feedback, dict):
        return {"turn_id": turn_id, "saved": False, "reason": "empty"}
    target_turn = None
    if turn_id:
        target_turn = ctx.db.get_turn(int(turn_id))
    if target_turn is None:
        turns = ctx.db.list_turns(session_id)
        for candidate in reversed(turns):
            if candidate.get("learner_transcript"):
                target_turn = candidate
                break
    if target_turn is None:
        return {"turn_id": None, "saved": False, "reason": "no learner turn yet"}

    mistakes = feedback.get("grammar_mistakes") or []
    if isinstance(mistakes, dict):
        mistakes = [mistakes]
    saved_mistakes = ctx.db.add_grammar_mistakes(session_id, target_turn["id"], mistakes)
    ctx.db.update_turn(
        target_turn["id"],
        corrected_text=feedback.get("corrected_text"),
        upgraded_text=feedback.get("upgraded_text"),
        grammar_feedback_json=feedback,
        pronunciation_feedback_json=feedback.get("pronunciation_tips"),
    )
    card = {
        "turn_id": target_turn["id"],
        "turn_index": target_turn.get("turn_index"),
        **feedback,
    }
    ctx.registry.push_feedback(session_id, card)
    return {
        "turn_id": target_turn["id"],
        "saved": True,
        "grammar_mistakes": len(saved_mistakes),
    }


def __getattr__(name: str) -> Any:
    """Lazily build the ASGI app so importing this module has no side effects.

    uvicorn's "daemon.main:app" import string still works (it getattr's us).
    """
    if name == "app":
        return create_app()
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="IELTS Speaking Coach daemon")
    parser.add_argument("--host", default=None)
    parser.add_argument("--port", type=int, default=None)
    parser.add_argument("--doctor", action="store_true", help="打印环境自检后退出")
    parser.add_argument("--no-prewarm", action="store_true", help="不在启动时预热模型")
    parser.add_argument("--reload", action="store_true")
    args = parser.parse_args(argv)

    if args.doctor:
        report = config.environment_report()
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0

    if args.no_prewarm:
        os.environ["IELTS_COACH_NO_PREWARM"] = "1"
    settings = config.load_settings()
    if args.host:
        settings.host = args.host
    if args.port:
        settings.port = args.port

    import uvicorn

    target = "daemon.main:app" if args.reload else create_app(settings)
    uvicorn.run(
        target,
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level.lower(),
        reload=args.reload,
        access_log=False,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
