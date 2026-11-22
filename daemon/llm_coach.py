"""Standalone coach: drive a lesson with an OpenAI-compatible chat model.

The MCP path needs an external agent to call back after every answer. This module
lets the desktop app run a lesson by itself: it asks the configured model for the
examiner line plus the correction card, then the daemon speaks it with local TTS.

Secrets stay on disk: the API key is never returned by GET /api/profile and never
logged.
"""

from __future__ import annotations

import json
import logging
import re
import time
from pathlib import Path
from typing import Any

import httpx

logger = logging.getLogger(__name__)

DEFAULT_BASE_URL = "https://api.deepseek.com/v1"
DEFAULT_MODEL = "deepseek-chat"
PROVIDERS = {"deepseek", "openai_compatible", "ollama"}
WRITABLE = {"llm_mode", "llm_provider", "llm_base_url", "llm_model", "llm_api_key", "voice_speed"}


def _defaults() -> dict[str, Any]:
    return {
        "llm_mode": "mcp",
        "llm_provider": "deepseek",
        "llm_base_url": DEFAULT_BASE_URL,
        "llm_model": DEFAULT_MODEL,
        "llm_api_key": "",
        "voice_speed": 1.0,
    }


class LLMConfigStore:
    """JSON file at ~/.ielts-coach/llm_config.json with a masked public view."""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self._data: dict[str, Any] | None = None

    def load(self) -> dict[str, Any]:
        if self._data is None:
            data = _defaults()
            try:
                if self.path.is_file():
                    stored = json.loads(self.path.read_text(encoding="utf-8"))
                    if isinstance(stored, dict):
                        for key in WRITABLE:
                            if key in stored:
                                data[key] = stored[key]
            except Exception as exc:  # noqa: BLE001
                logger.warning("读取 llm_config 失败，使用默认值: %s", exc)
            self._data = data
        return dict(self._data)

    def save(self, patch: dict[str, Any]) -> dict[str, Any]:
        data = self.load()
        for key in WRITABLE:
            if key not in patch:
                continue
            value = patch[key]
            if key == "voice_speed":
                try:
                    value = max(0.85, min(1.15, float(value)))
                except (TypeError, ValueError):
                    continue
            elif key == "llm_provider":
                value = str(value or "").strip().lower()
                if value not in PROVIDERS:
                    continue
            elif key == "llm_mode":
                value = str(value or "").strip().lower()
                if value not in {"mcp", "standalone"}:
                    continue
            else:
                value = str(value or "").strip()
            data[key] = value
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        self._data = data
        return dict(data)

    @staticmethod
    def masked_key(key: str) -> str:
        key = (key or "").strip()
        if not key:
            return ""
        if len(key) <= 8:
            return "****"
        return key[:3] + "****" + key[-4:]

    def public_view(self) -> dict[str, Any]:
        data = self.load()
        return {
            "llm_mode": data["llm_mode"],
            "llm_provider": data["llm_provider"],
            "llm_base_url": data["llm_base_url"],
            "llm_model": data["llm_model"],
            "voice_speed": data["voice_speed"],
            "has_api_key": bool(data["llm_api_key"]),
            "api_key_masked": self.masked_key(data["llm_api_key"]),
        }

    def is_configured(self) -> bool:
        data = self.load()
        if data["llm_mode"] != "standalone":
            return False
        if data["llm_provider"] == "ollama":
            return bool(data["llm_base_url"] and data["llm_model"])
        return bool(data["llm_api_key"] and data["llm_model"])


def _extract_json(text: str) -> dict[str, Any] | None:
    """Parse a JSON object out of a model reply that may be fenced or chatty."""
    body = (text or "").strip()
    if not body:
        return None
    fence = re.search(r"[\x60]{3}(?:json)?\s*(.+?)[\x60]{3}", body, re.S)
    if fence:
        body = fence.group(1).strip()
    try:
        value = json.loads(body)
        return value if isinstance(value, dict) else None
    except json.JSONDecodeError:
        pass
    start = body.find("{")
    if start == -1:
        return None
    depth = 0
    for index in range(start, len(body)):
        char = body[index]
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                try:
                    value = json.loads(body[start : index + 1])
                    return value if isinstance(value, dict) else None
                except json.JSONDecodeError:
                    return None
    return None

class StandaloneExaminer:
    """Calls an OpenAI-compatible /chat/completions endpoint."""

    def __init__(self, store: LLMConfigStore, skill_path: str | Path) -> None:
        self.store = store
        self.skill_path = Path(skill_path)
        self._skill: str | None = None

    def skill_text(self) -> str:
        if self._skill is None:
            try:
                self._skill = self.skill_path.read_text(encoding="utf-8")
            except Exception as exc:  # noqa: BLE001
                logger.warning("读取 SKILL.md 失败: %s", exc)
                self._skill = ""
        return self._skill

    def configured(self) -> bool:
        return self.store.is_configured()

    def _config(self, override: dict[str, Any] | None = None) -> dict[str, Any]:
        data = self.store.load()
        if override:
            for key in ("llm_provider", "llm_base_url", "llm_model", "llm_api_key"):
                if override.get(key):
                    data[key] = str(override[key]).strip()
        return data

    async def chat(
        self,
        messages: list[dict[str, str]],
        override: dict[str, Any] | None = None,
        timeout: float = 45.0,
        json_mode: bool = True,
    ) -> str:
        cfg = self._config(override)
        base = (cfg["llm_base_url"] or DEFAULT_BASE_URL).rstrip("/")
        url = base + "/chat/completions"
        headers = {"Content-Type": "application/json"}
        if cfg["llm_provider"] != "ollama" and cfg["llm_api_key"]:
            headers["Authorization"] = "Bearer " + cfg["llm_api_key"]
        body: dict[str, Any] = {
            "model": cfg["llm_model"] or DEFAULT_MODEL,
            "messages": messages,
            "temperature": 0.7,
        }
        if json_mode and cfg["llm_provider"] != "ollama":
            body["response_format"] = {"type": "json_object"}
        async with httpx.AsyncClient(timeout=httpx.Timeout(timeout, connect=10.0)) as client:
            try:
                response = await client.post(url, json=body, headers=headers)
            except httpx.HTTPError as exc:
                raise RuntimeError("连接模型失败: " + str(exc)) from exc
            if response.status_code == 400 and "response_format" in body:
                body.pop("response_format", None)
                response = await client.post(url, json=body, headers=headers)
        if response.status_code >= 400:
            raise RuntimeError("模型返回 " + str(response.status_code) + ": " + response.text[:300])
        payload = response.json()
        try:
            return str(payload["choices"][0]["message"]["content"] or "")
        except (KeyError, IndexError) as exc:
            raise RuntimeError("模型响应格式异常") from exc

    async def chat_json(
        self,
        system: str,
        user: str,
        override: dict[str, Any] | None = None,
        timeout: float = 45.0,
    ) -> dict[str, Any]:
        text = await self.chat(
            [{"role": "system", "content": system}, {"role": "user", "content": user}],
            override=override,
            timeout=timeout,
        )
        parsed = _extract_json(text)
        if parsed is None:
            raise RuntimeError("模型没有返回 JSON: " + text[:200])
        return parsed

    async def test(self, override: dict[str, Any] | None = None) -> dict[str, Any]:
        started = time.perf_counter()
        try:
            text = await self.chat(
                [
                    {"role": "system", "content": "Reply with the single word: ok"},
                    {"role": "user", "content": "ping"},
                ],
                override=override,
                timeout=20.0,
                json_mode=False,
            )
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "message": str(exc), "latency_ms": None}
        latency = round((time.perf_counter() - started) * 1000)
        return {"ok": True, "message": (text or "").strip()[:80] or "ok", "latency_ms": latency}

    def _system(self, extra: str) -> str:
        return self.skill_text() + "\n\n" + extra

    @staticmethod
    def _plan_questions(plan: dict[str, Any] | None) -> list[str]:
        questions: list[str] = []
        for item in (plan or {}).get("questions") or []:
            text = item.get("text") if isinstance(item, dict) else item
            if text:
                questions.append(str(text))
        return questions

    async def first_turn(
        self, plan: dict[str, Any] | None, profile: dict[str, Any]
    ) -> dict[str, Any]:
        questions = self._plan_questions(plan)
        first = questions[0] if questions else "Let's talk about your hometown."
        user = (
            "Lesson part: " + str((plan or {}).get("part_mode", "part1")) + "\n"
            + "Planned questions:\n- " + "\n- ".join(questions[:5]) + "\n\n"
            + "This is the opening turn. Greet in one short sentence (optional), then ask "
            + "question 1 exactly as planned.\n\n"
            + 'Return JSON: {"examiner_text": "..."}'
        )
        system = self._system(
            "You are the examiner. Output one JSON object with key examiner_text. "
            "examiner_text is English, at most two sentences."
        )
        try:
            data = await self.chat_json(system, user)
            text = str(data.get("examiner_text") or "").strip()
        except Exception as exc:  # noqa: BLE001 - fall back to the bank question
            logger.warning("standalone 首题生成失败，用题库原题: %s", exc)
            text = first
        return {"examiner_text": text or first}
    async def next_turn(
        self,
        plan: dict[str, Any] | None,
        transcript: str,
        wpm: float | None,
        pronunciation_brief: dict[str, Any] | None,
        stuck_hints: list[str] | None,
        question_index: int,
        feedback_style: str,
    ) -> dict[str, Any]:
        questions = self._plan_questions(plan)
        next_question = questions[question_index] if question_index < len(questions) else ""
        brief = json.dumps(pronunciation_brief or {}, ensure_ascii=False)
        schema = (
            '{"examiner_text": "<acknowledgement + next question, English, <=2 sentences>", '
            '"feedback_payload": {"quick_praise": "...", "corrected_text": "...", '
            '"upgraded_text": "...", "grammar_mistakes": [{"type": "tense", "wrong": "...", '
            '"right": "...", "note": "中文一句话"}], "pronunciation_tips": ["中文一句话"]}}'
        )
        user = (
            "Learner answer: " + (transcript or "(no speech)") + "\n"
            + "Speech rate wpm: " + str(wpm or "-") + "\n"
            + "Pronunciation brief: " + brief + "\n"
            + "Hint words offered while stuck: " + json.dumps(stuck_hints or [], ensure_ascii=False) + "\n"
            + "Next question to ask: " + (next_question or "(wrap up this part)") + "\n\n"
            + "Return JSON with exactly these keys:\n" + schema
        )
        system = self._system(
            "You are the examiner. Reply with ONE JSON object only, keys examiner_text and "
            "feedback_payload. Examiner text is English; notes inside feedback are Chinese. "
            "Never score pronunciation yourself: use the pronunciation brief I give you."
        )
        data = await self.chat_json(system, user)
        examiner_text = str(data.get("examiner_text") or "").strip() or (next_question or "Let's stop here.")
        feedback = data.get("feedback_payload")
        if not isinstance(feedback, dict):
            feedback = {}
        return {"examiner_text": examiner_text, "feedback_payload": feedback}

    async def report(
        self,
        session: dict[str, Any],
        plan: dict[str, Any] | None,
        turns: list[dict[str, Any]],
        context: dict[str, Any],
    ) -> dict[str, Any]:
        lines: list[str] = []
        for turn in turns:
            transcript = (turn.get("learner_transcript") or "").strip()
            if not transcript:
                continue
            lines.append(
                "- Q: " + str(turn.get("examiner_question") or "")[:160]
                + "\n  A: " + transcript[:400]
            )
        schema = (
            '{"bands": {"overall": 6.5, "fc": 6.5, "lr": 6.0, "gra": 6.5, "pr": 6.0}, '
            '"report_markdown": "...", "next_lesson_plan": "..."}'
        )
        user = (
            "Topic: " + str(session.get("topic_title")) + "\n"
            + "Part: " + str(session.get("part_mode")) + "\n"
            + "Long-term memory: " + json.dumps(context or {}, ensure_ascii=False)[:1200] + "\n\n"
            + "Answers:\n" + ("\n".join(lines) if lines else "(no answers)") + "\n\n"
            + "Return JSON with exactly these keys:\n" + schema
        )
        system = self._system(
            "Write the end-of-lesson report. Reply with one JSON object: bands (0-9, "
            "half bands), report_markdown (Chinese, short sections), next_lesson_plan "
            "(Chinese, 2-3 bullet lines)."
        )
        data = await self.chat_json(system, user, timeout=90.0)
        bands = data.get("bands") if isinstance(data.get("bands"), dict) else {}
        clean: dict[str, Any] = {}
        for key in ("overall", "fc", "lr", "gra", "pr"):
            try:
                clean[key] = max(0.0, min(9.0, round(float(bands.get(key, 6.0)) * 2) / 2))
            except (TypeError, ValueError):
                clean[key] = 6.0
        return {
            "bands_json": clean,
            "report_markdown": str(data.get("report_markdown") or "").strip(),
            "next_lesson_plan": str(data.get("next_lesson_plan") or "").strip(),
        }
