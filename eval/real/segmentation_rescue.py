"""Can any cheap change to the audio make segmentation hear the second speaker?

On mentra-mtg the segmentation model puts about nine of every ten seconds into
one local speaker slot, including at moments the transcript proves are two
people. Clustering runs after that and cannot undo it. So before concluding the
recording is unusable, try the obvious things to the audio and count slots
again: level, bandwidth, and the two stereo channels on their own rather than
averaged into mono.

The excerpts are the question-and-answer moments from dialogue_probe.py, where
two speakers are certain from the words alone.

  python eval/real/segmentation_rescue.py <stem> <at_seconds> [...]
"""

import os
import sys
import warnings

warnings.filterwarnings("ignore")

import numpy as np
import soundfile as sf
import torch
from pyannote.audio import Model
from pyannote.audio.core.inference import Inference
from scipy.signal import butter, sosfilt

SAMPLE_RATE = 16000
WINDOW = 30.0

stem = sys.argv[1]
moments = [float(x) for x in sys.argv[2:]] or [1143.0, 1244.8, 1171.4, 1034.3]

model = Model.from_pretrained("pyannote/segmentation-3.0", token=os.environ["HF_TOKEN"])
inference = Inference(model, duration=10.0, step=1.0)

mono, sample_rate = sf.read(f"fixtures/real/{stem}.wav", dtype="float32")
if mono.ndim > 1:
    mono = mono.mean(axis=1)
try:
    stereo, _ = sf.read(f"fixtures/real/{stem}.stereo.wav", dtype="float32")
except Exception:
    stereo = None


def variants(at: float) -> dict[str, np.ndarray]:
    lo, hi = int((at - WINDOW / 2) * SAMPLE_RATE), int((at + WINDOW / 2) * SAMPLE_RATE)
    clip = mono[lo:hi]
    peak = np.max(np.abs(clip)) + 1e-9
    out = {
        "mono as shipped": clip,
        "normalised to peak": clip / peak * 0.95,
        "gain +12 dB": np.clip(clip * 4.0, -1.0, 1.0),
        "high-pass 80 Hz": sosfilt(butter(4, 80, "hp", fs=SAMPLE_RATE, output="sos"), clip),
    }
    if stereo is not None and stereo.ndim > 1:
        out["stereo left"] = stereo[lo:hi, 0]
        out["stereo right"] = stereo[lo:hi, 1]
        out["stereo difference"] = (stereo[lo:hi, 0] - stereo[lo:hi, 1])
    # The segmentation model starts with an InstanceNorm over the waveform, so
    # the level variants are expected to be no-ops; they are kept to show that
    # rather than to leave it assumed.
    return {name: np.ascontiguousarray(clip, dtype=np.float32) for name, clip in out.items()}


def active_slots(clip: np.ndarray) -> tuple[float, np.ndarray]:
    scores = inference({"waveform": torch.from_numpy(np.ascontiguousarray(clip)).unsqueeze(0),
                        "sample_rate": SAMPLE_RATE})
    data = scores.data  # (chunks, frames, local speakers) for powerset output
    frame_seconds = 10.0 / data.shape[1]
    slot_seconds = data.sum(axis=1) * frame_seconds
    active = (slot_seconds > 0.1).sum(axis=1)
    voiced = active > 0
    share_single = float((active[voiced] == 1).mean()) if voiced.any() else 0.0
    return share_single, slot_seconds.mean(axis=0)


print(f"{stem}: local speaker slots in {WINDOW:.0f}s around each two-person moment")
for at in moments:
    print(f"\n  at {at:.1f}s")
    for name, clip in variants(at).items():
        share, mean_slots = active_slots(clip)
        print(f"    {name:22} {100 * share:3.0f}% of chunks find one speaker   "
              f"mean slot seconds {np.round(mean_slots, 2)}")
