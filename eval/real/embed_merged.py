"""Embed every substantial segment of the 48-minute recording, once.

Everything downstream -- pooling, stitching chunk-scoped labels into people,
and the stability checks that decide which labels are trustworthy enough to
enter ground truth -- reads the cache this writes. Keeping the model out of
those loops is what makes it affordable to re-pool a label a hundred times with
different subsets, which is the only honest way to say how sure we are.

Writes eval/real/merged-segments.npz.
"""
import json

import numpy as np
import soundfile as sf
import torch
from speechbrain.inference.speaker import EncoderClassifier

SR = 16000
MIN_SECONDS = 0.8
WAV = 'fixtures/real/dorm-40min.wav'
MERGED = 'fixtures/real/dorm-40min.merged.json'
OUT = 'eval/real/merged-segments.npz'

audio, sr = sf.read(WAV, dtype='float32')
assert sr == SR, sr
segments = json.load(open(MERGED))['segments']

model = EncoderClassifier.from_hparams(
    source='speechbrain/spkrec-ecapa-voxceleb',
    savedir='sidecar/.cache/ecapa',
    run_opts={'device': 'cpu'},
)


def embed(clip):
    with torch.no_grad():
        v = model.encode_batch(torch.from_numpy(clip).unsqueeze(0)).squeeze()
    return (v / v.norm(p=2)).numpy()


rows, vectors = [], []
usable = [s for s in segments if s['end'] - s['start'] >= MIN_SECONDS]
for n, seg in enumerate(usable):
    clip = audio[int(seg['start'] * SR):int(seg['end'] * SR)]
    if len(clip) / SR < MIN_SECONDS:
        continue
    vectors.append(embed(clip))
    rows.append({
        'label': seg['label'],
        'start': seg['start'],
        'end': seg['end'],
        'dur': seg['end'] - seg['start'],
    })
    if n % 25 == 0:
        print(f'\r{n + 1}/{len(usable)}', end='', flush=True)

np.savez(
    OUT,
    emb=np.stack(vectors),
    label=np.array([r['label'] for r in rows]),
    start=np.array([r['start'] for r in rows]),
    dur=np.array([r['dur'] for r in rows]),
)
print(f'\nembedded {len(rows)} segments >= {MIN_SECONDS}s '
      f'({sum(r["dur"] for r in rows):.0f}s of speech) -> {OUT}')
