"""Real-model smoke test: Kokoro TTS -> WAV -> Faster-Whisper ASR round trip.

Run:  python scripts/selftest_audio.py
Prints timings and a rough word-overlap score so a broken install is obvious.
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

if not os.environ.get("HF_ENDPOINT"):
    os.environ["HF_ENDPOINT"] = "https://hf-mirror.com"

from daemon import config  # noqa: E402
from daemon.audio.asr import ASRService  # noqa: E402
from daemon.audio.tts import TTSService  # noqa: E402


def main() -> int:
    settings = config.load_settings()
    settings.paths.ensure()
    print("device:", settings.device, "|", settings.device_name)
    print("asr model:", settings.asr_model, "| compute:", settings.asr_compute_type)
    print("home:", settings.paths.home)

    tts = TTSService(settings)
    asr = ASRService(settings)

    text = "Good morning. Where is your hometown, and what do you like about it?"
    started = time.time()
    result = tts.synth(text, accent="uk")
    print("TTS ok:", round(time.time() - started, 2), "s ->", result["path"], result["duration_sec"], "s audio")
    if not result.get("path"):
        print("TTS FAILED")
        return 1

    started = time.time()
    transcribed = asr.transcribe(result["path"])
    elapsed = round(time.time() - started, 2)
    print("ASR ok:", elapsed, "s")
    print("  text      :", transcribed["text"])
    print("  words     :", transcribed["word_count"], "| wpm:", transcribed["wpm"], "| pauses:", transcribed["pause_count"])

    expected = {w.strip(".,?!").lower() for w in text.split()}
    got = {w.strip(".,?!").lower() for w in (transcribed["text"] or "").split()}
    overlap = len(expected & got) / max(1, len(expected))
    print("  word overlap vs prompt: %.0f%%" % (overlap * 100))
    return 0 if overlap >= 0.5 else 2


if __name__ == "__main__":
    sys.exit(main())
