"""Sentence-completeness verdicts: the signal that replaces a silence timer."""

from __future__ import annotations

import pytest

from daemon.completeness import analyze

COMPLETE = [
    "I live in a small city near the coast.",
    "I've lived there for about twelve years.",
    "My favourite food is hot pot because it is cheap and tasty.",
    "It depends on the weather.",
    "I usually get up at seven in the morning.",
    "She is a teacher.",
    "Yes, I do.",
    "I like it.",
    "I think so.",
    "It's good too.",
    "Yes, I can.",
]

INCOMPLETE = [
    ("I live in a small city near the", "trailing_function_word"),
    ("I have lived there for", "trailing_function_word"),
    ("It is very good and", "trailing_function_word"),
    ("I like it because", "trailing_function_word"),
    ("I want to", "trailing_function_word"),
    ("My hometown is", "trailing_function_word"),
    ("Well, um,", "empty"),
    ("The", "too_short"),
]


@pytest.mark.parametrize("text", COMPLETE)
def test_complete_sentences(text):
    assert analyze(text)["complete"] is True


@pytest.mark.parametrize("text,reason", INCOMPLETE)
def test_incomplete_sentences(text, reason):
    verdict = analyze(text)
    assert verdict["complete"] is False
    assert verdict["reason"] == reason


def test_stuck_only_after_a_pause():
    quiet = analyze("I live in a city near the", pause_sec=0.4)
    stalled = analyze("I live in a city near the", pause_sec=2.2)
    assert quiet["stuck"] is False
    assert stalled["stuck"] is True


def test_empty_input():
    assert analyze("") ["reason"] == "empty"
    assert analyze("   ").get("complete") is False


def test_trailing_comma_is_weak_incomplete():
    verdict = analyze("I like living there, but")
    assert verdict["complete"] is False
