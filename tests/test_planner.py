"""Lesson planner tests: question bank, rotation and memory-driven review."""

from __future__ import annotations

import pytest

from daemon.planner import LessonPlanner, QuestionBank


@pytest.fixture()
def bank():
    return QuestionBank()


@pytest.fixture()
def planner(db, bank):
    return LessonPlanner(bank, db)


def test_bank_integrity(bank):
    counts = bank.question_count()
    assert counts["part1_topics"] >= 12
    assert counts["part2_cards"] >= 12
    assert counts["part3_sets"] >= 8
    ids = []
    for part in ("part1", "part2", "part3"):
        for topic in bank.topics(part):
            ids.append(topic["id"])
            assert topic.get("tags"), topic
            if part == "part2":
                assert topic.get("title") and topic.get("bullets")
            else:
                assert len(topic.get("questions", [])) >= 3, topic
    assert len(ids) == len(set(ids)), "duplicate topic ids"


def test_first_lesson_has_no_review_and_unique_refs(planner):
    plan = planner.plan(part_mode="part1", seed=7)
    assert plan.is_first_lesson is True
    assert plan.review["grammar_patterns"] == []
    assert plan.review["revisit_questions"] == []
    assert plan.questions, "plan must contain questions"
    assert all(item["part"] == "part1" for item in plan.questions)
    refs = [item["ref"] for item in plan.questions]
    assert len(refs) == len(set(refs))


def test_plan_is_deterministic_with_seed(planner):
    first = planner.plan(part_mode="part1", seed=42).as_dict()
    second = planner.plan(part_mode="part1", seed=42).as_dict()
    assert [q["text"] for q in first["questions"]] == [q["text"] for q in second["questions"]]
    assert first["topic"]["id"] == second["topic"]["id"]


def test_topic_hint_is_respected(planner):
    plan = planner.plan(part_mode="part1", topic_hint="food", seed=1)
    assert plan.topic["id"] == "p1_food"
    assert any("food" in q["text"].lower() for q in plan.questions)


def test_rotation_avoids_recent_topics(planner, db):
    topics = QuestionBank().topics("part1")
    used = [topic["id"] for topic in topics[:6]]
    for topic_id in used:
        db.record_topic_use(topic_id, ["x"])
    plan = planner.plan(part_mode="part1", seed=3)
    assert plan.topic["id"] not in used


def test_review_block_comes_from_memory(planner, db):
    session = db.create_session("part1", "Old lesson")
    turn = db.create_turn(session["id"], "part1", "What did you do last weekend?")
    db.update_turn(turn["id"], learner_transcript="I go to cinema")
    db.add_grammar_mistake(
        session["id"],
        turn["id"],
        "tense",
        "past_tense_missing_did",
        "I go to cinema",
        "I went to the cinema",
        "过去时间要用过去式",
    )
    db.add_pronunciation_issue(
        session["id"], turn["id"], word="think", phoneme="θ", gop_score=-3.2, word_score=48
    )
    db.upsert_memory_note("part2_story", "trip_2024", "云南旅行", "去年和家人去了云南")

    plan = planner.plan(part_mode="part1", seed=5)
    assert plan.is_first_lesson is False
    assert plan.review["grammar_patterns"][0]["pattern"] == "past_tense_missing_did"
    assert plan.review["weak_phonemes"][0]["phoneme"] == "θ"
    assert plan.review["story_to_polish"]["title"] == "云南旅行"
    assert plan.review["revisit_questions"][0]["question"] == "What did you do last weekend?"
    assert "past_tense_missing_did" in plan.focus
    assert "θ" in plan.focus
    assert plan.questions[0]["kind"] == "revisit"
    assert plan.questions[0]["text"] == "What did you do last weekend?"


def test_part2_plan_contains_a_cue_card(planner):
    plan = planner.plan(part_mode="part2", seed=11)
    cue = plan.questions[0]
    assert cue["kind"] == "cue_card"
    assert "You should say" in cue["text"]
    assert plan.topic["id"].startswith("p2_")


def test_full_mock_covers_three_parts(planner):
    plan = planner.plan(part_mode="full_mock", seed=2)
    parts = {item["part"] for item in plan.questions}
    assert {"part1", "part2", "part3"} <= parts
    assert any(item["kind"] == "cue_card" for item in plan.questions)


def test_free_drill_prefers_revisit_items(planner, db):
    session = db.create_session("part1", "Drill base")
    turn = db.create_turn(session["id"], "part1", "Do you enjoy reading?")
    db.update_turn(turn["id"], learner_transcript="I enjoy read")
    db.add_grammar_mistake(
        session["id"], turn["id"], "tense", "past_tense_missing_did", "a", "b", "c"
    )
    plan = planner.plan(part_mode="free_drill", seed=9)
    assert plan.questions, plan
    assert plan.questions[0]["kind"] == "revisit"


def test_record_usage_writes_rotation_history(planner, db):
    plan = planner.plan(part_mode="part1", seed=13, record_usage=True)
    assert plan.topic["id"] in db.recent_topic_keys(limit=5)
