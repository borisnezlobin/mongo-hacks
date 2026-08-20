"""Group chunk-scoped diarization labels into people.

Two scorings are compared on purpose. Raw cosine is the right metric for
deciding whether a voice is someone we have met before, because it preserves
absolute distance. Within a single recording the question is different -- these
labels are all from the same room and microphone, and the job is only to tell
them apart from each other -- which is exactly the case where subtracting the
session mean helps, by removing the channel the labels have in common.
"""
import numpy as np

d = np.load('eval/real/label-prints.npz', allow_pickle=True)
M, labels, seconds = d['M'], list(d['labels']), d['seconds']

def normalise(X):
    return X / np.linalg.norm(X, axis=1, keepdims=True)

def agglomerate(X, threshold):
    """Average-linkage until no pair is closer than `threshold`."""
    groups = [[i] for i in range(len(X))]
    while len(groups) > 1:
        best = None
        for a in range(len(groups)):
            for b in range(a + 1, len(groups)):
                sim = float(np.mean(X[groups[a]] @ X[groups[b]].T))
                if best is None or sim > best[0]:
                    best = (sim, a, b)
        if best[0] < threshold:
            break
        _, a, b = best
        groups[a] += groups[b]
        groups.pop(b)
    return groups

for tag, X in (('raw', normalise(M)), ('centred', normalise(M - M.mean(axis=0)))):
    print(f'\n================ {tag} ================')
    for threshold in (0.75, 0.7, 0.65, 0.6, 0.55, 0.5, 0.45, 0.4, 0.35, 0.3):
        groups = agglomerate(X, threshold)
        big = [g for g in groups if sum(seconds[i] for i in g) >= 30]
        print(f'  t={threshold:.2f}  {len(groups):2d} groups ({len(big)} with >=30s speech)')

X = normalise(M - M.mean(axis=0))
print('\ncentred similarity matrix')
S = X @ X.T
short = [l.replace('1900', '19').replace('950', '95').replace('2850', '28') for l in labels]
print('        ' + ''.join(f'{s:>8}' for s in short))
for i, li in enumerate(short):
    print(f'{li:>8}' + ''.join(f'{S[i, j]:8.2f}' for j in range(len(labels))))
