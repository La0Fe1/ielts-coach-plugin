"""Standalone mode: the daemon drives a whole lesson through an OpenAI-compatible API."""

from __future__ import annotations

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx
import pytest

from tests.conftest import make_wav_bytes


class _StubLLM(BaseHTTPRequestHandler):
    """Canned /chat/completions responses, chosen by what the prompt asks for."""

    def do_POST(self):  # noqa: N802 - http.server API
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        messages = body.get("messages") or []
        user = ""
        for message in messages:
            if message.get("role") == "user":
                user = message.get("content") or ""
        if "opening turn" in user:
            payload = {"examiner_text": "Hello. Do you like your hometown?"}
        elif "Learner answer" in user:
            payload = {
                "examiner_text": "Nice. What do you do at weekends?",
                "feedback_payload": {
                    "quick_praise": "回答完整。",
                    "corrected_text": user.splitlines()[0].replace("Learner answer: ", ""),
                    "upgraded_text": "I usually spend my weekends outdoors.",
                    "grammar_mistakes": [
                        {"type": "tense", "wrong": "I go yesterday", "right": "I went yesterday", "note": "过去时间用过去式"}
                    ],
                    "pronunciation_tips": ["注意 think 的 θ 音"],
                },
            }
        else:
            payload = {
                "bands": {"overall": 6.5, "fc": 6.5, "lr": 6.0, "gra": 6.5, "pr": 6.0},
                "report_markdown": "## 总评\n稳定，继续练连贯性。",
                "next_lesson_plan": "- 练 Part 2 的展开\n- 复习 θ 音",
            }
        content = json.dumps(payload, ensure_ascii=False)
        data = json.dumps({"choices": [{"message": {"content": content}}]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):  # silence the test output
        pass


@pytest.fixture()
def stub_llm():
    server = ThreadingHTTPServer(("127.0.0.1", 0), _StubLLM)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_address[1]}/v1"
    server.shutdown()


def _wait_for(fn, timeout: float = 10.0, interval: float = 0.15):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = fn()
        if last:
            return last
        time.sleep(interval)
    raise AssertionError(f"等待超时，最后结果: {last!r}")


def test_standalone_lesson_end_to_end(daemon_server, temp_home, stub_llm):
    home = temp_home
    (home / "llm_config.json").write_text(
        json.dumps(
            {
                "llm_mode": "standalone",
                "llm_provider": "openai_compatible",
                "llm_base_url": stub_llm,
                "llm_model": "stub-model",
                "llm_api_key": "sk-test-1234",
                "voice_speed": 1.0,
            }
        ),
        encoding="utf-8",
    )
    base = daemon_server.url

    with httpx.Client(base_url=base, timeout=30) as client:
        # 1) profile masks the key and reports standalone mode
        profile = client.get("/api/profile").json()
        assert profile["llm_mode"] == "standalone"
        assert profile["has_api_key"] is True
        assert profile["api_key_masked"] == "sk-****1234"
        assert "llm_api_key" not in profile

        # 2) create a session; the daemon must speak the opening question by itself
        session = client.post("/api/sessions", json={"part_mode": "part1", "drive_mode": "standalone"}).json()
        assert session["drive_mode"] == "standalone"
        sid = session["session_id"]

        def first_turn():
            turns = client.get(f"/api/sessions/{sid}").json().get("turns") or []
            return next((t for t in turns if t.get("examiner_question")), None)

        turn = _wait_for(first_turn)
        assert "hometown" in (turn["examiner_question"] or "").lower()

        # 3) answer: the daemon must push feedback and ask the next question
        upload = client.post(
            f"/api/sessions/{sid}/audio",
            files={"file": ("answer.wav", make_wav_bytes(), "audio/wav")},
        ).json()
        assert upload.get("transcript") or upload.get("status") in {"processed", "learner_replied"}

        def second_turn():
            turns = client.get(f"/api/sessions/{sid}").json().get("turns") or []
            asked = [t for t in turns if t.get("examiner_question")]
            return asked[1] if len(asked) >= 2 else None

        turn2 = _wait_for(second_turn)
        assert "weekend" in (turn2["examiner_question"] or "").lower()

        # 4) end: the report is generated and persisted without an agent
        client.post(f"/api/sessions/{sid}/end", json={"reason": "test"}).json()

        def report():
            data = client.get(f"/api/sessions/{sid}/report").json()
            return data if data.get("report_markdown") else None

        saved = _wait_for(report)
        assert "总评" in saved["report_markdown"]
        bands = (saved.get("report_json") or {}).get("bands") or {}
        assert bands["overall"] == 6.5
        assert bands["pr"] == 6.0
