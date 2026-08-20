"""Full pass: clean stretches become speaker models, everything else joins them.

Evaluated against the landmark constraints, which are the only ground truth here
that owes nothing to voiceprint clustering.
"""
import json
import numpy as np, soundfile as sf, torch
from speechbrain.inference.speaker import EncoderClassifier

SR = 16000
ANCHOR_MIN_S = 9.0
LINK = 0.50          # inside the measured gap: same >= 0.539, different <= 0.467
ASSIGN_MIN = 0.30    # below this a segment resembles no model well enough
ASSIGN_MARGIN = 0.06 # and it must beat the runner-up by this much

audio, _ = sf.read('fixtures/real/dorm-40min.wav', dtype='float32')
words = json.load(open('fixtures/real/dorm-40min.whisper.json'))['words']
segments = json.load(open('fixtures/real/dorm-40min.whisper.json'))['segments']

model = EncoderClassifier.from_hparams(source='speechbrain/spkrec-ecapa-voxceleb',
    savedir='sidecar/.cache/ecapa', run_opts={'device':'cpu'})
def embed(a, b):
    clip = audio[int(a*SR):int(b*SR)]
    if len(clip) < int(0.4*SR): return None
    with torch.no_grad():
        v = model.encode_batch(torch.from_numpy(clip).unsqueeze(0)).squeeze()
    return (v / v.norm(p=2)).numpy()

runs = []
for w in words:
    s, e = float(w['start']), float(w['end'])
    if runs and s - runs[-1][1] <= 0.45: runs[-1][1] = max(runs[-1][1], e)
    else: runs.append([s, e])
anchors = [(s, e) for s, e in runs if e - s >= ANCHOR_MIN_S]
print(f'{len(anchors)} anchor stretches >= {ANCHOR_MIN_S}s')

A = np.stack([embed(s, e) for s, e in anchors])
groups = [[i] for i in range(len(A))]
while len(groups) > 1:
    best = None
    for a in range(len(groups)):
        for b in range(a+1, len(groups)):
            sim = float(np.mean(A[groups[a]] @ A[groups[b]].T))
            if best is None or sim > best[0]: best = (sim, a, b)
    if best[0] < LINK: break
    _, a, b = best
    groups[a] += groups[b]; groups.pop(b)

groups.sort(key=lambda g: -sum(anchors[i][1]-anchors[i][0] for i in g))
models = []
for g in groups:
    secs = sum(anchors[i][1]-anchors[i][0] for i in g)
    v = A[g].mean(axis=0); v /= np.linalg.norm(v)
    models.append(v)
    print(f'  speaker {len(models)-1}: {len(g)} stretches, {secs:.0f}s')

assigned, unassigned = [], 0
for seg in segments:
    s, e = float(seg['start']), float(seg['end'])
    v = embed(s, e)
    if v is None: unassigned += 1; continue
    sims = np.array([float(v @ m) for m in models])
    order = np.argsort(-sims)
    top = sims[order[0]]; second = sims[order[1]] if len(sims) > 1 else -1
    if top < ASSIGN_MIN or (top - second) < ASSIGN_MARGIN:
        unassigned += 1; continue
    assigned.append({'start': s, 'end': e, 'speaker': f'S{order[0]}', 'text': seg['text'].strip()})

total = sum(float(s['end'])-float(s['start']) for s in segments)
claimed = sum(a['end']-a['start'] for a in assigned)
print(f'\nassigned {len(assigned)}/{len(segments)} segments, {claimed:.0f}s of {total:.0f}s ({100*claimed/total:.0f}%)')
json.dump({'segments': assigned}, open('eval/real/anchor-diarization.json','w'))
