"""Faster-Whisper speech recognition plus IELTS fluency metrics.

Two responsibilities:
1. Keep one Faster-Whisper model resident in memory (never reload per request).
2. Turn word timestamps into the fluency numbers the coach actually needs:
   WPM, hesitation positions, filler-word counts and effective speaking time.

compute_fluency() is a pure function so the metric logic is unit-testable
without downloading a 1.5 GB checkpoint.
"""

from __future__ import annotations

import logging
import os
import time
from pathlib import Path
from typing import Any, Iterable

from .. import config

logger = logging.getLogger(__name__)

#: Single-token hesitation markers counted in the fluency report.
FILLER_TOKENS = {
    "um",
    "uh",
    "er",
    "erm",
    "ah",
    "eh",
    "hmm",
    "mm",
    "mmm",
    "uhm",
    "like",
    "basically",
    "actually",
    "literally",
}
#: Multi-word hesitation phrases checked against the normalised transcript.
FILLER_PHRASES = ["you know", "i mean", "sort of", "kind of", "and so on"]


def _clean_word(raw: str) -> str:
    return (raw or "").strip().strip(".,!?;:\"'()[]{}").lower()


def compute_fluency(
    words: Iterable[dict[str, Any]],
    duration_sec: float,
    pause_threshold_sec: float = 0.8,
    transcript: str | None = None,
    vad_segments: list[dict[str, float]] | None = None,
) -> dict[str, Any]:
    """Derive IELTS fluency metrics from word-level timestamps.

    Args:
        words: iterable of {word, start, end} timestamps, in seconds.
        duration_sec: length of the audio file (used when timestamps are absent).
        pause_threshold_sec: gap (seconds) that counts as a hesitation.
        transcript: optional full text (used for filler-phrase counting).
        vad_segments: energy-VAD speech regions. Whisper's word timestamps are
            spread evenly across silences (a 2.6 s hesitation disappears), so when
            available these segments are the source of truth for pause detection
            and for the effective speaking time used by WPM.
    """
    clean: list[dict[str, Any]] = []
    for item in words or []:
        try:
            word = str(item.get("word", "")).strip()
            start = float(item.get("start", 0.0))
            end = float(item.get("end", start))
        except (TypeError, ValueError):
            continue
        if not word:
            continue
        clean.append({"word": word, "start": round(start, 3), "end": round(end, 3)})
    clean.sort(key=lambda w: (w["start"], w["end"]))

    word_count = len(clean)
    voiced_regions = [seg for seg in (vad_segments or []) if seg["end_sec"] > seg["start_sec"]]
    if voiced_regions:
        speech_start = float(voiced_regions[0]["start_sec"])
        speech_end = float(voiced_regions[-1]["end_sec"])
        # WPM should be measured over actually-spoken time, not wall-clock time that
        # includes long silences.
        effective = sum(float(seg["end_sec"]) - float(seg["start_sec"]) for seg in voiced_regions)
    elif clean:
        speech_start = clean[0]["start"]
        speech_end = clean[-1]["end"]
        effective = max(speech_end - speech_start, 0.0)
    else:
        speech_start, speech_end = 0.0, 0.0
        effective = 0.0
    if word_count and effective <= 0.0:
        # Degenerate timestamps (all zeros): fall back to the file duration.
        effective = max(float(duration_sec or 0.0), 0.0)

    wpm = round(word_count / effective * 60.0, 1) if effective > 0 and word_count else 0.0

    pauses: list[dict[str, Any]] = []
    if voiced_regions:
        for previous, current in zip(voiced_regions, voiced_regions[1:]):
            gap = float(current["start_sec"]) - float(previous["end_sec"])
            if gap < pause_threshold_sec:
                continue
            gap_start = float(previous["end_sec"])
            gap_end = float(current["start_sec"])
            before = [w["word"] for w in clean if w["end"] <= gap_start + 0.05]
            after = [w["word"] for w in clean if w["start"] >= gap_end - 0.05]
            pauses.append(
                {
                    "after_word": before[-1] if before else None,
                    "before_word": after[0] if after else None,
                    "at_sec": round(gap_start, 2),
                    "duration_sec": round(gap, 2),
                }
            )
    else:
        for previous, current in zip(clean, clean[1:]):
            gap = current["start"] - previous["end"]
            if gap >= pause_threshold_sec:
                pauses.append(
                    {
                        "after_word": previous["word"],
                        "before_word": current["word"],
                        "at_sec": round(previous["end"], 2),
                        "duration_sec": round(gap, 2),
                    }
                )

    text = transcript if transcript is not None else " ".join(w["word"] for w in clean)
    normalised = " " + " ".join(_clean_word(t) for t in text.split()) + " "
    filler_hits: dict[str, int] = {}
    for token in FILLER_TOKENS:
        count = normalised.count(f" {token} ")
        if count:
            filler_hits[token] = count
    for phrase in FILLER_PHRASES:
        count = normalised.count(f" {phrase} ")
        if count:
            filler_hits[phrase] = count

    filler_total = sum(filler_hits.values())
    longest = max((p["duration_sec"] for p in pauses), default=0.0)
    speech_ratio = (
        round(effective / float(duration_sec), 3) if (word_count and duration_sec) else 0.0
    )

    return {
        "word_count": word_count,
        "wpm": wpm,
        "speech_start_sec": round(speech_start, 3),
        "speech_end_sec": round(speech_end, 3),
        "effective_duration_sec": round(effective, 2),
        "pause_count": len(pauses),
        "long_pauses": pauses,
        "longest_pause_sec": round(longest, 2),
        "filler_words": filler_hits,
        "filler_total": filler_total,
        "speech_ratio": speech_ratio,
        "duration_sec": round(float(duration_sec or 0.0), 2),
        "words": clean,
    }


class ASRService:
    """Resident Faster-Whisper wrapper with a deterministic stub mode."""

    def __init__(self, settings: config.Settings):
        self.settings = settings
        self._model = None
        self._load_error: str | None = None
        self._load_seconds: float | None = None
        self.last_elapsed_sec: float | None = None

    # -- lifecycle -----------------------------------------------------------
    @property
    def model_name(self) -> str:
        return self.settings.asr_model

    def _resolve_model_name(self) -> str:
        name = (self.settings.asr_model or "").strip()
        aliases = {
            "large-v3-turbo": "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
            "turbo": "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
            # Shipped inside the portable package (small enough for one release asset).
            "distil-large-v3": "Systran/faster-distil-whisper-large-v3",
            "distil": "Systran/faster-distil-whisper-large-v3",
        }
        return aliases.get(name, name)

    def load(self):
        """Load the model once (~2-4 s cold, 0 s afterwards)."""
        if self._model is not None:
            return self._model
        if self.settings.stub_models:
            self._model = _StubWhisper()
            return self._model
        started = time.time()
        config.ensure_ascii_tempdir()
        from faster_whisper import WhisperModel  # heavy import kept lazy

        attempt_names = [self._resolve_model_name()]
        for fallback in ("medium.en", "small.en", "base.en"):
            if fallback not in attempt_names:
                attempt_names.append(fallback)

        last_error: Exception | None = None
        for name in attempt_names:
            try:
                logger.info(
                    "加载 Faster-Whisper 模型 %s (device=%s, compute_type=%s)",
                    name,
                    self.settings.device,
                    self.settings.asr_compute_type,
                )
                # The portable build ships a ready HF cache; download_root must point
                # at it, otherwise faster-whisper looks in ~/.ielts-coach/models and,
                # being offline, fails with "cannot find a cached snapshot".
                bundled = os.environ.get("IELTS_COACH_MODELS", "").strip()
                user_dir = Path(self.settings.paths.models_dir)
                download_root, local_only = self._cache_for(name, bundled, user_dir)
                self._model = WhisperModel(
                    name,
                    device=self.settings.device,
                    compute_type=self.settings.asr_compute_type,
                    download_root=download_root,
                    local_files_only=local_only,
                )
                self._load_error = None
                self._load_seconds = round(time.time() - started, 2)
                logger.info("ASR 模型加载完成，耗时 %.1fs", self._load_seconds)
                return self._model
            except Exception as exc:  # noqa: BLE001 - try the next candidate
                last_error = exc
                logger.warning("加载 ASR 模型 %s 失败: %s", name, exc)
        self._load_error = str(last_error)
        raise RuntimeError(f"Faster-Whisper 模型加载失败: {last_error}")

    @staticmethod
    def _cache_for(name: str, bundled: str, user_dir: Path) -> tuple[str, bool]:
        """Pick the cache that actually holds this model.

        A learner may download a different checkpoint from settings while running a
        portable copy: that file lands in ~/.ielts-coach/models, so the bundled
        offline cache must not be forced (it would look in the wrong directory and
        refuse to download).
        """
        repo = name
        if "/" not in repo:
            repo = "Systran/faster-whisper-" + repo
        folder = "models--" + repo.replace("/", "--")

        def has(base: Path) -> bool:
            return (base / folder).is_dir()

        if user_dir and has(user_dir):
            return str(user_dir), False
        if bundled:
            bundle_cache = Path(bundled) / "hf"
            if has(bundle_cache):
                return str(bundle_cache), True
            # Not in the bundle: download into the user cache.
            return str(user_dir), False
        return str(user_dir), False

    def is_ready(self) -> bool:
        """True once the model is resident (no loading attempt triggered)."""
        return self._model is not None

    def warmup(self) -> dict[str, Any]:
        try:
            self.load()
            return {"ok": True, "model": self.model_name, "load_seconds": self._load_seconds}
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "model": self.model_name, "error": str(exc)}

    def status(self) -> dict[str, Any]:
        return {
            "ok": self._model is not None,
            "model": self.model_name,
            "device": self.settings.device,
            "compute_type": self.settings.asr_compute_type,
            "stub": self.settings.stub_models,
            "load_seconds": self._load_seconds,
            "error": self._load_error,
        }

    # -- inference -----------------------------------------------------------
    @staticmethod
    def _load_audio(wav_path: str | Path):
        """Decode the WAV ourselves so PyAV/ffmpeg is never involved.

        Faster-Whisper would otherwise call av.open(), which drags in a native
        decoder whose API changes between PyAV releases. Our pipeline guarantees
        16 kHz mono PCM WAV, so a plain numpy array is both safer and faster.
        """
        from .processor import read_wav

        samples, _rate = read_wav(wav_path, config.TARGET_SAMPLE_RATE)
        return samples.astype("float32", copy=False)

    @staticmethod
    def _looks_english(words: list[dict[str, Any]]) -> bool:
        """Guard against a wrong language guess on a long English answer."""
        joined = " ".join(str(word.get("word") or "") for word in words)
        letters = [ch for ch in joined if ch.isalpha()]
        if not letters:
            return True
        ascii_ratio = sum(1 for ch in letters if ch.isascii()) / len(letters)
        return ascii_ratio >= 0.8

    def _run(self, model, audio, language: str | None):
        return model.transcribe(
            audio,
            language=language,
            beam_size=self.settings.asr_beam_size,
            word_timestamps=True,
            # Silence filtering collapses the pauses between words, which is exactly
            # the signal the fluency report and the "stuck" detector need: a 2.6 s
            # hesitation measured 1.82 s with it on. The clip is already trimmed by
            # our own energy VAD, so leave the internal gaps intact.
            vad_filter=False,
            condition_on_previous_text=False,
        )

    def _collect(self, segments) -> tuple[str, list[dict[str, Any]]]:
        words: list[dict[str, Any]] = []
        texts: list[str] = []
        for segment in segments:
            texts.append(segment.text.strip())
            for word in getattr(segment, "words", None) or []:
                words.append(
                    {
                        "word": str(getattr(word, "word", "")).strip(),
                        "start": round(float(getattr(word, "start", 0.0)), 3),
                        "end": round(float(getattr(word, "end", 0.0)), 3),
                        "probability": round(float(getattr(word, "probability", 0.0) or 0.0), 3),
                    }
                )
        return " ".join(t for t in texts if t).strip(), words

    def transcribe(self, wav_path: str | Path) -> dict[str, Any]:
        started = time.time()
        model = self.load()
        audio = self._load_audio(wav_path)

        forced = (self.settings.asr_language or "auto").lower()
        detected: str | None = None
        if forced == "auto":
            # Let Whisper pick the language so Chinese questions/commands are
            # transcribed too. Long answers are re-run forced-English when the
            # detection looks wrong: the IELTS answer itself must never be mangled.
            segments, info = self._run(model, audio, None)
            detected = str(getattr(info, "language", "") or "").lower() or None
            transcript, words = self._collect(segments)
            if detected and detected != "en" and len(words) >= 12 and self._looks_english(words):
                logger.info("语言检测为 %s 但内容是英文，强制按英文重跑", detected)
                segments, info = self._run(model, audio, "en")
                detected = "en"
                transcript, words = self._collect(segments)
        else:
            segments, info = self._run(model, audio, forced)
            detected = forced
            transcript, words = self._collect(segments)

        duration = float(getattr(info, "duration", 0.0) or 0.0)
        if duration <= 0 and words:
            duration = words[-1]["end"]
        # Energy VAD is the only trustworthy pause source: Whisper spreads word
        # timestamps across silence instead of leaving gaps.
        try:
            from . import processor

            vad_segments = processor.speech_segments(audio)
        except Exception as exc:  # noqa: BLE001
            logger.debug("能量 VAD 失败，回退到词级时间戳: %s", exc)
            vad_segments = None
        fluency = compute_fluency(
            words,
            duration,
            pause_threshold_sec=self.settings.pause_threshold_sec,
            transcript=transcript,
            vad_segments=vad_segments,
        )
        elapsed = round(time.time() - started, 2)
        self.last_elapsed_sec = elapsed
        return {
            "text": transcript or " ".join(w["word"] for w in words).strip(),
            "words": words,
            "duration_sec": round(duration, 2),
            "language": detected or str(getattr(info, "language", "en") or "en"),
            "asr_elapsed_sec": elapsed,
            "model": self.model_name,
            **{k: v for k, v in fluency.items() if k != "words"},
        }


class _StubWhisper:
    """Deterministic stand-in used by tests and by IELTS_COACH_STUB_MODELS=1."""

    def __init__(self) -> None:
        self.calls: list[str] = []

    def transcribe(self, path: Any, **_: Any):
        self.calls.append(str(path) if isinstance(path, (str, Path)) else "<array>")
        if hasattr(path, "__len__") and not isinstance(path, (str, bytes, Path)):
            duration = round(len(path) / config.TARGET_SAMPLE_RATE, 2)
        else:
            duration = _wav_duration(str(path))
        # Test hooks: let a test pretend the learner said something else (a stop
        # command, a Chinese question) without changing the stub itself.
        script = os.environ.get("IELTS_COACH_STUB_TRANSCRIPT") or (
            "I live in Shanghai and I have been living here for about ten years. "
            "I really enjoy the city because there are so many parks and coffee shops."
        )
        stub_language = os.environ.get("IELTS_COACH_STUB_LANGUAGE") or "en"
        tokens = script.split()
        step = duration / max(len(tokens), 1)
        words = []
        cursor = 0.0
        for index, token in enumerate(tokens):
            start = cursor
            end = min(duration, cursor + step * 0.82)
            words.append(
                _SegmentWord(
                    word=token,
                    start=round(start, 3),
                    end=round(end, 3),
                    probability=0.95,
                )
            )
            cursor += step
            if index == 6:  # injected hesitation so pause logic is exercised
                cursor += 1.1
        segment = _Segment(text=script, words=words)
        info = _SegmentInfo(language=stub_language, duration=duration)
        return [segment], info


def _wav_duration(path: str) -> float:
    import wave

    try:
        with wave.open(path, "rb") as handle:
            frames = handle.getnframes()
            rate = handle.getframerate() or 16000
            return round(frames / float(rate), 2)
    except Exception:  # noqa: BLE001
        return 1.0


class _SegmentWord:
    def __init__(self, word: str, start: float, end: float, probability: float) -> None:
        self.word = word
        self.start = start
        self.end = end
        self.probability = probability


class _Segment:
    def __init__(self, text: str, words: list[_SegmentWord]) -> None:
        self.text = text
        self.words = words


class _SegmentInfo:
    def __init__(self, language: str, duration: float) -> None:
        self.language = language
        self.duration = duration
        self.language_probability = 1.0
