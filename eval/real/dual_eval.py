"""Evaluate the anchor recipe on BOTH recordings at once.

A fixed minimum anchor length does not generalise: the 48-minute conversation
contains long monologues, the 3-minute one is rapid back-and-forth whose longest
uninterrupted stretch is far shorter. Demanding 9 s there left three anchors,
all from one person, and collapsed three people into one.

So anchors are chosen relative to what the recording contains -- the longest
stretches available, above a floor where an embedding still means something.
"""
import json
import numpy as np, soundfile as sf, torch
from speechbrain.inference.speaker import EncoderClassifier

SR=16000
m=EncoderClassifier.from_hparams(source='speechbrain/spkrec-ecapa-voxceleb',
    savedir='sidecar/.cache/ecapa', run_opts={'device':'cpu'})

RECORDINGS={
 'dorm-9pm':[('joshua',5.78,9.42),('boris',138.9,141.3),('tarun',122.64,125.88)],
 'dorm-40min':[('boris',1315.0,1345.0),('boris',1633.0,1636.5),
               ('mert',887.0,912.0),('mert',1690.0,1706.0),
               ('clara',1809.4,1811.0)],
}

cache={}
def load(stem):
    if stem in cache: return cache[stem]
    audio,_=sf.read(f'fixtures/real/{stem}.wav',dtype='float32')
    data=json.load(open(f'fixtures/real/{stem}.whisper.json'))
    runs=[]
    for w in data['words']:
        s,e=float(w['start']),float(w['end'])
        if runs and s-runs[-1][1]<=0.45: runs[-1][1]=max(runs[-1][1],e)
        else: runs.append([s,e])
    def emb(a,b):
        clip=audio[int(a*SR):int(b*SR)]
        if len(clip)<int(0.35*SR): return None
        with torch.no_grad():
            v=m.encode_batch(torch.from_numpy(clip).unsqueeze(0)).squeeze()
        return (v/v.norm(p=2)).numpy()
    stretches=sorted([(s,e) for s,e in runs if e-s>=3.0], key=lambda r:-(r[1]-r[0]))
    SA=np.stack([emb(a,b) for a,b in stretches])
    segs=data['segments']
    SS=[]
    for x in segs:
        v=emb(float(x['start']),float(x['end']))
        SS.append(v if v is not None else np.zeros(192,dtype='float32'))
    cache[stem]=(stretches,SA,segs,np.stack(SS))
    return cache[stem]

def agglo(V,thr):
    g=[[i] for i in range(len(V))]
    while len(g)>1:
        best=None
        for a in range(len(g)):
            for b in range(a+1,len(g)):
                s=float(np.mean(V[g[a]] @ V[g[b]].T))
                if best is None or s>best[0]: best=(s,a,b)
        if best[0]<thr: break
        _,a,b=best; g[a]+=g[b]; g.pop(b)
    return g

def evaluate(stem, n_anchors, floor, link, amin, margin):
    stretches,SA,segs,SS=load(stem)
    keep=[i for i,(a,b) in enumerate(stretches) if b-a>=floor]
    if n_anchors: keep=keep[:n_anchors]
    if len(keep)<2: return None
    V=SA[keep]
    g=agglo(V,link)
    g.sort(key=lambda gr:-sum(stretches[keep[i]][1]-stretches[keep[i]][0] for i in gr))
    M=np.stack([V[gr].mean(0)/np.linalg.norm(V[gr].mean(0)) for gr in g])
    lab=[None]*len(segs)
    R=SS@M.T
    for i in range(len(segs)):
        r=R[i]; o=np.argsort(-r)
        if r[o[0]]>=amin and (r[o[0]]-(r[o[1]] if len(r)>1 else -1))>=margin: lab[i]=int(o[0])
    tot=sum(float(x['end'])-float(x['start']) for x in segs)
    cl=sum(float(segs[i]['end'])-float(segs[i]['start']) for i in range(len(segs)) if lab[i] is not None)
    def who(a,b):
        best={}
        for i,x in enumerate(segs):
            if lab[i] is None: continue
            ov=min(b,float(x['end']))-max(a,float(x['start']))
            if ov>0: best[lab[i]]=best.get(lab[i],0)+ov
        return max(best,key=best.get) if best else None
    res={}
    for p,a,b in RECORDINGS[stem]:
        w=who(a,b)
        if w is not None: res.setdefault(p,set()).add(w)
    splits=sum(1 for s in res.values() if len(s)>1)
    seen={}; merges=0
    for p,s in res.items():
        for x in s:
            if x in seen and seen[x]!=p: merges+=1
            seen[x]=p
    return dict(models=len(M), cov=100*cl/tot, resolved=len(res), splits=splits, merges=merges)

print('use ALL stretches above the floor, not a fixed count\n')
print('  floor link |        dorm-9pm         |       dorm-40min')
print('             | mdl cov%  res spl mrg  | mdl cov%  res spl mrg')
for n in (None,):
    for floor in (3.0, 4.0, 5.0, 6.0, 8.0):
        for link in (0.45, 0.50, 0.55):
            a=evaluate('dorm-9pm', n, floor, link, 0.25, 0.06)
            b=evaluate('dorm-40min', n, floor, link, 0.25, 0.06)
            if not a or not b: continue
            clean = a['splits']==0 and a['merges']==0 and b['splits']==0 and b['merges']==0
            good = clean and a['resolved']==3 and b['resolved']>=3
            print(f'  {floor:.1f}  {link:.2f} |  {a["models"]:2d} {a["cov"]:5.1f}  {a["resolved"]}   {a["splits"]}   {a["merges"]}   '
                  f'|  {b["models"]:2d} {b["cov"]:5.1f}  {b["resolved"]}   {b["splits"]}   {b["merges"]}' + ('   <-- both clean, all resolved' if good else ''))
