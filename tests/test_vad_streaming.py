"""Silero-VAD streaming segmentation tests (no model needed)."""

from __future__ import annotations

import numpy as np

from daemon.audio.vad import FRAME_SAMPLES, FRAME_SEC, StreamingVAD, pcm16_to_float


class ScriptedService:
    """Returns a scripted speech probability per frame."""

    def __init__(self, probabilities):
        self.probabilities = list(probabilities)
        self.index = 0

    def probability(self, frame):
        value = self.probabilities[min(self.index, len(self.probabilities) - 1)]
        self.index += 1
        return value


def _detector(probabilities, **kwargs):
    service = ScriptedService(probabilities)
    defaults = dict(threshold=0.5, silence_sec=1.8, min_speech_sec=0.25, max_utterance_sec=150.0)
    defaults.update(kwargs)
    return StreamingVAD(service=service, **defaults)


def test_frame_geometry_matches_silero():
    assert FRAME_SAMPLES == 512
    assert abs(FRAME_SEC - 0.032) < 1e-6


def test_stop_fires_only_after_trailing_silence():
    # 10 voiced frames, then silence
    probabilities = [0.9] * 10 + [0.02] * 80
    detector = _detector(probabilities)
    frame = np.zeros(FRAME_SAMPLES, dtype=np.float32)
    stops = []
    for _ in range(100):
        event = detector.push(frame)
        if event["should_stop"]:
            stops.append(event)
            break
    assert len(stops) == 1
    assert stops[0]["stop_reason"] == "silence"
    assert stops[0]["trailing_silence"] >= 1.8
    assert stops[0]["speech_sec"] >= 0.25


def test_no_stop_while_speaking_continues():
    probabilities = [0.9] * 200
    detector = _detector(probabilities)
    frame = np.zeros(FRAME_SAMPLES, dtype=np.float32)
    for _ in range(60):
        event = detector.push(frame)
        assert event["should_stop"] is False
    assert event["speech_started"] is True


def test_no_speech_timeout():
    detector = _detector([0.01], no_speech_timeout_sec=1.0)
    frame = np.zeros(FRAME_SAMPLES, dtype=np.float32)
    for _ in range(int(1.0 / FRAME_SEC) + 2):
        event = detector.push(frame)
    assert event["should_stop"] is True
    assert event["stop_reason"] == "no_speech"
    assert event["speech_started"] is False


def test_max_utterance_guard():
    detector = _detector([0.9], max_utterance_sec=10.0)
    frame = np.zeros(FRAME_SAMPLES, dtype=np.float32)
    for _ in range(int(10.0 / FRAME_SEC) + 2):
        event = detector.push(frame)
    assert event["should_stop"] is True
    assert event["stop_reason"] == "max_length"


def test_flush_and_reset():
    detector = _detector([0.9])
    frame = np.zeros(FRAME_SAMPLES, dtype=np.float32)
    for _ in range(5):
        detector.push(frame)
    flushed = detector.flush()
    assert flushed["should_stop"] is True
    assert flushed["stop_reason"] == "manual"
    detector.reset()
    assert detector.total_frames == 0
    assert detector.speech_sec == 0.0


def test_pcm16_conversion():
    samples = np.array([0, 16384, -16384, 32767, -32768], dtype="<i2")
    floats = pcm16_to_float(samples.tobytes())
    assert floats.dtype == np.float32
    assert abs(floats[0]) < 1e-6
    assert 0.49 < floats[1] < 0.51
    assert -0.51 < floats[2] < -0.49
