"""Chinese input is accepted (auto language) and stop commands work in both languages."""

from __future__ import annotations

from daemon.completeness import analyze, is_stop_command


def test_chinese_utterance_is_a_finished_turn():
    verdict = analyze("这个单词怎么说", language="zh")
    assert verdict["complete"] is True
    assert verdict["reason"] == "non_english"
    assert verdict["stuck"] is False


def test_chinese_stop_phrases():
    for phrase in ("结束", "下课吧", "不练了", "拜拜"):
        assert is_stop_command(phrase) is True


def test_english_rules_untouched_when_language_is_en():
    assert analyze("I live near the", language="en", pause_sec=3.0)["complete"] is False
    assert analyze("I live near the coast.", language="en", pause_sec=3.0)["complete"] is True
