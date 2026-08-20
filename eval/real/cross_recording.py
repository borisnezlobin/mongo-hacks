"""Do the same people link across four separate recordings?

Everything in eval/real/ so far measures identity inside one recording. This
asks the product question instead: a voice heard in one conversation and again
in another, days apart and in a different room, has to come back as the same
person or Amelia is useless.

The method is deliberately hypothesis-free. It does not ask "where is Boris" --
it pools every diarization cluster in every recording into one model per
cluster, scores every cross-recording pair, and reports which pairs the shipped
threshold would join. Only afterwards are the joined pairs checked against
labels: reference spans where they exist, and the transcript where they do not.

  python eval/real/cross_recording.py                     scores every pair
  python eval/real/cross_recording.py --threshold 0.68

Reads eval/real/<stem>.turnemb.json, which turn_embeddings.py produces.
"""

import argparse
import json
import os
import sys
from collections import defaultdict

import numpy as np

STEMS = ["dorm-9pm", "dorm-40min", "jerry-45min", "mentra-mtg"]
MIN_TURN_MS = 1_000
MIN_CLUSTER_MS = 20_000


def load_clusters(stem: str, min_turn_ms: int = MIN_TURN_MS, min_cluster_ms: int = MIN_CLUSTER_MS):
    """One pooled model per diarization cluster, and the turns behind it."""
    path = f"eval/real/{stem}.turnemb.json"
    if not os.path.exists(path):
        return {}
    turns = json.load(open(path))["turns"]
    grouped = defaultdict(list)
    for turn in turns:
        if turn["vector"] is None or turn["exclusive_ms"] < min_turn_ms:
            continue
        grouped[turn["speaker"]].append(turn)
    clusters = {}
    for speaker, members in grouped.items():
        total = sum(turn["exclusive_ms"] for turn in members)
        if total < min_cluster_ms:
            continue
        vectors = np.array([turn["vector"] for turn in members], dtype="float64")
        weights = np.array([turn["exclusive_ms"] for turn in members], dtype="float64")
        centroid = (vectors * weights[:, None]).sum(axis=0) / weights.sum()
        clusters[speaker] = {
            "centroid": centroid / np.linalg.norm(centroid),
            "vectors": vectors,
            "weights": weights,
            "speech_ms": total,
            "turns": members,
        }
    return clusters


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--threshold", type=float, default=0.68)
    parser.add_argument("--min-cluster-ms", type=int, default=MIN_CLUSTER_MS)
    arguments = parser.parse_args()

    models = {stem: load_clusters(stem, min_cluster_ms=arguments.min_cluster_ms) for stem in STEMS}
    keys = [(stem, speaker) for stem in STEMS for speaker in sorted(models[stem])]
    for stem in STEMS:
        if not models[stem]:
            print(f"{stem}: no turn embeddings", file=sys.stderr)
            continue
        summary = ", ".join(
            f"{speaker} {models[stem][speaker]['speech_ms'] / 1000:.0f}s"
            for speaker in sorted(models[stem], key=lambda s: -models[stem][s]["speech_ms"])
        )
        print(f"{stem}: {summary}")

    matrix = np.array([models[stem][speaker]["centroid"] for stem, speaker in keys])
    scores = matrix @ matrix.T

    print("\ncross-recording cluster pairs, best first")
    pairs = []
    for i in range(len(keys)):
        for j in range(i + 1, len(keys)):
            if keys[i][0] == keys[j][0]:
                continue
            pairs.append((scores[i, j], keys[i], keys[j]))
    pairs.sort(reverse=True)
    for score, left, right in pairs:
        mark = "LINK" if score >= arguments.threshold else "    "
        print(f"  {mark} {score:.3f}  {left[0]}/{left[1]:11s} <-> {right[0]}/{right[1]}")

    print("\nwithin-recording cluster pairs, best first")
    within = []
    for i in range(len(keys)):
        for j in range(i + 1, len(keys)):
            if keys[i][0] != keys[j][0]:
                continue
            within.append((scores[i, j], keys[i], keys[j]))
    within.sort(reverse=True)
    for score, left, right in within[:20]:
        print(f"  {score:.3f}  {left[0]}/{left[1]} <-> {right[1]}")


if __name__ == "__main__":
    main()
