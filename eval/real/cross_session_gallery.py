"""Does a person model built from OTHER recordings beat one built from this one?

The premise under test: a voice model pooled across a person's recordings
identifies them better than anything computed inside a single recording. It is
easy to make that come out true by accident, because a model pooled from four
recordings has four times the speech; so the evidence budget is held fixed here.
Every gallery model is built from the same number of seconds, and only the
provenance of those seconds changes:

  within   all of it from the recording the query came from
  cross    none of it from the recording the query came from
  mixed    half and half

The query is a short pool of the person's speech, held out of every model. The
gallery is one model per person, and every diarization cluster that is not one
of the identified people enters as its own stranger, because in this product
most voices are strangers and a metric that cannot say "nobody I know" is
useless.

  python eval/real/cross_session_gallery.py

Identity of the clusters is in `PEOPLE`; the provenance of each label is in the
comment beside it, and they are not equally strong.
"""

import sys
import os
from collections import defaultdict

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cross_recording import STEMS  # noqa: E402
from pool_size_sweep import cluster_labelled  # noqa: E402

# Cluster -> person. Provenance, strongest first:
#   dorm-40min/04, dorm-40min/06   owner reference spans, 0.92 and 0.59 purity
#   dorm-9pm/01,02,03              owner-verified landmarks in eval/landmarks.ts
#   jerry-45min/04                 says "Jerry" to somebody else six times
#   jerry-45min/03                 says "Boris" to somebody else three times, and
#                                  "Jerry" twice, leaving the third participant
#   mentra-mtg/02                  "Amelia, our MongoDB hackathon project", said
#                                  by the person whose project it is
PEOPLE = {
    ("dorm-9pm", "SPEAKER_02"): "boris",
    ("dorm-9pm", "SPEAKER_01"): "joshua",
    ("dorm-9pm", "SPEAKER_03"): "tarun",
    ("dorm-40min", "SPEAKER_04"): "boris",
    ("dorm-40min", "SPEAKER_06"): "tarun",
    ("jerry-45min", "SPEAKER_04"): "boris",
    ("jerry-45min", "SPEAKER_03"): "tarun",
    ("mentra-mtg", "SPEAKER_02"): "boris",
}

QUERY_DURATIONS = [2, 4, 8, 20, 60]
MODEL_BUDGETS = [20, 60, 160]
TRIALS = 40


def weighted_mean(rows) -> np.ndarray:
    weights = np.array([ms for ms, _ in rows], dtype="float64")
    vectors = np.array([vector for _, vector in rows])
    mean = (vectors * weights[:, None]).sum(axis=0) / weights.sum()
    return mean / np.linalg.norm(mean)


def take(rows, budget_ms: float, rng):
    """A random subset of turns reaching the budget, and what is left over."""
    order = list(rng.permutation(len(rows)))
    taken, total = [], 0.0
    for position, index in enumerate(order):
        if total >= budget_ms:
            return [rows[i] for i in taken], [rows[i] for i in order[position:]]
        taken.append(index)
        total += rows[index][0]
    return ([rows[i] for i in taken], []) if total >= budget_ms * 0.9 else (None, [])


def build(clusters, person_of, budget_ms, exclude_stem, mode, rng, held_out):
    """One model per person, each from `budget_ms` of speech of the given provenance."""
    sources = defaultdict(list)
    for (stem, key), rows in clusters.items():
        person = person_of.get((stem, key), f"stranger:{stem}/{key}")
        pool = held_out.get((stem, key), rows)
        sources[person].append((stem, pool))

    models = {}
    for person, parts in sources.items():
        own = [row for stem, rows in parts if stem == exclude_stem for row in rows]
        other = [row for stem, rows in parts if stem != exclude_stem for row in rows]
        if mode == "within":
            chosen, _ = take(own, budget_ms, rng)
        elif mode == "cross":
            chosen, _ = take(other, budget_ms, rng)
        else:
            first, _ = take(own, budget_ms / 2, rng)
            second, _ = take(other, budget_ms / 2, rng)
            chosen = (first or []) + (second or []) if (first or second) else None
        if chosen:
            models[person] = weighted_mean(chosen)
    return models


def main() -> None:
    clusters = {}
    for stem in STEMS:
        for key, rows in cluster_labelled(stem).items():
            if sum(ms for ms, _ in rows) >= 20_000:
                clusters[(stem, key)] = rows

    print("gallery: " + ", ".join(sorted({PEOPLE.get(k, "stranger") for k in clusters})))
    print(f"{len(clusters)} clusters, {sum(1 for k in clusters if k in PEOPLE)} of them identified\n")

    rng = np.random.default_rng(0)
    for query_stem, query_key in sorted(k for k in clusters if k in PEOPLE):
        person = PEOPLE[(query_stem, query_key)]
        rows = clusters[(query_stem, query_key)]
        if sum(ms for ms, _ in rows) < 60_000:
            continue
        print(f"query {query_stem}/{query_key} = {person}")
        for budget in MODEL_BUDGETS:
            line = f"    model budget {budget:3d}s "
            for mode in ["within", "cross", "mixed"]:
                cells = []
                for duration in QUERY_DURATIONS:
                    hits, total, above = 0, 0, 0
                    for _ in range(TRIALS):
                        query_rows, rest = take(rows, duration * 1000, rng)
                        if query_rows is None or not rest:
                            continue
                        models = build(
                            clusters,
                            PEOPLE,
                            budget * 1000,
                            query_stem,
                            mode,
                            rng,
                            {(query_stem, query_key): rest},
                        )
                        if person not in models or len(models) < 2:
                            continue
                        query = weighted_mean(query_rows)
                        ranked = sorted(
                            ((float(query @ vector), name) for name, vector in models.items()), reverse=True
                        )
                        total += 1
                        hits += ranked[0][1] == person
                        above += ranked[0][0] >= 0.68
                    cells.append(f"{duration}s {100 * hits / total:3.0f}%" if total else f"{duration}s   - ")
                line += f" | {mode:6s} " + " ".join(cells)
            print(line)
        print()

    impostors(clusters, rng)


def impostors(clusters, rng, budget_ms: int = 160_000, trials: int = 60) -> None:
    """What a voice that is NOT in the gallery scores against it.

    Failing to link somebody costs a name prompt. Linking two different people
    costs one person's facts filed under another and is not recoverable by
    asking, so the impostor tail is the number that decides the threshold.
    """
    print("impostor trials: a cluster scored against models built only from OTHER recordings")
    print("(genuine = the same person's model is in the gallery; impostor = it is not)\n")
    genuine, impostor = [], []
    by_query = defaultdict(list)
    for (stem, key), rows in sorted(clusters.items()):
        person = PEOPLE.get((stem, key))
        for _ in range(trials):
            query_rows, rest = take(rows, 20_000, rng)
            if query_rows is None or not rest:
                continue
            models = build(clusters, PEOPLE, budget_ms, stem, "cross", rng, {(stem, key): rest})
            query = weighted_mean(query_rows)
            for name, vector in models.items():
                score = float(query @ vector)
                same = person is not None and name == person
                (genuine if same else impostor).append(score)
                if same:
                    by_query[f"{stem}/{key} = {person}"].append(score)
    genuine, impostor = np.array(genuine), np.array(impostor)
    print(f"  genuine  n={len(genuine):5d}  mean {genuine.mean():.3f}  p5 {np.percentile(genuine, 5):.3f}  "
          f"p50 {np.median(genuine):.3f}  min {genuine.min():.3f}")
    print(f"  impostor n={len(impostor):5d}  mean {impostor.mean():.3f}  p95 {np.percentile(impostor, 95):.3f}  "
          f"p99 {np.percentile(impostor, 99):.3f}  max {impostor.max():.3f}")
    print("\n  genuine scores, split by which recording the query came from")
    for label, scores in sorted(by_query.items()):
        scores = np.array(scores)
        print(f"    {label:34s} n={len(scores):4d}  median {np.median(scores):.3f}  "
              f"below 0.68 {100 * (scores < 0.68).mean():5.1f}%")

    print("\n  threshold   false accept   miss")
    for threshold in [0.50, 0.55, 0.60, 0.65, 0.68, 0.72, 0.75, 0.80, 0.85]:
        print(f"    {threshold:.2f}        {100 * (impostor >= threshold).mean():6.2f}%     "
              f"{100 * (genuine < threshold).mean():6.2f}%")


if __name__ == "__main__":
    main()
