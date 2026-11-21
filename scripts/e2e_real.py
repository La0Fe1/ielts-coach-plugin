"""Real-model end-to-end run: TTS examiner + simulated learner WAV + real ASR.

Spawns its own daemon on a scratch port so it never disturbs the one the MCP
bridge keeps warm. Prints a latency table and asserts the whole turn contract.

Run:  python scripts/e2e_real.py
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
PORT = int(os.environ.get("E2E_PORT", "8799"))
BASE = "http://127.0.0.1:" + str(PORT)
PYTHON = sys.executable

LEARNER_ANSWER = (
    "My hometown is a small city near the coast. I have lived there for about "
    "twelve years, and what I like most is the slow pace of life and the fresh seafood."
)


def wait_health(client: httpx.Client, timeout: float = 180.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            response = client.get(BASE + "/health", timeout=2.0)
            if response.status_code == 200:
                return response.json()
        except httpx.HTTPError:
            pass
        time.sleep(0.5)
    raise RuntimeError("daemon 未能启动")


def main() -> int:
    env = os.environ.copy()
    env["PYTHONUTF8"] = "1"
    env["HF_ENDPOINT"] = env.get("HF_ENDPOINT", "https://hf-mirror.com")
    log = open(ROOT / "scripts" / "_e2e_daemon.log", "w", encoding="utf-8")
    proc = subprocess.Popen(
        [PYTHON, "-m", "daemon.main", "--port", str(PORT)],
        cwd=str(ROOT),
        env=env,
        stdout=log,
        stderr=subprocess.STDOUT,
    )
    timings: dict[str, float] = {}
    try:
        with httpx.Client(timeout=httpx.Timeout(connect=5.0, read=300.0, write=60.0, pool=5.0)) as client:
            started = time.time()
            health = wait_health(client)
            timings["daemon_boot"] = round(time.time() - started, 2)
            print("daemon:", health["version"], "| device:", health["device_name"], "| espeak:", bool(health["espeak_ng"]))

            session = client.post(BASE + "/api/sessions", json={"part_mode": "part1", "topic_title": "Hometown"}).json()
            session_id = session["session_id"]
            print("session:", session_id, session["companion_url"])

            started = time.time()
            turn = client.post(
                BASE + "/api/sessions/" + str(session_id) + "/examiner_turn",
                json={"text": "Hello! Let us begin. Where is your hometown?", "part": "part1"},
            ).json()
            timings["examiner_tts"] = round(time.time() - started, 2)
            print("examiner turn:", turn["turn_id"], "| audio:", (turn.get("audio") or {}).get("url"),
                  "|", (turn.get("audio") or {}).get("duration_sec"), "s")

            # Render a *learner* answer with the US voice, then upload it as if the
            # browser had recorded it.
            started = time.time()
            spoken = client.get(BASE + "/api/tts/say", params={"text": LEARNER_ANSWER, "accent": "us"}).json()
            timings["learner_tts"] = round(time.time() - started, 2)
            wav_bytes = client.get(BASE + spoken["url"]).content
            print("simulated learner audio:", len(wav_bytes), "bytes /", spoken["duration_sec"], "s")

            started = time.time()
            upload = client.post(
                BASE + "/api/sessions/" + str(session_id) + "/audio",
                files={"file": ("turn.wav", wav_bytes, "audio/wav")},
            )
            timings["asr_and_store"] = round(time.time() - started, 2)
            upload.raise_for_status()
            payload = upload.json()
            transcript = payload.get("transcript", "")
            print("transcript:", transcript)
            print("wpm:", payload.get("wpm"), "| pauses:", payload.get("pauses"))

            started = time.time()
            reply = client.get(
                BASE + "/api/internal/sessions/" + str(session_id) + "/wait",
                params={"timeout_sec": 5},
            ).json()
            timings["wait_poll"] = round(time.time() - started, 2)
            print("wait status:", reply.get("status"))

            feedback = {
                "quick_praise": "开头直接给出家乡位置，很自然。",
                "corrected_text": "My hometown is a small city near the coast. I have lived there for about twelve years.",
                "upgraded_text": "I am from a small coastal city, and I have called it home for around twelve years.",
                "grammar_mistakes": [
                    {
                        "error_category": "collocation",
                        "error_pattern": "slow_pace_of_life",
                        "original_excerpt": "slow pace of life",
                        "corrected_excerpt": "the slow pace of life",
                        "explanation": "需要定冠词 the",
                    }
                ],
                "pronunciation_tips": "Phase 1 仅做文本与流利度分析，音素评测将在 Phase 2 启用。",
            }
            saved = client.post(
                BASE + "/api/sessions/" + str(session_id) + "/feedback",
                json={"turn_id": payload.get("turn_id"), "feedback_payload": feedback},
            ).json()
            print("feedback saved:", saved)

            aggregation = client.get(BASE + "/api/sessions/" + str(session_id) + "/aggregation").json()
            print("aggregation: turns", aggregation["turn_count"], "| avg wpm", aggregation["avg_wpm"],
                  "| grammar", aggregation["grammar_by_category"])

            client.post(BASE + "/api/sessions/" + str(session_id) + "/end", json={"reason": "e2e"})
            started = time.time()
            report = client.post(
                BASE + "/api/sessions/" + str(session_id) + "/report",
                json={
                    "bands_json": {"overall": 6.5, "fc": 6.5, "lr": 6.0, "gra": 6.0, "pr": None},
                    "report_markdown": "## 成绩单\n\n- Overall 6.5\n\n## 下节课处方\n\n- 冠词 5 句",
                    "next_lesson_plan": "1) 冠词 2) 停顿控制",
                },
            ).json()
            timings["report"] = round(time.time() - started, 2)
            report_path = Path(report["markdown_file_path"])
            print("report:", report_path, "exists:", report_path.is_file())

            context = client.get(BASE + "/api/learner/context").json()
            print("memory has_history:", context["has_history"], "| plan:", bool(context["last_lesson_plan"]))

        print("\nlatency (s):")
        for key, value in timings.items():
            print("  %-16s %s" % (key, value))

        ok = bool(transcript) and reply.get("status") == "learner_replied" and report_path.is_file()
        print("\nRESULT:", "PASS" if ok else "FAIL")
        return 0 if ok else 2
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()
        log.close()


if __name__ == "__main__":
    sys.exit(main())
