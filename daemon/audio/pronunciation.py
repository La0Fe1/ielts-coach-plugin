"""Phase 2 acoustic pronunciation scoring: G2P -> Wav2Vec2 -> forced align -> GOP.

Pipeline (per learner turn):
  1. G2P: espeak-ng (via phonemizer) turns each ASR word into IPA phonemes.
  2. Acoustic: facebook/wav2vec2-xlsr-53-espeak-cv-ft emits frame-level phoneme
     posteriors (20 ms per frame, ~50 fps).
  3. Alignment: torchaudio.functional.forced_align maps the expected phoneme
     sequence onto frame spans, so every phoneme knows exactly when it was said.
  4. GOP: for each phoneme span, mean(log P(target)) - max_{q != target} mean(log P(q)).
     A competing phoneme that wins by more than the margin is reported as a
     substitution ("θ -> s").
  5. 0..100 mapping through a logistic curve, then word aggregation.

prepare() and score_prepared() are split so the heavy acoustic forward pass can
run concurrently with Faster-Whisper; only the cheap alignment stage waits for the
transcript.
"""

from __future__ import annotations

import logging
import math
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence

import numpy as np

from .. import config

logger = logging.getLogger(__name__)

#: Characters espeak-ng adds that do not correspond to segments we want to align.
STRESS_MARKS = "\u02c8\u02cc"  # ˈ ˌ
IP_CHARS_TO_DROP = set(STRESS_MARKS) | set("|‖‿")

ACCENT_LANGUAGE = {"uk": "en-gb", "us": "en-us"}

#: Phonemes that are interchangeable across accents / espeak variants. Members of a
#: group never count as a substitution and are excluded from the competing set, so a
#: British /əʊ/ heard as American /oʊ/ does not become a red word. Consonants that
#: carry meaning (θ, s, ŋ, ...) are deliberately absent.
EQUIVALENT_PHONEMES: dict[str, set[str]] = {
    "\u0259\u028a": {"o\u028a", "o", "\u025a", "\u025c"},  # əʊ  GOAT
    "o\u028a": {"\u0259\u028a", "o", "\u025a"},  # oʊ
    "\u025c\u02d0": {"\u025c", "\u025a", "\u025d", "\u0259"},  # ɜː  NURSE
    "\u025a": {"\u025c\u02d0", "\u025c", "\u0259"},  # ɚ
    "\u0279": {"r"},  # ɹ
    "r": {"\u0279"},
    "\u025b": {"e"},  # ɛ
    "e": {"\u025b"},
    "i\u02d0": {"i"},
    "i": {"i\u02d0"},
    "u\u02d0": {"u"},
    "u": {"u\u02d0"},
    "\u0251\u02d0": {"\u0251", "a\u02d0", "a"},  # ɑː
    "\u0252": {"\u0251", "\u0254"},  # ɒ
    "\u0254\u02d0": {"\u0254", "o\u02d0"},  # ɔː
    "\u028a": {"u", "u\u02d0"},  # ʊ
    "\u0259": {"\u0250", "\u025a"},  # ə
}


@dataclass
class PhonemeTarget:
    phoneme: str
    token_id: int
    word_index: int

    @property
    def is_vowel(self) -> bool:
        return _is_vowel_like(self.phoneme)


class PronunciationService:
    """Resident Wav2Vec2 phoneme recogniser + G2P with graceful degradation."""

    def __init__(self, settings: config.Settings):
        self.settings = settings
        self._tokenizer = None
        self._model = None
        self._backends: dict[str, Any] = {}
        self._vocab: dict[str, int] = {}
        self._blank_id = 0
        self._error: str | None = None
        self._load_seconds: float | None = None
        self._loading = False
        self._g2p_error: str | None = None
        self.last_elapsed_sec: float | None = None

    # -- lifecycle -----------------------------------------------------------
    @property
    def device(self) -> str:
        # A quantized checkpoint can only run on CPU; the loader pins this flag.
        if getattr(self, "_pinned_cpu", False):
            return "cpu"
        device = self.settings.pronounce_device or self.settings.device
        return device if device in {"cuda", "mps", "cpu"} else "cpu"

    def _load_phonemizer(self, accent: str | None = None):
        key = "us" if (accent or "").lower() == "us" else "uk"
        if key in self._backends:
            return self._backends[key]
        import os

        espeak = config.find_espeak_ng()
        if espeak:
            exe = Path(espeak)
            dll = exe.with_name("libespeak-ng.dll")
            data_dir = exe.with_name("espeak-ng-data")
            if dll.exists():
                os.environ["PHONEMIZER_ESPEAK_LIBRARY"] = str(dll)
            os.environ.setdefault("ESPEAK_NG_PATH", espeak)
            # misaki (Kokoro's G2P) imports espeakng_loader and globally re-points
            # phonemizer's EspeakWrapper at its own bundled library, whose data
            # directory lacks the en-gb voice - that shows up as
            # 'language "en-gb" is not supported by the espeak backend'.
            # Pin the wrapper back to the system espeak-ng install.
            try:
                from phonemizer.backend.espeak.wrapper import EspeakWrapper

                if dll.exists():
                    EspeakWrapper.set_library(str(dll))
                if data_dir.is_dir() and hasattr(EspeakWrapper, "set_data_path"):
                    EspeakWrapper.set_data_path(str(data_dir))
            except Exception as exc:  # noqa: BLE001 - older phonemizer
                logger.debug("无法重置 espeak wrapper: %s", exc)

        from phonemizer.backend import EspeakBackend

        backend = EspeakBackend(
            language=ACCENT_LANGUAGE.get(key, "en-gb"),
            preserve_punctuation=False,
            with_stress=True,
            language_switch="remove-flags",
        )
        self._backends[key] = backend
        return backend

    @property
    def is_loading(self) -> bool:
        return self._loading

    def load(self):
        if self._model is not None:
            return self._model
        self._loading = True
        started = time.time()
        config.ensure_ascii_tempdir()
        try:
            import torch
            from . import MODEL_IMPORT_LOCK

            with MODEL_IMPORT_LOCK:
                from transformers import Wav2Vec2ForCTC, Wav2Vec2PhonemeCTCTokenizer

            name = self.settings.pronounce_model
            logger.info("加载音素识别模型 %s (device=%s)", name, self.device)
            local_quantized = Path(name) / "quantized_state.pt"
            if local_quantized.is_file():
                # Portable build: int8 shell rebuilt here, weights loaded from disk.
                # CTC logits are unaffected, but the model is CPU-only.
                from transformers import Wav2Vec2Config, Wav2Vec2ForCTC

                tokenizer = Wav2Vec2PhonemeCTCTokenizer.from_pretrained(name, local_files_only=True)
                base = Wav2Vec2ForCTC(Wav2Vec2Config.from_pretrained(name))
                model = torch.quantization.quantize_dynamic(
                    base, {torch.nn.Linear}, dtype=torch.qint8
                )
                model.load_state_dict(torch.load(str(local_quantized), map_location="cpu"))
                model.eval()
                # int8 dynamic quantization is CPU-only: feeding fp16 frames from a
                # CUDA tensor raises "Input type Half and bias type float".
                self._pinned_cpu = True
                self._tokenizer = tokenizer
                self._model = model
                self._vocab = {str(k): int(v) for k, v in tokenizer.get_vocab().items()}
                self._blank_id = int(getattr(model.config, "pad_token_id", 0) or 0)
                self._error = None
                self._load_seconds = round(time.time() - started, 2)
                logger.info("int8 音素模型就绪（%.2fs）", self._load_seconds)
                return self._model
            try:
                # Fast path: already in the local HF cache -> no network at all.
                tokenizer = Wav2Vec2PhonemeCTCTokenizer.from_pretrained(
                    name, local_files_only=True
                )
                model = Wav2Vec2ForCTC.from_pretrained(name, local_files_only=True)
            except Exception:  # noqa: BLE001 - not cached yet, download it
                tokenizer = Wav2Vec2PhonemeCTCTokenizer.from_pretrained(name)
                model = Wav2Vec2ForCTC.from_pretrained(name)
            model.eval()
            if self.device == "cuda":
                model = model.to("cuda").half()
            elif self.device == "mps":
                model = model.to("mps")
            self._tokenizer = tokenizer
            self._model = model
            self._vocab = {str(k): int(v) for k, v in tokenizer.get_vocab().items()}
            self._blank_id = int(getattr(model.config, "pad_token_id", 0) or 0)
            self._error = None
            self._load_seconds = round(time.time() - started, 2)
            logger.info("音素模型就绪 (%.1fs, vocab=%d)", self._load_seconds, len(self._vocab))
            return self._model
        except Exception as exc:  # noqa: BLE001 - pronunciation is an enhancement
            self._error = str(exc)
            logger.warning("音素模型加载失败，Phase 2 发音评分将返回 null: %s", exc)
            return None
        finally:
            self._loading = False

    def warmup(self) -> dict[str, Any]:
        if not self.settings.pronounce_enabled:
            return {"ok": False, "reason": "disabled"}
        model = self.load()
        if model is None:
            return {"ok": False, "error": self._error}
        try:
            import torch

            audio = torch.zeros(16000)
            self._forward(audio)
            return {"ok": True, "load_seconds": self._load_seconds, "device": self.device}
        except Exception as exc:  # noqa: BLE001
            self._error = str(exc)
            return {"ok": False, "error": self._error}

    def status(self) -> dict[str, Any]:
        return {
            "ok": self._model is not None,
            "enabled": self.settings.pronounce_enabled,
            "model": self.settings.pronounce_model,
            "device": self.device,
            "stub": self.settings.stub_models,
            "vocab_size": len(self._vocab),
            "g2p_error": self._g2p_error,
            "load_seconds": self._load_seconds,
            "last_elapsed_sec": self.last_elapsed_sec,
            "error": self._error,
        }

    # -- G2P -----------------------------------------------------------------
    def _max_token_len(self) -> int:
        if not hasattr(self, "_token_len"):
            sizes = [len(token) for token in self._vocab if not token.startswith("<")]
            self._token_len = max(sizes) if sizes else 1
        return self._token_len

    def _segment_ipa(self, ipa: str) -> list[str]:
        """Split an espeak IPA string using the model vocabulary.

        The espeak CTC checkpoints do not use one token per character: long vowels
        and diphthongs are single tokens ("iː", "aɪ", "əʊ"), so a greedy
        longest-match against the vocab is required before alignment.
        """
        text = "".join(ch for ch in (ipa or "") if ch not in IP_CHARS_TO_DROP and not ch.isspace())
        tokens: list[str] = []
        index = 0
        longest = self._max_token_len()
        while index < len(text):
            matched = None
            for size in range(min(longest, len(text) - index), 0, -1):
                candidate = text[index : index + size]
                if candidate in self._vocab:
                    matched = candidate
                    break
            if matched is None:
                index += 1  # symbol outside the model vocabulary: skip it
                continue
            tokens.append(matched)
            index += len(matched)
        return tokens

    def phonemize_words(self, words: Sequence[str], accent: str | None = None) -> list[list[str]]:
        """IPA phoneme-token list per word (stress marks stripped, vocab-matched).

        The accent must match the learner's target accent: espeak renders /ɒ/ vs
        /ɑ/, /eə/ vs /ɛr/ and /əʊ/ vs /oʊ/ differently, and feeding British vowels
        to American speech produces a wall of false red words.
        """
        cleaned = [re.sub(r"[^A-Za-z'\-]", "", w) for w in words]
        if not any(cleaned):
            return [[] for _ in words]
        try:
            backend = self._load_phonemizer(accent)
            raw = backend.phonemize(cleaned)
        except Exception as exc:  # noqa: BLE001
            self._g2p_error = f"{type(exc).__name__}: {exc}"
            logger.warning("G2P 失败（本轮跳过发音评分）: %s", exc)
            return [[] for _ in words]
        return [self._segment_ipa(item) for item in raw]

    def build_targets(
        self, words: Sequence[str], accent: str | None = None
    ) -> tuple[list[PhonemeTarget], list[list[int]]]:
        """Return the flat phoneme target list and the per-word phoneme index ranges."""
        per_word = self.phonemize_words(words, accent)
        targets: list[PhonemeTarget] = []
        word_slices: list[list[int]] = []
        for word_index, phonemes in enumerate(per_word):
            start = len(targets)
            for phoneme in phonemes:
                token_id = self._vocab.get(phoneme)
                if token_id is None:
                    continue
                targets.append(PhonemeTarget(phoneme=phoneme, token_id=token_id, word_index=word_index))
            word_slices.append([start, len(targets)])
        return targets, word_slices

    # -- acoustic front-end --------------------------------------------------
    def _forward(self, waveform):
        import torch

        model = self._model
        batch = waveform.unsqueeze(0)
        if self.device == "cuda":
            batch = batch.to("cuda").half()
        elif self.device == "mps":
            batch = batch.to("mps")
        with torch.no_grad():
            logits = model(batch).logits[0]
        return torch.log_softmax(logits.float(), dim=-1)

    def prepare(self, wav_path: str | Path) -> dict[str, Any] | None:
        """Run the acoustic model (safe to execute concurrently with ASR)."""
        if not self.settings.pronounce_enabled:
            return None
        if self._model is None:
            if self._loading:
                # Startup warm-up still in flight: never block a learner turn on it.
                logger.debug("音素模型仍在预热，本轮跳过发音评分")
                return None
            model = self.load()
            if model is None:
                return None
        started = time.time()
        try:
            from .processor import read_wav

            samples, _sr = read_wav(wav_path, config.TARGET_SAMPLE_RATE)
            if samples.size < int(0.25 * config.TARGET_SAMPLE_RATE):
                return None
            import torch

            waveform = torch.from_numpy(np.ascontiguousarray(samples, dtype=np.float32))
            log_probs = self._forward(waveform)
            return {
                "log_probs": log_probs,
                "frames": int(log_probs.shape[0]),
                "duration_sec": round(samples.size / config.TARGET_SAMPLE_RATE, 2),
                "forward_sec": round(time.time() - started, 2),
            }
        except Exception as exc:  # noqa: BLE001
            self._error = f"acoustic forward failed: {exc}"
            logger.warning("音素前向推理失败: %s", exc)
            return None

    # -- alignment + GOP -----------------------------------------------------
    def score_prepared(
        self,
        prepared: dict[str, Any] | None,
        transcript: str,
        words: Sequence[dict[str, Any]] | None = None,
        accent: str | None = None,
    ) -> dict[str, Any] | None:
        if prepared is None or not transcript.strip():
            return None
        started = time.time()
        try:
            result = self._score(prepared, transcript, words or [], accent)
        except Exception as exc:  # noqa: BLE001
            self._error = f"GOP failed: {exc}"
            logger.warning("GOP 计算失败: %s", exc)
            return None
        result["alignment_sec"] = round(time.time() - started, 2)
        result["forward_sec"] = prepared.get("forward_sec")
        result["elapsed_sec"] = round(
            (prepared.get("forward_sec") or 0) + result["alignment_sec"], 2
        )
        self.last_elapsed_sec = result["elapsed_sec"]
        return result

    def score(
        self,
        wav_path: str | Path,
        transcript: str,
        words: Sequence[dict[str, Any]] | None = None,
        accent: str | None = None,
    ) -> dict[str, Any] | None:
        return self.score_prepared(self.prepare(wav_path), transcript, words, accent)

    # ------------------------------------------------------------------ #
    def _bridge_align(self, log_probs, targets: Sequence[PhonemeTarget], frames: int):
        """Return a per-frame token-id path (the CTC forced alignment).

        torchaudio.functional.forced_align returns the vocabulary token ids (not
        target positions), so callers must walk the path to recover spans. It is
        deprecated in torchaudio 2.9, hence the pure-numpy Viterbi fallback.
        """
        import torch

        ids = [t.token_id for t in targets]
        try:
            import torchaudio.functional as AF

            target_tensor = torch.tensor([ids], dtype=torch.int32)
            alignment, _scores = AF.forced_align(
                log_probs.unsqueeze(0).cpu(),
                target_tensor,
                torch.tensor([frames], dtype=torch.int32),
                torch.tensor([len(ids)], dtype=torch.int32),
                blank=self._blank_id,
            )
            return alignment[0].tolist(), "torchaudio"
        except (ImportError, AttributeError, RuntimeError):
            pass
        path = self._viterbi(log_probs.detach().cpu().numpy(), ids, self._blank_id)
        return path, "numpy"

    @staticmethod
    def _viterbi(log_probs, token_ids: Sequence[int], blank: int) -> list[int]:
        """Minimal CTC Viterbi over the 2S+1 extended state graph.

        Returns, for every frame, the *token id* of the state the path visits
        (blank frames report the blank id). Vectorised over states per frame.
        """
        frames, vocab = log_probs.shape
        states: list[int] = [blank]
        for token in token_ids:
            states.append(token)
            states.append(blank)
        state_count = len(states)
        neg = -1e30
        score = [neg] * state_count
        score[0] = log_probs[0, blank]
        if state_count > 1:
            score[1] = log_probs[0, states[1]]
        back = np.zeros((frames, state_count), dtype=np.int32)
        for t in range(1, frames):
            emission = log_probs[t][np.asarray(states, dtype=np.int64)]
            stay = np.asarray(score, dtype=np.float64)
            step1 = np.concatenate(([neg], stay[:-1]))
            skip2 = np.concatenate(([neg, neg], stay[:-2]))
            allowed = np.zeros(state_count, dtype=bool)
            allowed[2:] = np.asarray(states[2:]) != np.asarray(states[:-2])
            skip2 = np.where(allowed, skip2, neg)
            stacked = np.vstack([stay, step1, skip2])
            choice = np.argmax(stacked, axis=0)
            best = stacked[choice, np.arange(state_count)]
            back[t] = choice
            score = (best + emission).tolist()
        # backtrack
        path = [0] * frames
        state = int(np.argmax(np.asarray(score)))
        for t in range(frames - 1, -1, -1):
            path[t] = int(states[state])
            state -= int(back[t][state])
            if state < 0:
                state = 0
        return path

    def _score(
        self,
        prepared: dict[str, Any],
        transcript: str,
        asr_words: Sequence[dict[str, Any]],
        accent: str | None = None,
    ) -> dict[str, Any]:
        log_probs = prepared["log_probs"]
        frames = prepared["frames"]
        duration = prepared.get("duration_sec") or (frames * 0.02)

        tokens = re.findall(r"[A-Za-z][A-Za-z'\-]*", transcript)
        if asr_words:
            tokens = [str(w.get("word", "")).strip() for w in asr_words if str(w.get("word", "")).strip()]
        if not tokens:
            return self._empty(duration, "没有可对齐的单词")

        targets, word_slices = self.build_targets(tokens, accent)
        if len(targets) < 2:
            return self._empty(duration, "G2P 未产生可用音素序列")
        if len(targets) > frames:
            return self._empty(duration, "音素序列长于音频帧数，无法对齐")

        path, engine = self._bridge_align(log_probs, targets, frames)

        # Walk the token-id path: a new token segment starts only after a blank (or a
        # different token), which keeps repeated identical phonemes distinguishable.
        spans: list[tuple[int, int]] = [(-1, -1)] * len(targets)
        position = 0
        active = -1
        for frame_index, token_id in enumerate(path):
            if token_id == self._blank_id:
                active = -1
                continue
            if active >= 0 and token_id == targets[active].token_id:
                spans[active] = (spans[active][0], frame_index)
                continue
            if position < len(targets) and token_id == targets[position].token_id:
                spans[position] = (frame_index, frame_index)
                active = position
                position += 1
                continue
            # Alignment visited a token we did not expect here; look ahead once.
            for look in range(position, len(targets)):
                if targets[look].token_id == token_id and spans[look][0] < 0:
                    spans[look] = (frame_index, frame_index)
                    active = look
                    position = look + 1
                    break

        # Per-word phoneme statistics, used for "function word" leniency below.
        word_phoneme_count = [0] * len(tokens)
        word_vowel_count = [0] * len(tokens)
        for target in targets:
            word_phoneme_count[target.word_index] += 1
            if _is_vowel_like(target.phoneme):
                word_vowel_count[target.word_index] += 1

        frame_sec = duration / max(frames, 1)
        decoded_ids = log_probs.argmax(dim=-1).tolist()
        phoneme_scores: list[dict[str, Any]] = []
        for index, target in enumerate(targets):
            start, end = spans[index]
            if start < 0:
                continue  # phoneme never aligned (skipped by the model)
            segment = log_probs[start : end + 1].mean(dim=0)
            target_lp = float(segment[target.token_id].item())
            group = EQUIVALENT_PHONEMES.get(target.phoneme, set()) | {target.phoneme}
            masked = segment.clone()
            masked[self._blank_id] = -math.inf
            for member in group:
                member_id = self._vocab.get(member)
                if member_id is not None:
                    masked[member_id] = -math.inf
            competitor_lp, competitor_id = float(masked.max().item()), int(masked.argmax().item())
            gop = target_lp - competitor_lp
            competitor = self._token_for_id(competitor_id)
            heard = self._dominant_token(decoded_ids[start : end + 1]) or competitor
            matched = heard in group or gop > -1.0
            # Short single-syllable words are mostly function words (a, of, and,
            # what, there). Their vowels are the most accent-sensitive part of
            # English and carrying them as red words only adds noise for a coach -
            # consonant substitutions still count in full.
            lenient_word = word_vowel_count[target.word_index] == 1 and word_phoneme_count[target.word_index] <= 3
            if not matched and lenient_word and _is_vowel_like(target.phoneme):
                matched = True
            score = self._matched_score(gop) if matched else self._gop_to_score(gop)
            phoneme_scores.append(
                {
                    "index": index,
                    "word_index": target.word_index,
                    "phoneme": target.phoneme,
                    "gop": round(gop, 2),
                    "score": score,
                    "matched": matched,
                    "heard": heard,
                    "competitor": competitor,
                    "competitor_gop": round(competitor_lp, 2),
                    "start_sec": round(start * frame_sec, 3),
                    "end_sec": round((end + 1) * frame_sec, 3),
                    "frames": end - start + 1,
                }
            )

        if not phoneme_scores:
            return self._empty(duration, "对齐后没有得到任何音素区间")

        words_payload: list[dict[str, Any]] = []
        flagged: list[dict[str, Any]] = []
        weak: dict[str, dict[str, Any]] = {}
        for word_index, (start_index, end_index) in enumerate(word_slices):
            chunk = [p for p in phoneme_scores if p["word_index"] == word_index]
            word_text = tokens[word_index] if word_index < len(tokens) else ""
            if not chunk:
                words_payload.append(
                    {
                        "word": word_text,
                        "index": word_index,
                        "score": None,
                        "ipa": None,
                        "start_sec": None,
                        "end_sec": None,
                        "color": "gray",
                        "issues": [],
                    }
                )
                continue
            scores = [p["score"] for p in chunk]
            # Weight the weakest phoneme higher: one broken /θ/ should not hide
            # behind three clean sounds.
            word_score = int(round(0.65 * (sum(scores) / len(scores)) + 0.35 * min(scores)))
            # A detected substitution dominates the word: if the acoustics clearly
            # chose another phoneme, the word cannot stay green just because its
            # other segments were clean (GOP magnitude varies with trimming/gain).
            # Two tiers keep marginal cases honest: a clear substitution (gop < -2)
            # is red, a marginal one (between -2 and -1) is only amber.
            clear = [p for p in chunk if not p.get("matched") and p["gop"] < -2.0]
            doubtful = [p for p in chunk if not p.get("matched") and -2.0 <= p["gop"] < -1.0]
            if clear:
                word_score = min(word_score, 59)
            elif doubtful or any(not p.get("matched") for p in chunk):
                word_score = min(word_score, 69)
            ipa = "".join(p["phoneme"] for p in chunk)
            issues = []
            for phoneme in chunk:
                if phoneme.get("matched"):
                    continue
                if phoneme["gop"] >= -0.6:
                    continue
                issue_type = "phoneme_distortion"
                if (
                    phoneme is chunk[-1]
                    and phoneme["frames"] <= 2
                    and phoneme["score"] < 50
                    and not _is_vowel_like(phoneme["phoneme"])
                ):
                    issue_type = "dropped_ending"
                if (
                    phoneme["gop"] > -self.settings.substitution_margin
                    and issue_type == "phoneme_distortion"
                ):
                    continue
                issues.append(
                    {
                        "phoneme": phoneme["phoneme"],
                        "likely_pronounced_as": phoneme["competitor"],
                        "gop_score": phoneme["gop"],
                        "issue_type": issue_type,
                        "start_sec": phoneme["start_sec"],
                        "end_sec": phoneme["end_sec"],
                    }
                )
                bucket = weak.setdefault(
                    phoneme["phoneme"],
                    {"phoneme": phoneme["phoneme"], "scores": [], "examples": []},
                )
                bucket["scores"].append(phoneme["score"])
                if word_text and word_text not in bucket["examples"]:
                    bucket["examples"].append(word_text)

            entry = {
                "word": word_text,
                "index": word_index,
                "score": word_score,
                "ipa": ipa,
                "start_sec": chunk[0]["start_sec"],
                "end_sec": chunk[-1]["end_sec"],
                "color": self._color(word_score),
                "issues": issues,
                "phonemes": [
                    {k: p[k] for k in ("phoneme", "score", "gop", "competitor", "start_sec", "end_sec")}
                    for p in chunk
                ],
            }
            words_payload.append(entry)
            if word_score < self.settings.score_amber or issues:
                flagged.append(entry)

        overall = round(
            sum(w["score"] for w in words_payload if w["score"] is not None)
            / max(1, sum(1 for w in words_payload if w["score"] is not None)),
            1,
        )
        weak_list = [
            {
                "phoneme": item["phoneme"],
                "avg_score": round(sum(item["scores"]) / len(item["scores"]), 1),
                "count": len(item["scores"]),
                "examples": item["examples"][:3],
            }
            for item in weak.values()
            if item["scores"]
        ]
        weak_list.sort(key=lambda item: item["avg_score"])

        return {
            "overall_score": overall,
            "words": words_payload,
            "flagged_words": flagged,
            "weak_phonemes": weak_list,
            "model": self.settings.pronounce_model,
            "device": self.device,
            "duration_sec": duration,
            "frames": frames,
            "phoneme_count": len(phoneme_scores),
            "alignment_engine": engine,
            "alignment_ok": True,
        }

    # -- helpers -------------------------------------------------------------
    def _token_for_id(self, token_id: int) -> str:
        for token, index in self._vocab.items():
            if index == token_id:
                return token
        return "?"

    def _dominant_token(self, ids: Sequence[int]) -> str | None:
        """Most frequent non-blank token id inside a span (i.e. what was heard)."""
        counts: dict[int, int] = {}
        for token_id in ids:
            if token_id == self._blank_id:
                continue
            counts[token_id] = counts.get(token_id, 0) + 1
        if not counts:
            return None
        best = max(counts.items(), key=lambda item: item[1])[0]
        return self._token_for_id(best)

    def _gop_to_score(self, gop: float) -> int:
        value = 100.0 / (1.0 + math.exp(-self.settings.gop_slope * (gop - self.settings.gop_center)))
        return max(1, min(100, int(round(value))))

    @staticmethod
    def _matched_score(gop: float) -> int:
        """Correct phoneme (possibly a different accent variant): keep it green/amber.

        A matched phoneme still earns less when its own posterior is weak, but it can
        never fall into the red band - that band is reserved for real substitutions
        and dropped endings.
        """
        value = 78.0 + 22.0 * (1.0 / (1.0 + math.exp(-1.2 * (gop + 1.0))))
        return max(70, min(100, int(round(value))))

    def _color(self, score: int | None) -> str:
        if score is None:
            return "gray"
        if score >= self.settings.score_green:
            return "green"
        if score >= self.settings.score_amber:
            return "amber"
        return "red"

    def _empty(self, duration: float, reason: str) -> dict[str, Any]:
        return {
            "overall_score": None,
            "words": [],
            "flagged_words": [],
            "weak_phonemes": [],
            "model": self.settings.pronounce_model,
            "device": self.device,
            "duration_sec": duration,
            "alignment_ok": False,
            "reason": reason,
        }


VOWEL_CHARS = set("ɪiʊuʌɜəæeaɑɒɔɐɚɞɵøœy") | {"\u02d0"}  # includes the length mark


GLIDE_CHARS = set("jw") | {"\u0279"}  # j w ɹ


def _is_vowel_like(phoneme: str) -> bool:
    """True for vowel syllables, including glides and multi-character tokens.

    The espeak CTC vocabulary contains whole syllables such as "ju" (you), "wa"
    (was) and diphthongs like "aɪ"/"əʊ"/"iə". A naive per-character test misses
    those, which used to leak short function words into the red band. Leading
    glides (j/w/ɹ) are stripped before the test, so /ju/ counts as a vowel
    nucleus - reducing "you" to /uː/ in fast speech is not a pronunciation error.
    """
    if not phoneme:
        return False
    body = phoneme.lstrip("jw\u0279")
    if not body:
        return False
    return all(ch in VOWEL_CHARS for ch in body)


class _StubPronunciation:
    """Deterministic stub used by IELTS_COACH_STUB_MODELS=1 (tests / CI)."""

    def __init__(self, settings: config.Settings):
        self.settings = settings

    def warmup(self) -> dict[str, Any]:
        return {"ok": True, "stub": True}

    def status(self) -> dict[str, Any]:
        return {"ok": True, "stub": True, "enabled": True, "model": "stub", "device": "cpu"}

    def prepare(self, wav_path: str | Path) -> dict[str, Any] | None:
        return {"log_probs": None, "frames": 100, "duration_sec": 2.0, "forward_sec": 0.01}

    def score_prepared(self, prepared, transcript: str, words=None):
        tokens = re.findall(r"[A-Za-z][A-Za-z'\-]*", transcript or "")
        if not tokens:
            return None
        payload_words = []
        for index, token in enumerate(tokens):
            score = 88 if index % 5 else 52
            payload_words.append(
                {
                    "word": token,
                    "index": index,
                    "score": score,
                    "ipa": token[:3],
                    "start_sec": round(index * 0.3, 2),
                    "end_sec": round(index * 0.3 + 0.25, 2),
                    "color": "green" if score >= 80 else ("amber" if score >= 60 else "red"),
                    "issues": [] if score >= 60 else [
                        {
                            "phoneme": "θ",
                            "likely_pronounced_as": "s",
                            "gop_score": -3.1,
                            "issue_type": "phoneme_distortion",
                            "start_sec": round(index * 0.3, 2),
                            "end_sec": round(index * 0.3 + 0.25, 2),
                        }
                    ],
                }
            )
        flagged = [w for w in payload_words if w["score"] < 60]
        return {
            "overall_score": round(sum(w["score"] for w in payload_words) / len(payload_words), 1),
            "words": payload_words,
            "flagged_words": flagged,
            "weak_phonemes": [{"phoneme": "θ", "avg_score": 52.0, "count": len(flagged), "examples": ["think"]}]
            if flagged
            else [],
            "model": "stub",
            "device": "cpu",
            "duration_sec": 2.0,
            "frames": 100,
            "alignment_ok": True,
            "stub": True,
        }

    def score(self, wav_path, transcript, words=None):
        return self.score_prepared(None, transcript, words)


def build_service(settings: config.Settings):
    if settings.stub_models:
        return _StubPronunciation(settings)
    return PronunciationService(settings)
