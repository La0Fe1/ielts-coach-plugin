"""Decide whether the learner finished an answer or is still mid-thought.

Silence length alone is a poor proxy: thinking two seconds mid-clause looks exactly
like finishing. This module looks at the sentence (POS rules + a verb check) and
then at how long the learner has actually been quiet, with a gate that depends on
how much they have said:

  * fewer than 12 words  -> the sentence may be only the first of several, so wait
    until 2.6 s of silence before submitting
  * 12 words or more     -> a complete sentence with 1.5 s of silence is an answer
  * one-word replies     -> 1.6 s (they are genuine answers, just short)
  * stop commands        -> submit immediately, no matter the pause

The verdict also carries suggested_submit_after_sec so the UI can draw a calm
"about to submit" countdown instead of guessing.
"""

from __future__ import annotations

import logging
import re
from typing import Any

logger = logging.getLogger(__name__)

#: Tokens that cannot end a well-formed English sentence.
#:
#: Deliberately excludes pronouns ("I like it") and non-copula auxiliaries
#: ("Yes, I do" / "I can"), which are legitimate sentence endings.
TRAILING_STOPWORDS = {
    # articles
    "a", "an", "the",
    # prepositions and the infinitive marker
    "in", "on", "at", "to", "for", "of", "with", "about", "from", "by", "into",
    "over", "under", "between", "through", "during", "without", "within", "upon",
    # conjunctions and subordinators
    "and", "but", "or", "nor", "because", "although", "though", "while",
    "if", "unless", "since", "than", "that", "which", "whose",
    "when", "where", "whether",
    # determiners / possessive determiners
    "my", "your", "his", "her", "its", "our", "their", "this", "these", "those",
    # copulas need a complement
    "is", "am", "are", "was", "were", "be", "been", "being",
    # intensifiers need what they intensify
    "very", "quite", "rather", "extremely",
}

FILLERS = {
    "uh", "uhh", "um", "umm", "er", "erm", "ah", "eh", "hmm", "mm", "mhm",
    "like", "well", "so",
}

#: POS tags that structurally cannot end a sentence. Pronouns and auxiliaries are
#: absent on purpose: "I like it" and "Yes, I do" are complete answers.
TRAILING_POS = {"DET", "ADP", "CCONJ", "SCONJ", "PART"}

#: One-word replies that ARE complete (after a pause): short answers and commands.
SHORT_ANSWERS = {
    "yes", "yeah", "yep", "no", "nope", "sure", "ok", "okay", "right", "correct",
    "done", "stop", "finish", "finished", "end", "bye", "thanks", "please",
}

#: Phrases that mean "end the lesson" (checked before completeness).
STOP_PHRASES = {
    # English
    "stop", "stop here", "let's stop", "lets stop", "end lesson", "end the lesson",
    "finish", "i am done", "i'm done", "that's all", "that is all", "we can stop",
    "no more", "bye", "goodbye", "see you",
    # Chinese (available once the ASR runs multilingual)
    "结束", "结束吧", "下课", "下课吧", "不练了", "停止", "停", "够了", "拜拜",
    "再见", "今天就到这", "今天就到这里",
}

#: How long the learner must be quiet before a syntactically complete sentence is
#: trusted as the whole answer.
GATE_LONG_ANSWER_SEC = 1.5
GATE_SHORT_ANSWER_SEC = 2.6
GATE_ONE_WORD_SEC = 1.6
SHORT_ANSWER_WORDS = 12

_TOKEN_RE = re.compile(r"[A-Za-z']+")

_nlp = None
_nlp_failed = False


def _load_nlp():
    global _nlp, _nlp_failed
    if _nlp is not None or _nlp_failed:
        return _nlp
    try:
        import spacy

        _nlp = spacy.load("en_core_web_sm")
        logger.debug("completeness: spaCy 已加载")
    except Exception as exc:  # noqa: BLE001 - rules still work
        _nlp_failed = True
        logger.debug("completeness: spaCy 不可用，使用词表规则 (%s)", exc)
    return _nlp


def _strip_fillers(words: list[str]) -> list[str]:
    trimmed = list(words)
    while trimmed and trimmed[-1].lower() in FILLERS:
        trimmed.pop()
    return trimmed


def is_stop_command(transcript: str) -> bool:
    """True when the learner is asking to end the lesson (English or Chinese)."""
    text = (transcript or "").strip().lower().rstrip(".!?。！？ ")
    return text in STOP_PHRASES


def _syntax_failure(cleaned: list[str], text: str) -> tuple[str, str, float] | None:
    """Return (reason, detail, confidence) when the sentence cannot stand alone."""
    last = cleaned[-1].lower()
    if last in TRAILING_STOPWORDS:
        return (
            "trailing_function_word",
            "停在「" + cleaned[-1] + "」上，这句话没说完",
            0.85,
        )

    nlp = _load_nlp()
    if nlp is not None:
        try:
            doc = nlp(text)
            tokens = [t for t in doc if not t.is_space and not t.is_punct]
            if tokens:
                tail = tokens[-1]
                if tail.pos_ in TRAILING_POS:
                    return (
                        "trailing_pos",
                        "停在「" + tail.text + "」上（" + tail.pos_ + "），句子没闭合",
                        0.9,
                    )
                sentences = [s for s in doc.sents if s.text.strip()]
                if sentences:
                    final = sentences[-1]
                    has_verb = any(t.pos_ in {"VERB", "AUX"} for t in final)
                    if not has_verb and len(final) >= 3:
                        return (
                            "no_main_verb",
                            "最后一小句没有谓语动词，像半句话",
                            0.75,
                        )
        except Exception as exc:  # noqa: BLE001
            logger.debug("completeness: spaCy 解析失败 (%s)", exc)

    if text.endswith(",") or text.endswith("，"):
        return ("trailing_comma", "以逗号结尾，通常还有后半句", 0.6)
    return None


def submit_gate(word_count: int, single_short_answer: bool = False) -> float:
    """Seconds of silence required before a complete sentence is submitted."""
    if single_short_answer:
        return GATE_ONE_WORD_SEC
    if word_count >= SHORT_ANSWER_WORDS:
        return GATE_LONG_ANSWER_SEC
    return GATE_SHORT_ANSWER_SEC


def analyze(
    transcript: str,
    pause_sec: float = 0.0,
    stuck_after: float = 1.8,
    language: str | None = "en",
) -> dict[str, Any]:
    """Return {complete, reason, detail, stuck, confidence, suggested_submit_after_sec}."""
    text = (transcript or "").strip()

    # Chinese (or any non-English) utterance: the English POS rules do not apply.
    if language and language.lower() not in {"en", ""}:
        return {
            "complete": True,
            "reason": "non_english",
            "detail": "非英文输入，交给 agent 处理",
            "stuck": False,
            "language": language.lower(),
            "pause_sec": round(float(pause_sec), 2),
            "confidence": 0.7,
            "suggested_submit_after_sec": 0.0,
        }

    words = _TOKEN_RE.findall(text)
    cleaned = _strip_fillers(words)

    if not cleaned:
        return _verdict(False, "empty", "还没有听到内容", pause_sec, stuck_after, 0.95)

    # Stop commands are honoured immediately.
    if is_stop_command(text):
        return _verdict(
            True, "stop_command", "结束口令", pause_sec, stuck_after, 0.95,
            suggested=0.0, allow_stuck=False,
        )

    if len(cleaned) < 2:
        if cleaned[-1].lower() in SHORT_ANSWERS:
            gate = GATE_ONE_WORD_SEC
            if pause_sec + 1e-6 < gate:
                return _verdict(
                    False, "waiting_for_more",
                    "短回答，再等 " + f"{gate:.1f}" + " 秒",
                    pause_sec, stuck_after, 0.9,
                    suggested=gate, allow_stuck=False,
                )
            return _verdict(True, "short_answer", "短回答也算完整", pause_sec, stuck_after, 0.9,
                            suggested=gate, allow_stuck=False)
        return _verdict(False, "too_short", "只说了 " + cleaned[-1] + "，还没成句",
                        pause_sec, stuck_after, 0.9)

    failure = _syntax_failure(cleaned, text)
    if failure is not None:
        reason, detail, confidence = failure
        return _verdict(False, reason, detail, pause_sec, stuck_after, confidence)

    # The sentence is complete. Now decide whether the learner is done ANSWERING:
    # short answers often continue with reasons, so they need a longer pause.
    gate = submit_gate(len(cleaned))
    if pause_sec + 1e-6 < gate:
        return _verdict(
            False, "waiting_for_more",
            "句子完整，再停 " + f"{gate:.1f}" + " 秒就提交",
            pause_sec, stuck_after, 0.8,
            suggested=gate, allow_stuck=False,
        )
    return _verdict(True, "ok", "句子完整", pause_sec, stuck_after, 0.8, suggested=gate)


def _verdict(
    complete: bool,
    reason: str,
    detail: str,
    pause_sec: float,
    stuck_after: float,
    confidence: float,
    suggested: float | None = None,
    allow_stuck: bool = True,
) -> dict[str, Any]:
    stuck = bool(allow_stuck and (not complete) and pause_sec >= stuck_after)
    return {
        "complete": complete,
        "reason": reason,
        "detail": detail,
        "stuck": stuck,
        "pause_sec": round(float(pause_sec), 2),
        "confidence": confidence,
        "suggested_submit_after_sec": suggested,
    }
