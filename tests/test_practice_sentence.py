"""Shadowing: score the recording against the text the learner meant to say."""

from __future__ import annotations

import httpx

from tests.conftest import make_wav_bytes


def test_practice_sentence_uses_target_text_and_skips_turns(daemon_server):
    base = daemon_server.url
    with httpx.Client(base_url=base, timeout=30) as client:
        session = client.post("/api/sessions", json={"part_mode": "part1"}).json()
        sid = session["session_id"]
        before = client.get(f"/api/sessions/{sid}").json().get("turns") or []

        result = client.post(
            f"/api/sessions/{sid}/practice_sentence",
            data={"target_text": "think", "accent": "uk"},
            files={"file": ("shadow.wav", make_wav_bytes(), "audio/wav")},
        ).json()

        assert result["ok"] is True
        assert result["target_text"] == "think"
        # The stub ASR returns a long canned sentence; only forced alignment on the
        # target text can produce a single scored word.
        words = (result["pronunciation"] or {}).get("words") or []
        assert [w["word"] for w in words] == ["think"]
        assert result["audio_url"].startswith("/api/audio/user/")

        after = client.get(f"/api/sessions/{sid}").json().get("turns") or []
        assert len(after) == len(before)


def test_practice_sentence_requires_target(daemon_server):
    with httpx.Client(base_url=daemon_server.url, timeout=30) as client:
        session = client.post("/api/sessions", json={"part_mode": "part1"}).json()
        response = client.post(
            f"/api/sessions/{session['session_id']}/practice_sentence",
            data={"target_text": "   "},
            files={"file": ("shadow.wav", make_wav_bytes(), "audio/wav")},
        )
        assert response.status_code == 400
