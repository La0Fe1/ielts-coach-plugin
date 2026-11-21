"""Unit tests for fluency metrics and the 16 kHz WAV pipeline (no model needed)."""

from __future__ import annotations

import math

import numpy as np
import pytest

from daemon.audio import processor
from daemon.audio.asr import ASRService, compute_fluency


def _words(pairs):
    return [{"word": w, "start": s, "end": e} for w, s, e in pairs]


def test_compute_fluency_basic_metrics():
    words = _words(
        [
            ("I", 0.2, 0.35),
            ("live", 0.4, 0.7),
            ("in", 0.75, 0.9),
            ("Shanghai", 0.95, 1.55),
            ("and", 2.6, 2.75),  # 1.05 s gap -> hesitation
            ("I", 2.8, 2.9),
            ("like", 2.95, 3.2),
            ("it", 3.25, 3.4),
        ]
    )
    result = compute_fluency(words, duration_sec=4.0, pause_threshold_sec=0.8)
    assert result["word_count"] == 8
    assert result["pause_count"] == 1
    assert result["long_pauses"][0]["after_word"] == "Shanghai"
    assert result["long_pauses"][0]["duration_sec"] == pytest.approx(1.05, abs=0.01)
    assert result["effective_duration_sec"] == pytest.approx(3.2, abs=0.01)
    expected_wpm = round(8 / 3.2 * 60, 1)
    assert result["wpm"] == pytest.approx(expected_wpm, abs=0.2)
    assert 110 <= result["wpm"] <= 160  # IELTS-comfortable range for this sample


def test_compute_fluency_counts_filler_words():
    words = _words(
        [
            ("um", 0.0, 0.2),
            ("I", 0.3, 0.4),
            ("think", 0.45, 0.7),
            ("uh", 0.75, 0.9),
            ("you", 1.0, 1.1),
            ("know", 1.15, 1.3),
            ("it", 1.35, 1.45),
            ("is", 1.5, 1.6),
            ("like", 1.65, 1.8),
            ("fine", 1.85, 2.1),
        ]
    )
    result = compute_fluency(words, duration_sec=2.2)
    assert result["filler_words"]["um"] == 1
    assert result["filler_words"]["uh"] == 1
    assert result["filler_words"]["you know"] == 1
    assert result["filler_words"]["like"] == 1
    assert result["filler_total"] == 4


def test_compute_fluency_handles_empty_and_silent_input():
    empty = compute_fluency([], duration_sec=3.0)
    assert empty["word_count"] == 0
    assert empty["wpm"] == 0.0
    assert empty["pause_count"] == 0
    assert empty["speech_ratio"] == 0.0

    malformed = compute_fluency([{"word": "", "start": "x"}, {"word": "hi", "start": 0.0, "end": 0.5}], 1.0)
    assert malformed["word_count"] == 1


def test_wav_bytes_roundtrip():
    samples = (0.4 * np.sin(2 * np.pi * 220 * np.arange(3200) / 16000)).astype(np.float32)
    data = processor.write_wav_bytes(samples, 16000)
    assert data[:4] == b"RIFF" and data[8:12] == b"WAVE"
    decoded, rate = processor.read_wav_bytes(data)
    assert rate == 16000
    assert decoded.size == samples.size
    assert np.max(np.abs(decoded - samples)) < 1e-3


def test_rejects_non_wav_containers():
    webm_like = b"\x1aE\xdf\xa3" + b"\x00" * 200
    with pytest.raises(processor.InvalidAudioError) as excinfo:
        processor.read_wav_bytes(webm_like)
    assert "webm" in str(excinfo.value)

    mp4_like = b"\x00\x00\x00\x18ftypisom" + b"\x00" * 100
    with pytest.raises(processor.InvalidAudioError):
        processor.validate_wav_bytes(mp4_like)

    with pytest.raises(processor.InvalidAudioError):
        processor.validate_wav_bytes(b"")


def test_resample_changes_sample_count_not_pitch_identity():
    source = np.sin(2 * np.pi * 100 * np.arange(48000) / 48000).astype(np.float32)
    down = processor.resample_linear(source, 48000, 16000)
    assert down.size == 16000
    up = processor.resample_linear(source, 48000, 24000)
    assert up.size == 24000
    # same signal length in seconds
    assert math.isclose(down.size / 16000, 1.0, abs_tol=1e-3)


def test_trim_and_segments_find_speech_region():
    rate = 16000
    silence = np.zeros(rate // 2, dtype=np.float32)
    speech = (0.3 * np.sin(2 * np.pi * 170 * np.arange(rate) / rate)).astype(np.float32)
    samples = np.concatenate([silence, speech, silence])

    start, end = processor.trim_bounds(samples, rate)
    assert start <= rate // 2 + 400
    assert end >= rate + rate // 2 - 400

    trimmed = processor.trim_silence(samples, rate)
    assert trimmed.size < samples.size

    segments = processor.speech_segments(samples, rate)
    assert len(segments) >= 1
    assert segments[0]["start_sec"] <= 0.6
    assert segments[-1]["end_sec"] >= 1.4


def test_process_upload_normalises_and_persists(tmp_path):
    data = processor.write_wav_bytes(
        np.concatenate(
            [
                np.zeros(4000, dtype=np.float32),
                0.2 * np.sin(2 * np.pi * 200 * np.arange(16000) / 16000).astype(np.float32),
                np.zeros(4000, dtype=np.float32),
            ]
        ),
        16000,
    )
    destination = tmp_path / "audio" / "turn1.wav"
    info, samples = processor.process_upload(data, destination)

    assert destination.is_file()
    assert info.sample_rate == 16000
    assert info.channels == 1
    assert 0.8 <= info.duration_sec <= 1.2  # silence trimmed then normalised
    assert info.voiced_duration_sec > 0
    assert 0.5 < info.peak <= 1.0
    assert samples.size > 0

    with pytest.raises(processor.InvalidAudioError):
        processor.process_upload(processor.write_wav_bytes(np.zeros(1600, dtype=np.float32)), tmp_path / "silent.wav")


def test_asr_service_stub_produces_fluency_payload(temp_home):
    from daemon import config

    settings = config.load_settings()
    settings.stub_models = True
    service = ASRService(settings)

    destination = temp_home / "stub.wav"
    t = np.arange(16000 * 3) / 16000.0
    processor.write_wav(destination, (0.2 * np.sin(2 * np.pi * 200 * t)).astype(np.float32), 16000)

    result = service.transcribe(destination)
    assert result["text"]
    assert result["word_count"] > 5
    assert result["wpm"] > 0
    assert result["asr_elapsed_sec"] >= 0
    assert service.status()["ok"] is True
    assert service.status()["stub"] is True
