"""Phase 2 end-to-end: real Whisper + Wav2Vec2 GOP + Silero VAD through HTTP.

Spawns a scratch daemon, feeds the two Kokoro fixtures (think / sink), and prints
what the full pipeline reports for pronunciation.
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
PORT = int(os.environ.get("E2E_PORT", "8800"))
BASE = "http://127.0.0.1:" + str(PORT)


def wait_ready(client: httpx.Client, timeout: float = 300.0) -> dict:
    deadline = time.time() + timeout
    last = {}
    while time.time() < deadline:
        try:
            last = client.get(BASE + "/health", timeout=3.0).json()
            models = last.get("models", {})
            if (
                models.get("asr", {}).get("ok")
                and models.get("tts", {}).get("ok")
                and models.get("pronounce", {}).get("ok")
            ):
                return last
        except httpx.HTTPError:
            pass
        time.sleep(1.0)
    return last


def main() -> int:
    env = os.environ.copy()
    env["PYTHONUTF8"] = "1"
    env["HF_ENDPOINT"] = env.get("HF_ENDPOINT", "https://hf-mirror.com")
    log = open(ROOT / "scripts" / "_e2e_phase2_daemon.log", "w", encoding="utf-8")
    proc = subprocess.Popen(
        [sys.executable, "-m", "daemon.main", "--port", str(PORT)],
        cwd=str(ROOT),
        env=env,
        stdout=log,
        stderr=subprocess.STDOUT,
    )
    try:
        with httpx.Client(timeout=httpx.Timeout(connect=5.0, read=300.0, write=60.0, pool=5.0)) as client:
            started = time.time()
            health = wait_ready(client)
            print("boot+warmup:", round(time.time() - started, 1), "s")
            models = health.get("models", {})
            for name in ("asr", "tts", "vad", "pronounce"):
                info = models.get(name, {})
                print("  %-9s ok=%s %s" % (name, info.get("ok"), info.get("model") or info.get("error") or ""))
            print("  pron vocab:", models.get("pronounce", {}).get("vocab_size"),
                  "| g2p_error:", models.get("pronounce", {}).get("g2p_error"))

            session = client.post(BASE + "/api/sessions", json={"part_mode": "part1", "topic_title": "GOP check"}).json()
            sid = session["session_id"]
            client.post(
                BASE + "/api/sessions/" + str(sid) + "/examiner_turn",
                json={"text": "Tell me what you think about living in a big city.", "part": "part1"},
            )

            for name in ("sink", "think"):
                wav = (ROOT / "tests" / "fixtures" / ("pron_" + name + ".wav")).read_bytes()
                t0 = time.time()
                response = client.post(
                    BASE + "/api/sessions/" + str(sid) + "/audio",
                    files={"file": ("turn.wav", wav, "audio/wav")},
                )
                elapsed = round(time.time() - t0, 2)
                response.raise_for_status()
                payload = response.json()
                pron = payload.get("pronunciation") or {}
                print("\n== fixture:", name, "| upload->response:", elapsed, "s ==")
                print("  transcript:", payload.get("transcript"))
                print("  asr:", payload["turn"].get("asr_elapsed_sec"), "s | pron:", pron.get("elapsed_sec"), "s")
                print("  overall:", pron.get("overall_score"), "| alignment:", pron.get("alignment_engine"), pron.get("alignment_ok"))
                if not pron.get("alignment_ok"):
                    print("  DEBUG pron:", json.dumps(pron, ensure_ascii=False)[:700])
                    print("  DEBUG asr words:", json.dumps(payload["turn"].get("word_count")), payload.get("transcript"))
                for word in pron.get("words", [])[:6]:
                    issues = [(i["phoneme"], i.get("likely_pronounced_as"), i.get("gop_score")) for i in word.get("issues", [])]
                    print("    %-10s %-5s %-3s %s" % (word["word"], word["score"], word["color"], issues))

            after = client.get(BASE + "/health").json()["models"]["pronounce"]
            print("\npron status after uploads:", json.dumps(after, ensure_ascii=False))

            aggregation = client.get(BASE + "/api/sessions/" + str(sid) + "/aggregation").json()
            print("\nDB pronunciation_issues:", len(aggregation.get("pronunciation_issues", [])))
            print("avg pronunciation score:", aggregation.get("avg_pronunciation_score"))
            for issue in aggregation.get("pronunciation_issues", [])[:5]:
                print("   ", issue["word"], issue["phoneme"], issue.get("word_score"), issue.get("gop_score"))
            return 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()
        log.close()


if __name__ == "__main__":
    sys.exit(main())
