"""Is the embedding broken, or are we embedding blends?

Every clip here has a speaker that the words themselves settle -- a
self-introduction names its own speaker. If ECAPA separates these, the model is
fine and the inverted similarities come from pooling impure diarizer labels. If
it does not, the model is the problem.
"""
import numpy as np, soundfile as sf, torch
from speechbrain.inference.speaker import EncoderClassifier

SR = 16000
audio, _ = sf.read('fixtures/real/dorm-40min.wav', dtype='float32')

# (person, start_s, end_s, why it is certain)
CLIPS = [
    ('boris', 18.558, 19.808, "'Hello, I'm Boris.'"),
    ('boris', 33.9,   35.1,   "'name is your name? Boris.'"),
    ('boris', 1633.0, 1636.5, "reads the borisen.com email"),
    ('vova',  24.308, 25.908, "'I'm Ukrainian, nice to meet you'"),
    ('vova',  28.608, 29.458, "'I'm Vova.'"),
    ('vova',  55.5,   60.0,   "'Also Josh, tomorrow...' (Vova per ground truth)"),
    ('clara', 1809.4, 1811.0, "'My sister goes to Cal Poly.'"),
    ('clara', 1813.2, 1817.0, "'these stickers are from me...'"),
    ('dhruv', 2316.78, 2317.03, "'Drew.'"),
    ('dhruv', 2318.53, 2319.03, "'Nice to meet you.'"),
]

model = EncoderClassifier.from_hparams(source='speechbrain/spkrec-ecapa-voxceleb',
    savedir='sidecar/.cache/ecapa', run_opts={'device': 'cpu'})

def embed(a, b):
    clip = audio[int(a*SR):int(b*SR)]
    with torch.no_grad():
        v = model.encode_batch(torch.from_numpy(clip).unsqueeze(0)).squeeze()
    return (v / v.norm(p=2)).numpy(), len(clip)/SR

vecs = []
print('clips:')
for person, a, b, why in CLIPS:
    v, dur = embed(a, b)
    vecs.append((person, v, dur, why))
    print(f'  {person:<6} {dur:4.2f}s  {why}')

print('\npairwise cosine (SAME speaker marked *):')
same, diff = [], []
for i in range(len(vecs)):
    for j in range(i+1, len(vecs)):
        pi, vi, _, _ = vecs[i]; pj, vj, _, _ = vecs[j]
        c = float(vi @ vj)
        (same if pi == pj else diff).append(c)
        if pi == pj:
            print(f'  * {pi}/{pj}  {c:+.3f}')
same, diff = np.array(same), np.array(diff)
print(f'\nSAME speaker : n={len(same)}  mean {same.mean():+.3f}  min {same.min():+.3f}  max {same.max():+.3f}')
print(f'DIFF speaker : n={len(diff)}  mean {diff.mean():+.3f}  min {diff.min():+.3f}  max {diff.max():+.3f}')
print(f'\noverlap: {(diff >= same.min()).sum()}/{len(diff)} different-speaker pairs score >= the weakest same-speaker pair')
