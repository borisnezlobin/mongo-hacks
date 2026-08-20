"""Does a segmentation model put a speaker boundary where one is known to be?

Answers one question about one place in one recording, so it can be pointed at
any model, any window length and any pair of intervals. For each analysis window
that fully covers the neighbourhood, it reads the RAW powerset posterior -- not
the argmax the pipeline keeps -- converts it to soft per-local-speaker activity,
and asks whether the inserted interval looks like a different local speaker from
the intervals either side of it.

  python eval/real/boundary_probe.py dorm-40min 19.4:20.8 20.86:21.52 22.0:24.1

Options through the environment, so the sweep is a shell loop:
  SEG_MODEL       checkpoint (default pyannote/segmentation-3.0)
  SEG_SUBFOLDER   subfolder inside the checkpoint (community-1 needs this)
  SEG_DURATION    analysis window in seconds (default: the model's own)
  SEG_STEP        hop in seconds (default 1.0)

"same" means the model spent the inserted interval on the same local speaker it
spent the outer intervals on, which no downstream threshold can undo.
"""

import os
import sys

import numpy as np
import soundfile as sf
import torch
from pyannote.audio import Inference, Model
from pyannote.audio.utils.powerset import Powerset

stem = sys.argv[1]
intervals = [tuple(float(x) for x in arg.split(":")) for arg in sys.argv[2:]]
before, inserted, after = intervals[0], intervals[1], intervals[2]

checkpoint = os.environ.get("SEG_MODEL", "pyannote/segmentation-3.0")
subfolder = os.environ.get("SEG_SUBFOLDER") or None
step = float(os.environ.get("SEG_STEP", 1.0))

kwargs = {"token": os.environ["HF_TOKEN"]}
if subfolder:
    kwargs["subfolder"] = subfolder
model = Model.from_pretrained(checkpoint, **kwargs)
spec = model.specifications
duration = float(os.environ.get("SEG_DURATION", spec.duration))

lo = max(0.0, before[0] - duration)
hi = after[1] + duration
info = sf.info(f"fixtures/real/{stem}.wav")
sr = info.samplerate
clip, sr = sf.read(
    f"fixtures/real/{stem}.wav",
    dtype="float32",
    start=int(lo * sr),
    stop=int(min(info.frames / sr, hi) * sr),
)

inference = Inference(
    model,
    duration=duration,
    step=step,
    skip_aggregation=True,
    skip_conversion=True,
    batch_size=8,
)
out = inference({"waveform": torch.from_numpy(clip).unsqueeze(0), "sample_rate": sr})
logits = out.data
window = out.sliding_window
starts = window.start + np.arange(logits.shape[0]) * window.step + lo
frame_s = window.duration / logits.shape[1]

powerset = Powerset(len(spec.classes), spec.powerset_max_classes)
soft = powerset.to_multilabel(torch.from_numpy(logits).float(), soft=True).numpy()

print(
    f"{checkpoint}{'/' + subfolder if subfolder else ''} "
    f"window={duration}s step={step}s local_speakers={len(spec.classes)} "
    f"max_simultaneous={spec.powerset_max_classes} frame={frame_s * 1000:.1f}ms"
)


def profile(activity: np.ndarray, start: float, span: tuple[float, float]) -> np.ndarray:
    lo_frame = int(round((span[0] - start) / frame_s))
    hi_frame = int(round((span[1] - start) / frame_s))
    return activity[max(lo_frame, 0) : hi_frame].mean(axis=0)


covering = [
    index
    for index, start in enumerate(starts)
    if start <= before[0] and start + duration >= after[1]
]
if not covering:
    print("no analysis window covers the whole neighbourhood at this window length")
    covering = [
        index
        for index, start in enumerate(starts)
        if start <= inserted[0] and start + duration >= inserted[1]
    ]

verdicts = []
for index in covering:
    start = starts[index]
    activity = soft[index]
    a, b, c = (profile(activity, start, span) for span in (before, inserted, after))
    outer = (a + c) / 2
    same = int(np.argmax(b)) == int(np.argmax(outer))
    verdicts.append(same)
    fmt = lambda v: "[" + " ".join(f"{x:.2f}" for x in v) + "]"
    print(
        f"  {start:6.2f}-{start + duration:6.2f}  before {fmt(a)}  inserted {fmt(b)}"
        f"  after {fmt(c)}  ->  {'same speaker' if same else 'DIFFERENT'}"
    )

print(
    f"{sum(1 for v in verdicts if not v)}/{len(verdicts)} covering windows separate "
    f"the inserted interval from its neighbours"
)
