"""Bilingual TTS: English words inside a Chinese sentence get an English voice."""

from __future__ import annotations

from daemon.audio.tts import split_bilingual


def _english_chunks(runs):
    return [chunk for lang, chunk in runs if lang == "en"]


def test_embedded_words_are_split_out():
    runs = split_bilingual("注意 think 的 θ 音，或者 slow pace")
    english = _english_chunks(runs)
    assert "think" in english
    assert "slow pace" in english
    assert any(lang == "zh" for lang, _ in runs)


def test_pure_chinese_stays_chinese():
    runs = split_bilingual("注意这个音，舌头要放平。")
    assert [lang for lang, _ in runs] == ["zh"]


def test_pure_english_stays_english():
    runs = split_bilingual("Your pronunciation is clear today.")
    assert [lang for lang, _ in runs] == ["en"]


def test_single_letter_is_not_pulled_out():
    runs = split_bilingual("这里用 a 和 b 两个音")
    assert all(lang == "zh" for lang, _ in runs)


def test_english_sentence_with_chinese_quote():
    runs = split_bilingual("Try again, 再慢一点。")
    assert runs[0][0] == "en"
    assert "Try again" in runs[0][1]
    assert any(lang == "zh" for lang, _ in runs)
