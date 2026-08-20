"""Compare speaker embedding models on clips whose speaker is certain.

ECAPA is the incumbent. On this recording it does separate these people on
average (same 0.21, different 0.03) but with so much overlap that no clustering
on top of it keeps one person together. The question here is whether that is a
property of the audio or of the model.
"""
import numpy as np, soundfile as sf, torch
from speechbrain.inference.speaker import EncoderClassifier

SR = 16000
audio, _ = sf.read('fixtures/real/dorm-40min.wav', dtype='float32')
CLIPS = [
    ('boris', 18.558, 19.808), ('boris', 33.9, 35.1), ('boris', 1633.0, 1636.5),
    ('vova', 24.308, 25.908), ('vova', 28.608, 29.458), ('vova', 55.5, 60.0),
    ('clara', 1809.4, 1811.0), ('clara', 1813.2, 1817.0),
]

def report(name, vecs):
    same, diff = [], []
    for i in range(len(vecs)):
        for j in range(i+1, len(vecs)):
            (same if CLIPS[i][0] == CLIPS[j][0] else diff).append(float(vecs[i] @ vecs[j]))
    same, diff = np.array(same), np.array(diff)
    overlap = int((diff >= same.min()).sum())
    sep = same.mean() - diff.mean()
    print(f'{name:<34} same {same.mean():+.3f} (min {same.min():+.3f})   '
          f'diff {diff.mean():+.3f} (max {diff.max():+.3f})   '
          f'gap {sep:+.3f}   overlap {overlap}/{len(diff)}')

def speechbrain_model(source, savedir):
    m = EncoderClassifier.from_hparams(source=source, savedir=savedir, run_opts={'device':'cpu'})
    def embed(a, b):
        clip = audio[int(a*SR):int(b*SR)]
        with torch.no_grad():
            v = m.encode_batch(torch.from_numpy(clip).unsqueeze(0)).squeeze()
        return (v / v.norm(p=2)).numpy()
    return embed

for label, source, savedir in [
    ('ECAPA-TDNN (incumbent)', 'speechbrain/spkrec-ecapa-voxceleb', 'sidecar/.cache/ecapa'),
    ('SpeechBrain ResNet',     'speechbrain/spkrec-resnet-voxceleb', 'sidecar/.cache/resnet'),
    ('SpeechBrain x-vector',   'speechbrain/spkrec-xvect-voxceleb',  'sidecar/.cache/xvect'),
]:
    try:
        embed = speechbrain_model(source, savedir)
        report(label, [embed(a, b) for _, a, b in CLIPS])
    except Exception as e:
        print(f'{label:<34} FAILED {type(e).__name__}: {str(e)[:60]}')
