"""Is a reference label one voice, or several wearing one name?

The owner falsified an identification that rested on the spans dorm-40min
labels `tarun`. Those labels came from a retired clustering pipeline, and two of
his own landmarks contradict them: the line he identified as Dhruv is labelled
tarun, and the one he identified as Clara is labelled boris. A label that mixes
two people produces a centroid that matches BOTH of them, which is exactly how a
false link at 0.8 can happen without the embedder failing at all.

This splits each label's own spans in two by k-means and reports how far apart
the halves land. A label holding one voice splits into two halves that still
look like each other; a label holding two people splits into two people.

  python eval/real/label_coherence.py dorm-40min dorm-9pm

Reads gitignored fixtures. Reports numbers, not verdicts.
"""

import json
import os
import sys

import numpy as np
import soundfile as sf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from embedders import load  # noqa: E402

CHECKPOINT = os.environ.get("SPK_MODEL", "speechbrain/spkrec-ecapa-voxceleb")
MIN_SPAN_S = 2.0
embedder = load(CHECKPOINT)


def embed(clip):
    out = np.asarray(embedder(clip.reshape(1, -1)), dtype="float64")[0]
    return out / np.linalg.norm(out)


def two_means(vectors, rounds=60):
    rng = np.random.default_rng(0)
    best = None
    for _ in range(8):
        centres = vectors[rng.choice(len(vectors), 2, replace=False)]
        assignment = np.zeros(len(vectors), dtype=int)
        for _ in range(rounds):
            assignment = np.argmax(vectors @ centres.T, axis=1)
            for k in (0, 1):
                if (assignment == k).any():
                    centre = vectors[assignment == k].mean(axis=0)
                    centres[k] = centre / np.linalg.norm(centre)
        if not (assignment == 0).any() or not (assignment == 1).any():
            continue
        spread = float(centres[0] @ centres[1])
        if best is None or spread < best[0]:
            best = (spread, assignment.copy())
    return best


for stem in sys.argv[1:] or ["dorm-40min"]:
    spans = json.load(open(f"eval/real/{stem}.reference.json"))["spans"]
    audio, sr = sf.read(f"fixtures/real/{stem}.wav", dtype="float32")
    labels = sorted({s["speaker"].lower() for s in spans})
    print(f"\n{stem}: k=2 split of each label's own spans (>= {MIN_SPAN_S}s, no overlap removal)")
    for label in labels:
        mine = [
            s for s in spans
            if s["speaker"].lower() == label and (s["end_ms"] - s["start_ms"]) / 1000 >= MIN_SPAN_S
        ]
        if len(mine) < 8:
            print(f"  {label:8s} only {len(mine)} spans this long — not enough to split")
            continue
        vectors = np.array([
            embed(audio[int(s["start_ms"] / 1000 * sr) : int(min(s["end_ms"] / 1000, s["start_ms"] / 1000 + 20) * sr)])
            for s in mine
        ])
        result = two_means(vectors)
        if result is None:
            continue
        spread, assignment = result
        sizes = [int((assignment == k).sum()) for k in (0, 1)]
        seconds = [
            sum((mine[i]["end_ms"] - mine[i]["start_ms"]) / 1000 for i in range(len(mine)) if assignment[i] == k)
            for k in (0, 1)
        ]
        print(
            f"  {label:8s} {len(mine):3d} spans -> halves of {sizes[0]}/{sizes[1]} "
            f"({seconds[0]:.0f}s / {seconds[1]:.0f}s), centroid cosine between halves {spread:.3f}"
        )
