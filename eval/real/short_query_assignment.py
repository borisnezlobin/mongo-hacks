"""Can a fragment shorter than EMBED_MIN_MS be assigned to one of N known voices?

`EMBED_MIN_MS = 3_000` drops about 30% of all speech and 80% of all turns before
identification sees them. It conflates two different quantities: how much speech
is needed to BUILD a voice model, and how much is needed to MATCH against one.
The model side needs tens of seconds. The query side is what this measures.

Three things are varied, because each of them is a way to fool yourself:

  gallery size   3, then 5, then 7 voices. A 3-way choice flatters everything;
                 the product has seven people in one room. Distractors are
                 clusters from OTHER recordings, so they are unambiguously
                 different people -- which also makes them acoustically easier
                 to reject than a roommate would be. Read the numbers as an
                 upper bound for that reason, and see `--distractors same` for
                 the pessimistic variant.
  pool source    reference   pools built from owner-labelled spans: clean, and
                             NOT something the product can build
                 cluster     pools built from the diarization's own clusters,
                             which is what the product actually has and is wrong
                             on a quarter of turns. If the result only survives
                             on clean pools, that dependency is the finding.
  embedder       ECAPA, which the sidecar ships and which stores every
                 voiceprint, against wespeaker, which the eval tooling defaults
                 to and which pyannote clusters with internally. Both see
                 byte-identical audio and the identical trials, because every
                 clip is chosen before any model is loaded.

Reported per cell: correct, confidently wrong, and abstained -- separately for
a thin top-two margin (ATTRIBUTION_MARGIN) and for a top score under
ATTRIBUTION_THRESHOLD. A rule that assigns 70% and abstains on the rest is worth
more than one that assigns everything at 75%, because a wrong identity files one
person's facts under another and is not recoverable by asking.

  python eval/real/short_query_assignment.py
  DURATIONS=0.5,1,2,3  MAX_QUERIES=80  SPK_MODELS=a,b

Real-people data: reads gitignored fixtures, writes none.
"""

import json
import os
import sys
from collections import defaultdict

import numpy as np
import soundfile as sf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from embedders import load  # noqa: E402

MODELS = os.environ.get(
    "SPK_MODELS", "speechbrain/spkrec-ecapa-voxceleb,pyannote/wespeaker-voxceleb-resnet34-LM"
).split(",")
STEM = os.environ.get("STEM", "dorm-40min")
DISTRACTOR_STEMS = ["jerry-45min", "mentra-mtg"]
DURATIONS = [float(x) for x in os.environ.get("DURATIONS", "0.5,1,2,3").split(",")]
MAX_QUERIES = int(os.environ.get("MAX_QUERIES", 80))
GALLERY_SIZES = [3, 5, 7]
POOL_S = 20.0
SPAN_CAP_S = 20.0
POOL_MIN_S = 2.0
MARGIN = 0.05
THRESHOLD = 0.68


def exclusive_pieces(turns):
    by_cluster = defaultdict(list)
    for turn in turns:
        pieces = [(turn["start_ms"], turn["end_ms"])]
        for other in turns:
            if other is turn or other["speaker"] == turn["speaker"]:
                continue
            if other["start_ms"] >= turn["end_ms"] or other["end_ms"] <= turn["start_ms"]:
                continue
            kept = []
            for lo, hi in pieces:
                if other["end_ms"] <= lo or other["start_ms"] >= hi:
                    kept.append((lo, hi))
                    continue
                if other["start_ms"] > lo:
                    kept.append((lo, other["start_ms"]))
                if other["end_ms"] < hi:
                    kept.append((other["end_ms"], hi))
            pieces = kept
            if not pieces:
                break
        for lo, hi in pieces:
            if hi - lo >= 700:
                by_cluster[turn["speaker"]].append((lo / 1000, hi / 1000))
    return by_cluster


def pooled_audio(audio, sr, pieces, seconds, rng):
    order = rng.permutation(len(pieces))
    taken, total = [], 0.0
    for index in order:
        if total >= seconds:
            break
        lo, hi = pieces[index]
        take = min(hi - lo, seconds - total)
        taken.append(audio[int(lo * sr) : int((lo + take) * sr)])
        total += take
    return np.concatenate(taken) if total >= seconds * 0.9 else None


rng = np.random.default_rng(0)

spans = json.load(open(f"eval/real/{STEM}.reference.json"))["spans"]
audio, sr = sf.read(f"fixtures/real/{STEM}.wav", dtype="float32")
long_spans = [s for s in spans if (s["end_ms"] - s["start_ms"]) / 1000 >= POOL_MIN_S]
people = sorted({s["speaker"].lower() for s in long_spans})
owned = {p: [i for i, s in enumerate(long_spans) if s["speaker"].lower() == p] for p in people}


def span_clip(index):
    lo = long_spans[index]["start_ms"] / 1000
    hi = min(long_spans[index]["end_ms"] / 1000, lo + SPAN_CAP_S)
    return audio[int(lo * sr) : int(hi * sr)]


span_clips = [span_clip(i) for i in range(len(long_spans))]

# Cluster-built models for the same three people, which is what the product can
# actually build. Cluster -> person by majority overlap with the reference.
turns = json.load(open(f"fixtures/real/{STEM}.pyannote.json"))["turns"]
pieces_by_cluster = exclusive_pieces(turns)
cluster_person = {}
for cluster, pieces in pieces_by_cluster.items():
    overlap = defaultdict(float)
    for lo, hi in pieces:
        for span in spans:
            a, b = max(lo * 1000, span["start_ms"]), min(hi * 1000, span["end_ms"])
            if b > a:
                overlap[span["speaker"].lower()] += b - a
    if overlap:
        cluster_person[cluster] = max(overlap.items(), key=lambda kv: kv[1])[0]

cluster_models = {}
for person in people:
    mine = [c for c, p in cluster_person.items() if p == person]
    if not mine:
        continue
    best = max(mine, key=lambda c: sum(hi - lo for lo, hi in pieces_by_cluster[c]))
    clip = pooled_audio(audio, sr, pieces_by_cluster[best], POOL_S, rng)
    if clip is not None:
        cluster_models[person] = (best, clip)

# Reference pools capped to the SAME budget as the cluster pools. Without this
# arm the "reference" rows carry ~176s of Boris against 20s distractors, and the
# gallery-size result measures pool size rather than pool cleanliness.
reference20 = defaultdict(list)
for person in people:
    for _ in range(3):
        order = list(rng.permutation(owned[person]))
        members, total, chunks = set(), 0.0, []
        for index in order:
            if total >= POOL_S:
                break
            clip = span_clips[index]
            take = min(len(clip) / sr, POOL_S - total)
            chunks.append(clip[: int(take * sr)])
            total += take
            members.add(index)
        if total >= POOL_S * 0.9:
            reference20[person].append((members, np.concatenate(chunks)))

distractors = []
for other in DISTRACTOR_STEMS:
    other_audio, other_sr = sf.read(f"fixtures/real/{other}.wav", dtype="float32")
    other_pieces = exclusive_pieces(json.load(open(f"fixtures/real/{other}.pyannote.json"))["turns"])
    for cluster, pieces in sorted(other_pieces.items(), key=lambda kv: -sum(h - l for l, h in kv[1])):
        clip = pooled_audio(other_audio, other_sr, pieces, POOL_S, rng)
        if clip is not None:
            distractors.append((f"{other}/{cluster}", clip))
    del other_audio

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
        cuts, owners, from_span = [cuts[i] for i in picked], [owners[i] for i in picked], [from_span[i] for i in picked]
    queries[duration] = (cuts, owners, from_span)

print(f"{STEM}: {len(long_spans)} spans at least {POOL_MIN_S}s, target voices {people}")
print(f"  cluster-built models: " + ", ".join(f"{p}<-{c}" for p, (c, _) in cluster_models.items()))
print(f"  {len(distractors)} distractor voices from {DISTRACTOR_STEMS}")
print(f"  queries: " + ", ".join(f"{d:g}s x{len(q[0])}" for d, q in queries.items()), flush=True)


def verdicts(query_vectors, owners, from_span, gallery, source_vectors):
    """gallery: list of (label, kind, payload). Returns counts."""
    counts = defaultdict(int)
    for vector, owner, span_id in zip(query_vectors, owners, from_span):
        scored = []
        for label, kind, payload in gallery:
            if kind == "reference":
                members = [i for i in owned[label] if i != span_id]
                if not members:
                    continue
                centroid = source_vectors["span"][members].mean(axis=0)
                candidates = [centroid / np.linalg.norm(centroid)]
            elif kind == "subsets":
                candidates = [vec for mem, vec in payload if span_id not in mem]
            else:
                candidates = [payload]
            if not candidates:
                continue
            scored.append((max(float(vector @ c) for c in candidates), label))
        if len(scored) < 2:
            continue
        scored.sort(reverse=True)
        top, runner = scored[0], scored[1]
        counts["n"] += 1
        counts["top1_correct"] += top[1] == owner
        if top[0] < THRESHOLD:
            counts["abstain_threshold"] += 1
        elif top[0] - runner[0] < MARGIN:
            counts["abstain_margin"] += 1
        elif top[1] == owner:
            counts["assigned_correct"] += 1
        else:
            counts["assigned_wrong"] += 1
    return counts


for checkpoint in MODELS:
    embedder = load(checkpoint)

    def embed_one(clip):
        out = np.asarray(embedder(clip.reshape(1, -1)), dtype="float64")[0]
        return out / np.linalg.norm(out)

    source_vectors = {"span": np.array([embed_one(c) for c in span_clips])}
    cluster_vectors = {p: embed_one(clip) for p, (_, clip) in cluster_models.items()}
    reference20_vectors = {
        p: [(mem, embed_one(clip)) for mem, clip in v] for p, v in reference20.items()
    }
    distractor_vectors = [(label, embed_one(clip)) for label, clip in distractors]
    query_vectors = {d: np.array([embed_one(c) for c in q[0]]) for d, q in queries.items()}
    print(f"\n{checkpoint}", flush=True)

    for pool_source in ["reference", "reference-20s", "cluster"]:
        if pool_source == "reference":
            targets = [(p, "reference", None) for p in people]
        elif pool_source == "reference-20s":
            targets = [(p, "subsets", reference20_vectors[p]) for p in people if reference20_vectors.get(p)]
        else:
            targets = [(p, "cluster", cluster_vectors[p]) for p in people if p in cluster_vectors]
        if len(targets) < 3:
            continue
        print(f"  pools from {pool_source}")
        for size in GALLERY_SIZES:
            extra = size - len(targets)
            if extra > len(distractor_vectors):
                continue
            gallery = targets + [(label, "cluster", vec) for label, vec in distractor_vectors[:extra]]
            cells = []
            for duration in DURATIONS:
                cuts, owners, from_span = queries[duration]
                counts = verdicts(query_vectors[duration], owners, from_span, gallery, source_vectors)
                if not counts["n"]:
                    continue
                total = counts["n"]
                cells.append(
                    f"{duration:g}s top1 {100 * counts['top1_correct'] / total:3.0f}%  "
                    f"ok {100 * counts['assigned_correct'] / total:3.0f}% "
                    f"bad {100 * counts['assigned_wrong'] / total:3.0f}% "
                    f"abs {100 * (counts['abstain_margin'] + counts['abstain_threshold']) / total:3.0f}%"
                )
            print(f"    gallery {size}: " + " | ".join(cells), flush=True)
