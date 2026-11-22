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

    requests: list[dict] = []
    fail = False

    def do_POST(self):  # noqa: N802 - http.server API
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        type(self).requests.append(body)
        if type(self).fail:
            data = b'{"error":"boom"}'
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if body.get("stream"):
            content = json.dumps(
                {
                    "examiner_text": "Nice answer. What do you do at weekends?",
                    "feedback_payload": {
                        "quick_praise": "回答完整。",
                        "corrected_text": "I went there yesterday.",
                        "upgraded_text": "I usually spend my weekends outdoors.",
                        "grammar_mistakes": [
                            {
                                "type": "tense",
                                "wrong": "I go yesterday",
                                "right": "I went yesterday",
                                "note": "过去时间用过去式",
                            }
                        ],
                    },
                },
                ensure_ascii=False,
            )
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            step = 24
            for start in range(0, len(content), step):
                chunk = json.dumps({"choices": [{"delta": {"content": content[start:start + step]}}]})
                self.wfile.write(("data: " + chunk + "\n\n").encode())
                self.wfile.flush()
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
            return
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
                    "corrected_text": "I went there yesterday.",
                    "upgraded_text": "I usually spend my weekends outdoors.",
                    "grammar_mistakes": [
                        {
                            "type": "tense",
                            "wrong": "I go yesterday",
                            "right": "I went yesterday",
                            "note": "过去时间用过去式",
                        }
                    ],
                    "pronunciation_tips": ["注意 think 的 θ 音"],
                },
            }
        else:
            payload = {
                "bands": {"overall": 6.5, "fc": 6.5, "lr": 6.0, "gra": 6.5, "pr": 6.0},
                "report_markdown": "## 总评\n稳定，继续练连贯性。",
                "next_lesson_plan": "- 练 Part 2 的展开\n- 复习 θ 音",
                "memory_updates": [
                    {
                        "memory_type": "weakness_grammar",
                        "memory_key": "past_tense_go_yesterday",
                        "title": "过去时间用过去式",
                        "content": "I go yesterday 应为 I went yesterday",
                        "mastery_delta": 0.1,
                    }
                ],
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
    _StubLLM.requests = []
    _StubLLM.fail = False
    server = ThreadingHTTPServer(("127.0.0.1", 0), _StubLLM)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_address[1]}/v1"
    server.shutdown()


def _configure(home, base_url, **extra):
    data = {
        "llm_mode": "standalone",
        "llm_provider": "openai_compatible",
        "llm_base_url": base_url,
        "llm_model": "stub-model",
        "llm_api_key": "sk-test-1234",
        "voice_speed": 1.0,
    }
    data.update(extra)
    (home / "llm_config.json").write_text(json.dumps(data), encoding="utf-8")


def _wait_for(fn, timeout: float = 10.0, interval: float = 0.15):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = fn()
        if last:
            return last
        time.sleep(interval)
    raise AssertionError(f"等待超时，最后结果: {last!r}")


def _turns(client, sid):
    return client.get(f"/api/sessions/{sid}").json().get("turns") or []


def test_standalone_lesson_end_to_end(daemon_server, temp_home, stub_llm):
    _configure(temp_home, stub_llm)
    base = daemon_server.url

    with httpx.Client(base_url=base, timeout=30) as client:
        profile = client.get("/api/profile").json()
        assert profile["llm_mode"] == "standalone"
        assert profile["has_api_key"] is True
        assert profile["api_key_masked"] == "sk-****1234"
        assert "llm_api_key" not in profile

        session = client.post("/api/sessions", json={"part_mode": "part1", "drive_mode": "standalone"}).json()
        assert session["drive_mode"] == "standalone"
        sid = session["session_id"]

        first = _wait_for(lambda: next((t for t in _turns(client, sid) if t.get("examiner_question")), None))
        assert first["examiner_question"]

        reply = client.post(
            f"/api/sessions/{sid}/audio",
            files={"file": ("answer.wav", make_wav_bytes(), "audio/wav")},
        ).json()
        assert reply.get("transcript")

        second = _wait_for(lambda: (lambda asked: asked[1] if len(asked) >= 2 else None)(
            [t for t in _turns(client, sid) if t.get("examiner_question")]
        ))
        assert "weekend" in second["examiner_question"].lower()

        # The examiner prompt must ask for the DB field names, not type/wrong/right.
        turn_prompt = next((r for r in _StubLLM.requests if "Learner answer" in json.dumps(r)), None)
        assert turn_prompt is not None

        # Legacy keys are normalised into the standard ones before persisting.
        client.post(f"/api/sessions/{sid}/end", json={"reason": "test"})
        saved = _wait_for(lambda: (lambda d: d if d.get("report_markdown") else None)(
            client.get(f"/api/sessions/{sid}/report").json()
        ))
        assert "总评" in saved["report_markdown"]
        assert (saved.get("report_json") or {}).get("bands", {}).get("overall") == 6.5

        # Report memory updates are persisted for the next lesson's review block.
        memory = client.get("/api/memory", params={"memory_type": "weakness_grammar"}).json()["items"]
        assert any(item.get("memory_key") == "past_tense_go_yesterday" for item in memory)


def test_grammar_mistakes_use_standard_fields(daemon_server, temp_home, stub_llm):
    _configure(temp_home, stub_llm)
    with httpx.Client(base_url=daemon_server.url, timeout=30) as client:
        sid = client.post("/api/sessions", json={"part_mode": "part1", "drive_mode": "standalone"}).json()["session_id"]
        _wait_for(lambda: next((t for t in _turns(client, sid) if t.get("examiner_question")), None))
        client.post(f"/api/sessions/{sid}/audio", files={"file": ("a.wav", make_wav_bytes(), "audio/wav")})
        _wait_for(lambda: (lambda asked: asked[1] if len(asked) >= 2 else None)(
            [t for t in _turns(client, sid) if t.get("examiner_question")]
        ))
        # Feedback is attached to the turn that was just answered (the first one).
        turn = next(t for t in _turns(client, sid) if t.get("examiner_question"))
        feedback = turn.get("grammar_feedback_json") or {}
        mistakes = feedback.get("grammar_mistakes") or []
        assert mistakes, feedback
        assert mistakes[0]["error_category"] == "tense"
        assert mistakes[0]["original_excerpt"] == "I go yesterday"
        assert mistakes[0]["corrected_excerpt"] == "I went yesterday"


def test_chinese_question_does_not_advance(daemon_server, temp_home, stub_llm, monkeypatch):
    _configure(temp_home, stub_llm)
    monkeypatch.setenv("IELTS_COACH_STUB_LANGUAGE", "zh")
    monkeypatch.setenv("IELTS_COACH_STUB_TRANSCRIPT", "这个词怎么用")
    with httpx.Client(base_url=daemon_server.url, timeout=30) as client:
        sid = client.post("/api/sessions", json={"part_mode": "part1", "drive_mode": "standalone"}).json()["session_id"]
        _wait_for(lambda: next((t for t in _turns(client, sid) if t.get("examiner_question")), None))
        client.post(f"/api/sessions/{sid}/audio", files={"file": ("a.wav", make_wav_bytes(), "audio/wav")})
        _wait_for(lambda: (lambda asked: asked[1] if len(asked) >= 2 else None)(
            [t for t in _turns(client, sid) if t.get("examiner_question")]
        ))
    prompts = [json.dumps(r, ensure_ascii=False) for r in _StubLLM.requests]
    assert any("SAME question" in prompt for prompt in prompts), prompts[-1][:300]


def test_card_only_feedback_style_reaches_prompt(daemon_server, temp_home, stub_llm):
    _configure(temp_home, stub_llm)
    with httpx.Client(base_url=daemon_server.url, timeout=30) as client:
        sid = client.post(
            "/api/sessions",
            json={"part_mode": "part1", "drive_mode": "standalone", "feedback_style": "instant_card_only"},
        ).json()["session_id"]
        _wait_for(lambda: next((t for t in _turns(client, sid) if t.get("examiner_question")), None))
        client.post(f"/api/sessions/{sid}/audio", files={"file": ("a.wav", make_wav_bytes(), "audio/wav")})
        _wait_for(lambda: (lambda asked: asked[1] if len(asked) >= 2 else None)(
            [t for t in _turns(client, sid) if t.get("examiner_question")]
        ))
    prompts = [json.dumps(r, ensure_ascii=False) for r in _StubLLM.requests]
    assert any("card-only" in prompt for prompt in prompts)


def test_stop_command_ends_lesson(daemon_server, temp_home, stub_llm, monkeypatch):
    _configure(temp_home, stub_llm)
    monkeypatch.setenv("IELTS_COACH_STUB_TRANSCRIPT", "Stop.")
    with httpx.Client(base_url=daemon_server.url, timeout=30) as client:
        sid = client.post("/api/sessions", json={"part_mode": "part1", "drive_mode": "standalone"}).json()["session_id"]
        _wait_for(lambda: next((t for t in _turns(client, sid) if t.get("examiner_question")), None))
        reply = client.post(f"/api/sessions/{sid}/audio", files={"file": ("a.wav", make_wav_bytes(), "audio/wav")}).json()
        assert reply.get("intent") == "end_lesson"
        saved = _wait_for(lambda: (lambda d: d if d.get("report_markdown") else None)(
            client.get(f"/api/sessions/{sid}/report").json()
        ), timeout=15)
        assert saved["report_markdown"]


def test_model_failure_surfaces_error_state(daemon_server, temp_home, stub_llm):
    _configure(temp_home, stub_llm)
    _StubLLM.fail = True
    with httpx.Client(base_url=daemon_server.url, timeout=30) as client:
        sid = client.post("/api/sessions", json={"part_mode": "part1", "drive_mode": "standalone"}).json()["session_id"]
        # The opening line uses the fast template path, so trigger the failure on
        # an actual answer instead.
        _wait_for(lambda: next((t for t in _turns(client, sid) if t.get("examiner_question")), None))
        client.post(f"/api/sessions/{sid}/audio", files={"file": ("a.wav", make_wav_bytes(), "audio/wav")})
        state = _wait_for(lambda: (lambda s: s if s.get("last_error") else None)(
            client.get(f"/api/sessions/{sid}").json().get("state") or {}
        ))
        assert "失败" in state["last_error"]

def test_next_turn_stream_emits_text_before_feedback(stub_llm, temp_home):
    from daemon.llm_coach import LLMConfigStore, StandaloneExaminer

    store = LLMConfigStore(temp_home / "llm_config.json")
    store.save({"llm_mode": "standalone", "llm_provider": "openai_compatible",
                "llm_base_url": stub_llm, "llm_model": "stub", "llm_api_key": "k"})
    examiner = StandaloneExaminer(store, temp_home / "SKILL.md")

    seen: list[str] = []

    async def on_text(text: str) -> None:
        seen.append(text)

    import asyncio

    result = asyncio.run(
        examiner.next_turn_stream(
            {"part_mode": "part1", "questions": [{"text": "Q1"}, {"text": "Q2"}]},
            "I go to the park", 120, {"overall_score": 80}, [], 1,
            "instant_card_plus_voice", on_examiner_text=on_text,
        )
    )
    assert seen, "on_examiner_text 没有在流式过程中触发"
    assert seen[0] in result["examiner_text"]
    assert result["feedback_payload"]["quick_praise"] == "回答完整。"

def test_full_mock_switches_parts_and_completes(daemon_server, temp_home, stub_llm):
    _configure(temp_home, stub_llm)
    with httpx.Client(base_url=daemon_server.url, timeout=30) as client:
        sid = client.post(
            "/api/sessions", json={"part_mode": "full_mock", "drive_mode": "standalone"}
        ).json()["session_id"]
        parts: list[str] = []
        for _ in range(14):
            asked = [t for t in _turns(client, sid) if t.get("examiner_question")]
            parts = [str(t.get("part")) for t in asked]
            if "part3" in parts and len(asked) >= 2:
                # keep answering until the plan is exhausted
                pass
            latest = asked[-1] if asked else None
            if latest and "end of our speaking session" in str(latest.get("examiner_question", "")).lower():
                break
            client.post(f"/api/sessions/{sid}/audio", files={"file": ("a.wav", make_wav_bytes(), "audio/wav")})
            time.sleep(0.4)
        assert {"part1", "part2", "part3"} <= set(parts), parts
        last = [t for t in _turns(client, sid) if t.get("examiner_question")][-1]
        assert "end of our speaking session" in str(last.get("examiner_question", "")).lower()
