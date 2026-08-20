"""WeSpeaker ResNet34-LM on the speaker-certain clips.

This is the embedding pyannote 3.1 ships for diarization, trained with far-field
and noise augmentation that ECAPA's VoxCeleb recipe does not emphasise. If the
ceiling is the model rather than the room, it should show here.
"""
import numpy as np, soundfile as sf
import onnxruntime as ort
from huggingface_hub import hf_hub_download

SR = 16000
audio, _ = sf.read('fixtures/real/dorm-40min.wav', dtype='float32')
CLIPS = [
    ('boris', 18.558, 19.808), ('boris', 33.9, 35.1), ('boris', 1633.0, 1636.5),
    ('vova', 24.308, 25.908), ('vova', 28.608, 29.458), ('vova', 55.5, 60.0),
    ('clara', 1809.4, 1811.0), ('clara', 1813.2, 1817.0),
]

path = hf_hub_download('Wespeaker/wespeaker-voxceleb-resnet34-LM', 'voxceleb_resnet34_LM.onnx')
sess = ort.InferenceSession(path, providers=['CPUExecutionProvider'])
inp = sess.get_inputs()[0]
print('input:', inp.name, inp.shape)

def fbank(wav):
    import torch, torchaudio
    t = torch.from_numpy(wav).unsqueeze(0)
    feat = torchaudio.compliance.kaldi.fbank(
        t, num_mel_bins=80, frame_length=25, frame_shift=10,
        dither=0.0, sample_frequency=SR, window_type='hamming', use_energy=False)
    return (feat - feat.mean(dim=0, keepdim=True)).numpy()[None, ...]

def embed(a, b):
    clip = audio[int(a*SR):int(b*SR)]
    out = sess.run(None, {inp.name: fbank(clip)})[-1][0]
    return out / np.linalg.norm(out)

vecs = [embed(a, b) for _, a, b in CLIPS]
same, diff = [], []
for i in range(len(vecs)):
    for j in range(i+1, len(vecs)):
        (same if CLIPS[i][0] == CLIPS[j][0] else diff).append(float(vecs[i] @ vecs[j]))
same, diff = np.array(same), np.array(diff)
print(f'WeSpeaker ResNet34-LM  same {same.mean():+.3f} (min {same.min():+.3f})  '
      f'diff {diff.mean():+.3f} (max {diff.max():+.3f})  gap {same.mean()-diff.mean():+.3f}  '
      f'overlap {int((diff>=same.min()).sum())}/{len(diff)}')
