"""Diarize from the audio, not from somebody else's labels.

The pipeline in server/ inherits speaker labels from the transcription provider
and pools them. Measured, those labels are not speaker-pure, so the pooled
"voiceprints" are blends -- and blends resemble each other more than a person
resembles himself, which is how different people ended up scoring 0.850 while
one man against himself scored 0.833.

So: never trust the provider's labels. Cut speech into short windows, embed each
one, and cluster them.

The difficulty is that short far-field windows are individually terrible: on
speaker-certain clips from this recording, same-speaker cosine averages 0.21 and
different-speaker 0.03, with heavy overlap. Greedy agglomerative merging makes a
hard decision from one such number and cannot recover from it.

Spectral clustering does not. It uses the whole affinity matrix at once, so a
window is placed by how it relates to everything, not to its nearest neighbour.
The refinement chain below (Wang et al., "Speaker Diarization with LSTM") is the
standard treatment for exactly this noise, and the eigengap gives the speaker
count instead of us assuming one.
"""
import json
import numpy as np, soundfile as sf, torch
from speechbrain.inference.speaker import EncoderClassifier

SR = 16000
WINDOW_S = 1.5
HOP_S = 0.75
MIN_SPEECH_S = 0.4

audio, _ = sf.read('fixtures/real/dorm-40min.wav', dtype='float32')
words = json.load(open('fixtures/real/dorm-40min.whisper.json'))['words']

# Speech regions come from whisper's word timings: it already found the speech,
# and a separate VAD would only disagree with the thing we align to later.
regions = []
for w in words:
    s, e = float(w['start']), float(w['end'])
    if regions and s - regions[-1][1] < 0.30:
        regions[-1][1] = max(regions[-1][1], e)
    else:
        regions.append([s, e])
regions = [(s, e) for s, e in regions if e - s >= MIN_SPEECH_S]
speech = sum(e - s for s, e in regions)
print(f'{len(regions)} speech regions, {speech:.0f}s of speech')

windows = []
for s, e in regions:
    t = s
    while t + WINDOW_S <= e + 1e-6:
        windows.append((t, t + WINDOW_S)); t += HOP_S
    if not windows or windows[-1][1] < e - 0.25:
        if e - s >= 0.8:
            windows.append((max(s, e - WINDOW_S), e))
print(f'{len(windows)} windows of {WINDOW_S}s at {HOP_S}s hop')

model = EncoderClassifier.from_hparams(source='speechbrain/spkrec-ecapa-voxceleb',
    savedir='sidecar/.cache/ecapa', run_opts={'device': 'cpu'})

BATCH = 64
embs = []
for i in range(0, len(windows), BATCH):
    chunk = windows[i:i+BATCH]
    n = int(WINDOW_S * SR)
    batch = np.zeros((len(chunk), n), dtype='float32')
    for j, (a, b) in enumerate(chunk):
        clip = audio[int(a*SR):int(a*SR)+n]
        batch[j, :len(clip)] = clip
    with torch.no_grad():
        v = model.encode_batch(torch.from_numpy(batch)).squeeze(1)
    v = v / v.norm(p=2, dim=1, keepdim=True)
    embs.append(v.numpy())
    print(f'\r  embedded {min(i+BATCH, len(windows))}/{len(windows)}', end='', flush=True)
X = np.concatenate(embs).astype('float64')
print()
np.savez('eval/real/windows.npz', X=X, windows=np.array(windows))
print('wrote eval/real/windows.npz')
