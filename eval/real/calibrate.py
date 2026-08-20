"""Pick an operating point from many trials, not from one lucky example.

Enrollment and test come from disjoint halves of the recording, so no trial
compares a segment against itself. Impostor trials include a speaker who was
never enrolled at all, which is the case that actually matters: the app will
meet far more strangers than friends, and handing a stranger a friend's name
is the one error the user would never catch.
"""
import numpy as np

d = np.load('eval/real/homogeneous.npz', allow_pickle=True)
X, y, start, dur = d['X'], d['y'], d['start'], d['dur']
names = sorted(set(y.tolist()))
rng = np.random.default_rng(7)

def pool(idx):
    v = X[idx].mean(axis=0)
    return v / np.linalg.norm(v)

def cos(a, b): return float(a @ b)

split = np.median(start)
enroll_idx = {n: np.where((y == n) & (start < split))[0] for n in names}
test_idx = {n: np.where((y == n) & (start >= split))[0] for n in names}
for n in names:
    print(f'{n}: enroll {len(enroll_idx[n])} segs / test {len(test_idx[n])} segs')

TRIALS = 400
BUDGET = 20.0
for enrolled_set in (['Josh', 'Me'], ['Josh', 'Me', 'Tarun']):
    prints = {n: pool(enroll_idx[n]) for n in enrolled_set if len(enroll_idx[n]) > 0}
    target, impostor = [], []
    for n in names:
        pool_src = test_idx[n]
        if len(pool_src) == 0: continue
        for _ in range(TRIALS):
            perm = rng.permutation(pool_src); chosen = []; acc = 0.0
            for i in perm:
                chosen.append(i); acc += dur[i]
                if acc >= BUDGET: break
            v = pool(np.array(chosen))
            for who, p in prints.items():
                (target if who == n else impostor).append(cos(v, p))
    target, impostor = np.array(target), np.array(impostor)
    print(f'\n=== enrolled: {sorted(prints)} ({len(target)} target / {len(impostor)} impostor trials) ===')
    print(f'  target   mean {target.mean():.3f}  p5  {np.percentile(target,5):.3f}  min {target.min():.3f}')
    print(f'  impostor mean {impostor.mean():.3f}  p95 {np.percentile(impostor,95):.3f}  max {impostor.max():.3f}')
    print('   thr   false-accept   miss')
    for t in (0.50, 0.55, 0.60, 0.65, 0.68, 0.70, 0.75, 0.80):
        print(f'  {t:.2f}   {(impostor>=t).mean()*100:11.1f}%  {(target<t).mean()*100:5.1f}%')
