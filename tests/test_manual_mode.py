"""V1.1: silence reports a stuck hint but never ends a manual utterance."""

from __future__ import annotations

import numpy as np

from daemon.audio.vad import FRAME_SAMPLES, StreamingVAD


class _StubService:
    """Reports voiced frames while the signal has energy, silence otherwise."""

    class settings:  # noqa: D106
        vad_threshold = 0.5
        vad_silence_sec = 2.6
        vad_stuck_sec = 2.0
        vad_min_speech_sec = 0.25
        vad_max_utterance_sec = 150.0
        vad_no_speech_timeout_sec = 20.0

    def probability(self, frame: np.ndarray) -> float:
        return 0.9 if float(np.abs(frame).mean()) > 0.01 else 0.02


def _frames(seconds: float, voiced: bool) -> list[np.ndarray]:
    count = int(seconds / (FRAME_SAMPLES / 16000))
    value = 0.2 if voiced else 0.0
    return [np.full(FRAME_SAMPLES, value, dtype=np.float32) for _ in range(count)]


def _run(detector: StreamingVAD, seconds: float, voiced: bool) -> list[dict]:
    return [detector.push(frame) for frame in _frames(seconds, voiced)]


def test_silence_cuts_by_default():
    detector = StreamingVAD(service=_StubService())
    _run(detector, 1.0, True)
    events = _run(detector, 3.0, False)
    assert any(event["should_stop"] for event in events)


def test_manual_mode_never_cuts_on_silence_but_reports_stuck():
    detector = StreamingVAD(service=_StubService(), cut_on_silence=False)
    _run(detector, 1.0, True)
    events = _run(detector, 4.0, False)
    assert not any(event["should_stop"] for event in events)
    assert any(event["stuck"] for event in events)


def test_manual_flush_still_closes():
    detector = StreamingVAD(service=_StubService(), cut_on_silence=False)
    _run(detector, 1.0, True)
    flushed = detector.flush()
    assert flushed["should_stop"] is True
    assert flushed["stop_reason"] == "manual"
