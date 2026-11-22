"""Sentence-completeness verdicts: the signal that replaces a silence timer."""

from __future__ import annotations

import pytest

from daemon.completeness import analyze, is_stop_command, submit_gate

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
def test_complete_sentences_after_the_gate(text):
    # 3 s of silence clears every gate (1.5 / 1.6 / 2.6 s).
    assert analyze(text, pause_sec=3.0)["complete"] is True


@pytest.mark.parametrize("text,reason", INCOMPLETE)
def test_incomplete_sentences(text, reason):
    verdict = analyze(text, pause_sec=3.0)
    assert verdict["complete"] is False
    assert verdict["reason"] == reason


def test_short_sentence_is_not_cut_at_one_second():
    """A complete first sentence must not be submitted while the learner may go on."""
    early = analyze("I live in a small city near the coast.", pause_sec=1.0)
    assert early["complete"] is False
    assert early["reason"] == "waiting_for_more"
    assert early["suggested_submit_after_sec"] == 2.6
    assert early["stuck"] is False


def test_short_sentence_submits_after_2_6s():
    late = analyze("I live in a small city near the coast.", pause_sec=2.6)
    assert late["complete"] is True


def test_long_sentence_submits_after_1_5s():
    long_text = (
        "I live in a small city near the coast and I have been living there for "
        "about twelve years now."
    )
    assert len(long_text.split()) >= 12
    assert analyze(long_text, pause_sec=1.5)["complete"] is True
    assert analyze(long_text, pause_sec=1.0)["complete"] is False


def test_one_word_answer_needs_1_6s():
    assert analyze("Yes.", pause_sec=1.0)["reason"] == "waiting_for_more"
    assert analyze("Yes.", pause_sec=1.6)["complete"] is True


def test_stop_command_ignores_the_gate():
    verdict = analyze("Stop.", pause_sec=0.0)
    assert verdict["complete"] is True
    assert verdict["reason"] == "stop_command"


def test_stuck_only_when_incomplete_and_quiet():
    assert analyze("I live in a city near the", pause_sec=0.4)["stuck"] is False
    assert analyze("I live in a city near the", pause_sec=2.2)["stuck"] is True
    # A complete-but-waiting sentence is thinking, not being stuck.
    assert analyze("I live near the coast.", pause_sec=2.2)["stuck"] is False


def test_gate_values():
    assert submit_gate(13) == 1.5
    assert submit_gate(5) == 2.6
    assert submit_gate(1, single_short_answer=True) == 1.6


def test_empty_input():
    assert analyze("")["reason"] == "empty"
    assert analyze("   ")["complete"] is False
