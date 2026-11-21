"""Audio pipeline: WAV I/O, ASR, TTS, VAD and (Phase 2) pronunciation scoring.

MODEL_IMPORT_LOCK serialises the first import of heavy ML libraries across the
daemon's warm-up threads. transformers 5.x resolves model classes lazily through
module-level __getattr__, which is not safe when two threads (Kokoro's
from-transformers-import-AlbertModel and Wav2Vec2's phoneme tokenizer) trigger it
at the same time - that race surfaces as "cannot import name 'AlbertModel'".
"""

from __future__ import annotations

import threading

MODEL_IMPORT_LOCK = threading.RLock()
