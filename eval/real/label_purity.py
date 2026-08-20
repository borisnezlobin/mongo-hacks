"""Does any pyannote label hold two different people?

A label is supposed to be one voice. If it is really two, its embeddings
split into two well-separated clusters; if it is one, a forced 2-way split
finds only noise. Run every label through the same forced split and compare
them against each other, so the number that matters is the contrast between
labels rather than any absolute threshold.
"""
import json, sys
import numpy as np, soundfile as sf, torch
sys.path.insert(0, 'sidecar')
from speechbrain.inference.speaker import EncoderClassifier

SR = 16000
STEM = sys.argv[1] if len(sys.argv) > 1 else 'dorm-40min'
MIN_DUR = 1.5      # shorter clips embed to noise
audio, sr = sf.read(f'fixtures/real/{STEM}.wav', dtype='float32')
if audio.ndim > 1: audio = audio.mean(axis=1)
assert sr == SR, sr

turns = json.load(open(f'fixtures/real/{STEM}.pyannote.json'))['turns']

# Only turns nobody else overlaps: a blended clip tells us nothing about
# whose voice the label is, which is the mistake that cost us a week.
def clean(t):
    for o in turns:
        if o is t or o['speaker'] == t['speaker']: continue
        if o['start_ms'] < t['end_ms'] and t['start_ms'] < o['end_ms']: return False
    return True

model = EncoderClassifier.from_hparams(
    source='speechbrain/spkrec-ecapa-voxceleb',
    savedir='sidecar/.cache/ecapa', run_opts={'device': 'cpu'})

def embed(clip):
    with torch.no_grad():
        v = model.encode_batch(torch.from_numpy(clip).unsqueeze(0)).squeeze()
    return (v / v.norm(p=2)).numpy()

def split_quality(V):
    """Forced 2-means; return between-cluster distance and the split sizes."""
    best = None
    for seed in range(8):
        rng = np.random.default_rng(seed)
        c = V[rng.choice(len(V), 2, replace=False)]
        for _ in range(30):
            a = np.argmax(V @ c.T, axis=1)
            if len(set(a.tolist())) < 2: break
            c = np.stack([V[a == k].mean(axis=0) for k in (0, 1)])
            c /= np.linalg.norm(c, axis=1, keepdims=True)
        if len(set(a.tolist())) < 2: continue
        gap = 1 - float(c[0] @ c[1])
        if best is None or gap > best[0]: best = (gap, a)
    return best

print(f'{"label":12} {"clips":>5} {"split gap":>10}  sizes / when each side speaks')
for sp in sorted({t['speaker'] for t in turns}):
    mine = [t for t in turns if t['speaker'] == sp
            and t['end_ms'] - t['start_ms'] >= MIN_DUR * 1000 and clean(t)]
    if len(mine) < 8:
        print(f'{sp:12} {len(mine):5}  too few clean clips'); continue
    V = np.stack([embed(audio[int(t["start_ms"]/1000*SR):int(t["end_ms"]/1000*SR)]) for t in mine])
    res = split_quality(V)
    if res is None:
        print(f'{sp:12} {len(mine):5}  no split'); continue
    gap, a = res
    t0 = [mine[i]['start_ms']/60000 for i in range(len(mine)) if a[i] == 0]
    t1 = [mine[i]['start_ms']/60000 for i in range(len(mine)) if a[i] == 1]
    print(f'{sp:12} {len(mine):5} {gap:10.3f}  {len(t0)}/{len(t1)}  '
          f'A {min(t0):.0f}-{max(t0):.0f}min  B {min(t1):.0f}-{max(t1):.0f}min')
