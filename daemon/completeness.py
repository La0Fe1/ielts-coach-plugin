"""Decide whether the learner finished a sentence or is still mid-thought.

Silence length is a poor proxy: thinking for two seconds mid-clause looks exactly
like finishing an answer. This module looks at *what was actually said* - the tail
of the utterance - and decides whether the sentence can stand on its own.

Two layers:
  1. POS rules on the last token (spaCy). "near the", "because", "and", "to" cannot
     end an English sentence.
  2. A verb check on the final clause: no main verb at all means an unfinished
     fragment ("in my opinion the best one").

Falls back to word lists when spaCy is unavailable (e.g. the model is not bundled),
so the daemon never loses the ability to make the call.
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


def analyze(transcript: str, pause_sec: float = 0.0, stuck_after: float = 1.8) -> dict[str, Any]:
    """Return {complete, reason, detail, stuck, confidence}.

    complete: the sentence can stand alone -> submit the turn
    stuck:    incomplete *and* the learner has gone quiet -> offer hints
    """
    text = (transcript or "").strip()
    words = _TOKEN_RE.findall(text)
    cleaned = _strip_fillers(words)

    if not cleaned:
        return _verdict(False, "empty", "还没有听到内容", pause_sec, stuck_after, 0.95)
    if len(cleaned) < 2:
        return _verdict(False, "too_short", "只说了 " + cleaned[-1] + "，还没成句",
                        pause_sec, stuck_after, 0.9)

    last = cleaned[-1].lower()

    # 1) word-list rule (works with or without spaCy)
    if last in TRAILING_STOPWORDS:
        return _verdict(
            False, "trailing_function_word",
            "停在「" + cleaned[-1] + "」上，这句话没说完",
            pause_sec, stuck_after, 0.85,
        )

    # 2) POS rule
    nlp = _load_nlp()
    if nlp is not None:
        try:
            doc = nlp(text)
            tokens = [t for t in doc if not t.is_space and not t.is_punct]
            if tokens:
                tail = tokens[-1]
                if tail.pos_ in TRAILING_POS:
                    return _verdict(
                        False, "trailing_pos",
                        "停在「" + tail.text + "」上（" + tail.pos_ + "），句子没闭合",
                        pause_sec, stuck_after, 0.9,
                    )
                # last sentence must contain a finite verb
                sentences = [s for s in doc.sents if s.text.strip()]
                if sentences:
                    final = sentences[-1]
                    has_verb = any(t.pos_ in {"VERB", "AUX"} for t in final)
                    if not has_verb and len(final) >= 3:
                        return _verdict(
                            False, "no_main_verb",
                            "最后一小句没有谓语动词，像半句话",
                            pause_sec, stuck_after, 0.75,
                        )
        except Exception as exc:  # noqa: BLE001
            logger.debug("completeness: spaCy 解析失败 (%s)", exc)

    # 3) trailing comma is a weak "more to come" signal
    if text.endswith(",") or text.endswith("，"):
        return _verdict(False, "trailing_comma", "以逗号结尾，通常还有后半句",
                        pause_sec, stuck_after, 0.6)

    return _verdict(True, "ok", "句子完整", pause_sec, stuck_after, 0.8)


def _verdict(
    complete: bool,
    reason: str,
    detail: str,
    pause_sec: float,
    stuck_after: float,
    confidence: float,
) -> dict[str, Any]:
    stuck = (not complete) and pause_sec >= stuck_after
    return {
        "complete": complete,
        "reason": reason,
        "detail": detail,
        "stuck": stuck,
        "pause_sec": round(float(pause_sec), 2),
        "confidence": confidence,
    }
