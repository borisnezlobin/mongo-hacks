"""Merge chunked diarization into one timeline with chunk-scoped labels.

Chunking is forced: the diarizing model refuses audio over 1400 s. Labels are
only meaningful inside a chunk -- 'A' in one chunk is a different person from
'A' in the next -- so they are namespaced here and stitched by voiceprint later.
Overlap regions are resolved by keeping the segment from whichever chunk heard
more of it, since a speaker cut off at a chunk boundary is diarized badly.
"""
import json

# The layout is recorded next to the fixtures it produced. It is not inferred
# and not re-derived from the current planner, which has since changed: these
# four files are a frozen artifact and plan.json is what describes them.
PLAN = json.load(open('fixtures/real/chunks/plan.json'))
STARTS, CHUNK, OVERLAP = PLAN['starts'], PLAN['cap'], PLAN['overlap']

merged = []
for start in STARTS:
    data = json.load(open(f'fixtures/real/chunks/diar_{start}.json'))
    centre = start + CHUNK / 2
    for seg in data.get('segments', []):
        s = seg['start'] + start
        e = seg['end'] + start
        if not seg.get('text', '').strip():
            continue
        merged.append({
            'start': s, 'end': e,
            'label': f"{start}:{seg['speaker']}",
            'chunk': start,
            'text': seg['text'].strip(),
            'dist_to_centre': abs((s + e) / 2 - centre),
        })

# Resolve overlaps: within a contested time span keep the chunk that heard it
# closer to its middle, where diarization is most reliable.
merged.sort(key=lambda x: (x['start'], x['dist_to_centre']))
kept = []
for seg in merged:
    clash = next((k for k in reversed(kept[-40:])
                  if seg['start'] < k['end'] - 0.05 and seg['end'] > k['start'] + 0.05
                  and k['chunk'] != seg['chunk']), None)
    if clash is None:
        kept.append(seg)
    elif seg['dist_to_centre'] < clash['dist_to_centre']:
        kept.remove(clash)
        kept.append(seg)
    kept.sort(key=lambda x: x['start'])

for seg in kept:
    del seg['dist_to_centre']
json.dump({'segments': kept}, open('fixtures/real/dorm-40min.merged.json', 'w'))

from collections import Counter
c = Counter(s['label'] for s in kept)
print(f'{len(kept)} segments, {len(c)} chunk-scoped labels')
speech = Counter()
for s in kept:
    speech[s['label']] += s['end'] - s['start']
for label, secs in sorted(speech.items(), key=lambda x: -x[1]):
    if secs >= 5:
        print(f'  {label:<10} {secs:7.1f}s  {c[label]:4d} segs')
print(f'  (labels under 5s: {sum(1 for l,v in speech.items() if v < 5)})')
print(f'total speech {sum(speech.values()):.0f}s of 2902s')
