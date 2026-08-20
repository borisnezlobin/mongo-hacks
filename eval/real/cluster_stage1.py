"""Cache the expensive half of pyannote 3.1 so clustering can be swept cheaply.

Segmentation and embedding cost about 1.2x realtime -- forty minutes for the
48-minute recording -- and neither depends on any clustering hyper-parameter.
Clustering itself is seconds. Running the whole pipeline once per candidate
threshold would make a sweep a day's work and is the reason nobody sweeps it;
caching stage one turns the same sweep into a couple of minutes, which is what
makes a plateau visible rather than a single fitted point.

  python eval/real/cluster_stage1.py dorm-9pm

Writes eval/real/<stem>.stage1.npz. Real-people audio, so it stays in the repo
and stays gitignored, like everything else derived from these recordings.
"""

import os
import sys
import time

import numpy as np
import soundfile as sf
import torch
from pyannote.audio import Pipeline

stem = sys.argv[1]
wav_path = f"fixtures/real/{stem}.wav"
out_path = f"eval/real/{stem}.stage1.npz"

pipeline = Pipeline.from_pretrained(
    "pyannote/speaker-diarization-3.1", token=os.environ["HF_TOKEN"]
)
print("default parameters:", pipeline.parameters(instantiated=True), flush=True)

wav, sr = sf.read(wav_path, dtype="float32")
file = {"waveform": torch.from_numpy(wav).unsqueeze(0), "sample_rate": sr, "uri": stem}

started = time.time()
segmentations = pipeline.get_segmentations(file)
print(f"segmentation {segmentations.data.shape} in {time.time() - started:.0f}s", flush=True)

# The 3.1 segmentation model is powerset, so apply() uses its output directly as
# the binarized version. Asserted rather than assumed: if a future model is not
# powerset, the cache would silently be of the wrong thing.
assert pipeline._segmentation.model.specifications.powerset, "expected a powerset segmentation model"
binarized = segmentations

count = pipeline.speaker_count(
    binarized, pipeline._segmentation.model.receptive_field, warm_up=(0.0, 0.0)
)

started = time.time()
embeddings = pipeline.get_embeddings(
    file, binarized, exclude_overlap=pipeline.embedding_exclude_overlap
)
print(f"embeddings {embeddings.shape} in {time.time() - started:.0f}s", flush=True)

np.savez_compressed(
    out_path,
    segmentations=segmentations.data,
    seg_start=np.float64(segmentations.sliding_window.start),
    seg_duration=np.float64(segmentations.sliding_window.duration),
    seg_step=np.float64(segmentations.sliding_window.step),
    count=count.data,
    count_start=np.float64(count.sliding_window.start),
    count_duration=np.float64(count.sliding_window.duration),
    count_step=np.float64(count.sliding_window.step),
    embeddings=embeddings,
    duration=np.float64(len(wav) / sr),
)
print(f"wrote {out_path}", flush=True)
