"""The same recipe on any recording. Run on the 3-minute one as a held-out check."""
import json, sys
import numpy as np, soundfile as sf, torch
from speechbrain.inference.speaker import EncoderClassifier

stem = sys.argv[1]
ANCHOR_MIN, LINK, AMIN, MARGIN = 9.0, 0.50, 0.25, 0.06
SR=16000
audio,_=sf.read(f'fixtures/real/{stem}.wav',dtype='float32')
data=json.load(open(f'fixtures/real/{stem}.whisper.json'))
words, segments = data['words'], data['segments']

m=EncoderClassifier.from_hparams(source='speechbrain/spkrec-ecapa-voxceleb',
    savedir='sidecar/.cache/ecapa', run_opts={'device':'cpu'})
def emb(a,b):
    clip=audio[int(a*SR):int(b*SR)]
    if len(clip)<int(0.35*SR): return None
    with torch.no_grad():
        v=m.encode_batch(torch.from_numpy(clip).unsqueeze(0)).squeeze()
    return (v/v.norm(p=2)).numpy()

runs=[]
for w in words:
    s,e=float(w['start']),float(w['end'])
    if runs and s-runs[-1][1]<=0.45: runs[-1][1]=max(runs[-1][1],e)
    else: runs.append([s,e])
anchors=[(s,e) for s,e in runs if e-s>=ANCHOR_MIN]
print(f'{stem}: {len(anchors)} anchors >= {ANCHOR_MIN}s of {len(runs)} stretches')
if len(anchors)<2:
    print('  too few anchors to build models from -- recipe declines to guess')
    longest=sorted((e-s for s,e in runs), reverse=True)[:5]
    print(f'  longest stretches: {[round(x,1) for x in longest]}')
    sys.exit(0)

A=np.stack([emb(a,b) for a,b in anchors])
g=[[i] for i in range(len(A))]
while len(g)>1:
    best=None
    for a in range(len(g)):
        for b in range(a+1,len(g)):
            s=float(np.mean(A[g[a]] @ A[g[b]].T))
            if best is None or s>best[0]: best=(s,a,b)
    if best[0]<LINK: break
    _,a,b=best; g[a]+=g[b]; g.pop(b)
g.sort(key=lambda gr:-sum(anchors[i][1]-anchors[i][0] for i in gr))
M=np.stack([A[gr].mean(0)/np.linalg.norm(A[gr].mean(0)) for gr in g])
print(f'  {len(M)} speaker models: {[round(sum(anchors[i][1]-anchors[i][0] for i in gr)) for gr in g]}s')

out=[]
for seg in segments:
    s,e=float(seg['start']),float(seg['end'])
    v=emb(s,e)
    if v is None: continue
    r=v@M.T; o=np.argsort(-r)
    if r[o[0]]>=AMIN and (r[o[0]]-(r[o[1]] if len(r)>1 else -1))>=MARGIN:
        out.append({'start':s,'end':e,'speaker':f'S{o[0]}','text':seg['text'].strip()})
tot=sum(float(x['end'])-float(x['start']) for x in segments)
cl=sum(o['end']-o['start'] for o in out)
print(f'  coverage {len(out)}/{len(segments)} segments, {cl:.0f}s of {tot:.0f}s ({100*cl/tot:.0f}%)')
json.dump({'segments':out}, open(f'eval/real/{stem}.anchor.json','w'))
