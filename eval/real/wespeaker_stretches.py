"""WeSpeaker on the LONG stretches, where ECAPA already separates.

The earlier shootout used 1-4s clips and found no model better than another.
That regime is hopeless for every model. The question that matters is whether a
stronger embedding widens the gap in the regime that WORKS -- because the gap is
what decides how badly clustering over-splits.
"""
import os, json
import numpy as np, soundfile as sf, torch
from pyannote.audio import Model
from pyannote.audio.core.inference import Inference

SR=16000
audio,_=sf.read('fixtures/real/dorm-40min.wav',dtype='float32')
d=np.load('eval/real/stretches.npz'); spans=d['spans']
order=sorted(range(len(spans)), key=lambda i:-(spans[i][1]-spans[i][0]))
idx={rank:i for rank,i in enumerate(order)}
BORIS=[idx[1], idx[4], idx[11]]
MERT =[idx[2], idx[6], idx[9], idx[12]]

model=Model.from_pretrained('pyannote/wespeaker-voxceleb-resnet34-LM', token=os.environ['HF_TOKEN'])
inf=Inference(model, window='whole')

def emb(i):
    a,b=spans[i]
    clip=audio[int(a*SR):int(b*SR)]
    v=inf({'waveform': torch.from_numpy(clip).float().unsqueeze(0), 'sample_rate': SR})
    v=np.asarray(v).squeeze()
    return v/np.linalg.norm(v)

V={i:emb(i) for i in BORIS+MERT}
def cos(a,b): return float(V[a] @ V[b])
same=[cos(a,b) for g in (BORIS,MERT) for k,a in enumerate(g) for b in g[k+1:]]
diff=[cos(a,b) for a in BORIS for b in MERT]
same=np.array(same); diff=np.array(diff)
print('WeSpeaker ResNet34-LM on long stretches')
print(f'  SAME  mean {same.mean():+.3f}  min {same.min():+.3f}')
print(f'  DIFF  mean {diff.mean():+.3f}  max {diff.max():+.3f}')
print(f'  gap between them: {same.min()-diff.max():+.3f}')
print('\nECAPA on the same stretches was: SAME min +0.539, DIFF max +0.467, gap +0.072')
