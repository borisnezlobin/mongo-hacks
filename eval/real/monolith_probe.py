"""Is the dominant label one voice, or several the clustering cannot separate?

On mentra-mtg every VBx configuration - 3 clusters or 14, any threshold, any
Fa/Fb - leaves one label holding 68% of the speech. Extra clusters are always
carved off the small labels. That pattern says the answer is not in the
clustering parameters, so this asks the stage before it: are the embeddings that
land in the dominant label separable at all?

The measure is a forced 2-means split of the label's own embeddings, reported as
the between-centroid cosine gap. An absolute gap means nothing, so every label
is split the same way and dorm-9pm, where the reference says the labels really
do hold different people, is the control.

  python eval/real/monolith_probe.py <stem> [threshold Fa Fb]
"""

import os
import sys
import warnings

warnings.filterwarnings("ignore")

import numpy as np
from pyannote.audio import Pipeline

from community1_sweep import load_stage1

stem = sys.argv[1]
threshold, fa, fb = (float(x) for x in (sys.argv[2:5] or ["0.50", "0.07", "0.40"]))

pipeline = Pipeline.from_pretrained(
    "pyannote/speaker-diarization-community-1", token=os.environ["HF_TOKEN"]
)
segmentations, embeddings, duration = load_stage1(stem)

pipeline.clustering.threshold, pipeline.clustering.Fa, pipeline.clustering.Fb = threshold, fa, fb
hard_clusters, _, centroids = pipeline.clustering(
    embeddings=embeddings, segmentations=segmentations,
    num_clusters=None, min_clusters=1, max_clusters=20,
)

active = np.sum(segmentations.data, axis=1) > 0
flat_embeddings = embeddings.reshape(-1, embeddings.shape[-1])
flat_clusters = hard_clusters.reshape(-1)
flat_active = active.reshape(-1)
finite = np.isfinite(flat_embeddings).all(axis=1)
usable = flat_active & finite


def split_gap(vectors: np.ndarray) -> tuple[float, tuple[int, int]]:
    """Forced 2-means; the between-centroid cosine gap and the two side sizes."""
    normed = vectors / np.linalg.norm(vectors, axis=1, keepdims=True)
    best = (0.0, (len(normed), 0))
    for seed in range(8):
        rng = np.random.default_rng(seed)
        centres = normed[rng.choice(len(normed), 2, replace=False)]
        assignment = None
        for _ in range(30):
            assignment = np.argmax(normed @ centres.T, axis=1)
            if len(set(assignment.tolist())) < 2:
                break
            centres = np.stack([normed[assignment == k].mean(axis=0) for k in (0, 1)])
            centres /= np.linalg.norm(centres, axis=1, keepdims=True)
        if assignment is None or len(set(assignment.tolist())) < 2:
            continue
        gap = 1.0 - float(centres[0] @ centres[1])
        if gap > best[0]:
            best = (gap, (int((assignment == 0).sum()), int((assignment == 1).sum())))
    return best


print(f"{stem}  threshold {threshold} Fa {fa} Fb {fb}")
print(f"{'label':>6} {'slots':>7} {'share':>7} {'2-means gap':>12}  sides")
sizes = [(label, int(((flat_clusters == label) & usable).sum()))
         for label in sorted(set(flat_clusters[usable].tolist()))]
total = sum(size for _, size in sizes)
for label, size in sorted(sizes, key=lambda kv: -kv[1]):
    vectors = flat_embeddings[(flat_clusters == label) & usable]
    if len(vectors) < 8:
        print(f"{label:6d} {size:7d} {100 * size / total:6.0f}%      too few")
        continue
    gap, sides = split_gap(vectors)
    print(f"{label:6d} {size:7d} {100 * size / total:6.0f}% {gap:12.4f}  {sides[0]}/{sides[1]}")
