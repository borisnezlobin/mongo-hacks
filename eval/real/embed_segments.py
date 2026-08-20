"""Embed every whisper segment of the real dorm recording with ECAPA.

Writes eval/real/segments.npz (embeddings + timing) so the clustering
experiments below never have to touch the model again.
"""
import json, sys
import numpy as np, soundfile as sf, torch
sys.path.insert(0, 'sidecar')
from speechbrain.inference.speaker import EncoderClassifier

SR = 16000
WAV = 'fixtures/real/dorm-9pm.wav'
ASR = 'fixtures/real/dorm-9pm.whisper.json'

audio, sr = sf.read(WAV, dtype='float32')
assert sr == SR, sr
print(f'audio {len(audio)/SR:.1f}s')

model = EncoderClassifier.from_hparams(
    source='speechbrain/spkrec-ecapa-voxceleb',
    savedir='sidecar/.cache/ecapa', run_opts={'device': 'cpu'})

def embed(clip):
    with torch.no_grad():
        v = model.encode_batch(torch.from_numpy(clip).unsqueeze(0)).squeeze()
    return (v / v.norm(p=2)).numpy()

segs = json.load(open(ASR))['segments']
rows, vecs = [], []
for i, s in enumerate(segs):
    a, b = int(s['start']*SR), int(s['end']*SR)
    clip = audio[a:b]
    dur = len(clip)/SR
    if dur < 0.25:
        rows.append(dict(i=i, start=s['start'], end=s['end'], dur=dur,
                         text=s['text'].strip(), embedded=False))
        vecs.append(np.zeros(192, dtype='float32'))
        continue
    vecs.append(embed(clip))
    rows.append(dict(i=i, start=s['start'], end=s['end'], dur=dur,
                     text=s['text'].strip(), embedded=True))
    print(f'\r{i+1}/{len(segs)}', end='', flush=True)

np.savez('eval/real/segments.npz', emb=np.stack(vecs),
         meta=json.dumps(rows))
print(f'\nembedded {sum(r["embedded"] for r in rows)}/{len(rows)} segments')
