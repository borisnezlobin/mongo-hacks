"""How much pooled speech does reliable identification actually need?

Per-segment ECAPA on this recording is ~27% EER — useless per turn. The whole
bet of the architecture is that pooling fixes it. This measures by how much.
"""
import numpy as np
d=np.load('eval/real/homogeneous.npz', allow_pickle=True)
X,y,start,dur = d['X'], d['y'], d['start'], d['dur']
names=sorted(set(y.tolist()))

def pool(idx, mean=None):
    M=X[idx]
    if mean is not None: M=M-mean
    v=M.mean(axis=0); return v/np.linalg.norm(v)

print('=== enroll on first half of each speaker, test on second half ===')
for sub in (None, X.mean(axis=0)):
    tag='mean-subtracted' if sub is not None else 'raw'
    enroll={}; test={}
    for n in names:
        idx=np.where(y==n)[0]; idx=idx[np.argsort(start[idx])]
        h=len(idx)//2
        enroll[n]=pool(idx[:h], sub); test[n]=pool(idx[h:], sub)
    print(f'\n[{tag}] pooled centroid similarity matrix (rows=test, cols=enrolled)')
    print('           '+''.join(f'{n:>9}' for n in names))
    correct=0
    for t in names:
        sims=[float(test[t]@enroll[e]) for e in names]
        pick=names[int(np.argmax(sims))]
        correct += pick==t
        margin=sorted(sims)[-1]-sorted(sims)[-2]
        print(f'  {t:>8}  '+''.join(f'{s:>9.3f}' for s in sims)+f'   -> {pick} {"OK" if pick==t else "WRONG"} (margin {margin:.3f})')
    print(f'  accuracy {correct}/{len(names)}')

print('\n=== accuracy vs pooled test duration (enroll = first half) ===')
sub=X.mean(axis=0)
enroll={}
for n in names:
    idx=np.where(y==n)[0]; idx=idx[np.argsort(start[idx])]
    enroll[n]=pool(idx[:len(idx)//2], sub)
rng=np.random.default_rng(0)
for budget in (2,4,6,8,12,20,30):
    hits=tot=0; margins=[]
    for n in names:
        idx=np.where(y==n)[0]; idx=idx[np.argsort(start[idx])]
        pool_idx=idx[len(idx)//2:]
        for _ in range(200):
            perm=rng.permutation(pool_idx); chosen=[]; acc=0.0
            for i in perm:
                chosen.append(i); acc+=dur[i]
                if acc>=budget: break
            if acc < budget*0.8: continue
            v=pool(np.array(chosen), sub)
            sims=[float(v@enroll[e]) for e in names]
            hits += names[int(np.argmax(sims))]==n; tot+=1
            margins.append(sorted(sims)[-1]-sorted(sims)[-2])
    if tot: print(f'  {budget:>3}s pooled: {hits/tot*100:5.1f}% correct over {tot} trials, median margin {np.median(margins):.3f}')
