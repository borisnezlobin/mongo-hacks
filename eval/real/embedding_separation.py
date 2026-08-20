"""Can these embeddings tell these people apart at all?

The sweep can only move where a boundary is drawn. This asks the prior
question: given the embeddings pyannote actually computed for this recording,
is there any threshold that separates the people in it? Each embedding belongs
to one (chunk, local speaker) pair; the reference says who was speaking in that
chunk's active frames, so an embedding whose active time is dominated by one
labelled person can be given that person's name. Then same-person and
different-person cosine distances are two distributions, and the gap between
them is the ceiling on any clustering rule that reads these vectors.

  python eval/real/embedding_separation.py dorm-9pm /tmp/ref-9pm.json
"""

import json
import sys

import numpy as np

stem, ref_path = sys.argv[1], sys.argv[2]
cached = np.load(f"eval/real/{stem}.stage1.npz")
segmentations = cached["segmentations"]  # (chunks, frames, local speakers)
embeddings = cached["embeddings"]  # (chunks, local speakers, dim)
step = float(cached["seg_step"])
duration = float(cached["seg_duration"])
start = float(cached["seg_start"])

reference = json.load(open(ref_path))
spans = sorted(reference["spans"], key=lambda span: span["start_ms"])
PURITY = 0.8

num_chunks, num_frames, num_local = segmentations.shape
frame_s = duration / num_frames

reasons = {"short": 0, "silent": 0, "mixed": 0, "clean": 0}
owners = []
for chunk in range(num_chunks):
    chunk_start = start + chunk * step
    for local in range(num_local):
        active = segmentations[chunk, :, local] > 0.5
        if active.sum() * frame_s < 1.0:
            owners.append(None)
            reasons["short"] += 1
            continue
        frames = np.flatnonzero(active)
        per_person = {}
        for frame in frames:
            at_ms = (chunk_start + frame * frame_s) * 1000
            for span in spans:
                if span["start_ms"] <= at_ms < span["end_ms"]:
                    per_person[span["speaker"]] = per_person.get(span["speaker"], 0) + 1
                    break
        total = sum(per_person.values())
        if total < len(frames) * 0.5 or not per_person:
            owners.append(None)
            reasons["silent"] += 1
            continue
        person, count = max(per_person.items(), key=lambda item: item[1])
        clean = count >= total * PURITY
        reasons["clean" if clean else "mixed"] += 1
        owners.append(person if clean else None)

owners = np.array(owners, dtype=object).reshape(num_chunks, num_local)

# The subset clustering actually trains on. pyannote drops any chunk-speaker
# with less than min_active_ratio (0.2) of the chunk in frames where it is the
# only active speaker -- two seconds of clean speech out of ten. Measuring the
# unfiltered set would describe vectors the clusterer never sees.
single_active = (segmentations.sum(axis=2, keepdims=True) == 1)
clean_frames = (segmentations * single_active).sum(axis=1)
trained_on = clean_frames >= 0.2 * num_frames
print(
    f"  clustering trains on {int(trained_on.sum())} of {trained_on.size} chunk-speaker slots "
    f"(pyannote's own min_active_ratio=0.2 filter); the rest are assigned afterwards"
)
labelled_and_trained = int(sum(
    1 for chunk in range(num_chunks) for local in range(num_local)
    if owners[chunk, local] is not None and trained_on[chunk, local]
))
print(f"  of those, {labelled_and_trained} are also one labelled person")
flat_emb = embeddings.reshape(-1, embeddings.shape[-1])
flat_owner = owners.reshape(-1)
flat_trained = trained_on.reshape(-1)
keep = np.array([owner is not None and trained and not np.isnan(vector).any()
                 for owner, trained, vector in zip(flat_owner, flat_trained, flat_emb)])
vectors = flat_emb[keep]
labels = flat_owner[keep]
vectors = vectors / np.linalg.norm(vectors, axis=1, keepdims=True)

print(
    "  segmentation regions: "
    f"{reasons['clean']} one-person, {reasons['mixed']} two-or-more-people, "
    f"{reasons['short']} under a second, {reasons['silent']} mostly outside labelled speech"
)
print(f"{stem}: {len(vectors)} of {len(flat_owner)} embeddings are {int(PURITY*100)}% one labelled person")
for person in sorted(set(labels)):
    print(f"   {person}: {(labels == person).sum()}")

distances = 1.0 - vectors @ vectors.T
same = labels[:, None] == labels[None, :]
upper = np.triu(np.ones_like(distances, dtype=bool), k=1)
within = distances[same & upper]
between = distances[~same & upper]
print(f"  same person    n={within.size:6d}  mean {within.mean():.3f}  p50 {np.percentile(within,50):.3f}  p90 {np.percentile(within,90):.3f}  p95 {np.percentile(within,95):.3f}")
print(f"  different      n={between.size:6d}  mean {between.mean():.3f}  p50 {np.percentile(between,50):.3f}  p10 {np.percentile(between,10):.3f}  p05 {np.percentile(between,5):.3f}")
print(f"  gap (mean different - mean same): {between.mean() - within.mean():.3f}")

# Where would a threshold have to sit, and how much does it cost either way?
print("  threshold      same-pair kept   different-pair wrongly joined")
for threshold in [0.5, 0.6, 0.65, 0.7046, 0.75, 0.8, 0.85, 0.9, 1.0]:
    print(f"    {threshold:.4f}         {(within < threshold).mean():6.1%}          {(between < threshold).mean():6.1%}")

# Per-pair, because one confusable pair is what a mean hides.
people = sorted(set(labels))
print("  mean distance between each pair of people")
for i, first in enumerate(people):
    row = []
    for second in people:
        block = distances[np.ix_(labels == first, labels == second)]
        row.append(f"{second}:{block.mean():.3f}")
    print(f"    {first:12s} " + "  ".join(row))
