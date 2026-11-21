"""Local TTS for the examiner, with two engines and bilingual output.

Engines
  * **edge** - Microsoft neural voices via edge-tts. Significantly more human than
    an 82M local model, supports rate/pitch, and covers Chinese. Needs network.
  * **kokoro** - Kokoro-82M, fully offline, 24 kHz, fast. The fallback.

Bilingual: a sentence such as
    "Nice answer. 注意 think 的 θ 音，舌尖轻触上齿。"
is split by script, the English run goes to the English voice and the Chinese run
to the Chinese voice, then the pieces are joined with a short pause. That is what
makes the examiner sound bilingual instead of reading Chinese with an English
accent.

Everything is cached on disk as 24 kHz mono WAV (edge's MP3 is decoded with
libsndfile), so playback, word-clip slicing and the existing /api/audio routes do
not care which engine produced it.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import time
import wave
from pathlib import Path
from typing import Any

import numpy as np

from .. import config

logger = logging.getLogger(__name__)

SAMPLE_RATE = config.TTS_SAMPLE_RATE
CJK_RE = re.compile(r"[\u4e00-\u9fff]")
SCRIPT_SPLIT_RE = re.compile(r"([\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]+)")
SEGMENT_GAP_SEC = 0.12


def _wav_duration(path: Path) -> float:
    try:
        with wave.open(str(path), "rb") as handle:
            return round(handle.getnframes() / float(handle.getframerate() or SAMPLE_RATE), 2)
    except Exception:  # noqa: BLE001
        return 0.0


SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?。！？])\s*")


def split_bilingual(text: str) -> list[tuple[str, str]]:
    """Split text into (lang, chunk) runs, deciding language per sentence.

    Splitting on every script change fragments technical terms out of Chinese
    sentences ("注意 think 的 θ 音" would become 5 network calls). Deciding per
    sentence and letting the Chinese voice pronounce embedded English words is both
    faster and closer to how bilingual teachers actually speak.
    """
    sentences = [part for part in SENTENCE_SPLIT_RE.split(text or "") if part and part.strip()]
    if not sentences:
        return []
    runs: list[tuple[str, str]] = []
    for sentence in sentences:
        stripped = re.sub(r"\s", "", sentence)
        cjk = len(CJK_RE.findall(sentence))
        ratio = cjk / max(1, len(stripped))
        lang = "zh" if ratio >= 0.25 else "en"
        if runs and runs[-1][0] == lang:
            runs[-1] = (lang, runs[-1][1] + " " + sentence.strip())
        else:
            runs.append((lang, sentence.strip()))
    return runs


class TTSService:
    """Resident TTS with disk cache (engine-agnostic)."""

    def __init__(self, settings: config.Settings):
        self.settings = settings
        self._pipelines: dict[str, Any] = {}
        self._error: str | None = None
        self._load_seconds: float | None = None
        self._engine = (settings.tts_engine or "auto").lower()
        self._edge_ok: bool | None = None
        self._edge_failed_at: float = 0.0
        #: Retry a failed edge probe after this cooldown instead of giving up forever.
        self._edge_retry_sec = 300.0

    # -- engine selection ----------------------------------------------------
    @property
    def engine(self) -> str:
        if self._engine in {"edge", "kokoro"}:
            return self._engine
        # auto: prefer edge once proven reachable, else kokoro (with retry cooldown)
        if self._edge_ok is None:
            self._probe_edge()
        elif not self._edge_ok and (time.time() - self._edge_failed_at) > self._edge_retry_sec:
            self._edge_ok = None
            self._probe_edge()
        return "edge" if self._edge_ok else "kokoro"

    @property
    def resolved_engine(self) -> str:
        """Engine for reporting only - never performs a network probe."""
        if self._engine in {"edge", "kokoro"}:
            return self._engine
        if self._edge_ok is None:
            return "auto-pending"
        return "edge" if self._edge_ok else "kokoro"

    def _probe_edge(self) -> bool:
        try:
            import edge_tts  # noqa: F401
        except Exception as exc:  # noqa: BLE001
            self._edge_ok = False
            logger.info("edge-tts 不可用，使用本地 Kokoro: %s", exc)
            return False
        try:
            self._synth_edge_segment("OK.", self.edge_voice("uk"))
            self._edge_ok = True
            logger.info("edge-tts 神经语音可用（音色更自然）")
        except Exception as exc:  # noqa: BLE001
            self._edge_ok = False
            self._edge_failed_at = time.time()
            logger.warning("edge-tts 连接失败，回退本地 Kokoro: %s", exc)
        return bool(self._edge_ok)

    @staticmethod
    def lang_code(accent: str | None) -> str:
        return "b" if (accent or "uk").lower() == "uk" else "a"

    def ko_voice(self, accent: str | None) -> str:
        key = "us" if (accent or "").lower() == "us" else "uk"
        return self.settings.tts_voices.get(key, "bf_emma")

    def edge_voice(self, accent: str | None) -> str:
        key = "us" if (accent or "").lower() == "us" else "uk"
        return self.settings.tts_edge_voices.get(key, "en-GB-SoniaNeural")

    def voice_for(self, accent: str | None) -> str:
        return self.edge_voice(accent) if self.engine == "edge" else self.ko_voice(accent)

    # -- cache ---------------------------------------------------------------
    def _cache_paths(self, text: str, accent: str, speed: float, engine: str) -> tuple[Path, Path]:
        voice = self.edge_voice(accent) if engine == "edge" else self.ko_voice(accent)
        digest = hashlib.sha256(
            f"{engine}|{voice}|{self.settings.tts_edge_rate}|{speed:.2f}|{text}".encode("utf-8")
        ).hexdigest()[:24]
        return (
            self.settings.paths.tts_cache_dir / f"{digest}.wav",
            self.settings.paths.tts_cache_dir / f"{digest}.json",
        )

    # -- lifecycle -----------------------------------------------------------
    def warmup(self) -> dict[str, Any]:
        if not self.settings.tts_enabled:
            return {"ok": False, "reason": "tts_disabled"}
        try:
            result = self.synth("Hello, let us begin.", accent="uk", force=True)
            return {
                "ok": True,
                "engine": result.get("engine"),
                "voice": result.get("voice"),
                "load_seconds": self._load_seconds,
            }
        except Exception as exc:  # noqa: BLE001
            self._error = str(exc)
            logger.warning("TTS 预热失败: %s", exc)
            return {"ok": False, "error": str(exc)}

    def status(self) -> dict[str, Any]:
        return {
            "ok": bool(self._pipelines) or self._edge_ok is True or self.settings.stub_models,
            "enabled": self.settings.tts_enabled,
            "engine": self.resolved_engine,
            "edge_available": self._edge_ok,
            "voices": {
                "kokoro": dict(self.settings.tts_voices),
                "edge": dict(self.settings.tts_edge_voices),
            },
            "loaded_langs": sorted(self._pipelines),
            "stub": self.settings.stub_models,
            "load_seconds": self._load_seconds,
            "error": self._error,
        }

    # -- public synthesis ----------------------------------------------------
    def synth(
        self,
        text: str,
        accent: str | None = "uk",
        speed: float | None = None,
        force: bool = False,
        kind: str = "sentence",
    ) -> dict[str, Any]:
        """Render text (may be mixed EN/ZH) to a cached 24 kHz WAV."""
        text = (text or "").strip()
        if not text:
            raise ValueError("TTS 文本为空")
        accent = (accent or "uk").lower()
        speed = float(speed if speed is not None else self.settings.tts_speed)
        engine = "stub" if self.settings.stub_models else self.engine
        wav_path, meta_path = self._cache_paths(text, accent, speed, engine)

        if wav_path.exists() and not force and wav_path.stat().st_size > 64:
            return {
                "url": f"/api/audio/tts/{wav_path.name}",
                "path": str(wav_path),
                "duration_sec": _wav_duration(wav_path),
                "voice": self.voice_for(accent),
                "accent": accent,
                "engine": engine,
                "cached": True,
                "kind": kind,
                "text": text,
            }

        started = time.time()
        try:
            audio = self._render(text, accent, speed, engine)
        except Exception as exc:  # noqa: BLE001
            self._error = str(exc)
            if engine == "edge":
                # Degrade gracefully: one failed network call must not break a lesson.
                logger.warning("edge-tts 合成失败，本次改用 Kokoro: %s", exc)
                self._edge_ok = False
                audio = self._render(text, accent, speed, "kokoro")
                engine = "kokoro"
            else:
                raise

        from . import processor

        processor.write_wav(wav_path, audio, SAMPLE_RATE)
        duration = _wav_duration(wav_path)
        meta = {
            "text": text,
            "engine": engine,
            "voice": self.voice_for(accent) if engine == "edge" else self.ko_voice(accent),
            "accent": accent,
            "speed": speed,
            "rate": self.settings.tts_edge_rate,
            "duration_sec": duration,
            "render_seconds": round(time.time() - started, 2),
            "kind": kind,
            "segments": len(split_bilingual(text)),
        }
        try:
            meta_path.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
        except OSError:
            pass
        return {
            "url": f"/api/audio/tts/{wav_path.name}",
            "path": str(wav_path),
            "duration_sec": duration,
            "voice": meta["voice"],
            "accent": accent,
            "engine": engine,
            "cached": False,
            "kind": kind,
            "text": text,
            "render_seconds": meta["render_seconds"],
        }

    def synth_word(self, word: str, accent: str | None = "uk") -> dict[str, Any]:
        return self.synth(word, accent=accent, kind="word")

    # -- rendering -----------------------------------------------------------
    def _render(self, text: str, accent: str, speed: float, engine: str) -> np.ndarray:
        if engine == "stub":
            return _stub_audio(text, speed)
        if engine == "edge":
            return self._render_edge(text, accent, speed)
        return self._render_kokoro(text, accent, speed)

    def _render_edge(self, text: str, accent: str, speed: float) -> np.ndarray:
        """Bilingual: each sentence run goes to the voice of its language.

        Segments are synthesised concurrently - three sequential websocket calls
        turned a bilingual line into ~5 s of dead air.
        """
        segments = split_bilingual(text) or [("en", text)]
        if len(segments) == 1 and segments[0][0] == "en":
            return self._synth_edge_segment(segments[0][1], self.edge_voice(accent))
        jobs = []
        for lang, chunk in segments:
            voice = (
                self.settings.tts_edge_voices.get("zh", "zh-CN-XiaoxiaoNeural")
                if lang == "zh"
                else self.edge_voice(accent)
            )
            jobs.append((chunk, voice))
        pieces = self._synth_edge_many(jobs)
        if not pieces:
            return _stub_audio(text, speed)
        gap = np.zeros(int(SAMPLE_RATE * SEGMENT_GAP_SEC), dtype=np.float32)
        merged: list[np.ndarray] = []
        for piece in pieces:
            merged.append(piece)
            merged.append(gap)
        return np.concatenate(merged[:-1])

    @staticmethod
    def _run_coro(factory):
        """Run a coroutine from sync code, even when called inside a live event loop.

        /health and the examiner-turn endpoint call into TTS from the daemon's event
        loop thread; asyncio.run() there raises "cannot be called from a running
        loop" and leaves the coroutine un-awaited, so hop to a private thread.
        """
        import asyncio
        import concurrent.futures

        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return asyncio.run(factory())
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            return pool.submit(lambda: asyncio.run(factory())).result()

    def _synth_edge_many(self, jobs: list[tuple[str, str]]) -> list[np.ndarray]:
        import tempfile

        import edge_tts
        import soundfile as sf

        async def one(text: str, voice: str, path: str) -> None:
            communicate = edge_tts.Communicate(
                text,
                voice,
                rate=self.settings.tts_edge_rate,
                pitch=self.settings.tts_edge_pitch,
            )
            await communicate.save(path)

        async def run_all(paths: list[str]) -> None:
            await asyncio.gather(*(one(t, v, p) for (t, v), p in zip(jobs, paths)))

        results: list[np.ndarray] = []
        with tempfile.TemporaryDirectory() as tmp:
            paths = [str(Path(tmp) / f"seg{i}.mp3") for i in range(len(jobs))]
            self._run_coro(lambda: run_all(paths))
            for path in paths:
                data, sample_rate = sf.read(path, dtype="float32", always_2d=True)
                mono = data.mean(axis=1) if data.ndim > 1 else data
                if sample_rate != SAMPLE_RATE and mono.size:
                    from .processor import resample_linear

                    mono = resample_linear(mono.astype(np.float32), int(sample_rate), SAMPLE_RATE)
                results.append(np.asarray(mono, dtype=np.float32))
        return results

    def _synth_edge_segment(self, text: str, voice: str) -> np.ndarray:
        return self._synth_edge_many([(text, voice)])[0]

    def _render_kokoro(self, text: str, accent: str, speed: float) -> np.ndarray:
        pipeline = self._pipeline(accent)
        voice = self.ko_voice(accent)
        chunks: list[np.ndarray] = []
        try:
            generator = pipeline(text, voice=voice, speed=speed, split_pattern=r"\n+")
            for item in generator:
                audio = getattr(item, "audio", None)
                if audio is None:
                    output = getattr(item, "output", None)
                    audio = getattr(output, "audio", output)
                if audio is None and isinstance(item, (tuple, list)) and len(item) >= 3:
                    audio = item[2]
                if audio is None or callable(audio):
                    continue
                if hasattr(audio, "detach"):
                    audio = audio.detach().cpu().numpy()
                array = np.asarray(audio, dtype=np.float32).reshape(-1)
                if array.size:
                    chunks.append(array)
        except Exception as exc:  # noqa: BLE001
            self._error = str(exc)
            raise RuntimeError(f"Kokoro 合成失败: {exc}") from exc
        if not chunks:
            raise RuntimeError("Kokoro 未返回任何音频数据")
        return np.concatenate(chunks)

    def _pipeline(self, accent: str | None):
        code = self.lang_code(accent)
        if code in self._pipelines:
            return self._pipelines[code]
        started = time.time()
        config.ensure_ascii_tempdir()
        from . import MODEL_IMPORT_LOCK

        with MODEL_IMPORT_LOCK:
            from kokoro import KPipeline

        device = self.settings.device if self.settings.device in {"cuda", "mps"} else "cpu"
        try:
            try:
                pipeline = KPipeline(lang_code=code, repo_id="hexgrad/Kokoro-82M", device=device)
            except TypeError:
                pipeline = KPipeline(lang_code=code, repo_id="hexgrad/Kokoro-82M")
        except Exception as exc:  # noqa: BLE001
            message = str(exc)
            if "spacy" in message.lower() or "en_core_web" in message.lower():
                raise RuntimeError(
                    "Kokoro 的英文 G2P 需要 spaCy 英文模型 en_core_web_sm。请执行：\n"
                    "  python -m spacy download en_core_web_sm\n"
                    "离线环境可先下载 en_core_web_sm-3.8.0-py3-none-any.whl 再 "
                    "pip install <wheel 路径>"
                ) from exc
            raise
        self._pipelines[code] = pipeline
        self._load_seconds = round(time.time() - started, 2)
        logger.info("Kokoro pipeline 就绪 accent=%s 耗时 %.1fs", accent, self._load_seconds)
        return pipeline


def _stub_audio(text: str, speed: float = 1.0) -> np.ndarray:
    words = max(1, len(text.split()))
    duration = max(0.4, words / 2.6) / max(speed, 0.5)
    total = int(SAMPLE_RATE * duration)
    t = np.arange(total, dtype=np.float32) / SAMPLE_RATE
    envelope = np.minimum(1.0, np.minimum(t * 40.0, (duration - t) * 40.0))
    tone = 0.12 * np.sin(2 * np.pi * 180.0 * t) + 0.06 * np.sin(2 * np.pi * 360.0 * t)
    return (tone * np.clip(envelope, 0.0, 1.0)).astype(np.float32)
