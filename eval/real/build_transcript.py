"""Join whisper's words to pyannote's speakers, at word level.

Two sources, each doing what it is good at. Whisper transcribes a whole file
coherently but has no idea who is talking; pyannote knows who is talking but not
what they said. The chunked diarizing model tried to do both and did neither --
its text arrives as fragments ("but like", "Yeah. That's", "No, alright,")
because it is transcribing 16-minute chunks of seven-way crosstalk.

Joining at word level rather than segment level matters: a whisper segment
frequently spans a speaker change, so attributing whole segments would hand one
person the other's words.
"""
import json, sys
from collections import Counter

stem = sys.argv[1]
words = json.load(open(f'fixtures/real/{stem}.whisper.json'))['words']
turns = json.load(open(f'eval/real/{stem}.pyannote.json'))['segments']
turns.sort(key=lambda t: t['start'])

SNAP_S = 0.40

def speaker_at(a, b):
    """Whoever holds most of this word's span.

    Falling back to the nearest turn within SNAP_S matters more than it looks.
    Whisper and pyannote place boundaries independently, so they disagree by a
    fraction of a second constantly; without the fallback every such disagreement
    orphans a word into its own unattributed line and the transcript reads as
    confetti. Beyond the tolerance the word really is in silence, and stays
    unattributed rather than being given to whoever spoke nearby.
    """
    # Pick the turn that fits this word most tightly, not the one that overlaps
    # it most. During simultaneous speech pyannote emits a long turn for whoever
    # holds the floor AND short turns for whoever cuts across it; scoring by raw
    # overlap lets the long turn swallow every word inside it, so one person is
    # credited with a 24-second stretch containing three other people. Dividing
    # by the turn's own length asks "how much of THIS turn is this word" instead.
    best, who = 0.0, None
    for t in turns:
        if t['start'] >= b: break
        ov = min(b, t['end']) - max(a, t['start'])
        if ov <= 0: continue
        fit = ov / max(t['end'] - t['start'], 1e-6)
        if fit > best: best, who = fit, t['speaker']
    if who: return who
    near, gap = None, SNAP_S
    for t in turns:
        d = t['start'] - b if t['start'] > b else (a - t['end'] if a > t['end'] else 0.0)
        if d < gap: gap, near = d, t['speaker']
    return near

raw = []
for w in words:
    a, b = float(w['start']), float(w['end'])
    raw.append((speaker_at(a, b), w['word'], a, b))

# Smooth single-word flips.
#
# Tightest-fit is right about who is talking at an instant, but whisper
# transcribes whichever voice dominates, so during simultaneous speech the
# per-word winner alternates and the transcript ping-pongs a word at a time.
# A speaker who holds the floor for one word between two words of somebody
# else did not take a turn. Taking the mode over a small neighbourhood keeps
# real turn changes, which last several words, and drops the flicker.
SMOOTH = 2
tagged = []
for i, (sp, word, a, b) in enumerate(raw):
    window = [raw[j][0] for j in range(max(0, i - SMOOTH), min(len(raw), i + SMOOTH + 1))]
    counts = {}
    for s2 in window:
        if s2 is not None: counts[s2] = counts.get(s2, 0) + 1
    tagged.append(((max(counts, key=counts.get) if counts else sp), word, a, b))

# Group consecutive words by speaker into turns a person would recognise.
lines, cur = [], None
for sp, word, a, b in tagged:
    if cur and cur['speaker'] == sp and a - cur['end'] < 2.0:
        cur['text'] += ' ' + word; cur['end'] = b
    else:
        if cur: lines.append(cur)
        cur = {'speaker': sp, 'text': word, 'start': a, 'end': b}
if cur: lines.append(cur)

attributed = sum(1 for l in lines if l['speaker'])
words_attributed = sum(len(l['text'].split()) for l in lines if l['speaker'])
total_words = sum(len(l['text'].split()) for l in lines)
print(f'{len(words)} words -> {len(lines)} turns, {attributed} attributed')
print(f'words attributed to a speaker: {words_attributed}/{total_words} ({100*words_attributed/total_words:.0f}%)')
print(f'speakers: {sorted(set(l["speaker"] for l in lines if l["speaker"]))}\n')
json.dump({'lines': lines}, open(f'eval/real/{stem}.transcript.json', 'w'))

for l in lines[:25]:
    who = l['speaker'] or '········'
    print(f"  {who:<12} [{int(l['start']//60)}:{int(l['start']%60):02d}] {l['text'][:88]}")
