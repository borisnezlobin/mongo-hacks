"""Can voiceprints collapse the diarizer's over-split labels back to 3 people?

gpt-4o-transcribe-diarize emitted 7 labels (A-G) for 3 speakers. Over-splitting
is recoverable and merging is not, so this is the safe failure -- but only if
pooled ECAPA can actually do the merge.
"""
import json
from collections import defaultdict
import numpy as np, soundfile as sf, torch
from speechbrain.inference.speaker import EncoderClassifier

SR=16000
audio,_=sf.read('fixtures/real/dorm-9pm.wav',dtype='float32')
segs=json.load(open('fixtures/real/dorm-9pm.diarize.json'))['segments']
TRUTH={'A':'Josh','C':'Me','G':'Tarun'}

model=EncoderClassifier.from_hparams(source='speechbrain/spkrec-ecapa-voxceleb',
    savedir='sidecar/.cache/ecapa',run_opts={'device':'cpu'})
def embed(c):
    with torch.no_grad(): v=model.encode_batch(torch.from_numpy(c).unsqueeze(0)).squeeze()
    return (v/v.norm(p=2)).numpy()

per=defaultdict(list); secs=defaultdict(float)
allv=[]
for s in segs:
    a,b=int(s['start']*SR),int(s['end']*SR); clip=audio[a:b]; dur=len(clip)/SR
    secs[s['speaker']]+=dur
    if dur<0.5: continue
    v=embed(clip); per[s['speaker']].append(v); allv.append(v)

mean=np.mean(allv,axis=0)
labels=sorted(per, key=lambda k:-secs[k])
print('label  segs  speech   truth')
for L in labels: print(f'  {L}   {len(per[L]):>4}  {secs[L]:6.1f}s   {TRUTH.get(L,"(over-split)")}')

cent={}
for L in labels:
    v=np.mean([x-mean for x in per[L]],axis=0); cent[L]=v/np.linalg.norm(v)

print('\npooled centroid cosine (session mean subtracted)')
print('      '+''.join(f'{L:>7}' for L in labels))
for i in labels:
    print(f'  {i}  '+''.join(f'{float(cent[i]@cent[j]):>7.2f}' for j in labels))

anchors=[L for L in labels if L in TRUTH]
print('\nassign every label to its nearest anchor (A=Josh, C=Me, G=Tarun):')
for L in labels:
    sims={a: float(cent[L]@cent[a]) for a in anchors}
    best=max(sims,key=sims.get)
    ok='' if L not in TRUTH else ('  OK' if best==L else '  <-- WRONG')
    print(f'  {L} ({secs[L]:5.1f}s) -> {TRUTH[best]:5}  ' +
          ' '.join(f'{TRUTH[a]}={sims[a]:+.2f}' for a in anchors) + ok)
