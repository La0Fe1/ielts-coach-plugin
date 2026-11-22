"""Configuration, path management and hardware self-check for the IELTS Coach daemon.

Everything the daemon needs to know about *where* it lives and *what* hardware it
runs on is derived here, so that Windows / macOS / Linux all share one code path.

Data root (override with the IELTS_COACH_HOME environment variable):
    ~/.ielts-coach/
        ielts_coach.db          SQLite long-term memory
        audio/user/             learner recordings (*.wav)
        audio/tts_cache/        Kokoro narration cache (*.wav + *.json)
        reports/                exported lesson reports (*.md)
        logs/                   daemon + bridge logs
        models/                 optional local model cache
"""

from __future__ import annotations

import os
import platform
import shutil
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

APP_NAME = "ielts-coach"
#: Keep in sync with pyproject.toml - tests/test_version.py enforces it.
VERSION = "1.5.1"

#: Sample rate mandated by the whole pipeline (browser recorder -> WAV -> models).
TARGET_SAMPLE_RATE = 16_000
#: Kokoro-82M always renders at 24 kHz.
TTS_SAMPLE_RATE = 24_000


def env_flag(name: str, default: bool = False) -> bool:
    """Read a boolean environment flag (1/true/yes/on)."""
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "y", "on"}


def env_int(name: str, default: int) -> int:
    try:
        return int(str(os.environ.get(name, "")).strip())
    except (TypeError, ValueError):
        return default


def env_float(name: str, default: float) -> float:
    try:
        return float(str(os.environ.get(name, "")).strip())
    except (TypeError, ValueError):
        return default


# --------------------------------------------------------------------------- #
# Filesystem layout
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class Paths:
    """All filesystem locations used by the daemon."""

    home: Path

    @property
    def db_path(self) -> Path:
        return self.home / "ielts_coach.db"

    @property
    def audio_dir(self) -> Path:
        return self.home / "audio"

    @property
    def user_audio_dir(self) -> Path:
        return self.audio_dir / "user"

    @property
    def tts_cache_dir(self) -> Path:
        return self.audio_dir / "tts_cache"

    @property
    def reports_dir(self) -> Path:
        return self.home / "reports"

    @property
    def logs_dir(self) -> Path:
        return self.home / "logs"

    @property
    def models_dir(self) -> Path:
        return self.home / "models"

    def all_dirs(self) -> list[Path]:
        return [
            self.home,
            self.audio_dir,
            self.user_audio_dir,
            self.tts_cache_dir,
            self.reports_dir,
            self.logs_dir,
            self.models_dir,
        ]

    def ensure(self) -> "Paths":
        for directory in self.all_dirs():
            directory.mkdir(parents=True, exist_ok=True)
        return self


def get_home() -> Path:
    raw = os.environ.get("IELTS_COACH_HOME", "").strip()
    if raw:
        return Path(os.path.expanduser(raw)).resolve()
    return (Path.home() / ".ielts-coach").resolve()


def get_paths() -> Paths:
    return Paths(home=get_home()).ensure()


# --------------------------------------------------------------------------- #
# Schema discovery
# --------------------------------------------------------------------------- #
def find_schema_file() -> Path | None:
    """Locate database/schema.sql no matter how the project was installed."""
    candidates: list[Path] = []
    override = os.environ.get("IELTS_COACH_SCHEMA", "").strip()
    if override:
        candidates.append(Path(override))
    here = Path(__file__).resolve()
    # daemon/config.py -> project root / database / schema.sql
    candidates.append(here.parent.parent / "database" / "schema.sql")
    candidates.append(here.parent / "database" / "schema.sql")
    candidates.append(get_home() / "schema.sql")
    candidates.append(Path.cwd() / "database" / "schema.sql")
    for candidate in candidates:
        try:
            if candidate.is_file():
                return candidate
        except OSError:
            continue
    return None


# --------------------------------------------------------------------------- #
# System tool discovery
# --------------------------------------------------------------------------- #
def ensure_ascii_tempdir() -> str | None:
    """Point TEMP/TMP at an ASCII path when the user profile is not ASCII.

    PyTorch (>=2.6) tries to create a CUDA kernel cache under %TEMP%/torch/kernels
    and, when that fails on a non-ASCII profile, emits a warning whose text is a
    GBK-encoded Windows path. pybind11 then decodes that std::string as UTF-8 and
    raises UnicodeDecodeError inside an unrelated tensor op. Redirecting TEMP to a
    plain ASCII directory removes the whole failure mode (and other native-library
    encoding landmines on Chinese Windows).
    """
    import tempfile

    override = os.environ.get("IELTS_COACH_TMP", "").strip()
    current = os.environ.get("TEMP") or os.environ.get("TMP") or tempfile.gettempdir()
    try:
        if current and str(current).isascii():
            os.environ.setdefault("TEMP", str(current))
            os.environ.setdefault("TMP", str(current))
            return str(current)
    except OSError:
        pass

    candidates: list[Path] = []
    if override:
        candidates.append(Path(override))
    programdata = os.environ.get("PROGRAMDATA", "").strip()
    if programdata:
        candidates.append(Path(programdata) / "ielts-coach" / "tmp")
    candidates.append(Path(os.environ.get("SystemDrive", "C:") + "\\ielts-coach-tmp"))
    candidates.append(Path(tempfile.gettempdir()) / "ielts-coach")

    for candidate in candidates:
        try:
            if not str(candidate).isascii():
                continue
            candidate.mkdir(parents=True, exist_ok=True)
            probe = candidate / ".write-probe"
            probe.write_bytes(b"ok")
            probe.unlink()
        except OSError:
            continue
        os.environ["TEMP"] = str(candidate)
        os.environ["TMP"] = str(candidate)
        tempfile.tempdir = str(candidate)
        return str(candidate)
    return None


def ascii_asset_dir() -> Path | None:
    """A guaranteed-ASCII directory for native libraries that cannot open unicode paths."""
    root = ensure_ascii_tempdir()
    if not root:
        return None
    target = Path(root) / "ielts-coach-assets"
    try:
        target.mkdir(parents=True, exist_ok=True)
    except OSError:
        return None
    return target


def ascii_safe_path(source: Path | str) -> Path:
    """Return an ASCII-path copy of *source* when the original path is not ASCII.

    torch.jit.load() opens files through C++ std::ifstream, which on Windows uses
    the ANSI code page: any non-ASCII character in the path makes it fail with
    "No such file or directory". Silero VAD ships a .jit checkpoint, so we stage a
    copy under the ASCII asset directory first.
    """
    source = Path(source)
    try:
        if str(source).isascii():
            return source
    except OSError:
        return source
    asset_dir = ascii_asset_dir()
    if asset_dir is None:
        return source
    destination = asset_dir / source.name
    try:
        if not destination.exists() or destination.stat().st_size != source.stat().st_size:
            shutil.copy2(source, destination)
        return destination
    except OSError:
        return source


def find_espeak_library() -> tuple[str, str] | None:
    """Locate a usable espeak-ng shared library plus its data directory.

    A bundled copy ships with the espeakng_loader wheel (a dependency of g2p_en), so
    the portable build scores pronunciation on machines with no espeak-ng installed.
    """
    override = os.environ.get("PHONEMIZER_ESPEAK_LIBRARY", "").strip()
    if override and Path(override).exists():
        return override, os.environ.get("ESPEAK_DATA_PATH", "")
    try:
        import espeakng_loader

        library = str(espeakng_loader.get_library_path())
        data = str(espeakng_loader.get_data_path())
        if Path(library).exists():
            return library, data
    except Exception:  # noqa: BLE001 - optional dependency
        pass
    executable = find_espeak_ng()
    if executable:
        for name in ("libespeak-ng.dll", "espeak-ng.dll", "libespeak-ng.so", "libespeak-ng.dylib"):
            candidate = Path(executable).with_name(name)
            if candidate.exists():
                return str(candidate), str(Path(executable).parent)
    return None


def find_espeak_ng() -> str | None:
    """Return the espeak-ng executable path if installed, else None."""
    override = os.environ.get("ESPEAK_NG_PATH", "").strip()
    if override and Path(override).exists():
        return override
    for name in ("espeak-ng", "espeak-ng.exe"):
        found = shutil.which(name)
        if found:
            return found
    candidates = [
        Path(r"C:\Program Files\eSpeak NG\espeak-ng.exe"),
        Path(r"C:\Program Files (x86)\eSpeak NG\espeak-ng.exe"),
        Path("/usr/bin/espeak-ng"),
        Path("/usr/local/bin/espeak-ng"),
        Path("/opt/homebrew/bin/espeak-ng"),
    ]
    try:  # portable builds ship the DLL only; there is no .exe to find
        import espeakng_loader

        bundled = Path(espeakng_loader.get_data_path())
        for name in ("espeak-ng.exe", "espeak-ng"):
            candidate = bundled.parent / name
            if candidate.is_file():
                return str(candidate)
    except Exception:  # noqa: BLE001
        pass
    for candidate in candidates:
        try:
            if candidate.is_file():
                return str(candidate)
        except OSError:
            continue
    return None


def espeak_install_hint() -> str:
    system = platform.system()
    if system == "Windows":
        return (
            "espeak-ng 未安装。请任选其一：\n"
            "  1) winget install --id eSpeak-NG.eSpeak-NG -e\n"
            "  2) 下载官方安装包 https://github.com/espeak-ng/espeak-ng/releases 并安装，"
            "把 C:/Program Files/eSpeak NG 加入 PATH"
        )
    if system == "Darwin":
        return "espeak-ng 未安装：brew install espeak-ng"
    return "espeak-ng 未安装：sudo apt install espeak-ng  (或 dnf/pacman 对应包名)"


# --------------------------------------------------------------------------- #
# Hardware detection
# --------------------------------------------------------------------------- #
@dataclass
class HardwareInfo:
    device: str = "cpu"  # cuda | mps | cpu
    device_name: str = "CPU"
    torch_version: str | None = None
    cuda_version: str | None = None
    vram_mb: int | None = None
    cpu_count: int = 1
    ram_gb: float | None = None
    platform: str = ""
    python: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {
            "device": self.device,
            "device_name": self.device_name,
            "torch_version": self.torch_version,
            "cuda_version": self.cuda_version,
            "vram_mb": self.vram_mb,
            "cpu_count": self.cpu_count,
            "ram_gb": self.ram_gb,
            "platform": self.platform,
            "python": self.python,
        }


def _ram_gb() -> float | None:
    try:  # optional dependency, never required
        import psutil  # type: ignore

        return round(psutil.virtual_memory().total / (1024**3), 1)
    except Exception:
        pass
    try:
        if platform.system() == "Windows":
            import ctypes

            class _MEMORYSTATUSEX(ctypes.Structure):
                _fields_ = [
                    ("dwLength", ctypes.c_ulong),
                    ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong),
                    ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong),
                    ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong),
                    ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
                ]

            stat = _MEMORYSTATUSEX()
            stat.dwLength = ctypes.sizeof(_MEMORYSTATUSEX)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat)):  # type: ignore[attr-defined]
                return round(stat.ullTotalPhys / (1024**3), 1)
        else:
            page = os.sysconf("SC_PAGE_SIZE")  # type: ignore[attr-defined]
            pages = os.sysconf("SC_PHYS_PAGES")  # type: ignore[attr-defined]
            return round(page * pages / (1024**3), 1)
    except Exception:
        return None
    return None


_HW_CACHE: HardwareInfo | None = None


def detect_hardware(force: bool = False) -> HardwareInfo:
    """Detect the best available accelerator: cuda > mps > cpu."""
    global _HW_CACHE
    if _HW_CACHE is not None and not force:
        return _HW_CACHE

    info = HardwareInfo(
        cpu_count=os.cpu_count() or 1,
        ram_gb=_ram_gb(),
        platform=f"{platform.system()} {platform.release()} ({platform.machine()})",
        python=platform.python_version(),
    )
    try:
        import torch  # noqa: WPS433 (optional at import time)

        info.torch_version = torch.__version__
        info.cuda_version = torch.version.cuda
        if torch.cuda.is_available():
            info.device = "cuda"
            try:
                info.device_name = torch.cuda.get_device_name(0)
                props = torch.cuda.get_device_properties(0)
                info.vram_mb = int(props.total_memory / (1024 * 1024))
            except Exception:
                info.device_name = "CUDA GPU"
        elif getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            info.device = "mps"
            info.device_name = "Apple Silicon (MPS)"
        else:
            info.device = "cpu"
            info.device_name = platform.processor() or "CPU"
    except Exception:
        info.device = "cpu"
        info.device_name = platform.processor() or "CPU"
    _HW_CACHE = info
    return info


# --------------------------------------------------------------------------- #
# Settings
# --------------------------------------------------------------------------- #
@dataclass
class Settings:
    """Runtime configuration for the daemon."""

    host: str = "127.0.0.1"
    port: int = 8765
    paths: Paths = field(default_factory=get_paths)
    device: str = "cpu"
    device_name: str = "CPU"
    #: ASR model. CUDA desktops get the accurate turbo checkpoint, CPU/MPS get a
    #: smaller English model so that latency stays usable.
    asr_model: str = "large-v3-turbo"
    asr_compute_type: str = "float16"
    asr_beam_size: int = 5
    #: "auto" lets Whisper detect the spoken language (Chinese commands work),
    #: "en" forces English for maximum accuracy on answers.
    asr_language: str = "auto"
    #: Kokoro voices per accent (offline engine).
    tts_voices: dict[str, str] = field(
        default_factory=lambda: {"uk": "bf_emma", "us": "af_heart"}
    )
    #: edge-tts neural voices (network engine, far less robotic). "zh" is used for
    #: Chinese explanation runs, which is what makes the coaching bilingual.
    tts_edge_voices: dict[str, str] = field(
        default_factory=lambda: {
            "uk": "en-GB-SoniaNeural",
            "us": "en-US-AriaNeural",
            "zh": "zh-CN-XiaoxiaoNeural",
        }
    )
    tts_edge_rate: str = "-4%"
    tts_edge_pitch: str = "+0Hz"
    #: auto = edge when reachable, else kokoro; or force one engine.
    tts_engine: str = "auto"
    tts_speed: float = 1.0
    tts_enabled: bool = True
    #: Long-poll ceiling for one MCP wait call (MCP clients usually time out at 60s).
    max_wait_sec: int = 40
    #: Silences longer than this are counted as hesitations.
    pause_threshold_sec: float = 0.8
    #: Trailing/first silence trimmed before measuring speech duration.
    silence_rms_threshold: float = 0.01
    #: Use deterministic stub models (tests / CI, no 3 GB download).
    stub_models: bool = False
    prewarm: bool = True
    log_level: str = "INFO"

    # -- Phase 2: acoustic pronunciation (GOP) ------------------------------
    pronounce_enabled: bool = True
    pronounce_model: str = "facebook/wav2vec2-xlsr-53-espeak-cv-ft"
    pronounce_device: str = ""  # empty -> same as the main device
    #: GOP -> 0..100 calibration: score = 100 * sigmoid(k * (gop - center)).
    gop_slope: float = 0.9
    gop_center: float = -2.6
    #: Word score thresholds (green / amber / red).
    score_green: int = 80
    score_amber: int = 60
    #: A competing phoneme this many nats above the target counts as a substitution.
    substitution_margin: float = 1.5

    # -- Silero VAD (hands-free auto segmentation) --------------------------
    vad_enabled: bool = True
    vad_threshold: float = 0.5
    #: Trailing silence that closes an utterance in free-talk mode.
    vad_silence_sec: float = 2.6
    vad_min_speech_sec: float = 0.25
    vad_max_utterance_sec: float = 150.0
    #: Stop waiting for a first word after this long.
    vad_no_speech_timeout_sec: float = 20.0
    #: Mid-answer silence that flags "the learner seems stuck" (UI nudge).
    vad_stuck_sec: float = 2.0

    @property
    def accent_default(self) -> str:
        return "uk"

    def as_dict(self) -> dict[str, Any]:
        return {
            "app": APP_NAME,
            "version": VERSION,
            "host": self.host,
            "port": self.port,
            "home": str(self.paths.home),
            "db_path": str(self.paths.db_path),
            "device": self.device,
            "device_name": self.device_name,
            "asr_model": self.asr_model,
            "asr_compute_type": self.asr_compute_type,
            "tts_voices": dict(self.tts_voices),
            "tts_engine": self.tts_engine,
            "tts_edge_voices": dict(self.tts_edge_voices),
            "stub_models": self.stub_models,
            "max_wait_sec": self.max_wait_sec,
            "pronounce": {
                "enabled": self.pronounce_enabled,
                "model": self.pronounce_model,
                "device": self.pronounce_device or self.device,
            },
            "vad": {
                "enabled": self.vad_enabled,
                "threshold": self.vad_threshold,
                "silence_sec": self.vad_silence_sec,
            },
        }


def _asr_defaults(device: str) -> tuple[str, str]:
    if device == "cuda":
        return "large-v3-turbo", "float16"
    if device == "mps":
        return "medium.en", "float32"
    return "medium.en", "int8"


def apply_bundled_models() -> str | None:
    """Point HuggingFace at the models shipped inside the portable build.

    The portable package carries its models, so a fresh machine must never reach the
    network: offline flags plus a local HF_HOME make every load a cache hit.
    """
    bundled = os.environ.get("IELTS_COACH_MODELS", "").strip()
    if not bundled:
        return None
    root = Path(bundled).expanduser()
    if not root.is_dir():
        return None
    hf_home = root / "hf"
    if hf_home.is_dir():
        # HF_HUB_CACHE points straight at the directory holding models--*; HF_HOME
        # would instead expect a "hub/" child and silently miss the bundled models
        # (the portable build then fell back to downloading and failed offline).
        os.environ.setdefault("HF_HUB_CACHE", str(hf_home))
        os.environ.setdefault("HF_HOME", str(hf_home))
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
        os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
    return str(root)


def bundled_asr_model(root: Path) -> str | None:
    """Name of the faster-whisper checkpoint shipped in the package, if any."""
    hf = root / "hf"
    for pattern in ("models--Systran--faster-whisper-*", "models--*faster*distil*"):
        for candidate in sorted(hf.glob(pattern)):
            name = candidate.name
            if "faster-whisper-" in name:
                return name.split("faster-whisper-", 1)[1]
            if "faster-distil-whisper-" in name:
                return "distil-large-v3"
    return None


def bundled_pronounce_model() -> str | None:
    """The int8 GOP checkpoint inside the package, when present."""
    bundled = os.environ.get("IELTS_COACH_MODELS", "").strip()
    if not bundled:
        return None
    candidate = Path(bundled).expanduser() / "gop-int8"
    return str(candidate) if (candidate / "config.json").is_file() else None


def load_settings() -> Settings:
    """Build Settings from the environment and detected hardware."""
    hardware = detect_hardware()
    device = os.environ.get("IELTS_COACH_DEVICE", "").strip().lower() or hardware.device
    asr_model, compute_type = _asr_defaults(device)
    paths = get_paths()
    bundled = apply_bundled_models()
    if bundled:
        # One ASR checkpoint travels with the package; prefer it over the GPU default
        # that would otherwise be downloaded. The CPU wheel cannot run fp16.
        asr_model = bundled_asr_model(Path(bundled)) or "small.en"
        compute_type = "int8" if device != "cuda" else "float16"

    return Settings(
        host=os.environ.get("IELTS_COACH_HOST", "127.0.0.1").strip() or "127.0.0.1",
        port=env_int("IELTS_COACH_PORT", 8765),
        paths=paths,
        device=device,
        device_name=hardware.device_name,
        asr_model=os.environ.get("IELTS_COACH_ASR_MODEL", "").strip() or asr_model,
        asr_compute_type=os.environ.get("IELTS_COACH_ASR_COMPUTE", "").strip() or compute_type,
        asr_language=os.environ.get("IELTS_COACH_ASR_LANGUAGE", "").strip() or "auto",
        asr_beam_size=env_int("IELTS_COACH_ASR_BEAM", 5),
        tts_voices={
            "uk": os.environ.get("IELTS_COACH_VOICE_UK", "bf_emma").strip() or "bf_emma",
            "us": os.environ.get("IELTS_COACH_VOICE_US", "af_heart").strip() or "af_heart",
        },
        tts_edge_voices={
            "uk": os.environ.get("IELTS_COACH_VOICE_EDGE_UK", "en-GB-SoniaNeural").strip()
            or "en-GB-SoniaNeural",
            "us": os.environ.get("IELTS_COACH_VOICE_EDGE_US", "en-US-AriaNeural").strip()
            or "en-US-AriaNeural",
            "zh": os.environ.get("IELTS_COACH_VOICE_EDGE_ZH", "zh-CN-XiaoxiaoNeural").strip()
            or "zh-CN-XiaoxiaoNeural",
        },
        tts_edge_rate=os.environ.get("IELTS_COACH_TTS_RATE", "-4%").strip() or "-4%",
        tts_edge_pitch=os.environ.get("IELTS_COACH_TTS_PITCH", "+0Hz").strip() or "+0Hz",
        tts_engine=os.environ.get("IELTS_COACH_TTS_ENGINE", "auto").strip() or "auto",
        tts_speed=env_float("IELTS_COACH_TTS_SPEED", 1.0),
        tts_enabled=not env_flag("IELTS_COACH_TTS_DISABLED"),
        max_wait_sec=env_int("IELTS_COACH_MAX_WAIT", 40),
        pause_threshold_sec=env_float("IELTS_COACH_PAUSE_THRESHOLD", 0.8),
        silence_rms_threshold=env_float("IELTS_COACH_SILENCE_RMS", 0.01),
        stub_models=env_flag("IELTS_COACH_STUB_MODELS"),
        prewarm=not env_flag("IELTS_COACH_NO_PREWARM"),
        log_level=os.environ.get("IELTS_COACH_LOG_LEVEL", "INFO").strip() or "INFO",
        pronounce_enabled=not env_flag("IELTS_COACH_PRON_DISABLED"),
        pronounce_model=os.environ.get("IELTS_COACH_PRON_MODEL", "").strip()
        or bundled_pronounce_model()
        or "facebook/wav2vec2-xlsr-53-espeak-cv-ft",
        pronounce_device=os.environ.get("IELTS_COACH_PRON_DEVICE", "").strip(),
        gop_slope=env_float("IELTS_COACH_GOP_SLOPE", 0.9),
        gop_center=env_float("IELTS_COACH_GOP_CENTER", -2.6),
        score_green=env_int("IELTS_COACH_SCORE_GREEN", 80),
        score_amber=env_int("IELTS_COACH_SCORE_AMBER", 60),
        substitution_margin=env_float("IELTS_COACH_SUB_MARGIN", 1.5),
        vad_enabled=not env_flag("IELTS_COACH_VAD_DISABLED"),
        vad_threshold=env_float("IELTS_COACH_VAD_THRESHOLD", 0.5),
        vad_silence_sec=env_float("IELTS_COACH_VAD_SILENCE", 2.6),
        vad_min_speech_sec=env_float("IELTS_COACH_VAD_MIN_SPEECH", 0.25),
        vad_max_utterance_sec=env_float("IELTS_COACH_VAD_MAX_UTTERANCE", 150.0),
        vad_no_speech_timeout_sec=env_float("IELTS_COACH_VAD_NO_SPEECH", 20.0),
        vad_stuck_sec=env_float("IELTS_COACH_VAD_STUCK", 2.0),
    )


def environment_report() -> dict[str, Any]:
    """Human-readable self-check used by ielts-daemon --doctor and /health."""
    hardware = detect_hardware()
    espeak = find_espeak_ng()
    settings = load_settings()
    node = shutil.which("node")
    uv = shutil.which("uv")
    schema = find_schema_file()
    return {
        "hardware": hardware.as_dict(),
        "paths": {"home": str(settings.paths.home), "db": str(settings.paths.db_path)},
        "schema_file": str(schema) if schema else None,
        "tools": {
            "espeak_ng": espeak,
            "espeak_ng_ok": bool(espeak),
            "espeak_ng_hint": None if espeak else espeak_install_hint(),
            "node": node,
            "uv": uv,
            "ffmpeg": shutil.which("ffmpeg"),
            "python": sys.executable,
            "python_version": platform.python_version(),
        },
        "settings": settings.as_dict(),
        "python_packages": _package_versions(),
    }


def _package_versions() -> dict[str, str | None]:
    import importlib.util

    out: dict[str, str | None] = {}
    for name in (
        "torch",
        "torchaudio",
        "faster_whisper",
        "kokoro",
        "soundfile",
        "fastapi",
        "mcp",
        "numpy",
    ):
        try:
            if importlib.util.find_spec(name) is None:
                out[name] = None
                continue
            module = __import__(name)
            out[name] = getattr(module, "__version__", "installed")
        except Exception as exc:  # pragma: no cover - broken installs
            out[name] = f"error: {exc}"
    return out
