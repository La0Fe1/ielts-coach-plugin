"""The payload an agent receives must stay small: pronunciation detail lives in the UI."""

from __future__ import annotations

import json

from mcp_bridge.server import _compact_turn


def _fake_payload() -> dict:
    words = [
        {
            "word": f"word{i}",
            "index": i,
            "score": 95 if i % 3 else 42,
            "ipa": "wɜːd",
            "start_sec": i * 0.2,
            "end_sec": i * 0.2 + 0.18,
            "color": "green" if i % 3 else "red",
            "issues": [] if i % 3 else [{"phoneme": "ɜː", "likely_pronounced_as": "ə", "gop_score": -3.2}],
            "phonemes": [{"phoneme": "ɜː", "score": 40, "gop": -3.2, "competitor": "ə"} for _ in range(4)],
        }
        for i in range(30)
    ]
    return {
        "status": "learner_replied",
        "transcript": "hello there",
        "wpm": 120,
        "stuck": {"detected": False},
        "pronunciation": {
            "overall_score": 88.0,
            "device": "cuda",
            "frames": 12345,
            "words": words,
            "weak_phonemes": [{"phoneme": "ɜː", "avg_score": 40, "count": 10}],
        },
    }


def test_compact_keeps_what_the_agent_needs():
    compact = _compact_turn(_fake_payload())
    assert compact["status"] == "learner_replied"
    assert compact["transcript"] == "hello there"
    assert compact["stuck"] == {"detected": False}
    pron = compact["pronunciation"]
    assert pron["overall_score"] == 88.0
    assert len(pron["flagged"]) == 8  # capped at the 8 most useful words
    assert pron["flagged"][0]["issues"][0]["phoneme"] == "ɜː"
    assert pron["weak_phonemes"] == [{"phoneme": "ɜː", "avg_score": 40, "count": 10}]
    assert "frames" not in pron


def test_compact_is_much_smaller():
    raw = _fake_payload()
    compact = _compact_turn(raw)
    raw_size = len(json.dumps(raw, ensure_ascii=False))
    compact_size = len(json.dumps(compact, ensure_ascii=False))
    assert compact_size < raw_size * 0.25, (compact_size, raw_size)
