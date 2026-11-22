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

    # -- normalisation -------------------------------------------------------
    CATEGORY_ALIASES = {
        "type": "error_category",
        "wrong": "original_excerpt",
        "right": "corrected_excerpt",
        "note": "explanation",
        "category": "error_category",
        "correction": "corrected_excerpt",
        "original": "original_excerpt",
    }

    VALID_CATEGORIES = {
        "tense", "subject_verb_agreement", "article", "preposition", "collocation",
        "word_order", "chinglish", "plural_singular", "other",
    }

    @classmethod
    def normalize_feedback(cls, feedback: dict[str, Any] | None) -> dict[str, Any]:
        """Map whatever the model returned onto the DB/frontend field names.

        The examiner prompt used to ask for type/wrong/right/note while the DB and
        the UI read error_category/original_excerpt/corrected_excerpt/explanation,
        so every standalone mistake was stored as "other" with empty strings.
        """
        data = dict(feedback or {})
        for legacy, standard in cls.CATEGORY_ALIASES.items():
            if legacy in data and standard not in data:
                data[standard] = data.pop(legacy)

        mistakes: list[dict[str, Any]] = []
        for item in data.get("grammar_mistakes") or []:
            if not isinstance(item, dict):
                continue
            mapped = dict(item)
            for legacy, standard in cls.CATEGORY_ALIASES.items():
                if legacy in mapped and standard not in mapped:
                    mapped[standard] = mapped.pop(legacy)
            category = str(mapped.get("error_category") or "other").strip().lower().replace("-", "_")
            if category not in cls.VALID_CATEGORIES:
                category = "other"
            pattern = str(mapped.get("error_pattern") or "").strip()
            if not pattern:
                base = mapped.get("corrected_excerpt") or mapped.get("original_excerpt") or category
                pattern = re.sub(r"[^a-z0-9]+", "_", str(base).lower()).strip("_")[:48] or category
            mistakes.append(
                {
                    "error_category": category,
                    "error_pattern": pattern,
                    "original_excerpt": str(mapped.get("original_excerpt") or "").strip(),
                    "corrected_excerpt": str(mapped.get("corrected_excerpt") or "").strip(),
                    "upgraded_excerpt": str(mapped.get("upgraded_excerpt") or "").strip(),
                    "explanation": str(mapped.get("explanation") or "").strip(),
                }
            )
        data["grammar_mistakes"] = mistakes
        return data

    # -- prompts -------------------------------------------------------------
    async def first_turn(
        self, plan: dict[str, Any] | None, profile: dict[str, Any]
    ) -> dict[str, Any]:
        """Opening question. Deliberately tiny: no SKILL.md, so it lands in <1 s."""
        questions = self._plan_questions(plan)
        first = questions[0] if questions else "Let's talk about your hometown."
        review = (plan or {}).get("review") or {}
        if (plan or {}).get("is_first_lesson") and not review.get("grammar_patterns") and not review.get("weak_phonemes"):
            # Nothing to revisit: no model round-trip at all, speak immediately.
            return {"examiner_text": "Good morning. Let's begin. " + first, "fast": True}
        user = (
            "Opening line for an IELTS speaking lesson.\n"
            + "Part: " + str((plan or {}).get("part_mode", "part1")) + "\n"
            + "First question: " + first + "\n"
            + 'Reply with JSON: {"examiner_text": "..."} - at most two English sentences.'
        )
        system = (
            "You are a warm IELTS examiner. Reply with one JSON object, key examiner_text. "
            "English only. Do not repeat these instructions."
        )
        try:
            data = await self.chat_json(system, user, timeout=20.0)
            text = str(data.get("examiner_text") or "").strip()
        except Exception as exc:  # noqa: BLE001 - fall back to the bank question
            logger.warning("standalone 首题生成失败，用模板开场: %s", exc)
            text = "Good morning. Let's begin. " + first
        return {"examiner_text": text or ("Good morning. Let's begin. " + first)}

    async def next_turn(
        self,
        plan: dict[str, Any] | None,
        transcript: str,
        wpm: float | None,
        pronunciation_brief: dict[str, Any] | None,
        stuck_hints: list[str] | None,
        question_index: int,
        feedback_style: str,
        history: list[dict[str, str]] | None = None,
        language: str = "en",
    ) -> dict[str, Any]:
        questions = self._plan_questions(plan)
        next_question = questions[question_index] if question_index < len(questions) else ""
        brief = json.dumps(pronunciation_brief or {}, ensure_ascii=False)
        past = "\n".join(
            "Q: " + str(item.get("q", ""))[:140] + "\nA: " + str(item.get("a", ""))[:220]
            for item in (history or [])[-6:]
        ) or "(none)"
        schema = (
            '{"examiner_text": "<=2 sentences, English>", '
            '"feedback_payload": {"quick_praise": "...", "corrected_text": "...", '
            '"upgraded_text": "...", "grammar_mistakes": [{"error_category": '
            '"tense|subject_verb_agreement|article|preposition|collocation|word_order|'
            'chinglish|plural_singular|other", "error_pattern": "snake_case_key", '
            '"original_excerpt": "...", "corrected_excerpt": "...", '
            '"upgraded_excerpt": "...", "explanation": "中文一句话"}], '
            '"pronunciation_tips": ["中文一句话"]}}'
        )
        chinese = language and language.lower() not in {"en", ""}
        style_rule = (
            "The learner chose card-only feedback: examiner_text must NOT contain grammar or "
            "pronunciation corrections. Just react naturally and ask the next question."
            if feedback_style == "instant_card_only"
            else "You may add at most one short spoken hint in examiner_text."
        )
        if chinese:
            task = (
                "The learner spoke Chinese (question or command). Answer in Chinese, give an "
                "English example, then invite them back to English on the SAME question. "
                "Do not advance to the next question."
            )
            target_question = "Repeat the current question: " + (questions[max(0, question_index - 1)] if questions else "")
        else:
            task = "React to the answer briefly, then ask the next question."
            target_question = "Next question: " + (next_question or "(wrap up this part)")
        user = (
            "Lesson part: " + str((plan or {}).get("part_mode", "part1")) + "\n"
            + "Previous turns:\n" + past + "\n\n"
            + "Learner answer: " + (transcript or "(no speech)") + "\n"
            + "Speech rate wpm: " + str(wpm or "-") + "\n"
            + "Pronunciation brief: " + brief + "\n"
            + "Hint words offered while stuck: " + json.dumps(stuck_hints or [], ensure_ascii=False) + "\n"
            + target_question + "\n"
            + "Task: " + task + "\n"
            + style_rule + "\n\n"
            + "Return JSON with exactly these keys:\n" + schema
        )
        system = (
            "You are an IELTS examiner and coach. Reply with ONE JSON object only. "
            "examiner_text is English unless the learner spoke Chinese. Notes inside "
            "feedback are Chinese. Never score pronunciation yourself: use the brief."
        )
        data = await self.chat_json(system, user)
        examiner_text = str(data.get("examiner_text") or "").strip() or (next_question or "Let's stop here.")
        feedback = self.normalize_feedback(data.get("feedback_payload"))
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
            '"report_markdown": "...", "next_lesson_plan": "...", '
            '"memory_updates": [{"memory_type": "weakness_grammar|weakness_phoneme|'
            'personal_fact|part2_story", "memory_key": "snake_case", "title": "...", '
            '"content": "中文一句话", "mastery_delta": 0.0}]}'
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
            "(Chinese, 2-3 bullets), memory_updates (2-4 durable items worth remembering)."
        )
        data = await self.chat_json(system, user, timeout=90.0)
        bands = data.get("bands") if isinstance(data.get("bands"), dict) else {}
        clean: dict[str, Any] = {}
        for key in ("overall", "fc", "lr", "gra", "pr"):
            try:
                clean[key] = max(0.0, min(9.0, round(float(bands.get(key, 6.0)) * 2) / 2))
            except (TypeError, ValueError):
                clean[key] = 6.0
        updates = [
            item for item in (data.get("memory_updates") or [])
            if isinstance(item, dict) and item.get("memory_type") and item.get("content")
        ]
        return {
            "bands_json": clean,
            "report_markdown": str(data.get("report_markdown") or "").strip(),
            "next_lesson_plan": str(data.get("next_lesson_plan") or "").strip(),
            "memory_updates": updates,
        }
