"""Cluster the clean stretches, then let everything else join them.

The measurement that motivates this: on uninterrupted stretches of 9-31 s, two
people identified from content separate with same-speaker cosine bottoming at
0.539 and cross-speaker peaking at 0.467. On 1.5 s windows from the same
recording the same two are inseparable. Length is what buys the signal, because
a long stretch is mostly one person while a short one is mostly the room.

So the clean stretches are the only thing worth clustering. They become speaker
models; everything else is assigned to them, and anything that does not clearly
belong to one is left unassigned rather than guessed.
"""
import numpy as np

d = np.load('eval/real/stretches.npz')
V, spans = d['V'], d['spans']
lengths = spans[:, 1] - spans[:, 0]

def agglomerate(V, threshold):
    groups = [[i] for i in range(len(V))]
    while len(groups) > 1:
        best = None
        for a in range(len(groups)):
            for b in range(a + 1, len(groups)):
                sim = float(np.mean(V[groups[a]] @ V[groups[b]].T))
                if best is None or sim > best[0]:
                    best = (sim, a, b)
        if best[0] < threshold: break
        _, a, b = best
        groups[a] += groups[b]; groups.pop(b)
    return groups

print('threshold sweep over the 40 longest stretches\n')
print(' thr | groups | groups holding >=2 stretches | seconds in each group')
for t in (0.40, 0.45, 0.50, 0.55, 0.60, 0.65):
    g = agglomerate(V, t)
    g.sort(key=lambda grp: -sum(lengths[i] for i in grp))
    multi = sum(1 for grp in g if len(grp) >= 2)
    secs = [round(float(sum(lengths[i] for i in grp))) for grp in g]
    print(f' {t:.2f} |   {len(g):3d}  |             {multi:3d}              | {secs[:9]}')
