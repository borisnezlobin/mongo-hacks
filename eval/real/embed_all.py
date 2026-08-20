"""Embed every whisper segment and every candidate anchor once, so the
parameters above them can be swept without paying for the model each time."""
import json
import numpy as np, soundfile as sf, torch
from speechbrain.inference.speaker import EncoderClassifier

SR=16000
audio,_=sf.read('fixtures/real/dorm-40min.wav',dtype='float32')
data=json.load(open('fixtures/real/dorm-40min.whisper.json'))
words, segments = data['words'], data['segments']

runs=[]
for w in words:
    s,e=float(w['start']),float(w['end'])
    if runs and s-runs[-1][1]<=0.45: runs[-1][1]=max(runs[-1][1],e)
    else: runs.append([s,e])
anchors=[(s,e) for s,e in runs if e-s>=4.0]
print(f'{len(anchors)} candidate anchors >=4s, {len(segments)} segments')

m=EncoderClassifier.from_hparams(source='speechbrain/spkrec-ecapa-voxceleb',
    savedir='sidecar/.cache/ecapa', run_opts={'device':'cpu'})
def emb(a,b):
    clip=audio[int(a*SR):int(b*SR)]
    if len(clip)<int(0.35*SR): return np.zeros(192,dtype='float32')
    with torch.no_grad():
        v=m.encode_batch(torch.from_numpy(clip).unsqueeze(0)).squeeze()
    return (v/v.norm(p=2)).numpy()

A=np.stack([emb(a,b) for a,b in anchors]); print('anchors embedded')
S=[]
for i,seg in enumerate(segments):
    S.append(emb(float(seg['start']),float(seg['end'])))
    if i%200==0: print(f'\r  segments {i}/{len(segments)}',end='',flush=True)
S=np.stack(S); print()
np.savez('eval/real/allemb.npz', A=A, anchors=np.array(anchors), S=S,
         seg=np.array([[float(x['start']),float(x['end'])] for x in segments]))
print('wrote eval/real/allemb.npz')
