"""Score every candidate voice against every other, with label provenance shown.

Written after a falsification. `jerry-45min/SPEAKER_03` was reported as Tarun on
two grounds -- he addresses "Boris" three times, and he matched the reference
spans labelled Tarun in dorm-40min at 0.88 -- and the owner says Tarun was not
there at all. One of the two sides of that match is mislabelled, or the metric
failed. This prints the whole matrix so the question is answerable from numbers
rather than from the chain of inferences that produced the error.

Sources carry their provenance, because they are not equally trustworthy:

  landmark   the owner named this speaker in eval/landmarks.ts, and the
             reference spans for that recording agree with every landmark
  reference  reference spans only, built by a retired clustering pipeline. In
             dorm-40min these CONTRADICT the owner twice: the span he identified
             as Dhruv is labelled tarun, and the one he identified as Clara is
             labelled boris
  cluster    a diarization cluster with no name attached at all

  python eval/real/identity_audit.py

Reports scores and nothing else. No identification in here is a conclusion.
"""

import json
import os
import sys
from collections import defaultdict

import numpy as np
import soundfile as sf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from embedders import load  # noqa: E402

CHECKPOINT = os.environ.get("SPK_MODEL", "speechbrain/spkrec-ecapa-voxceleb")
POOL_S = float(os.environ.get("POOL_S", 60))

# (stem, label, provenance, kind) -- kind picks the span source.
SOURCES = [
    ("dorm-9pm", "boris", "landmark", "reference"),
    ("dorm-9pm", "joshua", "landmark", "reference"),
    ("dorm-9pm", "tarun", "landmark", "reference"),
    ("dorm-40min", "boris", "reference", "reference"),
    ("dorm-40min", "tarun", "reference", "reference"),
    ("dorm-40min", "clara", "reference", "reference"),
    ("jerry-45min", "SPEAKER_03", "cluster", "cluster"),
    ("jerry-45min", "SPEAKER_04", "cluster", "cluster"),
    ("jerry-45min", "SPEAKER_02", "cluster", "cluster"),
    ("jerry-45min", "SPEAKER_01", "cluster", "cluster"),
    ("jerry-45min", "SPEAKER_00", "cluster", "cluster"),
    ("mentra-mtg", "SPEAKER_00", "cluster", "cluster"),
    ("mentra-mtg", "SPEAKER_02", "cluster", "cluster"),
    ("mentra-mtg", "SPEAKER_03", "cluster", "cluster"),
    ("mentra-mtg", "SPEAKER_01", "cluster", "cluster"),
]


def subtract(pieces, others):
    for lo2, hi2 in others:
        kept = []
        for lo, hi in pieces:
            if hi2 <= lo or lo2 >= hi:
                kept.append((lo, hi))
                continue
            if lo2 > lo:
                kept.append((lo, lo2))
            if hi2 < hi:
                kept.append((hi2, hi))
        pieces = kept
        if not pieces:
            break
    return pieces


def reference_pieces(stem, label):
    spans = json.load(open(f"eval/real/{stem}.reference.json"))["spans"]
    mine = [(s["start_ms"], s["end_ms"]) for s in spans if s["speaker"].lower() == label]
    theirs = [(s["start_ms"], s["end_ms"]) for s in spans if s["speaker"].lower() != label]
    out = []
    for span in mine:
        out.extend(subtract([span], theirs))
    return [(lo / 1000, hi / 1000) for lo, hi in out if hi - lo >= 700]


def cluster_pieces(stem, label):
    turns = json.load(open(f"fixtures/real/{stem}.pyannote.json"))["turns"]
    mine = [t for t in turns if t["speaker"] == label]
    theirs = [(t["start_ms"], t["end_ms"]) for t in turns if t["speaker"] != label]
    out = []
    for turn in mine:
        out.extend(subtract([(turn["start_ms"], turn["end_ms"])], theirs))
    return [(lo / 1000, hi / 1000) for lo, hi in out if hi - lo >= 700]


embedder = load(CHECKPOINT)
rng = np.random.default_rng(0)
audio_cache = {}
vectors, keys = [], []
for stem, label, provenance, kind in SOURCES:
    if stem not in audio_cache:
        audio_cache[stem] = sf.read(f"fixtures/real/{stem}.wav", dtype="float32")
    audio, sr = audio_cache[stem]
    pieces = reference_pieces(stem, label) if kind == "reference" else cluster_pieces(stem, label)
    order = rng.permutation(len(pieces))
    taken, total = [], 0.0
    for index in order:
        if total >= POOL_S:
            break
        lo, hi = pieces[index]
        take = min(hi - lo, POOL_S - total)
        taken.append(audio[int(lo * sr) : int((lo + take) * sr)])
        total += take
    if total < 10:
        print(f"  skipping {stem}/{label}: only {total:.0f}s available", flush=True)
        continue
    clip = np.concatenate(taken)
    out = np.asarray(embedder(clip.reshape(1, -1)), dtype="float64")[0]
    vectors.append(out / np.linalg.norm(out))
    keys.append((stem, label, provenance, total))
    print(f"  pooled {stem}/{label} [{provenance}] {total:.0f}s", flush=True)

vectors = np.array(vectors)
names = [f"{stem.split('-')[0]}/{label}" for stem, label, _, _ in keys]
width = max(len(n) for n in names) + 1
print("\ncosine, every source against every other (>= 0.68 marked *)")
print(" " * (width + 12) + " ".join(f"{n[:9]:>9s}" for n in names))
for i, (stem, label, provenance, seconds) in enumerate(keys):
    row = []
    for j in range(len(keys)):
        if i == j:
            row.append(f"{'-':>9s}")
            continue
        score = float(vectors[i] @ vectors[j])
        mark = "*" if score >= 0.68 else " "
        row.append(f"{score:>8.3f}{mark}")
    print(f"{names[i]:<{width}s}[{provenance[:4]}]{seconds:5.0f}s " + " ".join(row))
