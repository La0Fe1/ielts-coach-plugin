"""Unit tests for the SQLite long-term memory layer."""

from __future__ import annotations

import json

import pytest

from daemon.db import Database


def test_schema_is_created_idempotently(db):
    expected = {
        "learner_profile",
        "sessions",
        "turns",
        "grammar_mistakes",
        "pronunciation_issues",
        "memory_notes",
        "lesson_reports",
    }
    assert expected.issubset(set(db.table_names()))
    # running init again must not raise or drop data
    db.init_schema()
    assert expected.issubset(set(db.table_names()))


def test_default_profile(db):
    profile = db.get_profile()
    assert profile["id"] == 1
    assert profile["accent_preference"] == "uk"
    assert profile["target_band"] == 7.0
    assert profile["feedback_style"] == "instant_card_plus_voice"

    updated = db.update_profile(target_band=7.5, accent_preference="us", name="Ann")
    assert updated["target_band"] == 7.5
    assert updated["accent_preference"] == "us"
    assert updated["name"] == "Ann"


def test_session_and_turn_lifecycle(db):
    session = db.create_session("part1", "Hometown", target_band=7.0)
    assert session["status"] == "active"
    session_id = session["id"]

    turn_one = db.create_turn(session_id, "part1", "Where is your hometown?")
    assert turn_one["turn_index"] == 1
    turn_two = db.create_turn(session_id, "part1", "What do you like about it?")
    assert turn_two["turn_index"] == 2

    db.update_turn(
        turn_one["id"],
        learner_transcript="I live in Shanghai",
        wpm=132.5,
        pause_count=2,
        long_pauses_json={"pauses": [{"after_word": "Shanghai", "duration_sec": 0.9}]},
    )
    refreshed = db.get_turn(turn_one["id"])
    assert refreshed["wpm"] == 132.5
    # JSON columns come back decoded
    assert refreshed["long_pauses_json"]["pauses"][0]["duration_sec"] == 0.9

    turns = db.list_turns(session_id)
    assert [t["turn_index"] for t in turns] == [1, 2]
    assert db.get_turn_by_index(session_id, 2)["examiner_question"] == "What do you like about it?"


def test_grammar_mistakes_are_tracked_by_pattern(db):
    session = db.create_session("part1", "Grammar drill")
    turn = db.create_turn(session["id"], "part1", "Tell me about your weekend.")
    db.add_grammar_mistakes(
        session["id"],
        turn["id"],
        [
            {
                "error_category": "tense",
                "error_pattern": "past_tense_missing_did",
                "original_excerpt": "I go to cinema yesterday",
                "corrected_excerpt": "I went to the cinema yesterday",
                "explanation": "过去时间状语需要动词过去式",
            },
            {
                "error_category": "article",
                "error_pattern": "missing_article",
                "original_excerpt": "I am student",
                "corrected_excerpt": "I am a student",
                "explanation": "单数可数名词前需要冠词",
            },
        ],
    )
    db.add_grammar_mistake(
        session_id=session["id"],
        turn_id=turn["id"],
        error_category="tense",
        error_pattern="past_tense_missing_did",
        original_excerpt="I see him last week",
        corrected_excerpt="I saw him last week",
        explanation="同上",
    )
    # an unknown category is normalised instead of crashing
    db.add_grammar_mistake(
        session["id"], turn["id"], "not_a_category", "unknown", "a", "b", "c"
    )

    stats = db.grammar_pattern_stats(limit=5)
    by_pattern = {row["error_pattern"]: row for row in stats}
    assert by_pattern["past_tense_missing_did"]["count"] == 2
    assert by_pattern["missing_article"]["count"] == 1
    assert "unknown" in by_pattern
    assert len(db.list_grammar_mistakes(session["id"])) == 4


def test_memory_notes_upsert_increments_frequency(db):
    first = db.upsert_memory_note(
        "weakness_grammar", "missing_article", "冠词缺失", "经常漏掉 a/an", mastery_delta=0.1
    )
    assert first["frequency_count"] == 1

    second = db.upsert_memory_note(
        "weakness_grammar", "missing_article", "冠词缺失", "又漏了 a/an", mastery_delta=0.2
    )
    assert second["frequency_count"] == 2
    assert second["mastery_score"] > first["mastery_score"]

    # unknown memory_type is coerced to personal_fact
    coerced = db.upsert_memory_note("bogus_type", "k", "t", "c")
    assert coerced["memory_type"] == "personal_fact"


def test_learner_context_aggregates_everything(db):
    context = db.get_learner_context()
    assert context["profile"]["id"] == 1
    assert context["has_history"] is False

    session = db.create_session("part2", "A memorable trip")
    turn = db.create_turn(session["id"], "part2", "Describe a memorable trip.")
    db.add_grammar_mistake(
        session["id"], turn["id"], "tense", "past_tense_missing_did", "I go", "I went", "过去式"
    )
    db.upsert_memory_note("part2_story", "trip_2024", "云南旅行", "去年和家人去了云南")
    db.upsert_memory_note("weakness_phoneme", "phoneme_theta", "/θ/ 发成 /s/", "think -> sink")
    db.add_pronunciation_issue(
        session["id"],
        turn["id"],
        word="think",
        expected_ipa="θɪŋk",
        phoneme="θ",
        gop_score=-2.7,
        word_score=48,
    )

    context = db.get_learner_context()
    assert context["has_history"] is True
    assert context["top_grammar_weaknesses"][0]["error_pattern"] == "past_tense_missing_did"
    assert context["part2_stories"][0]["memory_key"] == "trip_2024"
    assert context["top_weak_phonemes"][0]["phoneme"] == "θ"


def test_lesson_aggregation_and_report(db):
    session = db.create_session("part1", "Technology")
    session_id = session["id"]
    turn = db.create_turn(session_id, "part1", "Do you use technology?")
    db.update_turn(
        turn["id"],
        learner_transcript="yes i use many technology every day",
        wpm=118.0,
        pause_count=1,
        learner_duration_sec=4.2,
    )
    db.add_grammar_mistake(
        session_id, turn["id"], "plural_singular", "much_many_confusion", "many technology", "much technology", "不可数名词"
    )

    aggregation = db.get_lesson_aggregation(session_id)
    assert aggregation["turn_count"] == 1
    assert aggregation["answered_turn_count"] == 1
    assert aggregation["avg_wpm"] == 118.0
    assert aggregation["grammar_by_category"]["plural_singular"] == 1
    assert aggregation["total_words"] == 7
    assert aggregation["session"]["id"] == session_id

    report = db.save_lesson_report(
        session_id=session_id,
        report_markdown="# 报告",
        report_json={"bands": {"overall": 6.5}},
        markdown_file_path="/tmp/report.md",
        bands={"overall": 6.5, "fc": 6.0, "lr": 6.5, "gra": 6.0, "pr": None},
        next_lesson_plan="下节课专练不可数名词",
        summary={"bands": {"overall": 6.5}},
    )
    assert report["session_id"] == session_id
    assert json.loads(json.dumps(report["report_json"]))["bands"]["overall"] == 6.5

    refreshed = db.get_session(session_id)
    assert refreshed["status"] == "completed"
    assert refreshed["estimated_band_overall"] == 6.5
    assert refreshed["ended_at"] is not None

    history = db.band_history(limit=5)
    assert len(history) == 1
    assert history[0]["estimated_band_overall"] == 6.5

    # saving twice updates rather than duplicates
    db.save_lesson_report(session_id, "# 报告 v2", {"bands": {}}, "/tmp/report2.md", bands={})
    assert db.get_lesson_report(session_id)["markdown_file_path"] == "/tmp/report2.md"

    plan = db.get_memory_note("next_lesson_plan", "latest")
    assert plan is not None
    assert "不可数名词" in plan["content"]


def test_database_survives_new_instance(temp_home):
    first = Database()
    session = first.create_session("part3", "Persisted")
    first.close()

    second = Database()
    assert second.get_session(session["id"])["topic_title"] == "Persisted"
    second.close()
