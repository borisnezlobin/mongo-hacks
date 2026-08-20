"""Do long uninterrupted stretches separate, when short clips do not?

A 1.5 s window in this room embeds the room. A 10 s monologue is mostly one
person, because whoever else is audible is not talking for all ten seconds. If
long stretches separate cleanly, the recipe is: cluster the clean stretches to
build reliable speaker models, then assign everything else to those -- rather
than clustering thousands of individually meaningless windows.
"""
import json
import numpy as np, soundfile as sf, torch
from speechbrain.inference.speaker import EncoderClassifier

SR = 16000
audio, _ = sf.read('fixtures/real/dorm-40min.wav', dtype='float32')
words = json.load(open('fixtures/real/dorm-40min.whisper.json'))['words']

# Continuous speech: words with no gap longer than this between them.
MAX_GAP = 0.45
runs = []
for w in words:
    s, e = float(w['start']), float(w['end'])
    if runs and s - runs[-1][1] <= MAX_GAP:
        runs[-1][1] = max(runs[-1][1], e)
    else:
        runs.append([s, e])
runs = [(s, e) for s, e in runs if e - s >= 4.0]
runs.sort(key=lambda r: r[1] - r[0], reverse=True)
print(f'{len(runs)} uninterrupted stretches >= 4s')
for s, e in runs[:12]:
    print(f'   {e-s:5.1f}s at {int(s//60)}:{int(s%60):02d}')

model = EncoderClassifier.from_hparams(source='speechbrain/spkrec-ecapa-voxceleb',
    savedir='sidecar/.cache/ecapa', run_opts={'device':'cpu'})
def embed(a, b):
    clip = audio[int(a*SR):int(b*SR)]
    with torch.no_grad():
        v = model.encode_batch(torch.from_numpy(clip).unsqueeze(0)).squeeze()
    return (v / v.norm(p=2)).numpy()

top = runs[:40]
V = np.stack([embed(a, b) for a, b in top])
S = V @ V.T
off = S[~np.eye(len(S), dtype=bool)]
print(f'\n{len(top)} longest stretches ({min(e-s for s,e in top):.1f}-{max(e-s for s,e in top):.1f}s)')
print(f'pairwise cosine: mean {off.mean():+.3f}  p90 {np.quantile(off,0.9):+.3f}  max {off.max():+.3f}')
strong = (off > 0.5).sum() / len(off)
print(f'fraction of pairs above 0.5: {strong:.1%}   (if these were all different people it should be near 0)')
np.savez('eval/real/stretches.npz', V=V, spans=np.array(top))
