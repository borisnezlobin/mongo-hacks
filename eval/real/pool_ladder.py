"""How much pooled speech a voiceprint needs before it survives a new room.

CONFIRMED_SPEECH_MS is 20 s, measured by enrolling from one half of a single
three-minute recording and testing on the other half. Both halves shared a room,
a microphone and a gain setting, so that measurement never asked the question
the product depends on. This asks it: models built from pooled audio in one
recording, scored against models built from pooled audio in another.

Three populations at every pool size:

  same person, different recording   what has to be accepted
  same cluster, same recording       the easy control the thresholds were set on
  different people                   what has to be rejected, most of them
                                     strangers who appear in one recording only

  python eval/real/pool_ladder.py            the shipping ECAPA vectors
  python eval/real/pool_ladder.py wespeaker
"""

import itertools
import json
import sys
from collections import defaultdict

import numpy as np

STEMS = ["dorm-9pm", "dorm-40min", "jerry-45min", "mentra-mtg"]

# Provenance for each label is documented in eval/real/cross-session-identity.mts.
TRUTH = {
    "dorm-9pm/SPEAKER_01": "joshua",
    "dorm-9pm/SPEAKER_02": "boris",
    "dorm-9pm/SPEAKER_03": "tarun",
    "dorm-40min/SPEAKER_04": "boris",
    "dorm-40min/SPEAKER_06": "tarun",
    "jerry-45min/SPEAKER_03": "tarun",
    "jerry-45min/SPEAKER_04": "boris",
    "mentra-mtg/SPEAKER_00": "alex",
    "mentra-mtg/SPEAKER_02": "boris",
    "mentra-mtg/SPEAKER_03": "brendan",
}
THRESHOLDS = [0.45, 0.50, 0.55, 0.60, 0.65, 0.68, 0.72, 0.75, 0.80]


def load(tag: str):
    pools = []
    for stem in STEMS:
        data = np.load(f"eval/real/{stem}.clusterpool.{tag}.npz", allow_pickle=True)
        meta = json.loads(str(data["meta"]))
        for row, vector in zip(meta, data["vectors"]):
            key = f"{stem}/{row['cluster']}"
            pools.append((stem, key, TRUTH.get(key), row["duration"], set(row["members"]), vector))
    return pools


def describe(name: str, scores: np.ndarray) -> str:
    if len(scores) == 0:
        return f"{name} -"
    return (
        f"{name} n={len(scores):5d} p5 {np.percentile(scores, 5):.3f} median {np.median(scores):.3f} "
        f"p95 {np.percentile(scores, 95):.3f} max {scores.max():.3f}"
    )


def main() -> None:
    tag = sys.argv[1] if len(sys.argv) > 1 else "ecapa"
    pools = load(tag)
    durations = sorted({row[3] for row in pools})
    print(f"{len(pools)} pooled clips, {len({row[1] for row in pools})} clusters, model tag {tag}\n")

    for duration in durations:
        here = [row for row in pools if row[3] == duration]
        same_person, same_cluster, different = [], [], []
        for left, right in itertools.combinations(here, 2):
            score = float(left[5] @ right[5])
            if left[1] == right[1]:
                if not (left[4] & right[4]):
                    same_cluster.append(score)
                continue
            if left[0] == right[0]:
                # Two clusters in one room are two people, but diarization splits
                # one person across clusters often enough that these are not
                # trustworthy as impostor trials. Left out on purpose.
                continue
            if left[2] and right[2]:
                (same_person if left[2] == right[2] else different).append(score)
            else:
                different.append(score)
        same_person = np.array(same_person)
        same_cluster = np.array(same_cluster)
        different = np.array(different)
        print(f"pool {duration:5.0f}s")
        print("  " + describe("same person, different recording ", same_person))
        print("  " + describe("same cluster, same recording      ", same_cluster))
        print("  " + describe("different people, diff recording  ", different))
        if len(same_person) and len(different):
            best = None
            for threshold in THRESHOLDS:
                false_accept = float((different >= threshold).mean())
                miss = float((same_person < threshold).mean())
                if best is None or false_accept + miss < best[1] + best[2]:
                    best = (threshold, false_accept, miss)
            row = "  ".join(
                f"{t:.2f}:{100 * (different >= t).mean():4.1f}/{100 * (same_person < t).mean():4.1f}"
                for t in THRESHOLDS
            )
            print(f"  false-accept/miss %  {row}")
        print()

    print("per-person cross-recording detail at the largest common pool size")
    for duration in durations:
        here = [row for row in pools if row[3] == duration and row[2]]
        by_person = defaultdict(list)
        for left, right in itertools.combinations(here, 2):
            if left[0] == right[0] or left[2] != right[2]:
                continue
            by_person[(left[2], left[0], right[0])].append(float(left[5] @ right[5]))
        if not by_person:
            continue
        print(f"  pool {duration:.0f}s")
        for (person, a, b), scores in sorted(by_person.items()):
            scores = np.array(scores)
            print(f"    {person:8s} {a:12s} <-> {b:12s} n={len(scores):3d} median {np.median(scores):.3f} "
                  f"min {scores.min():.3f}  below 0.68 {100 * (scores < 0.68).mean():5.1f}%")


if __name__ == "__main__":
    main()
