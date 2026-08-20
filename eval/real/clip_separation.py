"""Is the boundary in the audio at all, whatever the segmentation model thinks?

The segmentation model can only be wrong about a boundary if the boundary is
audible. This asks the speaker-embedding model instead: embed the inserted
interval and the intervals either side of it, and compare their distances to
duration-matched controls cut out of a single speaker's own speech. If the
inserted clip is no further from its neighbours than one speaker's clips are
from each other, no change-point detector over these embeddings can find it
either, and the loss is in the room rather than in the model.

  python eval/real/clip_separation.py dorm-40min 19.4:20.8 20.86:21.52 22.0:24.1

SPK_MODEL selects the embedding checkpoint (default: pyannote's wespeaker).
"""

import os
import sys

import numpy as np
import soundfile as sf
import torch
from pyannote.audio.pipelines.speaker_verification import PretrainedSpeakerEmbedding

stem = sys.argv[1]
spans = [tuple(float(x) for x in arg.split(":")) for arg in sys.argv[2:]]
checkpoint = os.environ.get("SPK_MODEL", "pyannote/wespeaker-voxceleb-resnet34-LM")

embedder = PretrainedSpeakerEmbedding(checkpoint, token=os.environ["HF_TOKEN"])
info = sf.info(f"fixtures/real/{stem}.wav")
sr = info.samplerate


def clip(span: tuple[float, float]) -> np.ndarray:
    audio, _ = sf.read(
        f"fixtures/real/{stem}.wav",
        dtype="float32",
        start=int(span[0] * sr),
        stop=int(span[1] * sr),
    )
    return audio


def embed(span: tuple[float, float]) -> np.ndarray:
    audio = clip(span)
    waveform = torch.from_numpy(audio).unsqueeze(0).unsqueeze(0)
    vector = embedder(waveform)[0]
    return vector / np.linalg.norm(vector)


def cosine(a: np.ndarray, b: np.ndarray) -> float:
    return float(1 - np.dot(a, b))


named = [(f"{lo:.2f}-{hi:.2f}", (lo, hi)) for lo, hi in spans]
vectors = {label: embed(span) for label, span in named}
print(f"{checkpoint}")
print("pairwise cosine distance between the named intervals")
labels = list(vectors)
for i, a in enumerate(labels):
    for b in labels[i + 1 :]:
        print(f"  {a}  vs  {b}   {cosine(vectors[a], vectors[b]):.3f}")

# Controls: same-speaker clips of the same length, cut from the longest interval.
inserted_length = spans[1][1] - spans[1][0]
longest = max(spans, key=lambda span: span[1] - span[0])
pieces = []
at = longest[0]
while at + inserted_length <= longest[1]:
    pieces.append((at, at + inserted_length))
    at += inserted_length
if len(pieces) >= 2:
    control = [embed(piece) for piece in pieces]
    within = [
        cosine(control[i], control[j])
        for i in range(len(control))
        for j in range(i + 1, len(control))
    ]
    print(
        f"same-speaker control: {len(pieces)} clips of {inserted_length:.2f}s from "
        f"{longest[0]:.2f}-{longest[1]:.2f}, cosine "
        f"min {min(within):.3f} median {np.median(within):.3f} max {max(within):.3f}"
    )
