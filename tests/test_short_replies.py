"""Short replies and stop commands must be recognised, not swallowed."""

from __future__ import annotations

import pytest

from daemon.completeness import analyze, is_stop_command


@pytest.mark.parametrize("word", ["Yes.", "No.", "Sure.", "Okay.", "Done.", "Stop."])
def test_one_word_replies_become_complete(word):
    assert analyze(word, pause_sec=1.6)["complete"] is True


@pytest.mark.parametrize("word", ["Because", "Near", "The"])
def test_one_word_fragments_stay_open(word):
    assert analyze(word, pause_sec=3.0)["complete"] is False


@pytest.mark.parametrize("phrase", ["stop", "Stop.", "let's stop", "that's all", "I'm done", "end the lesson"])
def test_stop_commands(phrase):
    assert is_stop_command(phrase) is True
    assert analyze(phrase, pause_sec=0.0)["reason"] == "stop_command"


@pytest.mark.parametrize("phrase", ["I stopped by the river", "the bus stop", "done my homework"])
def test_not_stop_commands(phrase):
    assert is_stop_command(phrase) is False
