"""Silero VAD: hands-free end-of-utterance detection for the live companion.

The browser streams 32 ms int16 frames over a WebSocket and the *daemon* decides
when the learner has finished a sentence (trailing silence ~1.8 s by default).
Running the model server-side keeps one source of truth: the same thresholds that
were tuned here also apply when the audio arrives as a file upload.

Silero's JIT checkpoint is staged to an ASCII path first because torch.jit.load()
opens files through C++ std::ifstream (ANSI code page on Windows), which breaks on
non-ASCII user profiles.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

from .. import config

logger = logging.getLogger(__name__)

#: Silero's 16 kHz model expects exactly 512 samples (32 ms) per call.
FRAME_SAMPLES = 512
FRAME_SEC = FRAME_SAMPLES / 16000.0


class VADService:
    """Resident Silero VAD (torch.jit) with graceful degradation."""

    def __init__(self, settings: config.Settings):
        self.settings = settings
        self._model = None
        self._error: str | None = None
        self._load_seconds: float | None = None

    # -- lifecycle -----------------------------------------------------------
    def load(self):
        if self._model is not None:
            return self._model
        started = time.time()
        try:
            import torch
            import silero_vad

            data_dir = Path(silero_vad.__file__).resolve().parent / "data"
            checkpoint = data_dir / "silero_vad.jit"
            safe_path = config.ascii_safe_path(checkpoint)
            model = torch.jit.load(str(safe_path), map_location="cpu")
            model.eval()
            self._model = model
            self._error = None
            self._load_seconds = round(time.time() - started, 2)
            logger.info("Silero VAD 就绪 (%.2fs)", self._load_seconds)
        except Exception as exc:  # noqa: BLE001 - never break the lesson
            self._error = str(exc)
            logger.warning("Silero VAD 加载失败，前端将回退到能量 VAD: %s", exc)
        return self._model

    def warmup(self) -> dict[str, Any]:
        model = self.load()
        if model is None:
            return {"ok": False, "error": self._error}
        try:
            import torch

            with torch.no_grad():
                model(torch.zeros(FRAME_SAMPLES), 16000)
            return {"ok": True, "load_seconds": self._load_seconds}
        except Exception as exc:  # noqa: BLE001
            self._error = str(exc)
            return {"ok": False, "error": self._error}

    def status(self) -> dict[str, Any]:
        return {
            "ok": self._model is not None,
            "enabled": self.settings.vad_enabled,
            "error": self._error,
            "load_seconds": self._load_seconds,
            "threshold": self.settings.vad_threshold,
            "silence_sec": self.settings.vad_silence_sec,
        }

    # -- inference -----------------------------------------------------------
    @property
    def available(self) -> bool:
        return self.load() is not None

    def probability(self, frame: np.ndarray) -> float:
        """Speech probability for one 512-sample (32 ms) frame."""
        model = self.load()
        if model is None:
            # Energy fallback so the endpoint still works without the model.
            energy = float(np.sqrt(np.mean(np.square(frame, dtype=np.float64)))) if frame.size else 0.0
            return 0.0 if energy < 0.012 else 0.95
        import torch

        if frame.size < FRAME_SAMPLES:
            frame = np.pad(frame, (0, FRAME_SAMPLES - frame.size))
        elif frame.size > FRAME_SAMPLES:
            frame = frame[:FRAME_SAMPLES]
        tensor = torch.from_numpy(np.ascontiguousarray(frame, dtype=np.float32))
        with torch.no_grad():
            return float(model(tensor, 16000).item())

    def is_speech(self, frame: np.ndarray, threshold: float | None = None) -> bool:
        limit = self.settings.vad_threshold if threshold is None else threshold
        return self.probability(frame) >= limit


@dataclass
class StreamingVAD:
    """Per-connection state machine turning frame probabilities into segments."""

    service: VADService
    threshold: float = 0.5
    silence_sec: float = 1.8
    min_speech_sec: float = 0.25
    max_utterance_sec: float = 150.0
    no_speech_timeout_sec: float = 20.0
    #: Silence (after speech started) that suggests the learner is stuck.
    stuck_sec: float = 2.5

    # running state
    total_frames: int = 0
    voiced_frames: int = 0
    trailing_silence: float = 0.0
    speech_started: bool = False
    speech_sec: float = 0.0
    last_prob: float = 0.0
    started_at: float = field(default_factory=time.time)

    @classmethod
    def from_settings(cls, service: VADService) -> "StreamingVAD":
        s = service.settings
        return cls(
            service=service,
            threshold=s.vad_threshold,
            silence_sec=s.vad_silence_sec,
            min_speech_sec=s.vad_min_speech_sec,
            max_utterance_sec=s.vad_max_utterance_sec,
            no_speech_timeout_sec=s.vad_no_speech_timeout_sec,
            stuck_sec=getattr(s, "vad_stuck_sec", 2.5),
        )

    def reset(self) -> None:
        self.total_frames = 0
        self.voiced_frames = 0
        self.trailing_silence = 0.0
        self.speech_started = False
        self.speech_sec = 0.0
        self.last_prob = 0.0
        self.started_at = time.time()

    @property
    def elapsed_sec(self) -> float:
        return self.total_frames * FRAME_SEC

    def push(self, frame: np.ndarray) -> dict[str, Any]:
        prob = self.service.probability(frame)
        self.last_prob = round(prob, 3)
        self.total_frames += 1
        voiced = prob >= self.threshold

        if voiced:
            if not self.speech_started:
                self.speech_started = True
            self.voiced_frames += 1
            self.speech_sec += FRAME_SEC
            self.trailing_silence = 0.0
        elif self.speech_started:
            self.trailing_silence += FRAME_SEC
        else:
            self.trailing_silence = 0.0

        stop_reason: str | None = None
        if self.speech_started and self.trailing_silence >= self.silence_sec:
            stop_reason = "silence"
        elif self.elapsed_sec >= self.max_utterance_sec:
            stop_reason = "max_length"
        elif (
            not self.speech_started
            and self.elapsed_sec >= self.no_speech_timeout_sec
        ):
            stop_reason = "no_speech"

        return {
            "type": "vad",
            "prob": self.last_prob,
            "speech": voiced,
            "speech_started": self.speech_started,
            "speech_sec": round(self.speech_sec, 2),
            "trailing_silence": round(self.trailing_silence, 2),
            "elapsed_sec": round(self.elapsed_sec, 2),
            "should_stop": stop_reason is not None,
            "stop_reason": stop_reason,
            "enough_speech": self.speech_sec >= self.min_speech_sec,
            "stuck": bool(self.speech_started and self.trailing_silence >= self.stuck_sec),
        }

    def flush(self) -> dict[str, Any]:
        """Force-close the utterance (manual mode / user pressed stop)."""
        return {
            "type": "vad",
            "prob": self.last_prob,
            "speech": False,
            "speech_started": self.speech_started,
            "speech_sec": round(self.speech_sec, 2),
            "trailing_silence": round(self.trailing_silence, 2),
            "elapsed_sec": round(self.elapsed_sec, 2),
            "should_stop": True,
            "stop_reason": "manual",
            "enough_speech": self.speech_sec >= self.min_speech_sec,
        }


def pcm16_to_float(raw: bytes) -> np.ndarray:
    """Convert little-endian int16 PCM bytes (as sent by the browser) to float32."""
    array = np.frombuffer(raw, dtype="<i2").astype(np.float32)
    return array / 32768.0


def speech_ratio(samples: np.ndarray, service: VADService, threshold: float | None = None) -> float:
    """Fraction of 32 ms frames that contain speech (used for diagnostics)."""
    if samples.size == 0:
        return 0.0
    frames = 0
    voiced = 0
    for start in range(0, samples.size - FRAME_SAMPLES + 1, FRAME_SAMPLES):
        frames += 1
        if service.is_speech(samples[start : start + FRAME_SAMPLES], threshold):
            voiced += 1
    return round(voiced / frames, 3) if frames else 0.0
