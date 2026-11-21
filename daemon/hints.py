"""Stuck detection and bilingual word hints.

The learner freezing mid-answer is the moment a good teacher speaks up:
"When people do too much at once, they feel ... stressed?"  This module turns the
acoustic evidence (long internal pauses, filler clusters) into a small structured
report plus 2-3 candidate words drawn from the current topic's tag vocabulary, so
the agent can offer a hint instead of silently waiting.
"""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Any, Iterable

logger = logging.getLogger(__name__)

DEFAULT_HINTS = Path(__file__).resolve().parent / "content" / "hints.json"
WORD_RE = re.compile(r"[A-Za-z][A-Za-z'\-]*")

#: Generic fallback when the topic carries no tags.
GENERIC_HINTS = [
    "in my opinion",
    "to be honest",
    "for example",
    "it depends",
    "what I mean is",
]


class HintBook:
    """Tag -> candidate vocabulary, used only when the learner gets stuck."""

    def __init__(self, path: Path | None = None):
        self.path = Path(path) if path else DEFAULT_HINTS
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            self.tags: dict[str, list[str]] = {
                str(key): [str(word) for word in value]
                for key, value in (data.get("tags") or {}).items()
            }
        except Exception as exc:  # noqa: BLE001 - hints are optional
            logger.warning("提示词库加载失败: %s", exc)
            self.tags = {}

    def words_for(
        self,
        tags: Iterable[str] | None,
        exclude: Iterable[str] | None = None,
        limit: int = 3,
    ) -> list[str]:
        used = {word.lower() for word in (exclude or [])}
        picked: list[str] = []
        for tag in list(tags or []):
            for word in self.tags.get(tag, []):
                if word.lower() in used or word in picked:
                    continue
                picked.append(word)
                if len(picked) >= limit:
                    return picked
        for word in GENERIC_HINTS:
            if len(picked) >= limit:
                break
            if word.lower() not in used and word not in picked:
                picked.append(word)
        return picked[:limit]

    def stats(self) -> dict[str, int]:
        return {"tags": len(self.tags), "words": sum(len(v) for v in self.tags.values())}


def used_words(transcripts: Iterable[str]) -> set[str]:
    words: set[str] = set()
    for text in transcripts:
        for token in WORD_RE.findall(text or ""):
            words.add(token.lower())
    return words


def analyze_stuck(
    asr_result: dict[str, Any],
    hint_words: list[str] | None = None,
    deep_pause_sec: float = 2.0,
    filler_threshold: int = 4,
) -> dict[str, Any]:
    """Report whether the learner visibly got stuck in this turn."""
    pauses = list(asr_result.get("long_pauses") or [])
    deep = [p for p in pauses if float(p.get("duration_sec") or 0) >= deep_pause_sec]
    longest = max((float(p.get("duration_sec") or 0) for p in pauses), default=0.0)
    fillers = int(asr_result.get("filler_total") or 0)
    word_count = int(asr_result.get("word_count") or 0)
    detected = bool(deep) or (fillers >= filler_threshold and longest >= 1.2)

    # Very short answers with many fillers also count: the learner stalled out.
    if not detected and word_count and word_count < 8 and fillers >= 2:
        detected = True

    at_word = deep[0].get("after_word") if deep else None
    return {
        "detected": detected,
        "longest_pause_sec": round(longest, 2),
        "deep_pause_count": len(deep),
        "at_word": at_word,
        "filler_total": fillers,
        "word_count": word_count,
        "hint_words": (hint_words or [])[:3] if detected else [],
    }
