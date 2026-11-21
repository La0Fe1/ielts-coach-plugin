-- =============================================================================
-- IELTS Speaking Coach Plugin — Local SQLite Schema
-- Default DB Path: ~/.ielts-coach/ielts_coach.db
-- =============================================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 1. Learner Profile & Preferences
CREATE TABLE IF NOT EXISTS learner_profile (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    name TEXT NOT NULL DEFAULT 'Learner',
    target_band REAL NOT NULL DEFAULT 7.0,
    accent_preference TEXT NOT NULL DEFAULT 'uk' CHECK (accent_preference IN ('uk', 'us')),
    feedback_style TEXT NOT NULL DEFAULT 'instant_card_plus_voice'
        CHECK (feedback_style IN ('instant_card_plus_voice', 'instant_card_only')),
    native_language TEXT NOT NULL DEFAULT 'zh-CN',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO learner_profile (id) VALUES (1);

-- 2. Practice Sessions (Lessons)
CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    part_mode TEXT NOT NULL CHECK (part_mode IN ('part1', 'part2', 'part3', 'full_mock', 'free_drill')),
    topic_title TEXT NOT NULL,
    feedback_style TEXT NOT NULL DEFAULT 'instant_card_plus_voice',
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'abandoned')),
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at TEXT,
    estimated_band_overall REAL,
    band_fc REAL,  -- Fluency & Coherence
    band_lr REAL,  -- Lexical Resource
    band_gra REAL, -- Grammatical Range & Accuracy
    band_pr REAL,  -- Pronunciation
    summary_json TEXT -- JSON snapshot of metrics & highlights
);

-- 3. Conversation Turns (Examiner prompts + Learner audio/transcript + Instant feedback)
CREATE TABLE IF NOT EXISTS turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    turn_index INTEGER NOT NULL,
    part TEXT NOT NULL CHECK (part IN ('part1', 'part2', 'part3', 'drill')),
    examiner_question TEXT NOT NULL,
    examiner_tts_path TEXT,
    learner_audio_path TEXT,
    learner_duration_sec REAL,
    learner_transcript TEXT,
    wpm REAL,
    pause_count INTEGER DEFAULT 0,
    long_pauses_json TEXT,        -- JSON: [{"after_word": "...", "duration_sec": 1.4}]
    pronunciation_score REAL,     -- 0..100 overall acoustic score (Phase 2)
    pronunciation_json TEXT,      -- JSON: word/phoneme GOP details (Phase 2)
    corrected_text TEXT,          -- Grammatically corrected version of learner's answer
    upgraded_text TEXT,           -- Band 7.5+ natural/idiomatic rewrite
    grammar_feedback_json TEXT,   -- JSON: concise instant feedback pushed to UI
    pronunciation_feedback_json TEXT, -- JSON: pronunciation coaching tips pushed to UI
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, turn_index);

-- 4. Grammar & Expression Mistakes (for long-term pattern tracking)
CREATE TABLE IF NOT EXISTS grammar_mistakes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    turn_id INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
    error_category TEXT NOT NULL CHECK (
        error_category IN (
            'tense',
            'subject_verb_agreement',
            'article',
            'preposition',
            'collocation',
            'word_order',
            'chinglish',
            'plural_singular',
            'other'
        )
    ),
    error_pattern TEXT NOT NULL,      -- Normalized pattern key, e.g. "past_tense_missing_did"
    original_excerpt TEXT NOT NULL,
    corrected_excerpt TEXT NOT NULL,
    upgraded_excerpt TEXT,
    explanation TEXT NOT NULL,
    mastered INTEGER NOT NULL DEFAULT 0 CHECK (mastered IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_grammar_pattern ON grammar_mistakes(error_pattern);

-- 5. Pronunciation & Phoneme Issues (populated by Phase 2 Acoustic GOP Engine)
CREATE TABLE IF NOT EXISTS pronunciation_issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    turn_id INTEGER NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
    word TEXT NOT NULL,
    expected_ipa TEXT,
    phoneme TEXT NOT NULL,            -- IPA symbol, e.g. "θ", "ð", "v", "æ"
    issue_type TEXT NOT NULL DEFAULT 'phoneme_distortion'
        CHECK (issue_type IN ('phoneme_distortion', 'stress_error', 'dropped_ending', 'epenthesis', 'intonation')),
    gop_score REAL,                   -- Raw or normalized GOP score
    word_score REAL,                  -- 0..100 word-level score
    audio_start_sec REAL,
    audio_end_sec REAL,
    coaching_tip TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pron_phoneme ON pronunciation_issues(phoneme);
CREATE INDEX IF NOT EXISTS idx_pron_word ON pronunciation_issues(word);

-- 6. Long-Term Memory Notes (Weaknesses, Personal Facts, Part 2 Stories, Study Prescriptions)
CREATE TABLE IF NOT EXISTS memory_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_type TEXT NOT NULL CHECK (
        memory_type IN (
            'weakness_grammar',
            'weakness_phoneme',
            'personal_fact',
            'part2_story',
            'next_lesson_plan'
        )
    ),
    memory_key TEXT NOT NULL,         -- Unique identifier within memory_type, e.g. "hometown", "phoneme_theta"
    title TEXT NOT NULL,
    content TEXT NOT NULL,            -- Markdown or JSON details
    frequency_count INTEGER NOT NULL DEFAULT 1,
    mastery_score REAL NOT NULL DEFAULT 0.0, -- 0.0 (needs work) .. 1.0 (mastered)
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (memory_type, memory_key)
);

CREATE INDEX IF NOT EXISTS idx_memory_type ON memory_notes(memory_type, last_seen_at);

-- 7. End-of-Lesson Learning Reports
CREATE TABLE IF NOT EXISTS lesson_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
    report_markdown TEXT NOT NULL,
    report_json TEXT NOT NULL,        -- Structured data for UI charts/cards
    markdown_file_path TEXT NOT NULL, -- Exported .md path under ~/.ielts-coach/reports/
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
