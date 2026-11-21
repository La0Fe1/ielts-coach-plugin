"""Phase 2 acoustic pronunciation (GOP) tests.

Two layers:
  * pure unit tests with synthetic posteriors - no model download, run anywhere;
  * integration tests on real Kokoro-generated audio that reproduce the acceptance
    case (the word "think" spoken as "sink"), skipped automatically when the
    wav2vec2 checkpoint is not available offline.
"""

from __future__ import annotations

from pathlib import Path

import pytest
import torch

from daemon import config
from daemon.audio.pronunciation import PronunciationService, build_service

FIXTURES = Path(__file__).resolve().parent / "fixtures"

SYNTH_VOCAB = {
    "<pad>": 0,
    "<s>": 1,
    "</s>": 2,
    "<unk>": 3,
    "aɪ": 4,
    "θ": 5,
    "s": 6,
    "ɪ": 7,
    "ŋ": 8,
    "k": 9,
    "əʊ": 10,
    "n": 11,
    "t": 12,
}


def _service_with_vocab(phonemes_by_word):
    """A PronunciationService with a fake vocab and a stubbed G2P."""
    settings = config.load_settings()
    service = PronunciationService(settings)
    service._vocab = dict(SYNTH_VOCAB)
    service._blank_id = 0
    service.phonemize_words = lambda words, accent=None: [  # type: ignore[assignment]
        list(phonemes_by_word.get(w, [])) for w in words
    ]
    return service


def _log_probs(frame_tokens, vocab_size=len(SYNTH_VOCAB), boost=6.0, floor=-6.0):
    """Build [T, V] log-probs where each frame "sounds like" the given token id."""
    logits = torch.full((len(frame_tokens), vocab_size), floor)
    for index, token in enumerate(frame_tokens):
        logits[index, token] = boost
    return torch.log_softmax(logits, dim=-1)


def _frames_for(phonemes, per_phoneme=5, gap=3, blank=0):
    frames = []
    for phoneme_id in phonemes:
        frames.extend([phoneme_id] * per_phoneme)
        frames.extend([blank] * gap)
    return frames


def test_gop_score_mapping_is_monotonic_and_bounded():
    service = _service_with_vocab({})
    low = service._gop_to_score(-6.0)
    mid = service._gop_to_score(-2.6)
    high = service._gop_to_score(0.0)
    assert 1 <= low < mid < high <= 100
    assert 45 <= mid <= 55  # logistic centre maps near the amber boundary
    for gop in (-20.0, -1.0, 0.0, 5.0):
        score = service._gop_to_score(gop)
        assert 1 <= score <= 100


def test_matched_score_never_red():
    service = _service_with_vocab({})
    for gop in (-8.0, -3.0, -1.0, 0.0):
        score = service._matched_score(gop)
        assert 70 <= score <= 100


def test_ipa_segmentation_uses_multi_character_tokens():
    service = _service_with_vocab({})
    assert service._segment_ipa("θɪŋk") == ["θ", "ɪ", "ŋ", "k"]
    # diphthong and long vowel must stay single tokens
    assert service._segment_ipa("aɪ") == ["aɪ"]
    assert service._segment_ipa("səʊ") == ["s", "əʊ"]
    # unknown symbols are skipped, not fatal
    assert service._segment_ipa("θ§ɪ") == ["θ", "ɪ"]


def test_viterbi_alignment_tracks_the_target_sequence():
    service = _service_with_vocab({})
    targets = [4, 5, 7, 8, 9]  # aɪ θ ɪ ŋ k
    log_probs = _log_probs(_frames_for(targets))
    path = service._viterbi(log_probs.numpy(), targets, blank=0)
    assert len(path) == log_probs.shape[0]
    spoken = [
        token
        for index, token in enumerate(path)
        if token != 0 and (index == 0 or path[index - 1] != token)
    ]
    assert spoken == targets


def test_score_flags_wrong_theta_as_substitution():
    """A /θ/ pronounced as /s/ must be flagged as a substitution."""
    service = _service_with_vocab({"I": ["aɪ"], "think": ["θ", "ɪ", "ŋ", "k"], "so": ["s", "əʊ"]})
    wrong = [4, 6, 7, 8, 9, 6, 10]  # θ frames actually sound like s
    frames = _frames_for(wrong)
    prepared = {"log_probs": _log_probs(frames), "frames": len(frames), "duration_sec": 1.6}
    result = service._score(prepared, "I think so", [])
    assert result["alignment_ok"] is True
    words = {word["word"]: word for word in result["words"]}
    assert set(words) == {"I", "think", "so"}

    think = words["think"]
    assert think["score"] < 60, think
    assert think["color"] == "red"
    assert think["issues"], think
    issue = think["issues"][0]
    assert issue["phoneme"] == "θ"
    assert issue["likely_pronounced_as"] == "s"
    assert issue["gop_score"] < -1.5
    assert result["flagged_words"]

    # untouched words stay acceptable and produce no issues
    assert words["so"]["score"] >= 60
    assert words["so"]["issues"] == []


def test_score_accepts_correct_pronunciation():
    service = _service_with_vocab({"I": ["aɪ"], "think": ["θ", "ɪ", "ŋ", "k"], "so": ["s", "əʊ"]})
    correct = [4, 5, 7, 8, 9, 6, 10]
    frames = _frames_for(correct)
    prepared = {"log_probs": _log_probs(frames), "frames": len(frames), "duration_sec": 1.6}
    result = service._score(prepared, "I think so", [])
    for word in result["words"]:
        assert word["score"] >= 80, word
        assert word["color"] == "green"
        assert word["issues"] == []
    assert result["overall_score"] >= 80
    assert result["flagged_words"] == []


def test_accent_variants_are_not_penalised():
    """A British /əʊ/ heard as American /oʊ/ must not become a red word."""
    service = _service_with_vocab({"so": ["s", "əʊ"]})
    service._vocab["oʊ"] = 12
    spoken = [6, 12]  # s + oʊ
    frames = _frames_for(spoken)
    prepared = {
        "log_probs": _log_probs(frames, vocab_size=len(service._vocab)),
        "frames": len(frames),
        "duration_sec": 0.6,
    }
    result = service._score(prepared, "so", [])
    word = result["words"][0]
    assert word["score"] >= 70
    assert word["issues"] == []


def test_alignment_rejects_overlong_target():
    service = _service_with_vocab({"think": ["θ", "ɪ", "ŋ", "k"]})
    prepared = {"log_probs": _log_probs([5, 0, 0]), "frames": 3, "duration_sec": 0.1}
    result = service._score(prepared, "think", [])
    assert result["alignment_ok"] is False
    assert result["overall_score"] is None


# --------------------------------------------------------------------------- #
# Integration with the real acoustic model (skipped when unavailable offline)
# --------------------------------------------------------------------------- #
@pytest.fixture(scope="module")
def real_service():
    settings = config.load_settings()
    if settings.stub_models:
        pytest.skip("stub models")
    service = PronunciationService(settings)
    if not (FIXTURES / "pron_think.wav").is_file() or not (FIXTURES / "pron_sink.wav").is_file():
        pytest.skip("audio fixtures missing")
    if service.load() is None:
        pytest.skip("wav2vec2 phoneme model unavailable: " + str(service.status().get("error")))
    return service


def test_real_model_detects_think_spoken_as_sink(real_service):
    good = real_service.score(FIXTURES / "pron_think.wav", "I think so")
    bad = real_service.score(FIXTURES / "pron_sink.wav", "I think so")
    assert good is not None and bad is not None
    good_words = {word["word"].lower(): word for word in good["words"]}
    bad_words = {word["word"].lower(): word for word in bad["words"]}

    assert good_words["think"]["score"] >= 70, good_words["think"]
    assert bad_words["think"]["score"] < good_words["think"]["score"]
    assert bad_words["think"]["score"] < 60
    assert bad_words["think"]["color"] == "red"
    issues = bad_words["think"]["issues"]
    assert issues, bad_words["think"]
    assert issues[0]["phoneme"] == "θ"
    assert issues[0]["likely_pronounced_as"] == "s"
    assert bad["overall_score"] < good["overall_score"]


def test_real_model_returns_word_timings(real_service):
    result = real_service.score(FIXTURES / "pron_think.wav", "I think so")
    assert result is not None
    for word in result["words"]:
        if word["score"] is None:
            continue
        assert word["start_sec"] is not None and word["end_sec"] is not None
        assert word["end_sec"] >= word["start_sec"]
        assert word["start_sec"] >= 0
    assert result["elapsed_sec"] is not None
    assert result["elapsed_sec"] < 2.0  # GPU budget from BUILD_PLAN


def test_stub_service_shape():
    settings = config.load_settings()
    settings.stub_models = True
    stub = build_service(settings)
    prepared = stub.prepare("ignored.wav")
    result = stub.score_prepared(prepared, "I think so")
    assert result is not None
    assert "words" in result and len(result["words"]) == 3
    assert result["stub"] is True
