"""How much speech does a person model need before it survives a change of room?

Attribution inside one recording is measured at 100% from 20 seconds of pooled
speech, and CONFIRMED_SPEECH_MS is set from that. Nothing has ever asked what
20 seconds buys when the two sides of the comparison come from DIFFERENT
recordings, which is the only comparison that makes identity persist.

This sweeps the pooled duration on both sides independently and reports the
same-person and different-person cosine distributions at each size, so the gap
-- or its absence -- can be read off directly rather than inferred from an
accuracy number.

Models are built the way a person's voiceprint set is built: an average of the
per-turn embeddings the pipeline already produces, renormalised. Turns are
sampled without replacement to reach the requested duration, so a 20-second
model and a 200-second model differ only in how much evidence is behind them.

  python eval/real/pool_size_sweep.py

Label provenance is printed with the results and is not all equally strong; see
the `SOURCES` table.
"""

import json
import os
import sys
from collections import defaultdict

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

TRIALS = 60
DURATIONS = [10, 20, 40, 80, 160, 320]
MIN_TURN_MS = 700


def reference_labelled(stem: str, purity: float = 0.95):
    """Turn vectors whose speaker the owner-verified reference spans settle."""
    spans = json.load(open(f"eval/real/{stem}.reference.json"))["spans"]
    turns = json.load(open(f"eval/real/{stem}.turnemb.json"))["turns"]
    rows = defaultdict(list)
    for turn in turns:
        if turn["vector"] is None or turn["exclusive_ms"] < MIN_TURN_MS:
            continue
        overlap = defaultdict(float)
        for span in spans:
            lo, hi = max(turn["start_ms"], span["start_ms"]), min(turn["end_ms"], span["end_ms"])
            if hi > lo:
                overlap[span["speaker"].lower()] += hi - lo
        total = sum(overlap.values())
        if total < 0.6 * (turn["end_ms"] - turn["start_ms"]):
            continue
        name, best = max(overlap.items(), key=lambda item: item[1])
        if best / total < purity:
            continue
        rows[name].append((turn["exclusive_ms"], np.array(turn["vector"])))
    return rows


def cluster_labelled(stem: str):
    """Turn vectors grouped by the diarization cluster, with no name attached."""
    turns = json.load(open(f"eval/real/{stem}.turnemb.json"))["turns"]
    rows = defaultdict(list)
    for turn in turns:
        if turn["vector"] is None or turn["exclusive_ms"] < MIN_TURN_MS:
            continue
        rows[turn["speaker"]].append((turn["exclusive_ms"], np.array(turn["vector"])))
    return rows


def pooled_model(members, duration_s: float, rng) -> np.ndarray | None:
    order = rng.permutation(len(members))
    taken, total = [], 0.0
    for index in order:
        if total >= duration_s * 1000:
            break
        taken.append(members[index])
        total += members[index][0]
    if total < duration_s * 1000 * 0.9:
        return None
    weights = np.array([ms for ms, _ in taken], dtype="float64")
    vectors = np.array([vector for _, vector in taken])
    mean = (vectors * weights[:, None]).sum(axis=0) / weights.sum()
    return mean / np.linalg.norm(mean)


def sweep(left, right, label: str) -> None:
    rng = np.random.default_rng(0)
    available = min(sum(ms for ms, _ in left), sum(ms for ms, _ in right)) / 1000
    line = [f"  {label:42s}"]
    for duration in DURATIONS:
        if duration * 1.15 > available:
            line.append(f"{duration:>4}s     -   ")
            continue
        scores = []
        for _ in range(TRIALS):
            a = pooled_model(left, duration, rng)
            b = pooled_model(right, duration, rng)
            if a is None or b is None:
                continue
            scores.append(float(a @ b))
        if not scores:
            line.append(f"{duration:>4}s     -   ")
            continue
        line.append(f"{duration:>4}s {np.median(scores):.3f}")
    print(" ".join(line))


def main() -> None:
    reference = {stem: reference_labelled(stem) for stem in ["dorm-9pm", "dorm-40min"]}
    clusters = {stem: cluster_labelled(stem) for stem in ["dorm-9pm", "dorm-40min", "jerry-45min", "mentra-mtg"]}

    print("owner-labelled speech available (seconds of clean turn audio):")
    for stem, people in reference.items():
        print(f"  {stem}: " + ", ".join(f"{name} {sum(ms for ms, _ in rows) / 1000:.0f}" for name, rows in sorted(people.items())))

    print("\nmedian cosine between two pooled models, by pooled seconds on EACH side")
    print("\n  A. same person, two different recordings (owner-labelled)")
    for name in ["boris", "tarun"]:
        if name in reference["dorm-9pm"] and name in reference["dorm-40min"]:
            sweep(reference["dorm-9pm"][name], reference["dorm-40min"][name], f"dorm-9pm/{name} <-> dorm-40min/{name}")

    print("\n  B. different people, two different recordings (owner-labelled)")
    for left_name in sorted(reference["dorm-9pm"]):
        for right_name in sorted(reference["dorm-40min"]):
            if left_name == right_name:
                continue
            sweep(reference["dorm-9pm"][left_name], reference["dorm-40min"][right_name], f"dorm-9pm/{left_name} <-> dorm-40min/{right_name}")

    print("\n  C. different people, same recording (owner-labelled)")
    for stem in ["dorm-9pm", "dorm-40min"]:
        names = sorted(reference[stem])
        for i in range(len(names)):
            for j in range(i + 1, len(names)):
                sweep(reference[stem][names[i]], reference[stem][names[j]], f"{stem}/{names[i]} <-> {names[j]}")

    print("\n  D. same person, same recording, disjoint halves (owner-labelled)")
    for stem in ["dorm-9pm", "dorm-40min"]:
        for name, rows in sorted(reference[stem].items()):
            half = len(rows) // 2
            if half < 3:
                continue
            sweep(rows[:half], rows[half:], f"{stem}/{name} first half <-> second half")

    print("\n  E. the cross-recording links the graph found (diarization clusters)")
    for (left_stem, left_key), (right_stem, right_key), note in [
        (("dorm-40min", "SPEAKER_04"), ("jerry-45min", "SPEAKER_04"), "boris?"),
        (("dorm-40min", "SPEAKER_04"), ("mentra-mtg", "SPEAKER_02"), "boris?"),
        (("jerry-45min", "SPEAKER_04"), ("mentra-mtg", "SPEAKER_02"), "boris?"),
        (("dorm-40min", "SPEAKER_06"), ("jerry-45min", "SPEAKER_03"), "?"),
        (("dorm-40min", "SPEAKER_04"), ("jerry-45min", "SPEAKER_03"), "different"),
        (("dorm-40min", "SPEAKER_04"), ("mentra-mtg", "SPEAKER_00"), "different"),
        (("dorm-9pm", "SPEAKER_02"), ("dorm-40min", "SPEAKER_04"), "boris/boris"),
        (("dorm-9pm", "SPEAKER_02"), ("jerry-45min", "SPEAKER_04"), "boris/boris?"),
        (("dorm-9pm", "SPEAKER_02"), ("mentra-mtg", "SPEAKER_02"), "boris/boris?"),
    ]:
        sweep(clusters[left_stem][left_key], clusters[right_stem][right_key], f"{left_stem}/{left_key} <-> {right_stem}/{right_key} [{note}]")


if __name__ == "__main__":
    main()
