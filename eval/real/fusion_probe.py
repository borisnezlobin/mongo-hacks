"""Does stereo position add anything to pooled-embedding fragment matching?

One measured test, built to sit directly beside `pooled_floor.py`: same pools,
same query clips, same nearest-centroid decision, with a spatial term added.
The only new thing is the term, so any difference is the term.

    combined = z(embedding distance) + weight * z(spatial distance)

Both distance matrices are divided by their own spread before they are added,
so `weight` is in units of "as much as the embedding" rather than in units of
degrees or microseconds, and weight 0 is exactly the published study. The
weights are swept and all of them printed. A cue that only helps at one fitted
weight is not a cue, and the sweep is the only way to see that.

  sidecar/.venv/bin/python eval/real/fusion_probe.py dorm-9pm
  POOLS=labels sidecar/.venv/bin/python eval/real/fusion_probe.py dorm-40min

POOLS=reference (default) reproduces the upper-bound study. POOLS=labels builds
the pools from the diarizer's own long turns instead, which is the product
shape -- worth both, because a cue could help a clean pool and not a real one.
"""

import json
import os
import sys

import numpy as np
import soundfile as sf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import spatial  # noqa: E402
from embedders import load  # noqa: E402

stem = sys.argv[1]
durations = [float(v) for v in (sys.argv[2].split(",") if len(sys.argv) > 2 else ["0.5", "1", "2", "4"])]
weights = [float(v) for v in os.environ.get("WEIGHTS", "0,0.25,0.5,1,2,4").split(",")]
checkpoint = os.environ.get("SPK_MODEL", "pyannote/wespeaker-voxceleb-resnet34-LM")
pool_source = os.environ.get("POOLS", "reference")
POOL_MIN_S = float(os.environ.get("POOL_MIN_S", 4.0))

spans = json.load(open(f"eval/real/{stem}.reference.json"))["spans"]
turns = json.load(open(f"fixtures/real/{stem}.pyannote.json"))["turns"]
mono, sr = sf.read(f"fixtures/real/{stem}.wav", dtype="float32")
stereo, stereo_sr = sf.read(f"fixtures/real/{stem}.stereo.wav", dtype="float32")
assert stereo_sr == sr and abs(len(stereo) - len(mono)) < sr, "stereo and mono are not the same clock"

embed_batch = load(checkpoint)


def embed(cuts, batch=24):
    out = []
    for start in range(0, len(cuts), batch):
        group = cuts[start : start + batch]
        width = max(int((hi - lo) * sr) for lo, hi in group)
        block = np.zeros((len(group), width), dtype="float32")
        for row, (lo, hi) in enumerate(group):
            clip = mono[int(lo * sr) : int(lo * sr) + width]
            block[row, : len(clip)] = clip
        got = np.asarray(embed_batch(block), dtype="float64")
        out.append(got / np.maximum(np.linalg.norm(got, axis=1, keepdims=True), 1e-9))
    return np.concatenate(out)


if pool_source == "reference":
    long_spans = [s for s in spans if (s["end_ms"] - s["start_ms"]) / 1000 >= POOL_MIN_S]
    pool_owner = [s["speaker"] for s in long_spans]
    pool_span = [(s["start_ms"], s["end_ms"]) for s in long_spans]
else:
    long_turns = [t for t in turns if (t["end_ms"] - t["start_ms"]) / 1000 >= POOL_MIN_S]
    pool_owner = [t["speaker"] for t in long_turns]
    pool_span = [(t["start_ms"], t["end_ms"]) for t in long_turns]

if pool_source == "labels":
    # A diarizer label has no name, so each is named by the person holding most
    # of its pooled time. That uses the reference to SCORE, never to build the
    # pool, which is what keeps this a product-shaped condition.
    weight_of = {}
    for label, (lo, hi) in zip(pool_owner, pool_span):
        for span in spans:
            shared = min(hi, span["end_ms"]) - max(lo, span["start_ms"])
            if shared > 0:
                key = (label, span["speaker"])
                weight_of[key] = weight_of.get(key, 0) + shared
    naming = {}
    for (label, person), value in sorted(weight_of.items(), key=lambda kv: -kv[1]):
        naming.setdefault(label, person)
    pool_owner = [naming.get(label, f"unnamed:{label}") for label in pool_owner]

pool_cuts = [(lo / 1000, min(hi / 1000, lo / 1000 + 20.0)) for lo, hi in pool_span]
people = sorted(set(pool_owner))
pool_vectors = embed(pool_cuts)
pool_spatial = spatial.features(stereo, sr, pool_cuts)

# The spread each feature is measured against. Taken over the pools rather than
# over the queries, because it describes the room, and it must not move when the
# query length moves or the two clip lengths would not be comparable.
spread = np.maximum(pool_spatial.std(axis=0), 1e-6)

print(f"{stem}: pools from {pool_source}, {len(pool_cuts)} spans, {len(people)} groups")
for person in people:
    rows = [i for i, owner in enumerate(pool_owner) if owner == person]
    values = pool_spatial[rows]
    print(
        f"  {person:14s} n={len(rows):3d}  ILD {values[:, 0].mean():6.2f} +- {values[:, 0].std():5.2f} dB"
        f"   ITD {values[:, 1].mean():7.1f} +- {values[:, 1].std():6.1f} us"
    )

rng = np.random.default_rng(0)
for duration in durations:
    queries, owners, from_span = [], [], []
    for span in spans:
        lo, hi = span["start_ms"] / 1000, span["end_ms"] / 1000
        if hi - lo < duration:
            continue
        at = lo + (hi - lo - duration) / 2
        queries.append((at, at + duration))
        owners.append(span["speaker"])
        from_span.append((span["start_ms"], span["end_ms"]))
    if len(queries) < 8:
        print(f"  {duration:5.1f}s  not enough reference spans this long")
        continue
    if len(queries) > 300:
        picked = sorted(rng.choice(len(queries), 300, replace=False))
        queries = [queries[i] for i in picked]
        owners = [owners[i] for i in picked]
        from_span = [from_span[i] for i in picked]
    vectors = embed(queries)
    query_spatial = spatial.features(stereo, sr, queries)

    # A group is scored by the centroid of its pool with the query's own span
    # held out, exactly as pooled_floor.py does it.
    embedding_distance = np.full((len(queries), len(people)), np.inf)
    spatial_distance = np.full((len(queries), len(people)), np.inf)
    for column, person in enumerate(people):
        for row, span_id in enumerate(from_span):
            members = [
                i
                for i, (owner, span) in enumerate(zip(pool_owner, pool_span))
                if owner == person and span != span_id
            ]
            if not members:
                continue
            centroid = pool_vectors[members].mean(axis=0)
            centroid /= np.linalg.norm(centroid)
            embedding_distance[row, column] = 1 - float(vectors[row] @ centroid)
            here = pool_spatial[members].mean(axis=0)
            spatial_distance[row, column] = float(
                np.sqrt((((query_spatial[row] - here) / spread) ** 2).sum())
            )

    finite = np.isfinite(embedding_distance)
    embedding_z = embedding_distance / embedding_distance[finite].std()
    spatial_z = spatial_distance / spatial_distance[finite].std()

    counts = {person: owners.count(person) for person in people if person in owners}
    majority = max(counts.values()) / len(owners)
    truth = np.array([people.index(owner) if owner in people else -1 for owner in owners])
    line = [f"  {duration:5.1f}s  clips={len(queries):3d}  majority {100 * majority:3.0f}%"]
    spatial_only = 100 * (np.argmin(np.where(finite, spatial_distance, np.inf), axis=1) == truth).mean()
    for weight in weights:
        combined = np.where(finite, embedding_z + weight * spatial_z, np.inf)
        accuracy = 100 * (np.argmin(combined, axis=1) == truth).mean()
        line.append(f"w={weight:g} {accuracy:5.1f}%")
    line.append(f"| spatial alone {spatial_only:5.1f}%")
    print("  ".join(line))
