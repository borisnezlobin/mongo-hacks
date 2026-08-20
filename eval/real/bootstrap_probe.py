"""Is the shipping pipeline already a bootstrap, and if so how big is each half?

pyannote's BaseClustering.__call__ clusters only the chunk-speakers that
filter_embeddings keeps -- those with at least `min_active_ratio` of the chunk
spent speaking with nobody else active -- and then calls assign_embeddings,
which places EVERY chunk-speaker, seeds included, at the nearest pooled
centroid. That is the shape of the mechanism this study was asked to build, so
before building it the claim has to be checked against the cache: how many
slots seed, how many are assigned, and how often each half is right.

  sidecar/.venv/bin/python eval/real/bootstrap_probe.py dorm-40min
"""

import json
import os
import sys

import numpy as np
import torch
from pyannote.audio import Pipeline

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cluster_stage2 import SHIPPING_THRESHOLD, load_stage1  # noqa: E402

stem = sys.argv[1]
segmentations, count, embeddings, duration = load_stage1(stem)
reference = json.load(open(f"eval/real/{stem}.reference.json"))["spans"]

pipeline = Pipeline.from_pretrained(
    "pyannote/speaker-diarization-3.1", token=os.environ["HF_TOKEN"]
)
pipeline.instantiate(
    {
        "clustering": {"method": "centroid", "min_cluster_size": 12, "threshold": SHIPPING_THRESHOLD},
        "segmentation": {"min_duration_off": 0.0},
    }
)

window = segmentations.sliding_window
frames = pipeline._segmentation.model.receptive_field
num_chunks, num_frames, num_local = segmentations.data.shape
frame_seconds = window.duration / num_frames

alone = (segmentations.data.sum(axis=2, keepdims=True) == 1)
clean_frames = (segmentations.data * alone).sum(axis=1)
active_frames = segmentations.data.sum(axis=1)

clustering = pipeline.clustering
train, chunk_idx, speaker_idx = clustering.filter_embeddings(
    embeddings, segmentations=segmentations
)
hard, soft, centroids = clustering(
    embeddings=embeddings, segmentations=segmentations,
    num_clusters=None, min_clusters=1, max_clusters=20, frames=frames,
)

valid = ~np.isnan(embeddings).any(axis=-1)
occupied = (active_frames > 0) & valid
seed = np.zeros_like(occupied)
seed[chunk_idx, speaker_idx] = True

print(f"{stem}: {num_chunks} chunks x {num_local} local speakers, {occupied.sum()} occupied slots")
print(f"  seeds (>=2s alone in chunk): {seed.sum()} ({100 * seed.sum() / occupied.sum():.0f}% of occupied)")
print(f"  assigned but never seeded:   {(occupied & ~seed).sum()}")
print(f"  clusters from seeds: {len(centroids)}")

# Whose speech is in each slot, by reference overlap over the slot's own frames.
def slot_owner(chunk, local):
    start = window.start + chunk * window.step
    active = np.flatnonzero(segmentations.data[chunk, :, local] > 0)
    if len(active) == 0:
        return None, 0.0
    lo = start + active[0] * frame_seconds
    hi = start + (active[-1] + 1) * frame_seconds
    per = {}
    for span in reference:
        shared = min(hi * 1000, span["end_ms"]) - max(lo * 1000, span["start_ms"])
        if shared > 0:
            per[span["speaker"]] = per.get(span["speaker"], 0) + shared / 1000
    if not per:
        return None, 0.0
    owner = max(per, key=per.get)
    purity = per[owner] / sum(per.values())
    return owner, purity

rows = []
for chunk in range(num_chunks):
    for local in range(num_local):
        if not occupied[chunk, local]:
            continue
        owner, purity = slot_owner(chunk, local)
        if owner is None:
            continue
        rows.append(
            {
                "chunk": chunk, "local": local, "owner": owner, "purity": purity,
                "seed": bool(seed[chunk, local]),
                "cluster": int(hard[chunk, local]),
                "clean_s": float(clean_frames[chunk, local] * frame_seconds),
                "active_s": float(active_frames[chunk, local] * frame_seconds),
                "margin": float(np.sort(soft[chunk, local])[-1] - np.sort(soft[chunk, local])[-2])
                if soft.shape[-1] > 1 else 0.0,
                "best": float(np.max(soft[chunk, local])),
            }
        )

# Map cluster -> person by which person holds most slot-seconds in it.
weight = {}
for row in rows:
    key = (row["cluster"], row["owner"])
    weight[key] = weight.get(key, 0) + row["active_s"]
naming = {}
for (cluster, owner), seconds in sorted(weight.items(), key=lambda kv: -kv[1]):
    naming.setdefault(cluster, owner)

def report(name, subset):
    if not subset:
        print(f"  {name}: none")
        return
    correct = sum(1 for row in subset if naming.get(row["cluster"]) == row["owner"])
    pure = [row for row in subset if row["purity"] >= 0.9]
    correct_pure = sum(1 for row in pure if naming.get(row["cluster"]) == row["owner"])
    print(
        f"  {name}: {len(subset):5d} slots  {100 * correct / len(subset):5.1f}% right  "
        f"| pure-only {len(pure):5d} slots {100 * correct_pure / max(len(pure), 1):5.1f}% right"
    )

print("\nslot accuracy against the reference (cluster named by its dominant person)")
report("all slots     ", rows)
report("seed slots    ", [r for r in rows if r["seed"]])
report("assigned only ", [r for r in rows if not r["seed"]])

print("\nby clean-alone seconds in the chunk")
for lo, hi in [(0, 0.5), (0.5, 1), (1, 2), (2, 4), (4, 11)]:
    subset = [r for r in rows if lo <= r["clean_s"] < hi]
    report(f"  {lo:4.1f}-{hi:4.1f}s", subset)

print("\nreference purity of the slot itself (a slot holding two people cannot be right)")
for lo, hi in [(0, 0.6), (0.6, 0.8), (0.8, 0.9), (0.9, 1.01)]:
    subset = [r for r in rows if lo <= r["purity"] < hi]
    print(f"  purity {lo:.1f}-{hi:.1f}: {len(subset)} slots, {sum(r['active_s'] for r in subset):.0f}s")

np.savez_compressed(
    f"eval/real/{stem}.slots.npz",
    **{key: np.array([row[key] for row in rows]) for key in rows[0]},
)
print(f"\nwrote eval/real/{stem}.slots.npz")
