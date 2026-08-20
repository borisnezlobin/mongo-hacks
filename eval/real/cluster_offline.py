"""Offline reference diarization: average-linkage agglomerative clustering
over the ECAPA segment embeddings. Full-conversation, non-streaming — this is
the silver standard the live streaming clusterer gets scored against."""
import json
import numpy as np

d = np.load('eval/real/segments.npz')
emb = d['emb']; meta = json.loads(str(d['meta']))
ok = [i for i, m in enumerate(meta) if m['embedded'] and m['dur'] >= 1.0]
X = emb[ok]
X = X / np.linalg.norm(X, axis=1, keepdims=True)
S = X @ X.T
np.fill_diagonal(S, -1)
print(f'{len(ok)} segments >=1.0s')
print(f'pairwise cosine: min={S[S>-1].min():.3f} max={S.max():.3f} mean={S[S>-1].mean():.3f}')
print()

# average-linkage agglomerative down to K clusters
clusters = [[i] for i in range(len(ok))]
def avg_link(a, b):
    return float(np.mean(X[a] @ X[b].T))
merges = []
while len(clusters) > 2:
    best = None
    for i in range(len(clusters)):
        for j in range(i+1, len(clusters)):
            s = avg_link(clusters[i], clusters[j])
            if best is None or s > best[0]: best = (s, i, j)
    s, i, j = best
    merges.append((len(clusters), s))
    if len(clusters) <= 8:
        print(f'  merging at k={len(clusters)} link={s:.3f}')
    clusters[i] = clusters[i] + clusters[j]
    clusters.pop(j)
    if len(clusters) == 3:
        snapshot = [list(c) for c in clusters]
print()
lab = {}
for cid, c in enumerate(snapshot):
    for idx in c: lab[ok[idx]] = cid
print('=== 3-cluster reference ===')
for i, m in enumerate(meta):
    c = lab.get(i)
    tag = f'S{c}' if c is not None else ' ?'
    print(f'{tag} [{m["start"]:6.2f}] ({m["dur"]:4.1f}s) {m["text"][:78]}')
json.dump({str(k): v for k, v in lab.items()}, open('eval/real/reference.json','w'))
