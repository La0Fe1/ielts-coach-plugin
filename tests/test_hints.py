"""Bilingual TTS splitting and stuck-analysis tests."""

from __future__ import annotations

from daemon.audio.tts import split_bilingual
from daemon.hints import GENERIC_HINTS, HintBook, analyze_stuck, used_words


def test_split_english_only():
    segments = split_bilingual("Good morning. Where is your hometown?")
    assert segments == [("en", "Good morning. Where is your hometown?")]


def test_split_bilingual_pronounces_embedded_english():
    segments = split_bilingual(
        "Nice answer. 注意 think 里的 θ 音，舌尖轻触上齿。Now, what do you like most?"
    )
    # English words inside a Chinese sentence get their own English run so the
    # taught word is not read with a Mandarin accent.
    assert [lang for lang, _ in segments] == ["en", "zh", "en", "zh", "en"]
    assert ("en", "think") in segments
    assert "θ" in segments[3][1]


def test_split_merges_consecutive_same_language():
    segments = split_bilingual("First sentence. Second sentence. 这是中文。Another one.")
    assert [lang for lang, _ in segments] == ["en", "zh", "en"]
    assert segments[0][1].count(".") == 2


def test_split_empty():
    assert split_bilingual("") == []
    assert split_bilingual("   ") == []


def test_hint_book_words_for_tag():
    book = HintBook()
    words = book.words_for(["place"], limit=3)
    assert len(words) == 3
    assert "hometown" in words


def test_hint_book_excludes_used_words():
    book = HintBook()
    first = book.words_for(["place"], limit=2)
    second = book.words_for(["place"], exclude=first, limit=2)
    assert not set(first) & set(second)
    assert len(second) == 2


def test_hint_book_falls_back_to_generic():
    book = HintBook()
    words = book.words_for(["unknown-tag"], limit=2)
    assert words
    assert set(words) <= set(GENERIC_HINTS) | set(words)


def test_used_words_extraction():
    words = used_words(["I like the Crowded city", "and the coast"])
    assert {"i", "like", "crowded", "city", "coast"} <= words


def test_stuck_detected_on_deep_pause():
    report = analyze_stuck(
        {"long_pauses": [{"after_word": "and", "duration_sec": 2.6}], "filler_total": 1, "word_count": 12},
        ["crowded"],
    )
    assert report["detected"] is True
    assert report["longest_pause_sec"] == 2.6
    assert report["at_word"] == "and"
    assert report["hint_words"] == ["crowded"]


def test_stuck_not_detected_for_fluent_answer():
    report = analyze_stuck(
        {"long_pauses": [{"after_word": "so", "duration_sec": 0.9}], "filler_total": 0, "word_count": 30},
        ["crowded"],
    )
    assert report["detected"] is False
    assert report["hint_words"] == []


def test_stuck_detected_for_short_filler_heavy_answer():
    report = analyze_stuck(
        {"long_pauses": [], "filler_total": 3, "word_count": 5},
        ["suburb"],
    )
    assert report["detected"] is True
