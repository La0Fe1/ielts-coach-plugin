"""WAV ingestion, validation, resampling and energy-based VAD.

The companion web UI always uploads **16 kHz / mono / 16-bit PCM WAV** recorded
straight from the Web Audio API, so no ffmpeg (and no fragile webm/mp4 decoding)
is ever involved. This module is still defensive: it accepts any PCM WAV sample
rate / channel count and normalises it, and it rejects container formats with a
clear, actionable error instead of crashing deep inside the ASR stack.
"""

from __future__ import annotations

import io
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from .. import config

TARGET_SR = config.TARGET_SAMPLE_RATE
FRAME_MS = 20
#: Consecutive silent frames needed to split / end a speech segment.
MIN_SILENCE_SEC = 0.25


class InvalidAudioError(ValueError):
    """Raised when an upload is not a decodable PCM WAV file."""


@dataclass
class WavInfo:
    path: str
    sample_rate: int
    channels: int
    sample_width: int
    frames: int
    duration_sec: float
    voiced_duration_sec: float
    rms: float
    peak: float
    warning: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "path": self.path,
            "sample_rate": self.sample_rate,
            "channels": self.channels,
            "sample_width": self.sample_width,
            "frames": self.frames,
            "duration_sec": self.duration_sec,
            "voiced_duration_sec": self.voiced_duration_sec,
            "rms": self.rms,
            "peak": self.peak,
            "warning": self.warning,
        }


# --------------------------------------------------------------------------- #
# Format detection / validation
# --------------------------------------------------------------------------- #
def sniff_audio_container(data: bytes) -> str:
    """Best-effort container sniffing so we can produce a helpful error message."""
    head = data[:64]
    if head[:4] == b"RIFF" and head[8:12] == b"WAVE":
        return "wav"
    if head[:4] == b"OggS":
        return "ogg"
    if head[:4] == b"\x1aE\xdf\xa3":
        return "webm"
    if head[4:8] == b"ftyp":
        return "mp4/m4a"
    if head[:3] == b"ID3" or head[:2] in (b"\xff\xfb", b"\xff\xf3"):
        return "mp3"
    return "unknown"


def validate_wav_bytes(data: bytes) -> None:
    if not data:
        raise InvalidAudioError("上传的音频为空。请在网页端重新录音后提交。")
    container = sniff_audio_container(data)
    if container != "wav":
        raise InvalidAudioError(
            f"收到的音频格式是 {container}，本系统只接受 16kHz 单声道 PCM WAV。"
            " 请使用伴随网页的 Web Audio 录音按钮（不要用浏览器 MediaRecorder 导出 webm/mp4）。"
        )
    if len(data) < 44:
        raise InvalidAudioError("WAV 文件头不完整（少于 44 字节）。")


# --------------------------------------------------------------------------- #
# Reading / writing
# --------------------------------------------------------------------------- #
def read_wav(path: str | Path, target_sr: int = TARGET_SR) -> tuple[np.ndarray, int]:
    """Read any PCM WAV and return mono float32 in [-1, 1] at target_sr."""
    try:
        with wave.open(str(path), "rb") as handle:
            channels = handle.getnchannels()
            width = handle.getsampwidth()
            rate = handle.getframerate()
            raw = handle.readframes(handle.getnframes())
    except wave.Error as exc:  # compressed WAV (e.g. float32 or adpcm) or bad header
        raise InvalidAudioError(f"无法解析 WAV 文件: {exc}") from exc

    samples = _decode_pcm(raw, width)
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)
    samples = np.asarray(samples, dtype=np.float32)
    if rate != target_sr and samples.size:
        samples = resample_linear(samples, rate, target_sr)
        rate = target_sr
    return samples, rate


def read_wav_bytes(data: bytes, target_sr: int = TARGET_SR) -> tuple[np.ndarray, int]:
    validate_wav_bytes(data)
    with wave.open(io.BytesIO(data), "rb") as handle:
        channels = handle.getnchannels()
        width = handle.getsampwidth()
        rate = handle.getframerate()
        raw = handle.readframes(handle.getnframes())
    samples = _decode_pcm(raw, width)
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)
    samples = np.asarray(samples, dtype=np.float32)
    if rate != target_sr and samples.size:
        samples = resample_linear(samples, rate, target_sr)
        rate = target_sr
    return samples, rate


def _decode_pcm(raw: bytes, width: int) -> np.ndarray:
    if width == 2:
        return np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    if width == 1:
        return (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    if width == 4:
        ints = np.frombuffer(raw, dtype="<i4").astype(np.float32)
        return ints / 2147483648.0
    if width == 3:  # 24-bit little endian
        buf = np.frombuffer(raw, dtype=np.uint8)
        buf = buf[: len(buf) // 3 * 3].reshape(-1, 3)
        ints = (
            buf[:, 0].astype(np.int32)
            | (buf[:, 1].astype(np.int32) << 8)
            | (buf[:, 2].astype(np.int32) << 16)
        )
        ints = np.where(ints >= 1 << 23, ints - (1 << 24), ints)
        return ints.astype(np.float32) / 8388608.0
    raise InvalidAudioError(f"不支持的 PCM 位深: {width * 8} bit")


def write_wav(path: str | Path, samples: np.ndarray, sample_rate: int = TARGET_SR) -> Path:
    """Write mono float32 [-1,1] samples as 16-bit PCM WAV."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    clipped = np.clip(np.asarray(samples, dtype=np.float32), -1.0, 1.0)
    pcm = (clipped * 32767.0).astype("<i2")
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(int(sample_rate))
        handle.writeframes(pcm.tobytes())
    return path


def write_wav_bytes(samples: np.ndarray, sample_rate: int = TARGET_SR) -> bytes:
    buffer = io.BytesIO()
    clipped = np.clip(np.asarray(samples, dtype=np.float32), -1.0, 1.0)
    pcm = (clipped * 32767.0).astype("<i2")
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(int(sample_rate))
        handle.writeframes(pcm.tobytes())
    return buffer.getvalue()


def resample_linear(samples: np.ndarray, src_sr: int, dst_sr: int) -> np.ndarray:
    """Cheap, dependency-free linear resampler (16 kHz speech is forgiving)."""
    if src_sr == dst_sr or samples.size == 0:
        return np.asarray(samples, dtype=np.float32)
    duration = samples.size / float(src_sr)
    target_count = max(1, int(round(duration * dst_sr)))
    src_index = np.linspace(0.0, samples.size - 1, num=samples.size, dtype=np.float64)
    dst_index = np.linspace(0.0, samples.size - 1, num=target_count, dtype=np.float64)
    return np.interp(dst_index, src_index, samples.astype(np.float64)).astype(np.float32)


# --------------------------------------------------------------------------- #
# Energy VAD
# --------------------------------------------------------------------------- #
def frame_energies(samples: np.ndarray, sample_rate: int = TARGET_SR, frame_ms: int = FRAME_MS) -> np.ndarray:
    frame_len = max(1, int(sample_rate * frame_ms / 1000))
    if samples.size < frame_len:
        padded = np.pad(np.asarray(samples, dtype=np.float32), (0, frame_len - samples.size))
        return np.array([float(np.sqrt(np.mean(padded**2)))], dtype=np.float32)
    count = samples.size // frame_len
    frames = np.asarray(samples[: count * frame_len], dtype=np.float32).reshape(count, frame_len)
    return np.sqrt(np.mean(frames**2, axis=1))


def noise_floor(samples: np.ndarray, sample_rate: int = TARGET_SR) -> float:
    energies = frame_energies(samples, sample_rate)
    if energies.size == 0:
        return 0.0
    return float(np.percentile(energies, 10))


def auto_threshold(samples: np.ndarray, sample_rate: int = TARGET_SR) -> float:
    """Pick a voicing threshold that survives "no silence at all" recordings.

    A pure 10th-percentile noise floor collapses when the clip is wall-to-wall
    speech (the floor becomes the speech level itself), so the adaptive value is
    capped and never allowed to exceed a normal speech RMS.
    """
    floor = noise_floor(samples, sample_rate)
    return float(max(min(floor * 3.0, 0.05), 0.008))


def voiced_mask(samples: np.ndarray, sample_rate: int = TARGET_SR, threshold: float | None = None) -> np.ndarray:
    energies = frame_energies(samples, sample_rate)
    if threshold is None:
        threshold = auto_threshold(samples, sample_rate)
    return energies > threshold


def trim_bounds(samples: np.ndarray, sample_rate: int = TARGET_SR, threshold: float | None = None) -> tuple[int, int]:
    """Return (start_sample, end_sample) with leading/trailing silence removed."""
    if samples.size == 0:
        return 0, 0
    mask = voiced_mask(samples, sample_rate, threshold)
    if not mask.any():
        return 0, int(samples.size)
    frame_len = max(1, int(sample_rate * FRAME_MS / 1000))
    first = int(np.argmax(mask))
    last = int(len(mask) - 1 - np.argmax(mask[::-1]))
    start = max(0, first * frame_len - frame_len)
    end = min(samples.size, (last + 1) * frame_len + frame_len)
    return start, end


def trim_silence(samples: np.ndarray, sample_rate: int = TARGET_SR, threshold: float | None = None) -> np.ndarray:
    start, end = trim_bounds(samples, sample_rate, threshold)
    return samples[start:end]


def speech_segments(
    samples: np.ndarray,
    sample_rate: int = TARGET_SR,
    threshold: float | None = None,
    min_silence_sec: float = MIN_SILENCE_SEC,
) -> list[dict[str, float]]:
    """Split audio into voiced regions (used for auto-stop VAD and diagnostics)."""
    mask = voiced_mask(samples, sample_rate, threshold)
    frame_len = max(1, int(sample_rate * FRAME_MS / 1000))
    min_silent_frames = max(1, int(min_silence_sec * 1000 / FRAME_MS))
    segments: list[dict[str, float]] = []
    run_start: int | None = None
    silent_run = 0
    for index, voiced in enumerate(mask):
        if voiced:
            if run_start is None:
                run_start = index
            silent_run = 0
        elif run_start is not None:
            silent_run += 1
            if silent_run >= min_silent_frames:
                end_index = index - silent_run
                segments.append(
                    {
                        "start_sec": round(run_start * frame_len / sample_rate, 3),
                        "end_sec": round((end_index + 1) * frame_len / sample_rate, 3),
                    }
                )
                run_start = None
                silent_run = 0
    if run_start is not None:
        segments.append(
            {
                "start_sec": round(run_start * frame_len / sample_rate, 3),
                "end_sec": round(samples.size / sample_rate, 3),
            }
        )
    return [seg for seg in segments if seg["end_sec"] - seg["start_sec"] >= 0.08]


# --------------------------------------------------------------------------- #
# High level entry point used by the HTTP layer
# --------------------------------------------------------------------------- #
def process_upload(
    data: bytes,
    dest_path: str | Path,
    normalize: bool = True,
    trim: bool = True,
) -> tuple[WavInfo, np.ndarray]:
    """Validate an uploaded WAV, normalise it to 16 kHz mono, persist it."""
    samples, sample_rate = read_wav_bytes(data, TARGET_SR)
    if samples.size == 0:
        raise InvalidAudioError("音频不含任何采样点，请重新录音。")

    peak = float(np.max(np.abs(samples)))
    warning = None
    if peak < 1e-4:
        raise InvalidAudioError("录音几乎是静音（peak < 0.0001），请检查麦克风权限/音量后重试。")

    if trim:
        samples = trim_silence(samples, sample_rate)
    if normalize:
        peak = float(np.max(np.abs(samples))) if samples.size else 0.0
        if peak > 0:
            # Aim for 0.95 full-scale, but never amplify more than 8x (that would
            # just raise the noise floor of a very quiet microphone).
            samples = samples * min(0.95 / peak, 8.0)
    if samples.size < int(0.2 * sample_rate):
        warning = "本轮录音不足 0.2 秒，可能是误触。"

    dest_path = Path(dest_path)
    write_wav(dest_path, samples, sample_rate)
    duration = samples.size / float(sample_rate)
    rms = float(np.sqrt(np.mean(samples**2))) if samples.size else 0.0
    info = WavInfo(
        path=str(dest_path),
        sample_rate=sample_rate,
        channels=1,
        sample_width=2,
        frames=int(samples.size),
        duration_sec=round(duration, 3),
        voiced_duration_sec=round(
            sum(seg["end_sec"] - seg["start_sec"] for seg in speech_segments(samples, sample_rate)), 3
        ),
        rms=round(rms, 5),
        peak=round(float(np.max(np.abs(samples))) if samples.size else 0.0, 5),
        warning=warning,
    )
    return info, samples


def to_base64_wav(samples: np.ndarray, sample_rate: int = TARGET_SR) -> str:
    import base64

    return base64.b64encode(write_wav_bytes(samples, sample_rate)).decode("ascii")
