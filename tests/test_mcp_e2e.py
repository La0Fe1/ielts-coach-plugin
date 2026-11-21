"""End-to-end test: MCP bridge tools -> daemon -> SQLite -> report file.

Runs the real FastAPI app under uvicorn on a random port with the deterministic
stub ASR/TTS backends, then drives a two-turn IELTS conversation exactly the way
the SKILL.md instructs an agent to do it.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import httpx
import pytest

from conftest import make_wav_bytes

pytestmark = pytest.mark.asyncio


async def _upload_turn(url: str, session_id: int, duration: float = 2.4) -> dict:
    """POST a 16 kHz mono WAV exactly like the browser recorder does."""
    wav = make_wav_bytes(duration)
    async with httpx.AsyncClient(base_url=url, timeout=60.0) as client:
        response = await client.post(
            f"/api/sessions/{session_id}/audio",
            files={"file": ("turn.wav", wav, "audio/wav")},
        )
    assert response.status_code == 200, response.text
    return response.json()


async def test_health_and_context(daemon_server):
    import mcp_bridge.server as bridge

    health = await bridge.daemon_status()
    assert health["ok"] is True
    assert health["service"] == "ielts-coach-daemon"
    assert health["device"] in {"cuda", "mps", "cpu"}

    context = await bridge.get_learner_context()
    assert context["profile"]["id"] == 1
    assert context["has_history"] is False


async def test_full_lesson_roundtrip_with_report(daemon_server, temp_home):
    import mcp_bridge.server as bridge

    started = await bridge.start_lesson(
        part_mode="part1", topic_hint="Hometown and daily life", open_browser=False
    )
    assert started["ok"] is not False
    session_id = started["session_id"]
    assert started["companion_url"].endswith(f"session={session_id}")
    plan = started.get("plan") or {}
    assert plan.get("questions"), plan
    assert plan["questions"][0].get("text")
    assert plan.get("part_mode") == "part1"

    # ---- turn 1: examiner asks, learner answers ------------------------------ #
    waiting = asyncio.create_task(
        bridge.respond_with_feedback_and_wait(
            session_id=session_id,
            examiner_text="Hello! Let us start. Where is your hometown?",
            part="part1",
            timeout_sec=40,
        )
    )
    await asyncio.sleep(0.5)
    uploaded = await _upload_turn(daemon_server.url, session_id)
    assert uploaded["status"] == "learner_replied"

    reply = await waiting
    assert reply["status"] == "learner_replied", reply
    assert reply["transcript"]
    assert reply["wpm"] > 0
    turn_one = reply["turn_id"]
    assert reply["examiner"]["turn_id"] == turn_one

    # ---- turn 2: merged feedback + next question --------------------------- #
    feedback = {
        "quick_praise": "你用了一个很自然的地点表达。",
        "corrected_text": "I live in Shanghai and I have been living here for ten years.",
        "upgraded_text": "I am based in Shanghai and have called it home for about a decade.",
        "grammar_mistakes": [
            {
                "error_category": "tense",
                "error_pattern": "present_perfect_missing",
                "original_excerpt": "I live here for ten years",
                "corrected_excerpt": "I have lived here for ten years",
                "upgraded_excerpt": "I have called it home for about a decade",
                "explanation": "for + 时间段要用现在完成时",
            }
        ],
        "pronunciation_tips": "声学音素评测将在 Phase 2 启用；本轮关注 WPM 与停顿。",
    }
    waiting_two = asyncio.create_task(
        bridge.respond_with_feedback_and_wait(
            session_id=session_id,
            examiner_text="Nice. And what do you like most about it?",
            part="part1",
            turn_id_for_feedback=turn_one,
            feedback_payload=feedback,
            timeout_sec=40,
        )
    )
    await asyncio.sleep(0.5)
    await _upload_turn(daemon_server.url, session_id, duration=3.0)
    reply_two = await waiting_two
    assert reply_two["status"] == "learner_replied", reply_two
    assert reply_two["feedback_saved"]["saved"] is True
    assert reply_two["feedback_saved"]["grammar_mistakes"] == 1

    # ---- timeout path returns a status instead of blocking forever --------- #
    status_payload = await bridge.respond_with_feedback_and_wait(
        session_id=session_id,
        examiner_text="One more quick one: is it a good place for young people?",
        part="part1",
        timeout_sec=1,
    )
    assert status_payload["status"] in {"waiting_for_learner", "recording_in_progress"}, status_payload
    # the helper must also return (not raise) when nothing happens
    again = await bridge.wait_for_learner_turn(session_id=session_id, timeout_sec=1)
    assert again["status"] in {"waiting_for_learner", "recording_in_progress"}

    # ---- recording state transitions -------------------------------------- #
    async with httpx.AsyncClient(base_url=daemon_server.url, timeout=20.0) as client:
        state = (await client.post(f"/api/sessions/{session_id}/recording_start")).json()
        assert state["status"] == "recording_in_progress"
        await client.post(f"/api/sessions/{session_id}/recording_cancel")

    # ---- aggregation ------------------------------------------------------ #
    aggregation = await bridge.get_lesson_aggregation(session_id)
    assert aggregation["session"]["id"] == session_id
    assert aggregation["turn_count"] >= 3
    assert aggregation["answered_turn_count"] == 2
    assert aggregation["grammar_by_category"]["tense"] == 1
    assert aggregation["avg_wpm"] > 0
    assert len(aggregation["turns"]) >= 3

    # ---- memory update ---------------------------------------------------- #
    memory = await bridge.update_learner_memory(
        [
            {
                "memory_type": "personal_fact",
                "memory_key": "hometown",
                "title": "家乡",
                "content": "住在上海十年",
            },
            {
                "memory_type": "next_lesson_plan",
                "memory_key": "latest",
                "title": "下节课处方",
                "content": "专练现在完成时 + 数字表达",
            },
        ]
    )
    assert memory["count"] == 2

    # ---- report ----------------------------------------------------------- #
    saved = await bridge.save_lesson_report(
        session_id=session_id,
        bands_json={"overall": 6.5, "fc": 6.5, "lr": 6.0, "gra": 6.0, "pr": None},
        report_markdown="## 成绩单\n\n- Overall 6.5\n\n## 错题本\n\n- present_perfect_missing",
        next_lesson_plan="1) 现在完成时 5 句 2) 数字表达 3) 停顿控制",
    )
    assert saved["ok"] is True
    assert saved["markdown_file_path"]
    report_file = Path(saved["markdown_file_path"])
    assert report_file.is_file()
    assert "Overall 6.5" in report_file.read_text(encoding="utf-8")

    # ---- the learner's memory now carries history ------------------------- #
    context_after = await bridge.get_learner_context()
    assert context_after["has_history"] is True
    assert context_after["part2_stories"] == []
    assert any(note["memory_key"] == "hometown" for note in context_after["personal_facts"])
    assert context_after["last_lesson_plan"]["content"].startswith("1) 现在完成时")

    session_after = aggregation["session"]
    assert session_after["status"] == "active"  # snapshot was taken before the report


async def test_learner_can_end_lesson_and_waiter_unblocks(daemon_server):
    import mcp_bridge.server as bridge

    started = await bridge.start_lesson(part_mode="part2", topic_hint="Cue card", open_browser=False)
    session_id = started["session_id"]

    waiter = asyncio.create_task(
        bridge.respond_with_feedback_and_wait(
            session_id=session_id,
            examiner_text="Describe a skill you learned recently.",
            part="part2",
            timeout_sec=30,
        )
    )
    await asyncio.sleep(0.4)
    ended = await bridge.end_lesson(session_id=session_id, reason="test")
    assert ended["status"] == "lesson_ended_by_user"

    result = await waiter
    assert result["status"] == "lesson_ended_by_user"


async def test_audio_validation_rejects_webm(daemon_server):
    import mcp_bridge.server as bridge

    started = await bridge.start_lesson(part_mode="part1", topic_hint="bad audio", open_browser=False)
    session_id = started["session_id"]
    async with httpx.AsyncClient(base_url=daemon_server.url, timeout=20.0) as client:
        response = await client.post(
            f"/api/sessions/{session_id}/audio",
            files={"file": ("turn.webm", b"\x1aE\xdf\xa3" + b"\x00" * 300, "audio/webm")},
        )
    assert response.status_code == 400
    assert "WAV" in response.json()["detail"]


async def test_static_companion_ui_is_served(daemon_server):
    async with httpx.AsyncClient(base_url=daemon_server.url, timeout=20.0) as client:
        response = await client.get("/")
    assert response.status_code == 200
    assert "IELTS" in response.text
