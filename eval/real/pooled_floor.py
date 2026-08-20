"""Is a short fragment separable against a POOLED speaker model, not another fragment?

`duration_floor.py` asked the hardest possible question: two short clips, same
person or not. That is not what a person in the room does. The owner does not
compare 0.68 s of one voice to 0.68 s of another; he matches 0.68 s against
minutes of somebody he already knows. One side of his comparison is long.

So this asks the asymmetric question. A centroid is pooled from a person's long
clean reference spans, the query clip's own span is held out of it, and the
query is scored against every person's centroid. Same clip lengths, same
recordings, same embedding models, so the two studies sit side by side.

  python eval/real/pooled_floor.py dorm-40min eval/real/dorm-40min.reference.json

The pool needs to know which stretches belong to whom, which is the problem
being solved -- so this is an UPPER BOUND, not a product number. If the bound is
good the mechanism is bootstrapping: cluster the long confident stretches first,
pool them, then attribute the short fragments against those pools. If the bound
is no better than clip-to-clip, the floor is real.

  SPK_MODEL     embedding checkpoint
  POOL_MIN_S    shortest span allowed into a pool (default 4)
  ENHANCE       path to a directory of enhanced wavs, to repeat this on them
"""

import json
import os
import sys

import numpy as np
import soundfile as sf
import torch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from embedders import load  # noqa: E402

stem, reference_path = sys.argv[1], sys.argv[2]
durations = [float(x) for x in (sys.argv[3].split(",") if len(sys.argv) > 3 else ["0.5", "1", "2", "4"])]
checkpoint = os.environ.get("SPK_MODEL", "pyannote/wespeaker-voxceleb-resnet34-LM")
POOL_MIN_S = float(os.environ.get("POOL_MIN_S", 4.0))

audio_path = os.environ.get("ENHANCE_WAV", f"fixtures/real/{stem}.wav")
spans = json.load(open(reference_path))["spans"]
audio, sr = sf.read(audio_path, dtype="float32")

embed_batch = load(checkpoint)


def embed(cuts: list[tuple[float, float]], batch: int = 24) -> np.ndarray:
    vectors = []
    for start in range(0, len(cuts), batch):
        group = cuts[start : start + batch]
        width = max(int((hi - lo) * sr) for lo, hi in group)
        block = np.zeros((len(group), width), dtype="float32")
        for row, (lo, hi) in enumerate(group):
            clip = audio[int(lo * sr) : int(lo * sr) + width]
            block[row, : len(clip)] = clip
        out = np.asarray(embed_batch(block), dtype="float64")
        vectors.append(out / np.linalg.norm(out, axis=1, keepdims=True))
    return np.concatenate(vectors)


long_spans = [span for span in spans if (span["end_ms"] - span["start_ms"]) / 1000 >= POOL_MIN_S]
people = sorted({span["speaker"] for span in long_spans})
pool_cuts, pool_owner, pool_span = [], [], []
for index, span in enumerate(long_spans):
    lo, hi = span["start_ms"] / 1000, span["end_ms"] / 1000
    pool_cuts.append((lo, min(hi, lo + 20.0)))
    pool_owner.append(span["speaker"])
    pool_span.append((span["start_ms"], span["end_ms"]))
pool_vectors = embed(pool_cuts) if pool_cuts else np.zeros((0, 1))

print(f"{stem}: {len(spans)} reference spans, {len(long_spans)} at least {POOL_MIN_S}s")
print(f"  pools: " + ", ".join(f"{p} {sum(1 for o in pool_owner if o == p)}" for p in people))
print(f"  audio {audio_path}, embedding {checkpoint}")
rng = np.random.default_rng(0)

for duration in durations:
    queries, owners, from_span = [], [], []
    for span in spans:
        lo, hi = span["start_ms"] / 1000, span["end_ms"] / 1000
        if hi - lo < duration or span["speaker"] not in people:
            continue
        at = lo + (hi - lo - duration) / 2
        queries.append((at, at + duration))
        owners.append(span["speaker"])
        from_span.append((span["start_ms"], span["end_ms"]))
    if len(queries) < 4:
        print(f"  {duration:5.1f}s  not enough reference spans this long")
        continue
    if len(queries) > 300:
        picked = sorted(rng.choice(len(queries), 300, replace=False))
        queries = [queries[i] for i in picked]
        owners = [owners[i] for i in picked]
        from_span = [from_span[i] for i in picked]
    vectors = embed(queries)

    same, different = [], []
    correct = 0
    scored = 0
    for row, (vector, owner, span_id) in enumerate(zip(vectors, owners, from_span)):
        best_person, best_distance = None, None
        for person in people:
            # Leave the query's own span out of the pool it is compared against.
            members = [
                i for i, (p, s) in enumerate(zip(pool_owner, pool_span)) if p == person and s != span_id
            ]
            if not members:
                continue
            centroid = pool_vectors[members].mean(axis=0)
            centroid /= np.linalg.norm(centroid)
            distance = float(1 - np.dot(vector, centroid))
            (same if person == owner else different).append(distance)
            if best_distance is None or distance < best_distance:
                best_person, best_distance = person, distance
        if best_person is not None:
            scored += 1
            correct += best_person == owner
    counts = {person: owners.count(person) for person in people}
    majority = max(counts.values()) / len(owners)
    same, different = np.array(same), np.array(different)
    order = np.argsort(np.concatenate([different, same]))
    marks = np.concatenate([np.ones(len(different)), np.zeros(len(same))])[order]
    ranks = np.arange(1, len(marks) + 1)
    auc = (ranks[marks == 1].sum() - len(different) * (len(different) + 1) / 2) / (
        len(different) * len(same)
    )
    grid = np.linspace(0, 2, 401)
    false_accept = np.array([(different <= t).mean() for t in grid])
    false_reject = np.array([(same > t).mean() for t in grid])
    eer_at = int(np.argmin(np.abs(false_accept - false_reject)))
    print(
        f"  {duration:5.1f}s  clips={len(queries):3d}  AUC={auc:.3f}  "
        f"EER={(false_accept[eer_at] + false_reject[eer_at]) / 2:.2f} at d={grid[eer_at]:.2f}  "
        f"nearest-centroid accuracy {100 * correct / max(scored, 1):.0f}% of {len(people)} people "
        f"(always-guess-the-commonest scores {100 * majority:.0f}%)  "
        f"same median {np.median(same):.3f}  different median {np.median(different):.3f}"
    )
