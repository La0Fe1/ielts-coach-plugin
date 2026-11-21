"""Prepare the bundled speech models for the portable build.

The package must work offline on a fresh machine, so every model the daemon needs
travels with it. GitHub caps a release asset at 2 GB, which forces two decisions:

  * ASR: distil-large-v3 (CT2 int8, ~750 MB) instead of large-v3-turbo (~1.6 GB).
    English-only and close to large-v3 quality, roughly twice as fast.
  * GOP: the fp32 wav2vec2 checkpoint is 1.2 GB; dynamic int8 quantization of the
    Linear layers cuts it to ~300 MB with negligible change to CTC logits.

HuggingFace-shaped models (ASR, Kokoro) are written into a local HF_HOME so
huggingface_hub resolves them offline with no code changes.
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODELS = ROOT / "models"

# Small English model: the distil-large fp16 checkpoint alone is 1.44 GB, which does
# not fit a single 2 GB release asset next to the GOP and TTS models. Users who want
# more accuracy can set IELTS_COACH_ASR_MODEL and let it download.
# Multilingual small (same size as small.en): Chinese questions/commands are
# transcribed too, which the "speak to stop / ask a word" flows need.
ASR_REPO = "Systran/faster-whisper-small"
GOP_REPO = "facebook/wav2vec2-xlsr-53-espeak-cv-ft"
TTS_REPO = "hexgrad/Kokoro-82M"


def log(message: str) -> None:
    print(f"[models] {message}", flush=True)


def human(path: Path) -> str:
    total = sum(f.stat().st_size for f in path.rglob("*") if f.is_file())
    return f"{total / 1024 / 1024:.0f} MB"


def snapshot(repo: str, target: Path, patterns: list[str] | None = None) -> None:
    from huggingface_hub import snapshot_download

    log(f"下载 {repo} -> {target}")
    snapshot_download(
        repo_id=repo,
        cache_dir=str(target),
        allow_patterns=patterns,
        local_dir_use_symlinks=False,
    )


def quantize_gop(quality_check: bool = True) -> None:
    import torch
    from transformers import Wav2Vec2ForCTC, Wav2Vec2Processor

    target = MODELS / "gop-int8"
    if (target / "config.json").exists():
        log(f"GOP int8 已存在（{human(target)}）")
        return
    log("加载 wav2vec2（fp32，约 1.2 GB）…")
    from huggingface_hub import snapshot_download

    # Load straight from the cached snapshot: Wav2Vec2Processor in offline mode still
    # tries to fetch the feature extractor and fails with WinError 10054 / OSError.
    snapshot = Path(snapshot_download(GOP_REPO, local_files_only=True))
    model = Wav2Vec2ForCTC.from_pretrained(str(snapshot), local_files_only=True)
    model.eval()

    reference = None
    if quality_check:
        torch.manual_seed(0)
        probe = torch.randn(1, 16000 * 2) * 0.05
        with torch.no_grad():
            reference = model(probe).logits

    log("动态 int8 量化 …")
    quantized = torch.quantization.quantize_dynamic(model, {torch.nn.Linear}, dtype=torch.qint8)
    target.mkdir(parents=True, exist_ok=True)
    # save_pretrained cannot serialise a dynamically-quantized module (its state dict
    # holds packed int8 tensors and dtype markers), so keep a plain state dict plus
    # the config/tokenizer; the daemon rebuilds the shell and loads the weights.
    torch.save(quantized.state_dict(), target / "quantized_state.pt")
    model.config.save_pretrained(str(target))
    for name in (
        "preprocessor_config.json",
        "tokenizer_config.json",
        "vocab.json",
        "special_tokens_map.json",
        "tokenizer.json",
    ):
        source = snapshot / name
        if source.is_file():
            shutil.copy2(source, target / name)

    if reference is not None:
        with torch.no_grad():
            got = quantized(probe).logits
        delta = (reference - got).abs().mean().item()
        top1 = (reference.argmax(-1) == got.argmax(-1)).float().mean().item()
        log(f"质量检查: 平均 logit 偏差 {delta:.4f}，top-1 一致率 {top1:.4f}")
    log(f"GOP int8 就绪（{human(target)}）")


def copy_vad() -> None:
    target = MODELS / "vad"
    target.mkdir(parents=True, exist_ok=True)
    import silero_vad

    source = Path(silero_vad.__file__).parent / "data" / "silero_vad.jit"
    if source.exists():
        shutil.copy2(source, target / "silero_vad.jit")
        log("Silero VAD 已复制")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--skip-asr", action="store_true")
    parser.add_argument("--skip-tts", action="store_true")
    parser.add_argument("--skip-gop", action="store_true")
    parser.add_argument("--no-check", action="store_true")
    args = parser.parse_args()

    MODELS.mkdir(parents=True, exist_ok=True)
    hf_home = MODELS / "hf"
    hf_home.mkdir(parents=True, exist_ok=True)
    # Deliberately NOT setting HF_HOME here: quantisation reads wav2vec2 from the
    # developer's normal cache. Forcing HF_HOME made it download a second 1.2 GB copy
    # into the bundle.

    if not args.skip_asr:
        snapshot(ASR_REPO, hf_home)
    if not args.skip_tts:
        snapshot(TTS_REPO, hf_home)
    if not args.skip_gop:
        quantize_gop(quality_check=not args.no_check)
    copy_vad()

    log("合计：")
    for name in ["hf", "gop-int8", "vad"]:
        path = MODELS / name
        if path.exists():
            log(f"  {name}: {human(path)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
