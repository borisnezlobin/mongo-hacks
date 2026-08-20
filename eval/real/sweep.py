import json
import numpy as np

d=np.load('eval/real/allemb.npz')
A, anchors, S, seg = d['A'], d['anchors'], d['S'], d['seg']
full=json.load(open('fixtures/real/dorm-40min.whisper.json'))['segments']
total=float(sum(seg[:,1]-seg[:,0]))

ANCH=[('boris',18.558,19.808),('boris',33.9,35.1),('boris',1633.0,1636.5),('boris',1315.0,1345.0),
      ('vova',24.308,25.908),('vova',28.608,29.458),
      ('mert',887.0,912.0),('mert',1690.0,1706.0),
      ('clara',1809.4,1811.0),('dhruv',2316.78,2317.03)]

def agglomerate(V, thr):
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

def run(anchor_min, link, amin, margin, bracket_gap=2.0):
    keep=[i for i,(a,b) in enumerate(anchors) if b-a>=anchor_min]
    if len(keep)<2: return None
    V=A[keep]
    groups=agglomerate(V, link)
    groups.sort(key=lambda gr: -sum(anchors[keep[i]][1]-anchors[keep[i]][0] for i in gr))
    models=[]
    for gr in groups:
        v=V[gr].mean(axis=0); n=np.linalg.norm(v)
        if n>0: models.append(v/n)
    if not models: return None
    M=np.stack(models)
    sims=S @ M.T
    out=[None]*len(seg)
    for i in range(len(seg)):
        row=sims[i]; o=np.argsort(-row)
        top=row[o[0]]; second=row[o[1]] if len(row)>1 else -1
        if top>=amin and (top-second)>=margin: out[i]=int(o[0])
    conf=[(seg[i][0],seg[i][1],out[i]) for i in range(len(seg)) if out[i] is not None]
    for i in range(len(seg)):
        if out[i] is not None: continue
        s,e=seg[i]
        before=[c for c in conf if c[1]<=s and s-c[1]<=bracket_gap]
        after=[c for c in conf if c[0]>=e and c[0]-e<=bracket_gap]
        if before and after:
            b=max(before,key=lambda c:c[1])[2]; a2=min(after,key=lambda c:c[0])[2]
            if b==a2: out[i]=b
    claimed=float(sum(seg[i][1]-seg[i][0] for i in range(len(seg)) if out[i] is not None))
    def who(a,b):
        best={}
        for i in range(len(seg)):
            if out[i] is None: continue
            ov=min(b,seg[i][1])-max(a,seg[i][0])
            if ov>0: best[out[i]]=best.get(out[i],0)+ov
        return max(best,key=best.get) if best else None
    res={}
    for p,a,b in ANCH:
        w=who(a,b)
        if w is not None: res.setdefault(p,set()).add(w)
    splits=sum(1 for s in res.values() if len(s)>1)
    seen={}; merges=0
    for p,s in res.items():
        for x in s:
            if x in seen and seen[x]!=p: merges+=1
            seen[x]=x and p
    return dict(models=len(models), cov=100*claimed/total, people=len(res), splits=splits, merges=merges)

print('anchor link amin marg | models cov%  people splits merges')
for anchor_min in (6.0, 9.0, 12.0):
    for link in (0.45, 0.50, 0.55):
        for amin in (0.25, 0.30, 0.35):
            for margin in (0.04, 0.06, 0.10):
                r=run(anchor_min, link, amin, margin)
                if not r: continue
                flag='  <-- clean' if r['splits']==0 and r['merges']==0 else ''
                print(f'  {anchor_min:4.1f} {link:.2f} {amin:.2f} {margin:.2f} |   {r["models"]:2d}  {r["cov"]:5.1f}   {r["people"]}     {r["splits"]}      {r["merges"]}{flag}')
