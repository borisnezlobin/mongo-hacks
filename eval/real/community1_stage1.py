"""Cache community-1's segmentation and embeddings so clustering can be swept.

Everything before clustering is deterministic given the audio and costs minutes
per recording; clustering costs seconds. Caching the boundary makes a VBx
parameter sweep affordable, the same way cluster_stage1.py does for 3.1.

  python eval/real/community1_stage1.py <stem>

Writes eval/real/<stem>.community1.stage1.npz
"""

import os
import sys
import time

import numpy as np
import soundfile as sf
import torch
from pyannote.audio import Pipeline

stem = sys.argv[1]
device = sys.argv[2] if len(sys.argv) > 2 else "mps"

pipeline = Pipeline.from_pretrained(
    "pyannote/speaker-diarization-community-1", token=os.environ["HF_TOKEN"]
)
if device != "cpu":
    pipeline.to(torch.device(device))

audio, sample_rate = sf.read(f"fixtures/real/{stem}.wav", dtype="float32")
if audio.ndim > 1:
    audio = audio.mean(axis=1)

captured: dict[str, object] = {}


def capture(step, artifact, **_):
    if step in ("segmentation", "embeddings"):
        captured[step] = artifact


started = time.time()
pipeline({"waveform": torch.from_numpy(audio).unsqueeze(0), "sample_rate": sample_rate},
         hook=capture)
elapsed = time.time() - started

segmentations = captured["segmentation"]
embeddings = captured["embeddings"]
window = segmentations.sliding_window

np.savez(
    f"eval/real/{stem}.community1.stage1.npz",
    segmentations=segmentations.data.astype(np.float32),
    embeddings=np.asarray(embeddings, dtype=np.float32),
    window=np.array([window.start, window.duration, window.step], dtype=np.float64),
    duration=np.array([len(audio) / sample_rate], dtype=np.float64),
)
print(
    f"{stem}: segmentations {segmentations.data.shape}, embeddings {np.asarray(embeddings).shape}, "
    f"{elapsed:.0f}s"
)
