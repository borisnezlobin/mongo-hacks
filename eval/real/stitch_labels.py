"""Stitch chunk-scoped diarization labels into people, by voice.

Pooling is what makes this reliable: each label here carries tens to hundreds of
seconds of speech, far above the ~20 s where pooled ECAPA was measured at 100%
on this microphone. Individual turns would be a coin flip; pooled labels are not.
"""
import json
from collections import defaultdict
import numpy as np, soundfile as sf, torch
from speechbrain.inference.speaker import EncoderClassifier

SR = 16000
MIN_LABEL_SECONDS = 8.0

audio, _ = sf.read('fixtures/real/dorm-40min.wav', dtype='float32')
segments = json.load(open('fixtures/real/dorm-40min.merged.json'))['segments']

model = EncoderClassifier.from_hparams(source='speechbrain/spkrec-ecapa-voxceleb',
    savedir='sidecar/.cache/ecapa', run_opts={'device': 'cpu'})

def embed(clip):
    with torch.no_grad():
        v = model.encode_batch(torch.from_numpy(clip).unsqueeze(0)).squeeze()
    return (v / v.norm(p=2)).numpy()

by_label = defaultdict(list)
for seg in segments:
    by_label[seg['label']].append(seg)

# Pool each label from its longest segments: long turns embed far better, and a
# label with 200 s of speech does not need its half-second backchannels.
prints = {}
seconds = {}
for label, segs in by_label.items():
    total = sum(s['end'] - s['start'] for s in segs)
    seconds[label] = total
    if total < MIN_LABEL_SECONDS:
        continue
    chosen = sorted(segs, key=lambda s: s['start'] - s['end'])[:40]
    vectors, used = [], 0.0
    for s in chosen:
        clip = audio[int(s['start'] * SR):int(s['end'] * SR)]
        if len(clip) / SR < 0.8:
            continue
        vectors.append(embed(clip) * (len(clip) / SR))
        used += len(clip) / SR
        if used > 60:
            break
    if not vectors:
        continue
    v = np.sum(vectors, axis=0)
    prints[label] = v / np.linalg.norm(v)

labels = sorted(prints, key=lambda l: -seconds[l])
M = np.stack([prints[l] for l in labels])
S = M @ M.T

print(f'{len(labels)} labels with >= {MIN_LABEL_SECONDS}s of speech\n')
print('        ' + ''.join(f'{l.split(":")[0][:2]+l.split(":")[1]:>8}' for l in labels))
for i, li in enumerate(labels):
    print(f'{li:>8}' + ''.join(f'{S[i,j]:8.2f}' for j in range(len(labels))))

np.savez('eval/real/label-prints.npz', M=M, labels=np.array(labels),
         seconds=np.array([seconds[l] for l in labels]))
print('\nwrote eval/real/label-prints.npz')
