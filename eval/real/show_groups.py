import json
import numpy as np

d = np.load('eval/real/label-prints.npz', allow_pickle=True)
M, labels, seconds = d['M'], list(d['labels']), d['seconds']
X = M / np.linalg.norm(M, axis=1, keepdims=True)
segs = json.load(open('fixtures/real/dorm-40min.merged.json'))['segments']

def agglomerate(X, threshold):
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
        groups[a] += groups[b]; groups.pop(b)
    return groups

groups = agglomerate(X, 0.70)
groups.sort(key=lambda g: -sum(seconds[i] for i in g))
for n, g in enumerate(groups):
    members = [labels[i] for i in g]
    total = sum(seconds[i] for i in g)
    chunks = sorted({m.split(':')[0] for m in members})
    print(f'\n=== group {n}  {total:6.1f}s  labels {members}  chunks {chunks}')
    text = [s for s in segs if s['label'] in members and len(s['text']) > 25]
    for s in text[:6]:
        print(f'    {s["start"]:7.1f} {s["text"][:88]}')
