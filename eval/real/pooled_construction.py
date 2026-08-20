"""Which embedder, and which pooling, wins at POOLED ASSIGNMENT of a short clip?

Two questions that had been answered in the wrong framing.

1. Construction. `pooled_floor.py` averages per-span embeddings. A separate
   finding -- that averaging per-TURN vectors loses a lot -- was read as casting
   doubt on it. Held members, seconds, queries and held-out rule fixed and
   varying only whether the audio is joined before embedding or the embeddings
   averaged after, the two are equal. What actually matters is how many members
   the average has.

2. Embedder. ECAPA and wespeaker were compared once before and found
   equivalent, in a CLIP-TO-CLIP verification framing: "are these two the same
   person?". That is not this task. This task is "which of these N people is
   this?", against a pooled model, and two models can be equivalent at the first
   and not at the second. Both embedders see byte-identical audio, identical
   pool membership, identical query cuts and the identical held-out rule,
   because every clip list is built before any model is loaded.

  python eval/real/pooled_construction.py dorm-40min dorm-9pm
  SPK_MODELS=a,b  POOL_MIN_S=1  BUDGETS=20,60  SUBSETS=3  DURATIONS=0.5,1,2

The query's own span is held out of every pool. Models are built from random
subsets and a query only scores against models excluding its span, which keeps
the guarantee without rebuilding a model per query. Real-people data: reads
gitignored fixtures, writes none.
"""

import json
import os
import sys

import numpy as np
import soundfile as sf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from embedders import load  # noqa: E402

MODELS = os.environ.get(
    "SPK_MODELS", "speechbrain/spkrec-ecapa-voxceleb,pyannote/wespeaker-voxceleb-resnet34-LM"
).split(",")
POOL_MIN_S = float(os.environ.get("POOL_MIN_S", 4.0))
SPAN_CAP_S = 20.0
BUDGETS = [float(x) for x in os.environ.get("BUDGETS", "20").split(",")]
SUBSETS = int(os.environ.get("SUBSETS", 3))
DURATIONS = [float(x) for x in os.environ.get("DURATIONS", "0.5,1,2").split(",")]
MAX_QUERIES = int(os.environ.get("MAX_QUERIES", 80))


def metrics(same, different):
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
    at = int(np.argmin(np.abs(false_accept - false_reject)))
    return auc, (false_accept[at] + false_reject[at]) / 2


def build_trials(stem: str):
    """Every clip this study needs, decided before any embedder is loaded."""
    spans = json.load(open(f"eval/real/{stem}.reference.json"))["spans"]
    audio, sr = sf.read(f"fixtures/real/{stem}.wav", dtype="float32")
    long_spans = [s for s in spans if (s["end_ms"] - s["start_ms"]) / 1000 >= POOL_MIN_S]
    people = sorted({s["speaker"].lower() for s in long_spans})
    owned = {p: [i for i, s in enumerate(long_spans) if s["speaker"].lower() == p] for p in people}

    def span_clip(index: int) -> np.ndarray:
        lo = long_spans[index]["start_ms"] / 1000
        hi = min(long_spans[index]["end_ms"] / 1000, lo + SPAN_CAP_S)
        return audio[int(lo * sr) : int(hi * sr)]

    rng = np.random.default_rng(0)
    subsets = []  # (person, budget, members, joined audio)
    for person in people:
        poolable = sum(min(len(span_clip(i)) / sr, SPAN_CAP_S) for i in owned[person])
        for budget in BUDGETS:
            if poolable < budget * 1.4:
                continue
            for _ in range(SUBSETS):
                order = list(rng.permutation(owned[person]))
                members, total, pieces = [], 0.0, []
                for index in order:
                    if total >= budget:
                        break
                    clip = span_clip(index)
                    take = min(len(clip) / sr, budget - total)
                    pieces.append(clip[: int(take * sr)])
                    total += take
                    members.append(index)
                if total >= budget * 0.95:
                    subsets.append((person, budget, set(members), np.concatenate(pieces)))

    queries = {}
    for duration in DURATIONS:
        cuts, owners, from_span = [], [], []
        for index, span in enumerate(long_spans):
            lo, hi = span["start_ms"] / 1000, span["end_ms"] / 1000
            if hi - lo < duration:
                continue
            at = lo + (hi - lo - duration) / 2
            cuts.append(audio[int(at * sr) : int((at + duration) * sr)])
            owners.append(span["speaker"].lower())
            from_span.append(index)
        if len(cuts) > MAX_QUERIES:
            picked = sorted(rng.choice(len(cuts), MAX_QUERIES, replace=False))
            cuts = [cuts[i] for i in picked]
            owners = [owners[i] for i in picked]
            from_span = [from_span[i] for i in picked]
        queries[duration] = (cuts, owners, from_span)

    span_clips = [span_clip(i) for i in range(len(long_spans))]
    return people, owned, span_clips, subsets, queries


def score(people, owned, span_vectors, subsets, subset_vectors, queries):
    rows = [("floor", 0.0)] + sorted({(c, b) for _, b, _, _ in subsets for c in ("mean", "concat")})
    results = {}
    for duration, (_, owners, from_span) in queries.items():
        vectors = queries[duration][3]
        majority = max(owners.count(p) for p in people) / max(len(owners), 1)
        for construction, budget in rows:
            same, different, correct, scored = [], [], 0, 0
            for vector, owner, span_id in zip(vectors, owners, from_span):
                best, best_distance = None, None
                for person in people:
                    if construction == "floor":
                        members = [i for i in owned[person] if i != span_id]
                        if not members:
                            continue
                        centroid = span_vectors[members].mean(axis=0)
                        candidates = [centroid / np.linalg.norm(centroid)]
                    else:
                        candidates = []
                        for position, (p, b, mem, _) in enumerate(subsets):
                            if p != person or b != budget or span_id in mem:
                                continue
                            if construction == "concat":
                                candidates.append(subset_vectors[position])
                            else:
                                centroid = span_vectors[sorted(mem)].mean(axis=0)
                                candidates.append(centroid / np.linalg.norm(centroid))
                    if not candidates:
                        continue
                    distance = min(float(1 - np.dot(vector, c)) for c in candidates)
                    (same if person == owner else different).append(distance)
                    if best_distance is None or distance < best_distance:
                        best, best_distance = person, distance
                if best is not None:
                    scored += 1
                    correct += best == owner
            if not same or not different:
                continue
            auc, eer = metrics(same, different)
            results.setdefault((construction, budget), []).append(
                (duration, auc, eer, correct / max(scored, 1), majority)
            )
    return results


for stem in sys.argv[1:] or ["dorm-40min"]:
    people, owned, span_clips, subsets, queries = build_trials(stem)
    print(f"\n{stem}: {len(span_clips)} spans at least {POOL_MIN_S}s, people {people}", flush=True)
    for person in people:
        print(f"  {person}: {len(owned[person])} spans", flush=True)
    print(f"  {len(subsets)} pooled subsets, "
          + ", ".join(f"{d:g}s x{len(q[0])}" for d, q in queries.items()), flush=True)

    for checkpoint in MODELS:
        embedder = load(checkpoint)

        def embed_one(clip: np.ndarray) -> np.ndarray:
            out = np.asarray(embedder(clip.reshape(1, -1)), dtype="float64")[0]
            return out / np.linalg.norm(out)

        span_vectors = np.array([embed_one(c) for c in span_clips])
        subset_vectors = [embed_one(joined) for _, _, _, joined in subsets]
        prepared = {}
        for duration, (cuts, owners, from_span) in queries.items():
            prepared[duration] = (cuts, owners, from_span, np.array([embed_one(c) for c in cuts]))
        results = score(people, owned, span_vectors, subsets, subset_vectors, prepared)

        print(f"\n  {checkpoint}")
        print(f"    {'construction':14s} {'pool':>5s}  "
              + "  ".join(f"{d:>4g}s AUC   EER   acc" for d in DURATIONS))
        for (construction, budget), cells in results.items():
            label = "floor (no cap)" if construction == "floor" else construction
            pool = "all" if construction == "floor" else f"{budget:.0f}s"
            line = f"    {label:14s} {pool:>5s}  "
            line += "  ".join(f"{auc:.3f} {eer:.2f}  {100 * acc:3.0f}%" for _, auc, eer, acc, _ in cells)
            print(line + f"   (baseline {100 * cells[0][4]:.0f}%)", flush=True)
