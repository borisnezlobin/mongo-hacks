"""Split the dorm recording into two disjoint 'sessions' per speaker.

First half enrolls, second half tests. Each half gets its OWN session mean,
which is what makes this a cross-session test rather than a self-comparison:
the mean is the room-and-microphone term the matcher has to cancel out.
"""
import json
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

rows=[]
for s in segs:
    if s['speaker'] not in TRUTH: continue
    a,b=int(s['start']*SR),int(s['end']*SR); clip=audio[a:b]
    if len(clip)/SR < 1.0: continue
    rows.append((TRUTH[s['speaker']], s['start'], len(clip)/SR, embed(clip)))

half = sorted(r[1] for r in rows)[len(rows)//2]
out={}
for tag, keep in (('enroll', lambda t: t < half), ('test', lambda t: t >= half)):
    part=[r for r in rows if keep(r[1])]
    mean=np.mean([r[3] for r in part],axis=0)
    speakers={}
    for name in TRUTH.values():
        mine=[r for r in part if r[0]==name]
        if not mine: continue
        v=np.mean([r[3] for r in mine],axis=0)
        speakers[name]={'embedding':[float(x) for x in v],
                        'duration_ms':int(sum(r[2] for r in mine)*1000)}
    out[tag]={'session_mean':[float(x) for x in mean],'speakers':speakers}
    print(tag, {k:v['duration_ms'] for k,v in speakers.items()})

json.dump(out, open('fixtures/real/cross-session.json','w'))
print('wrote fixtures/real/cross-session.json')
