"""The real pyannote 3.1 diarization pipeline.

Overlap-aware segmentation, WeSpeaker embeddings, PLDA-based clustering. This is
the purpose-built system; everything before it in this repo was an attempt to
reconstruct it from a transcription provider's speaker labels.
"""
import os, sys, json, time
import soundfile as sf, torch
from pyannote.audio import Pipeline

stem = sys.argv[1]
pipe = Pipeline.from_pretrained('pyannote/speaker-diarization-3.1', token=os.environ['HF_TOKEN'])

wav, sr = sf.read(f'fixtures/real/{stem}.wav', dtype='float32')
started = time.time()
# Waveform passed directly: pyannote 4 reads files via torchcodec, whose native
# library does not link against the ffmpeg on this machine.
ann = pipe({'waveform': torch.from_numpy(wav).unsqueeze(0), 'sample_rate': sr})
elapsed = time.time() - started

payload = ann.serialize()
turns = [{'start': float(t['start']), 'end': float(t['end']), 'speaker': str(t['speaker'])}
         for t in payload['diarization']]
json.dump({'segments': turns}, open(f'eval/real/{stem}.pyannote.json', 'w'))

from collections import Counter
counts = Counter(t['speaker'] for t in turns)
audio_s = len(wav) / sr
print(f'{stem}: {len(turns)} turns, {len(counts)} speakers, {elapsed:.0f}s for {audio_s:.0f}s of audio '
      f'({audio_s/elapsed:.1f}x realtime)')
for sp, _ in counts.most_common():
    secs = sum(t['end'] - t['start'] for t in turns if t['speaker'] == sp)
    print(f'   {sp}: {secs:6.1f}s')
# Overlap is now expressible: turns from different speakers that share time.
ov = 0.0
for i, a in enumerate(turns):
    for b in turns[i+1:]:
        if b['start'] >= a['end']: break
        if b['speaker'] != a['speaker']:
            ov += max(0.0, min(a['end'], b['end']) - max(a['start'], b['start']))
print(f'   simultaneous speech detected: {ov:.1f}s')
