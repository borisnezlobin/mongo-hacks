"""Measure ECAPA separability on REAL room audio using diarization-derived,
speaker-homogeneous segments. The prior calibration used synthetic TTS."""
import json
import numpy as np, soundfile as sf, torch
from speechbrain.inference.speaker import EncoderClassifier

SR=16000
audio,_ = sf.read('fixtures/real/dorm-9pm.wav', dtype='float32')
segs = json.load(open('fixtures/real/dorm-9pm.diarize.json'))['segments']
NAME = {'A':'Josh','C':'Me','G':'Tarun'}

model = EncoderClassifier.from_hparams(source='speechbrain/spkrec-ecapa-voxceleb',
    savedir='sidecar/.cache/ecapa', run_opts={'device':'cpu'})
def embed(c):
    with torch.no_grad(): v = model.encode_batch(torch.from_numpy(c).unsqueeze(0)).squeeze()
    return (v/v.norm(p=2)).numpy()

rows=[]
for s in segs:
    spk=s.get('speaker')
    if spk not in NAME: continue
    a,b=int(s['start']*SR),int(s['end']*SR)
    clip=audio[a:b]; dur=len(clip)/SR
    if dur < 1.0: continue
    rows.append((NAME[spk], s['start'], dur, embed(clip), s['text'].strip()))

print(f'{len(rows)} homogeneous segments >=1.0s')
for n in NAME.values(): print(f'  {n}: {sum(1 for r in rows if r[0]==n)} segs, {sum(r[2] for r in rows if r[0]==n):.0f}s')

X=np.stack([r[3] for r in rows]); y=[r[0] for r in rows]
def report(tag, M):
    M = M/np.linalg.norm(M,axis=1,keepdims=True)
    S=M@M.T
    same=[S[i,j] for i in range(len(y)) for j in range(i+1,len(y)) if y[i]==y[j]]
    diff=[S[i,j] for i in range(len(y)) for j in range(i+1,len(y)) if y[i]!=y[j]]
    same,diff=np.array(same),np.array(diff)
    # equal error threshold sweep
    best=None
    for t in np.arange(-0.2,0.95,0.005):
        fr=(same<t).mean(); fa=(diff>=t).mean()
        if best is None or abs(fr-fa)<abs(best[1]-best[2]): best=(t,fr,fa)
    print(f'\n[{tag}]')
    print(f'  same-speaker : mean {same.mean():.3f}  p5 {np.percentile(same,5):.3f}  min {same.min():.3f}')
    print(f'  diff-speaker : mean {diff.mean():.3f}  p95 {np.percentile(diff,95):.3f}  max {diff.max():.3f}')
    print(f'  EER threshold {best[0]:.3f}  EER ~{(best[1]+best[2])/2*100:.1f}%')
    return best[0]

report('raw cosine', X)
report('session-mean-subtracted', X - X.mean(axis=0))
np.savez('eval/real/homogeneous.npz', X=X, y=np.array(y),
         start=np.array([r[1] for r in rows]), dur=np.array([r[2] for r in rows]))
