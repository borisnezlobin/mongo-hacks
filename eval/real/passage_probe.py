"""The owner-verified passage, sentence by sentence, against pooled voices.

18.22-24.38 s of dorm-40min is one 6.16 s pyannote turn with nothing nested in
it, and the owner says it is Boris / Vova / Boris. Nothing found so far locates
that seam: window lengths 10/5/3/2 s all fail and the raw powerset posterior
never dips. Whisper, however, ends a sentence at 20.84 s and starts another at
21.52 s, exactly on the two true boundaries -- so the seam is already in the
transcript, and the only open question is whether pooled matching can DECIDE
the fragments once something else has cut them.

This prints that decision, per sentence, with distances to every pool, so the
answer is legible rather than a rate. If the three sentences do not land on at
least two different pools, sentence-granularity pooling does not touch this
case and must not be described as if it might.

  sidecar/.venv/bin/python eval/real/passage_probe.py
"""

import json
import sys

import numpy as np

stem = "dorm-40min"
FROM_S, TO_S = 16.0, 27.0
POOL_MIN_S = 4.0

turns = json.load(open(f"fixtures/real/{stem}.pyannote.json"))["turns"]
whisper = json.load(open(f"fixtures/real/{stem}.whisper.json"))
pool_vectors = np.load(f"eval/real/{stem}.turnemb.npz", allow_pickle=True)["vectors"]
query_vectors = np.load(f"eval/real/{stem}.sentencesemb.npz", allow_pickle=True)["vectors"]
sentences = [s for s in whisper["segments"] if s["end"] > s["start"]]
assert len(sentences) == len(query_vectors), "sentence cache is stale; rerun pooled_turns.py"

members = {}
for index, turn in enumerate(turns):
    if (turn["end_ms"] - turn["start_ms"]) / 1000 >= POOL_MIN_S:
        members.setdefault(turn["speaker"], []).append(index)
names = sorted(members)
centroids = np.vstack(
    [
        pool_vectors[members[name]].mean(axis=0)
        / np.linalg.norm(pool_vectors[members[name]].mean(axis=0))
        for name in names
    ]
)

print(f"pools >= {POOL_MIN_S}s: " + ", ".join(f"{n}({len(members[n])})" for n in names))
print("\npyannote turns over the passage:")
for turn in turns:
    if turn["end_ms"] / 1000 > FROM_S and turn["start_ms"] / 1000 < TO_S:
        print(
            f"  {turn['start_ms'] / 1000:6.2f}-{turn['end_ms'] / 1000:6.2f}  "
            f"{turn['speaker']}  ({(turn['end_ms'] - turn['start_ms']) / 1000:.2f}s)"
        )

print("\nwhisper sentences, each matched against the pools:")
for index, sentence in enumerate(sentences):
    if not (sentence["end"] > FROM_S and sentence["start"] < TO_S):
        continue
    distances = 1 - centroids @ query_vectors[index]
    order = np.argsort(distances)
    detail = "  ".join(f"{names[i]}:{distances[i]:.3f}" for i in order[:4])
    print(
        f"  {sentence['start']:6.2f}-{sentence['end']:6.2f}  "
        f"-> {names[order[0]]}  margin {distances[order[1]] - distances[order[0]]:.3f}  "
        f"| {sentence['text'].strip()[:44]:44s} | {detail}"
    )
