"""Dump the raw powerset posterior of the segmentation model over a time range.

The cached stage1.npz holds only the ARGMAX of this posterior (verified: it has
exactly two distinct values, 0 and 1), because Inference converts powerset ->
multilabel with a hard one-hot before aggregation. So any question of the form
"did the model see a boundary the binarizer threw away" cannot be answered from
the cache; it needs the model re-run, which is cheap over a few seconds of audio.

  python eval/real/seg_posterior.py dorm-40min 10 40 [model]

Writes eval/real/<stem>.posterior-<t0>-<t1>.npz and prints a frame-level view.
"""

import os
import sys

import numpy as np
import soundfile as sf
import torch
from pyannote.audio import Inference, Model

stem = sys.argv[1]
t0 = float(sys.argv[2])
t1 = float(sys.argv[3])
checkpoint = sys.argv[4] if len(sys.argv) > 4 else "pyannote/segmentation-3.0"
subfolder = sys.argv[5] if len(sys.argv) > 5 else None

spec_kwargs = {"token": os.environ["HF_TOKEN"]}
if subfolder:
    spec_kwargs["subfolder"] = subfolder
model = Model.from_pretrained(checkpoint, **spec_kwargs)
spec = model.specifications
print(
    f"{checkpoint} {subfolder or ''}: duration={spec.duration}s "
    f"local_speakers={len(spec.classes)} max_simultaneous={spec.powerset_max_classes} "
    f"powerset_classes={spec.num_powerset_classes}"
)

pad = spec.duration
info = sf.info(f"fixtures/real/{stem}.wav")
sr = info.samplerate
lo = max(0.0, t0 - pad)
hi = min(info.frames / sr, t1 + pad)
clip, sr = sf.read(
    f"fixtures/real/{stem}.wav",
    dtype="float32",
    start=int(lo * sr),
    stop=int(hi * sr),
)

inference = Inference(
    model,
    duration=spec.duration,
    step=float(os.environ.get("SEG_STEP", 1.0)),
    skip_aggregation=True,
    skip_conversion=True,
    batch_size=8,
)
out = inference({"waveform": torch.from_numpy(clip).unsqueeze(0), "sample_rate": sr})
logits = out.data  # (windows, frames, powerset_classes), log-probabilities
window = out.sliding_window
starts = window.start + np.arange(logits.shape[0]) * window.step + lo
frame_step = out.sliding_window.duration / logits.shape[1]

np.savez_compressed(
    f"eval/real/{stem}.posterior-{int(t0)}-{int(t1)}.npz",
    logits=logits.astype("float32"),
    starts=starts,
    frame_step=np.float64(frame_step),
    win_duration=np.float64(out.sliding_window.duration),
    num_classes=np.int32(len(spec.classes)),
    max_set_size=np.int32(spec.powerset_max_classes),
)
print("windows", logits.shape, "frame_step", frame_step)
