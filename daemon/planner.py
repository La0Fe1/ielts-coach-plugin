"""Lesson planning: pick questions from the local bank and weave in review.

The learner never chooses a topic. Each lesson is composed as

    review block (from long-term memory)  +  new material (random, rotated)

* Review block: recurring grammar patterns, weak phonemes, questions the learner
  answered badly before, and an existing Part 2 story worth polishing. It is
  empty for the very first lesson.
* New block: a topic from daemon/content/question_bank.json that has not been used
  in the recent sessions, chosen at random (seeded for reproducible tests).

The resulting plan is handed to the agent, which must read the questions verbatim
instead of inventing its own - that keeps examiners consistent between lessons.
"""

from __future__ import annotations

import json
import logging
import random
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

DEFAULT_BANK = Path(__file__).resolve().parent / "content" / "question_bank.json"
PART_MODES = {"part1", "part2", "part3", "full_mock", "free_drill"}


def _load_bank(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as handle:
        data = json.load(handle)
    for part in ("part1", "part2", "part3"):
        data.setdefault(part, [])
    return data


class QuestionBank:
    """Read-only view over the JSON bank with a tiny fuzzy search."""

    def __init__(self, path: Path | None = None):
        self.path = Path(path) if path else DEFAULT_BANK
        self.data = _load_bank(self.path)
        self._by_id: dict[str, tuple[str, dict[str, Any]]] = {}
        for part in ("part1", "part2", "part3"):
            for item in self.data[part]:
                self._by_id[item["id"]] = (part, item)

    # -- access ----------------------------------------------------------
    def topics(self, part: str) -> list[dict[str, Any]]:
        return list(self.data.get(part, []))

    def get(self, topic_id: str) -> tuple[str, dict[str, Any]] | None:
        return self._by_id.get(topic_id)

    def find(self, query: str) -> list[tuple[str, dict[str, Any]]]:
        """Match a free-text topic hint against id / title / zh title / tags."""
        needle = (query or "").strip().lower()
        if not needle:
            return []
        scored: list[tuple[int, str, dict[str, Any]]] = []
        for topic_id, (part, item) in self._by_id.items():
            haystacks = [
                topic_id.lower(),
                str(item.get("topic", "")).lower(),
                str(item.get("topic_zh", "")).lower(),
                str(item.get("title", "")).lower(),
                " ".join(item.get("tags", [])).lower(),
            ]
            score = 0
            for text in haystacks:
                if not text:
                    continue
                if text == needle:
                    score = max(score, 100)
                elif needle in text or text in needle:
                    score = max(score, 50)
            for tag in item.get("tags", []):
                if needle in tag.lower():
                    score = max(score, 40)
            if score:
                scored.append((score, part, item))
        scored.sort(key=lambda row: (-row[0], row[1], row[2]["id"]))
        return [(part, item) for _score, part, item in scored]

    def question_count(self) -> dict[str, int]:
        return {
            "part1_topics": len(self.data["part1"]),
            "part2_cards": len(self.data["part2"]),
            "part3_sets": len(self.data["part3"]),
            "questions": sum(len(t["questions"]) for t in self.data["part1"])
            + len(self.data["part2"])
            + sum(len(t["questions"]) for t in self.data["part3"]),
        }


@dataclass
class LessonPlan:
    part_mode: str
    topic: dict[str, Any]
    questions: list[dict[str, Any]]
    review: dict[str, Any]
    focus: list[str]
    is_first_lesson: bool
    rationale: str
    plan_id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])

    def as_dict(self) -> dict[str, Any]:
        return {
            "plan_id": self.plan_id,
            "part_mode": self.part_mode,
            "topic": self.topic,
            "questions": self.questions,
            "review": self.review,
            "focus": self.focus,
            "is_first_lesson": self.is_first_lesson,
            "rationale": self.rationale,
            "question_count": len(self.questions),
        }


class LessonPlanner:
    def __init__(self, bank: QuestionBank, db):
        self.bank = bank
        self.db = db

    # -- helpers ---------------------------------------------------------
    def _has_history(self) -> bool:
        try:
            sessions = self.db.list_sessions(limit=1)
        except Exception:  # noqa: BLE001
            sessions = []
        return bool(sessions)

    def _review_block(self) -> dict[str, Any]:
        context = self.db.get_learner_context()
        grammar = context.get("top_grammar_weaknesses") or []
        phonemes = context.get("top_weak_phonemes") or []
        stories = context.get("part2_stories") or []
        plan_note = context.get("last_lesson_plan") or None
        revisit = self.db.struggled_questions(limit=3)
        return {
            "grammar_patterns": [
                {
                    "pattern": item.get("error_pattern"),
                    "category": item.get("error_category"),
                    "count": item.get("count"),
                    "explanation": item.get("explanation"),
                }
                for item in grammar[:3]
            ],
            "weak_phonemes": [
                {
                    "phoneme": item.get("phoneme"),
                    "avg_score": item.get("avg_score"),
                    "count": item.get("count"),
                }
                for item in phonemes[:3]
            ],
            "revisit_questions": [
                {
                    "question": row.get("examiner_question"),
                    "session_id": row.get("session_id"),
                    "turn_id": row.get("turn_id"),
                    "mistakes": row.get("mistakes"),
                }
                for row in revisit
            ],
            "story_to_polish": (
                {"title": stories[0].get("title"), "content": stories[0].get("content")}
                if stories
                else None
            ),
            "last_plan": (plan_note or {}).get("content") if plan_note else None,
        }

    def _pick_topic(
        self,
        part: str,
        topic_hint: str | None,
        rng: random.Random,
        used: set[str],
    ) -> dict[str, Any]:
        if topic_hint:
            matches = self.bank.find(topic_hint)
            for candidate_part, item in matches:
                if candidate_part == part:
                    return item
        topics = self.bank.topics(part)
        if not topics:
            raise RuntimeError("题库为空：" + part)
        fresh = [topic for topic in topics if topic["id"] not in used]
        pool = fresh or topics
        return rng.choice(pool)

    def _questions_for(self, part: str, topic: dict[str, Any]) -> list[dict[str, Any]]:
        if part == "part2":
            bullets = "; ".join(topic.get("bullets", []))
            cue = topic.get("title", "")
            text = cue + "\nYou should say: " + bullets + "."
            items = [{"part": "part2", "text": text, "ref": topic["id"], "kind": "cue_card"}]
            for index, follow in enumerate(topic.get("follow_ups", [])[:2], start=1):
                items.append(
                    {
                        "part": "part3",
                        "text": follow,
                        "ref": topic["id"] + "#f" + str(index),
                        "kind": "follow_up",
                    }
                )
            return items
        return [
            {
                "part": part,
                "text": text,
                "ref": topic["id"] + "#q" + str(index),
                "kind": "question",
            }
            for index, text in enumerate(topic.get("questions", []), start=1)
        ]

    # -- public ----------------------------------------------------------
    def plan(
        self,
        part_mode: str = "part1",
        topic_hint: str | None = None,
        seed: int | None = None,
        record_usage: bool = False,
    ) -> LessonPlan:
        mode = (part_mode or "part1").strip().lower()
        if mode not in PART_MODES:
            mode = "part1"
        rng = random.Random(seed)
        used = set(self.db.recent_topic_keys(limit=8))
        review = self._review_block()
        has_history = self._has_history()

        questions: list[dict[str, Any]] = []
        topics: list[dict[str, Any]] = []

        if mode == "part1":
            topic = self._pick_topic("part1", topic_hint, rng, used)
            topics.append(topic)
            questions = self._questions_for("part1", topic)
        elif mode == "part2":
            topic = self._pick_topic("part2", topic_hint, rng, used)
            topics.append(topic)
            questions = self._questions_for("part2", topic)
        elif mode == "part3":
            topic = self._pick_topic("part3", topic_hint, rng, used)
            topics.append(topic)
            questions = self._questions_for("part3", topic)
        elif mode == "full_mock":
            t1 = self._pick_topic("part1", topic_hint, rng, used)
            used.add(t1["id"])
            t2 = self._pick_topic("part2", None, rng, used)
            used.add(t2["id"])
            t3 = self._pick_topic("part3", None, rng, used)
            topics.extend([t1, t2, t3])
            questions = (
                self._questions_for("part1", t1)[:3]
                + self._questions_for("part2", t2)
                + self._questions_for("part3", t3)
            )
        else:  # free_drill / drill
            revisit = review["revisit_questions"]
            if revisit:
                questions = [
                    {
                        "part": "drill",
                        "text": row["question"],
                        "ref": "revisit:" + str(row.get("turn_id")),
                        "kind": "revisit",
                    }
                    for row in revisit[:3]
                    if row.get("question")
                ]
            topic = self._pick_topic("part1", topic_hint, rng, used)
            topics.append(topic)
            questions += self._questions_for("part1", topic)[:2]

        # A review question opens the lesson whenever we have history: it is the
        # cheapest way to make "last lesson" visible in this lesson.
        review_questions: list[dict[str, Any]] = []
        if has_history and review["revisit_questions"] and mode != "free_drill":
            top = review["revisit_questions"][0]
            if top.get("question"):
                review_questions.append(
                    {
                        "part": "review",
                        "text": top["question"],
                        "ref": "revisit:" + str(top.get("turn_id")),
                        "kind": "revisit",
                    }
                )

        focus: list[str] = []
        focus += [item["pattern"] for item in review["grammar_patterns"][:2] if item.get("pattern")]
        focus += [item["phoneme"] for item in review["weak_phonemes"][:2] if item.get("phoneme")]
        if review.get("story_to_polish"):
            focus.append("part2_story_reuse")

        if has_history:
            rationale = (
                "沿用上一节课的记忆：复习 "
                + ("、".join(focus) if focus else "高频错误")
                + "；新题来自题库随机抽取（避开最近 "
                + str(len(used))
                + " 个已用话题）。"
            )
        else:
            rationale = "这是第一节课：从题库随机抽题建立基线，暂不注入复习块。"

        plan_obj = LessonPlan(
            part_mode=mode,
            topic={
                "id": topics[0]["id"] if topics else None,
                "title": topics[0].get("topic") or topics[0].get("title") if topics else topic_hint,
                "title_zh": topics[0].get("topic_zh") if topics else topic_hint,
                "tags": topics[0].get("tags", []) if topics else [],
                "all_topics": [
                    {"id": t["id"], "title": t.get("topic") or t.get("title"), "topic_zh": t.get("topic_zh")}
                    for t in topics
                ],
            },
            questions=review_questions + questions,
            review=review,
            focus=focus,
            is_first_lesson=not has_history,
            rationale=rationale,
        )

        if record_usage:
            for topic in topics:
                try:
                    self.db.record_topic_use(topic["id"], topic.get("tags", []))
                except Exception as exc:  # noqa: BLE001
                    logger.debug("记录话题使用失败: %s", exc)
        return plan_obj
