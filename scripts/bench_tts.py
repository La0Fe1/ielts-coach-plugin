import os, time, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
from daemon import config
from daemon.audio import processor
config.ensure_ascii_tempdir()
from kokoro import KPipeline

TEXT = "Nice answer. Now tell me, what do you like most about your hometown?"

def bench(device):
    t0 = time.time()
    p = KPipeline(lang_code="b", repo_id="hexgrad/Kokoro-82M", device=device)
    load = time.time() - t0
    # warm
    list(p("Hello.", voice="bf_emma", speed=1.0))
    times = []
    dur = 0.0
    for i in range(3):
        t = time.time()
        chunks = []
        for item in p(TEXT, voice="bf_emma", speed=1.0):
            a = item.audio
            if a is not None:
                chunks.append(a.detach().cpu().numpy().reshape(-1))
        times.append(round(time.time() - t, 2))
    import numpy as np
    audio = np.concatenate(chunks)
    dur = len(audio) / 24000
    print(device, "load", round(load,2), "s | synth times", times, "| audio", round(dur,2), "s | RTF", round(min(times)/dur, 2))
    return p

bench("cuda")
del _
bench("cpu")
