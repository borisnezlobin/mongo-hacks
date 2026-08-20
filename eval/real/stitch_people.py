"""Stitch chunk-scoped diarization labels into people, and say how sure we are.

The diarizing model caps out at 1400 s, so the 48-minute recording had to be cut
into four overlapping chunks and its speaker labels are only meaningful inside
one chunk: 'A' at the start is a different person from 'A' twenty minutes later.
Joining them back up is a voice problem, and pooled ECAPA is good at it -- each
label here carries tens to hundreds of seconds of speech, far above the point
where a single turn is a coin flip.

Good at it is not the same as right, so nothing here reports a grouping without
also reporting how fragile it is. Every grouping is recomputed a few hundred
times over resampled segments and jittered thresholds, and two labels are only
called the same person if they land together nearly every time. Labels whose
membership wobbles are reported as unresolved rather than guessed, because a
ground truth that quietly guesses is worse than one with holes in it.

Writes eval/real/label-groups.json.
"""
import json
from collections import defaultdict

import numpy as np

CACHE = 'eval/real/merged-segments.npz'
OUT = 'eval/real/label-groups.json'
MIN_LABEL_SECONDS = 8.0
THRESHOLDS = (0.66, 0.68, 0.70, 0.72, 0.74)
DRAWS = 400
TOGETHER = 0.90
SEED = 7


def pooled(vectors, weights):
    v = (vectors * weights[:, None]).sum(axis=0)
    return v / (np.linalg.norm(v) or 1.0)


def agglomerate(X, threshold):
    """Average-linkage merging until no two groups are closer than `threshold`."""
    groups = [[i] for i in range(len(X))]
    sims = X @ X.T
    while len(groups) > 1:
        best = None
        for a in range(len(groups)):
            for b in range(a + 1, len(groups)):
                sim = float(sims[np.ix_(groups[a], groups[b])].mean())
                if best is None or sim > best[0]:
                    best = (sim, a, b)
        if best[0] < threshold:
            break
        _, a, b = best
        groups[a] += groups[b]
        groups.pop(b)
    return groups


def main():
    cache = np.load(CACHE, allow_pickle=True)
    emb, label, dur = cache['emb'], cache['label'], cache['dur']

    by_label = defaultdict(list)
    for i, name in enumerate(label):
        by_label[str(name)].append(i)
    seconds = {name: float(dur[idx].sum()) for name, idx in by_label.items()}
    labels = sorted(
        (name for name, secs in seconds.items() if secs >= MIN_LABEL_SECONDS),
        key=lambda name: -seconds[name],
    )
    index = {name: np.array(by_label[name]) for name in labels}

    full = np.stack([pooled(emb[index[n]], dur[index[n]]) for n in labels])
    # Raw cosine is the right question for "have we met this person before",
    # because it keeps absolute distance. Inside one recording the question is
    # only "are these two the same person in this room", and every label shares
    # the same microphone and the same walls -- so the session mean is common
    # mode, and subtracting it is what turns a matrix of 0.4-to-0.9 into one
    # that actually separates people.
    centre = emb.mean(axis=0)
    centred = np.stack([pooled(emb[index[n]] - centre, dur[index[n]]) for n in labels])

    rng = np.random.default_rng(SEED)
    together = np.zeros((len(labels), len(labels)))
    for draw in range(DRAWS):
        resampled = []
        for name in labels:
            idx = index[name]
            pick = rng.choice(idx, size=len(idx), replace=True)
            resampled.append(pooled(emb[pick], dur[pick]))
        X = np.stack(resampled)
        for group in agglomerate(X, THRESHOLDS[draw % len(THRESHOLDS)]):
            for a in group:
                for b in group:
                    together[a, b] += 1
    together /= DRAWS

    # A person is a set of labels that survive every reasonable perturbation
    # together. Anything that only sometimes joins is left out on purpose.
    parent = list(range(len(labels)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for a in range(len(labels)):
        for b in range(a + 1, len(labels)):
            if together[a, b] >= TOGETHER:
                parent[find(a)] = find(b)

    groups = defaultdict(list)
    for i in range(len(labels)):
        groups[find(i)].append(i)
    ordered = sorted(groups.values(), key=lambda g: -sum(seconds[labels[i]] for i in g))

    result = []
    for n, group in enumerate(ordered):
        members = [labels[i] for i in group]
        # The weakest link inside the group is the group's confidence: one
        # label that only joins 60% of the time makes the whole group doubtful.
        cohesion = min(
            (together[a, b] for a in group for b in group if a != b),
            default=1.0,
        )
        # And the strongest pull towards a different group is what would break
        # it. Two groups that nearly merged are two labels away from being one
        # person, and that has to be visible.
        pull = max(
            (together[a, b] for a in group for b in range(len(labels)) if b not in group),
            default=0.0,
        )
        result.append({
            'group': n,
            'labels': members,
            'seconds': round(sum(seconds[m] for m in members), 1),
            'chunks': sorted({m.split(':')[0] for m in members}, key=int),
            'cohesion': round(float(cohesion), 3),
            'nearest_other': round(float(pull), 3),
        })

    print(f'{len(labels)} labels >= {MIN_LABEL_SECONDS}s -> {len(result)} groups '
          f'over {DRAWS} resamples x thresholds {THRESHOLDS}\n')
    for row in result:
        flag = '' if row['cohesion'] >= TOGETHER and row['nearest_other'] < 0.5 else '   <- fragile'
        print(f"group {row['group']}  {row['seconds']:7.1f}s  cohesion {row['cohesion']:.2f}  "
              f"nearest other {row['nearest_other']:.2f}  {row['labels']}{flag}")

    print('\nco-assignment probability (blank = never)')
    short = [l.replace('1900', '19').replace('950', '95').replace('2850', '28') for l in labels]
    print('       ' + ''.join(f'{s:>7}' for s in short))
    for i, name in enumerate(short):
        cells = ''.join(f'{together[i, j]:7.2f}' if together[i, j] else '      .'
                        for j in range(len(labels)))
        print(f'{name:>7}{cells}')

    json.dump({
        'min_label_seconds': MIN_LABEL_SECONDS,
        'thresholds': list(THRESHOLDS),
        'draws': DRAWS,
        'together_threshold': TOGETHER,
        'labels': labels,
        'seconds': {n: round(seconds[n], 1) for n in labels},
        'co_assignment': {labels[i]: {labels[j]: round(float(together[i, j]), 3)
                                      for j in range(len(labels)) if together[i, j] > 0}
                          for i in range(len(labels))},
        'similarity': {labels[i]: {labels[j]: round(float(full[i] @ full[j]), 3)
                                   for j in range(len(labels))}
                       for i in range(len(labels))},
        'similarity_centred': {labels[i]: {labels[j]: round(float(centred[i] @ centred[j]), 3)
                                           for j in range(len(labels))}
                               for i in range(len(labels))},
        'groups': result,
    }, open(OUT, 'w'), indent=1)
    print(f'\nwrote {OUT}')


main()
