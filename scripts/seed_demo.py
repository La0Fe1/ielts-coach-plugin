"""Seed one demo lesson on a running daemon (screenshots / UI smoke review)."""

from __future__ import annotations

import sys
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
BASE = "http://127.0.0.1:8765"
ANSWER = (
    "I live in a small city near the coast. I have lived there for about twelve years, "
    "and what I like most is the slow pace of life and the fresh seafood."
)


def wait_ready(client: httpx.Client, timeout: float = 240.0) -> dict:
    deadline = time.time() + timeout
    last = {}
    while time.time() < deadline:
        try:
            last = client.get(BASE + "/health", timeout=3.0).json()
            models = last.get("models", {})
            if models.get("asr", {}).get("ok") and models.get("tts", {}).get("ok") and models.get("pronounce", {}).get("ok"):
                return last
        except httpx.HTTPError:
            pass
        time.sleep(1.0)
    return last


def main() -> int:
    with httpx.Client(timeout=httpx.Timeout(connect=5.0, read=300.0, write=60.0, pool=5.0)) as client:
        health = wait_ready(client)
        print("models:", {k: v.get("ok") for k, v in health.get("models", {}).items()})

        session = client.post(BASE + "/api/sessions", json={"part_mode": "part1", "topic_title": "Hometown and daily life"}).json()
        sid = session["session_id"]
        print("session", sid)

        # --- turn 1: realistic answer -------------------------------------- #
        client.post(
            BASE + "/api/sessions/" + str(sid) + "/examiner_turn",
            json={"text": "Good morning, let us begin. Where is your hometown, and what is it like?", "part": "part1"},
        )
        # Match the profile accent (G2P uses the same accent, so the demo audio must too).
        profile = client.get(BASE + "/api/profile").json()
        accent = profile.get("accent_preference", "uk")
        spoken = client.get(BASE + "/api/tts/say", params={"text": ANSWER, "accent": accent}).json()
        wav = client.get(BASE + spoken["url"]).content
        first = client.post(BASE + "/api/sessions/" + str(sid) + "/audio", files={"file": ("turn.wav", wav, "audio/wav")}).json()
        print("turn1:", first.get("transcript"), "| pron", (first.get("pronunciation") or {}).get("overall_score"))

        feedback_one = {
            "quick_praise": "用了 'the slow pace of life' 这种地道搭配，很自然。",
            "corrected_text": "I live in a small city near the coast. I have lived there for about twelve years.",
            "upgraded_text": "I am based in a small coastal city, and I have called it home for around a dozen years.",
            "grammar_mistakes": [
                {
                    "error_category": "collocation",
                    "error_pattern": "slow_pace_of_life_article",
                    "original_excerpt": "the slow pace of life",
                    "corrected_excerpt": "the slow pace of life",
                    "upgraded_excerpt": "the unhurried rhythm of everyday life",
                    "explanation": "搭配本身没问题，升级时可以换成 unhurried rhythm 更出彩。",
                }
            ],
            "pronunciation_tips": "注意 seafood 的重音在第一音节；coast 的尾音 /t/ 不要吞掉。",
        }

        # --- turn 2: deliberately mispronounced think ---------------------- #
        turn2 = client.post(
            BASE + "/api/sessions/" + str(sid) + "/examiner_turn",
            json={
                "text": "Nice. And what do you think about living there long term?",
                "part": "part1",
                "turn_id_for_feedback": first.get("turn_id"),
                "feedback_payload": feedback_one,
            },
        ).json()
        sink_wav = (ROOT / "tests" / "fixtures" / "pron_sink.wav").read_bytes()
        second = client.post(BASE + "/api/sessions/" + str(sid) + "/audio", files={"file": ("turn.wav", sink_wav, "audio/wav")}).json()
        pron = second.get("pronunciation") or {}
        print("turn2:", second.get("transcript"), "| flagged", [w["word"] for w in pron.get("flagged_words", [])])

        feedback_two = {
            "quick_praise": "回答直接切题，没有绕圈子。",
            "corrected_text": "I think so.",
            "upgraded_text": "I would say so, yes - it suits me really well.",
            "grammar_mistakes": [],
            "pronunciation_tips": "think 的 /θ/ 舌尖要轻触上齿，别发成 /s/（sink）。",
        }
        client.post(
            BASE + "/api/sessions/" + str(sid) + "/examiner_turn",
            json={
                "text": "Thank you. Let us move on: do you think you will stay there for a long time?",
                "part": "part1",
                "turn_id_for_feedback": second.get("turn_id"),
                "feedback_payload": feedback_two,
            },
        )
        print("seeded session", sid)
        return 0


if __name__ == "__main__":
    sys.exit(main())
