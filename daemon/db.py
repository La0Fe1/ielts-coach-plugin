"""SQLite persistence and long-term memory for the IELTS Coach daemon.

The schema lives in database/schema.sql and is applied idempotently on start-up.
Every public method returns plain JSON-serialisable data (dict / list / scalar)
so it can be forwarded straight to the MCP bridge and the companion UI.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Sequence

from . import config

JSON_COLUMNS = {
    "plan_json",
    "long_pauses_json",
    "pronunciation_json",
    "grammar_feedback_json",
    "pronunciation_feedback_json",
    "summary_json",
    "report_json",
}

#: Tables added by Phase 2.5 (topic rotation + lesson plans). They are not part of
#: the original database/schema.sql, so they live here and are created idempotently.
_EXTRA_SCHEMA = """
CREATE TABLE IF NOT EXISTS topic_usage (
    topic_key TEXT PRIMARY KEY,
    tags TEXT NOT NULL DEFAULT '',
    use_count INTEGER NOT NULL DEFAULT 1,
    last_used_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lesson_plans (
    session_id INTEGER PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    plan_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
"""

VALID_MEMORY_TYPES = {
    "weakness_grammar",
    "weakness_phoneme",
    "personal_fact",
    "part2_story",
    "next_lesson_plan",
}

VALID_ERROR_CATEGORIES = {
    "tense",
    "subject_verb_agreement",
    "article",
    "preposition",
    "collocation",
    "word_order",
    "chinglish",
    "plural_singular",
    "other",
}

VALID_PARTS = {"part1", "part2", "part3", "drill"}
VALID_PART_MODES = {"part1", "part2", "part3", "full_mock", "free_drill"}


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def _row_to_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if row is None:
        return None
    data = dict(row)
    for column in JSON_COLUMNS & data.keys():
        raw = data[column]
        if isinstance(raw, str) and raw:
            try:
                data[column] = json.loads(raw)
            except json.JSONDecodeError:
                pass
    return data


def _dumps(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False)


class Database:
    """Thread-safe SQLite wrapper (one connection per thread, WAL mode)."""

    def __init__(self, db_path: Path | str | None = None, schema_path: Path | str | None = None):
        paths = config.get_paths()
        self.db_path = Path(db_path) if db_path else paths.db_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.schema_path = Path(schema_path) if schema_path else config.find_schema_file()
        self._local = threading.local()
        self._lock = threading.RLock()
        self.init_schema()

    # -- connection handling -------------------------------------------------
    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(
            str(self.db_path), timeout=30.0, check_same_thread=False, isolation_level=None
        )
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA busy_timeout=30000")
        return conn

    @property
    def conn(self) -> sqlite3.Connection:
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = self._connect()
            self._local.conn = conn
        return conn

    def close(self) -> None:
        conn = getattr(self._local, "conn", None)
        if conn is not None:
            try:
                conn.close()
            finally:
                self._local.conn = None

    # -- schema --------------------------------------------------------------
    def schema_sql(self) -> str:
        if self.schema_path is None or not Path(self.schema_path).is_file():
            raise FileNotFoundError(
                "database/schema.sql 未找到，请设置 IELTS_COACH_SCHEMA 或重新安装项目。"
            )
        return Path(self.schema_path).read_text(encoding="utf-8")

    def init_schema(self) -> None:
        sql = self.schema_sql()
        with self._lock:
            conn = self.conn
            conn.executescript(sql)
            conn.executescript(_EXTRA_SCHEMA)
            conn.commit()

    def table_names(self) -> list[str]:
        rows = self.conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        ).fetchall()
        return [row[0] for row in rows]

    # -- helpers -------------------------------------------------------------
    def _execute(self, sql: str, params: Sequence[Any] = ()) -> sqlite3.Cursor:
        with self._lock:
            return self.conn.execute(sql, tuple(params))

    def _query_all(self, sql: str, params: Sequence[Any] = ()) -> list[dict[str, Any]]:
        with self._lock:
            rows = self.conn.execute(sql, tuple(params)).fetchall()
        return [_row_to_dict(row) or {} for row in rows]

    def _query_one(self, sql: str, params: Sequence[Any] = ()) -> dict[str, Any] | None:
        with self._lock:
            row = self.conn.execute(sql, tuple(params)).fetchone()
        return _row_to_dict(row)

    # -- learner profile -----------------------------------------------------
    def get_profile(self) -> dict[str, Any]:
        row = self._query_one("SELECT * FROM learner_profile WHERE id = 1")
        if row is None:
            self._execute(
                "INSERT OR IGNORE INTO learner_profile (id) VALUES (1)"
            )
            row = self._query_one("SELECT * FROM learner_profile WHERE id = 1")
        return row or {}

    def update_profile(self, **fields: Any) -> dict[str, Any]:
        allowed = {"name", "target_band", "accent_preference", "feedback_style", "native_language"}
        updates = {k: v for k, v in fields.items() if k in allowed and v is not None}
        if updates:
            updates["updated_at"] = utc_now()
            assignments = ", ".join(f"{key} = ?" for key in updates)
            self._execute(
                f"UPDATE learner_profile SET {assignments} WHERE id = 1",
                list(updates.values()),
            )
        return self.get_profile()

    # -- sessions ------------------------------------------------------------
    def create_session(
        self,
        part_mode: str,
        topic_title: str,
        feedback_style: str = "instant_card_plus_voice",
        target_band: float | None = None,
    ) -> dict[str, Any]:
        if part_mode not in VALID_PART_MODES:
            part_mode = "part1"
        cursor = self._execute(
            "INSERT INTO sessions (part_mode, topic_title, feedback_style) VALUES (?, ?, ?)",
            (part_mode, topic_title, feedback_style),
        )
        session_id = int(cursor.lastrowid)
        if target_band is not None:
            self.update_profile(target_band=target_band)
        session = self.get_session(session_id)
        assert session is not None
        return session

    def get_session(self, session_id: int) -> dict[str, Any] | None:
        return self._query_one("SELECT * FROM sessions WHERE id = ?", (session_id,))

    def list_sessions(self, limit: int = 20) -> list[dict[str, Any]]:
        return self._query_all(
            "SELECT * FROM sessions ORDER BY id DESC LIMIT ?", (int(limit),)
        )

    def update_session(self, session_id: int, **fields: Any) -> dict[str, Any] | None:
        allowed = {
            "topic_title",
            "feedback_style",
            "status",
            "ended_at",
            "estimated_band_overall",
            "band_fc",
            "band_lr",
            "band_gra",
            "band_pr",
            "summary_json",
        }
        updates = {k: v for k, v in fields.items() if k in allowed}
        if updates:
            if "summary_json" in updates:
                updates["summary_json"] = _dumps(updates["summary_json"])
            assignments = ", ".join(f"{key} = ?" for key in updates)
            self._execute(
                f"UPDATE sessions SET {assignments} WHERE id = ?",
                list(updates.values()) + [session_id],
            )
        return self.get_session(session_id)

    def complete_session(
        self,
        session_id: int,
        bands: dict[str, Any] | None = None,
        status: str = "completed",
        summary: Any = None,
    ) -> dict[str, Any] | None:
        bands = bands or {}
        return self.update_session(
            session_id,
            status=status,
            ended_at=utc_now(),
            estimated_band_overall=bands.get("overall"),
            band_fc=bands.get("fc"),
            band_lr=bands.get("lr"),
            band_gra=bands.get("gra"),
            band_pr=bands.get("pr"),
            summary_json=summary,
        )

    # -- turns ---------------------------------------------------------------
    def next_turn_index(self, session_id: int) -> int:
        row = self._query_one(
            "SELECT COALESCE(MAX(turn_index), 0) AS idx FROM turns WHERE session_id = ?",
            (session_id,),
        )
        return int((row or {}).get("idx", 0)) + 1

    def create_turn(
        self,
        session_id: int,
        part: str,
        examiner_question: str,
        examiner_tts_path: str | None = None,
        turn_index: int | None = None,
    ) -> dict[str, Any]:
        if part not in VALID_PARTS:
            part = "part1"
        index = turn_index if turn_index is not None else self.next_turn_index(session_id)
        cursor = self._execute(
            "INSERT INTO turns (session_id, turn_index, part, examiner_question, examiner_tts_path)"
            " VALUES (?, ?, ?, ?, ?)",
            (session_id, index, part, examiner_question, examiner_tts_path),
        )
        turn = self.get_turn(int(cursor.lastrowid))
        assert turn is not None
        return turn

    def get_turn(self, turn_id: int) -> dict[str, Any] | None:
        return self._query_one("SELECT * FROM turns WHERE id = ?", (turn_id,))

    def get_turn_by_index(self, session_id: int, turn_index: int) -> dict[str, Any] | None:
        return self._query_one(
            "SELECT * FROM turns WHERE session_id = ? AND turn_index = ?",
            (session_id, turn_index),
        )

    def list_turns(self, session_id: int) -> list[dict[str, Any]]:
        return self._query_all(
            "SELECT * FROM turns WHERE session_id = ? ORDER BY turn_index ASC",
            (session_id,),
        )

    def update_turn(self, turn_id: int, **fields: Any) -> dict[str, Any] | None:
        allowed = {
            "examiner_question",
            "examiner_tts_path",
            "learner_audio_path",
            "learner_duration_sec",
            "learner_transcript",
            "wpm",
            "pause_count",
            "long_pauses_json",
            "pronunciation_score",
            "pronunciation_json",
            "corrected_text",
            "upgraded_text",
            "grammar_feedback_json",
            "pronunciation_feedback_json",
        }
        updates = {k: v for k, v in fields.items() if k in allowed}
        if updates:
            for key in list(updates):
                if key in JSON_COLUMNS:
                    updates[key] = _dumps(updates[key])
            assignments = ", ".join(f"{key} = ?" for key in updates)
            self._execute(
                f"UPDATE turns SET {assignments} WHERE id = ?",
                list(updates.values()) + [turn_id],
            )
        return self.get_turn(turn_id)

    # -- grammar mistakes ----------------------------------------------------
    def add_grammar_mistake(
        self,
        session_id: int,
        turn_id: int,
        error_category: str,
        error_pattern: str,
        original_excerpt: str,
        corrected_excerpt: str,
        explanation: str,
        upgraded_excerpt: str | None = None,
    ) -> dict[str, Any]:
        if error_category not in VALID_ERROR_CATEGORIES:
            error_category = "other"
        cursor = self._execute(
            "INSERT INTO grammar_mistakes (session_id, turn_id, error_category, error_pattern,"
            " original_excerpt, corrected_excerpt, upgraded_excerpt, explanation)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                session_id,
                turn_id,
                error_category,
                error_pattern,
                original_excerpt,
                corrected_excerpt,
                upgraded_excerpt,
                explanation,
            ),
        )
        return self._query_one(
            "SELECT * FROM grammar_mistakes WHERE id = ?", (int(cursor.lastrowid),)
        ) or {}

    def add_grammar_mistakes(
        self, session_id: int, turn_id: int, mistakes: Iterable[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        saved = []
        for mistake in mistakes or []:
            saved.append(
                self.add_grammar_mistake(
                    session_id=session_id,
                    turn_id=turn_id,
                    error_category=mistake.get("error_category", "other"),
                    error_pattern=mistake.get("error_pattern", "unspecified"),
                    original_excerpt=mistake.get("original_excerpt", ""),
                    corrected_excerpt=mistake.get("corrected_excerpt", ""),
                    explanation=mistake.get("explanation", ""),
                    upgraded_excerpt=mistake.get("upgraded_excerpt"),
                )
            )
        return saved

    def list_grammar_mistakes(self, session_id: int) -> list[dict[str, Any]]:
        return self._query_all(
            "SELECT * FROM grammar_mistakes WHERE session_id = ? ORDER BY id ASC",
            (session_id,),
        )

    def grammar_pattern_stats(self, limit: int = 10) -> list[dict[str, Any]]:
        return self._query_all(
            "SELECT error_pattern, error_category, COUNT(*) AS count,"
            " MAX(created_at) AS last_seen,"
            " (SELECT explanation FROM grammar_mistakes AS g2"
            "   WHERE g2.error_pattern = g1.error_pattern ORDER BY g2.id DESC LIMIT 1) AS explanation"
            " FROM grammar_mistakes AS g1"
            " GROUP BY error_pattern ORDER BY count DESC, last_seen DESC LIMIT ?",
            (int(limit),),
        )

    # -- pronunciation issues (populated by Phase 2) --------------------------
    def add_pronunciation_issue(self, session_id: int, turn_id: int, **fields: Any) -> dict[str, Any]:
        cursor = self._execute(
            "INSERT INTO pronunciation_issues (session_id, turn_id, word, expected_ipa, phoneme,"
            " issue_type, gop_score, word_score, audio_start_sec, audio_end_sec, coaching_tip)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                session_id,
                turn_id,
                fields.get("word", ""),
                fields.get("expected_ipa"),
                fields.get("phoneme", ""),
                fields.get("issue_type", "phoneme_distortion"),
                fields.get("gop_score"),
                fields.get("word_score"),
                fields.get("audio_start_sec"),
                fields.get("audio_end_sec"),
                fields.get("coaching_tip"),
            ),
        )
        return self._query_one(
            "SELECT * FROM pronunciation_issues WHERE id = ?", (int(cursor.lastrowid),)
        ) or {}

    def list_pronunciation_issues(self, session_id: int) -> list[dict[str, Any]]:
        return self._query_all(
            "SELECT * FROM pronunciation_issues WHERE session_id = ? ORDER BY id ASC",
            (session_id,),
        )

    def weak_phoneme_stats(self, limit: int = 10) -> list[dict[str, Any]]:
        return self._query_all(
            "SELECT phoneme, COUNT(*) AS count, ROUND(AVG(COALESCE(word_score, 0)), 1) AS avg_score,"
            " MAX(created_at) AS last_seen"
            " FROM pronunciation_issues GROUP BY phoneme"
            " ORDER BY avg_score ASC, count DESC LIMIT ?",
            (int(limit),),
        )

    # -- memory notes --------------------------------------------------------
    def upsert_memory_note(
        self,
        memory_type: str,
        memory_key: str,
        title: str,
        content: str,
        mastery_delta: float = 0.0,
    ) -> dict[str, Any]:
        if memory_type not in VALID_MEMORY_TYPES:
            memory_type = "personal_fact"
        existing = self._query_one(
            "SELECT * FROM memory_notes WHERE memory_type = ? AND memory_key = ?",
            (memory_type, memory_key),
        )
        now = utc_now()
        if existing is None:
            self._execute(
                "INSERT INTO memory_notes (memory_type, memory_key, title, content,"
                " frequency_count, mastery_score, last_seen_at) VALUES (?, ?, ?, ?, 1, ?, ?)",
                (
                    memory_type,
                    memory_key,
                    title,
                    content,
                    max(0.0, min(1.0, 0.25 + float(mastery_delta or 0.0))),
                    now,
                ),
            )
        else:
            mastery = max(0.0, min(1.0, float(existing.get("mastery_score") or 0.0) + float(mastery_delta or 0.0)))
            self._execute(
                "UPDATE memory_notes SET title = ?, content = ?, frequency_count = frequency_count + 1,"
                " mastery_score = ?, last_seen_at = ? WHERE id = ?",
                (title, content, mastery, now, existing["id"]),
            )
        return self._query_one(
            "SELECT * FROM memory_notes WHERE memory_type = ? AND memory_key = ?",
            (memory_type, memory_key),
        ) or {}

    def list_memory_notes(
        self, memory_type: str | None = None, limit: int = 50
    ) -> list[dict[str, Any]]:
        if memory_type:
            return self._query_all(
                "SELECT * FROM memory_notes WHERE memory_type = ? ORDER BY last_seen_at DESC LIMIT ?",
                (memory_type, int(limit)),
            )
        return self._query_all(
            "SELECT * FROM memory_notes ORDER BY last_seen_at DESC LIMIT ?", (int(limit),)
        )

    def get_memory_note(self, memory_type: str, memory_key: str) -> dict[str, Any] | None:
        return self._query_one(
            "SELECT * FROM memory_notes WHERE memory_type = ? AND memory_key = ?",
            (memory_type, memory_key),
        )

    # -- reports -------------------------------------------------------------
    def save_lesson_report(
        self,
        session_id: int,
        report_markdown: str,
        report_json: Any,
        markdown_file_path: str,
        bands: dict[str, Any] | None = None,
        next_lesson_plan: str | None = None,
        summary: Any = None,
    ) -> dict[str, Any]:
        payload = report_json if isinstance(report_json, dict) else {"raw": report_json}
        if next_lesson_plan:
            payload.setdefault("next_lesson_plan", next_lesson_plan)
        existing = self.get_lesson_report(session_id)
        if existing:
            self._execute(
                "UPDATE lesson_reports SET report_markdown = ?, report_json = ?,"
                " markdown_file_path = ? WHERE session_id = ?",
                (report_markdown, _dumps(payload), markdown_file_path, session_id),
            )
        else:
            self._execute(
                "INSERT INTO lesson_reports (session_id, report_markdown, report_json, markdown_file_path)"
                " VALUES (?, ?, ?, ?)",
                (session_id, report_markdown, _dumps(payload), markdown_file_path),
            )
        self.complete_session(session_id, bands=bands or {}, summary=summary)
        if next_lesson_plan:
            self.upsert_memory_note(
                memory_type="next_lesson_plan",
                memory_key="latest",
                title="下节课处方",
                content=next_lesson_plan,
            )
        report = self.get_lesson_report(session_id)
        assert report is not None
        return report

    def get_lesson_report(self, session_id: int) -> dict[str, Any] | None:
        return self._query_one(
            "SELECT * FROM lesson_reports WHERE session_id = ?", (session_id,)
        )

    def band_history(self, limit: int = 5) -> list[dict[str, Any]]:
        rows = self._query_all(
            "SELECT id AS session_id, topic_title, started_at, estimated_band_overall,"
            " band_fc, band_lr, band_gra, band_pr FROM sessions"
            " WHERE status = 'completed' AND estimated_band_overall IS NOT NULL"
            " ORDER BY id DESC LIMIT ?",
            (int(limit),),
        )
        return list(reversed(rows))

    # -- topic rotation & lesson plans (Phase 2.5) ---------------------------
    def record_topic_use(self, topic_key: str, tags: Sequence[str] | None = None) -> None:
        tags_text = ",".join(tags or [])
        now = utc_now()
        self._execute(
            "INSERT INTO topic_usage (topic_key, tags, use_count, last_used_at)"
            " VALUES (?, ?, 1, ?)"
            " ON CONFLICT(topic_key) DO UPDATE SET"
            " use_count = use_count + 1, last_used_at = excluded.last_used_at,"
            " tags = excluded.tags",
            (topic_key, tags_text, now),
        )

    def recent_topic_keys(self, limit: int = 8) -> list[str]:
        rows = self._query_all(
            "SELECT topic_key FROM topic_usage ORDER BY last_used_at DESC LIMIT ?",
            (int(limit),),
        )
        return [row["topic_key"] for row in rows]

    def save_lesson_plan(self, session_id: int, plan: Any) -> None:
        self._execute(
            "INSERT INTO lesson_plans (session_id, plan_json) VALUES (?, ?)"
            " ON CONFLICT(session_id) DO UPDATE SET plan_json = excluded.plan_json",
            (session_id, _dumps(plan)),
        )

    def get_lesson_plan(self, session_id: int) -> dict[str, Any] | None:
        row = self._query_one(
            "SELECT plan_json FROM lesson_plans WHERE session_id = ?", (session_id,)
        )
        if row is None:
            return None
        plan = row.get("plan_json")
        return plan if isinstance(plan, dict) else None

    def struggled_questions(self, limit: int = 3) -> list[dict[str, Any]]:
        """Questions where the learner produced the most grammar mistakes."""
        return self._query_all(
            "SELECT t.id AS turn_id, t.session_id, t.examiner_question,"
            " COUNT(g.id) AS mistakes, MAX(g.created_at) AS last_seen"
            " FROM turns t JOIN grammar_mistakes g ON g.turn_id = t.id"
            " WHERE length(trim(t.examiner_question)) > 0"
            " GROUP BY t.id ORDER BY mistakes DESC, t.id DESC LIMIT ?",
            (int(limit),),
        )

    # -- aggregates ----------------------------------------------------------
    def get_learner_context(self) -> dict[str, Any]:
        profile = self.get_profile()
        grammar = self.grammar_pattern_stats(limit=5)
        phonemes = self.weak_phoneme_stats(limit=5)
        stories = self.list_memory_notes("part2_story", limit=5)
        facts = self.list_memory_notes("personal_fact", limit=10)
        plan = self.get_memory_note("next_lesson_plan", "latest")
        history = self.band_history(limit=5)
        sessions = self.list_sessions(limit=1)
        return {
            "profile": profile,
            "top_grammar_weaknesses": grammar,
            "top_weak_phonemes": phonemes,
            "part2_stories": stories,
            "personal_facts": facts,
            "last_lesson_plan": plan,
            "band_history": history,
            "last_session": sessions[0] if sessions else None,
            "has_history": bool(history or grammar or stories),
        }

    def get_lesson_aggregation(self, session_id: int) -> dict[str, Any]:
        session = self.get_session(session_id)
        turns = self.list_turns(session_id)
        grammar = self.list_grammar_mistakes(session_id)
        pron = self.list_pronunciation_issues(session_id)
        report = self.get_lesson_report(session_id)

        category_counts: dict[str, int] = {}
        pattern_counts: dict[str, int] = {}
        for mistake in grammar:
            category_counts[mistake["error_category"]] = category_counts.get(mistake["error_category"], 0) + 1
            pattern_counts[mistake["error_pattern"]] = pattern_counts.get(mistake["error_pattern"], 0) + 1

        answered = [t for t in turns if t.get("learner_transcript")]
        wpms = [float(t["wpm"]) for t in answered if t.get("wpm")]
        pauses = [int(t["pause_count"] or 0) for t in answered]
        pron_scores = [
            float(t["pronunciation_score"])
            for t in answered
            if t.get("pronunciation_score") is not None
        ]
        words_total = sum(len((t.get("learner_transcript") or "").split()) for t in answered)
        duration_total = sum(float(t.get("learner_duration_sec") or 0) for t in answered)

        return {
            "session": session,
            "turn_count": len(turns),
            "answered_turn_count": len(answered),
            "total_words": words_total,
            "total_learner_speaking_sec": round(duration_total, 2),
            "avg_wpm": round(sum(wpms) / len(wpms), 1) if wpms else None,
            "total_pauses": sum(pauses),
            "avg_pronunciation_score": round(sum(pron_scores) / len(pron_scores), 1)
            if pron_scores
            else None,
            "grammar_mistakes": grammar,
            "grammar_by_category": category_counts,
            "grammar_by_pattern": pattern_counts,
            "pronunciation_issues": pron,
            "turns": turns,
            "existing_report": report,
            "band_history": self.band_history(limit=5),
        }

    def stats(self) -> dict[str, Any]:
        sessions = self._query_one("SELECT COUNT(*) AS n FROM sessions") or {}
        turns = self._query_one("SELECT COUNT(*) AS n FROM turns") or {}
        notes = self._query_one("SELECT COUNT(*) AS n FROM memory_notes") or {}
        reports = self._query_one("SELECT COUNT(*) AS n FROM lesson_reports") or {}
        return {
            "sessions": int(sessions.get("n", 0)),
            "turns": int(turns.get("n", 0)),
            "memory_notes": int(notes.get("n", 0)),
            "reports": int(reports.get("n", 0)),
        }
