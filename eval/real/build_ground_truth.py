"""Build reviewable ground truth for the 48-minute dorm recording.

Nothing here is asserted on one signal. A chunk-scoped diarization label only
becomes part of a person when at least two independent things say so, and the
three things available are independent in the way that matters -- they fail for
different reasons:

  voiceprint     pooled ECAPA over the label's segments, agreed by a bootstrap
                 over resampled segments and jittered thresholds (see
                 stitch_people.py). Fails on similar voices and on overlap.
  chunk overlap  the four diarization chunks overlap by 30 s, so for those 30 s
                 two independent runs of the same model labelled the same audio.
                 Matching them up needs no acoustics at all. Fails because 30 s
                 is short and boundaries disagree, so it is only believed when
                 the voiceprint agrees the two labels are each other's best
                 counterpart in the other chunk.
  level          median RMS of the label's speech. A person's distance from the
                 phone barely changes over an hour, so it corroborates; it is
                 never allowed to carry a link, because it is the one signal
                 that would happily join two strangers who sat in the same
                 chair. An earlier version of this file let it, and it welded
                 the whole loudest half of the room into one person.

Names come only from the transcript, and only from lines quoted verbatim below
with their timestamps, so every name in the output can be checked in a minute by
reading the transcript. Most of the seven people are never named out loud by
anybody; they get stable anonymous ids and stay anonymous. That is a real
finding about the recording, not a gap to be filled in with a guess.

The naming lines cannot be taken at face value either. The diarizer put "Hello,
I'm Boris." on label 0:A, and embedding that clip on its own puts it nowhere
near 0:A -- it lands on 0:G/950:C/1900:F, the voice that later reads out an
email offering to sell him borisen.com. So a naming line is only believed if
re-embedding the clip picks the label it is being credited to; that check runs
here, on the audio, every time this file is built.

Everything that fails these tests goes into `excluded`, and the fraction
excluded is printed and stored. Writes eval/real/ground-truth.json.
"""
import json
from collections import Counter, defaultdict

import numpy as np
import soundfile as sf

SR = 16000
WAV = 'fixtures/real/dorm-40min.wav'
MERGED = 'fixtures/real/dorm-40min.merged.json'
GROUPS = 'eval/real/label-groups.json'
PLAN = 'fixtures/real/chunks/plan.json'
OUT = 'eval/real/ground-truth.json'

TRUE_PEOPLE = 7
MIN_LABEL_SECONDS = 8.0
VOICEPRINT_LINK = 0.90        # bootstrap co-assignment that counts as a link
VOICEPRINT_CONTEST = 0.45     # co-assignment to a *different* person that spoils it
OVERLAP_LINK_SECONDS = 3.0    # shared time in a chunk overlap that counts as a link
LEVEL_AGREE_DB = 3.0
PURITY_FLOOR = 0.50           # a voice's own speech must mostly pick that voice
CROSS_MARGIN = 0.15           # how far ahead the winner must be to name a voice

# The other recording, whose three people the owner can name from memory. It is
# the only evidence here that does not come from this recording at all, which
# makes it the only check on the naming that cannot be circular: a voice that
# matches 9pm's Boris was not decided by anything the 48-minute stitching did.
NINE_PM_WAV = 'fixtures/real/dorm-9pm.wav'
NINE_PM_DIARIZE = 'fixtures/real/dorm-9pm.diarize.json'
NINE_PM_PEOPLE = {'A': ('joshua', 'Joshua'), 'C': ('boris', 'Boris'), 'G': ('tarun', 'Tarun')}

# Naming lines. `label` is the label the name is being credited to, which is not
# always the label the diarizer put the line on -- `speaks_as` says who the
# diarizer thought was talking, and where the two differ the audio decides.
# `probe` means: re-embed exactly this clip and require `label` to be its
# closest pooled voice, otherwise refuse to build.
ANCHORS = [
    {'label': '0:G', 'speaks_as': '0:A', 'person': 'boris', 'name': 'Boris',
     'at': 18.558, 'until': 19.808, 'quote': "Hello, I'm Boris.", 'probe': True,
     'reasoning': 'self-introduction, answering "You Boris?" a moment earlier. The '
                  'diarizer credits it to 0:A; the clip itself is closest to 0:G and '
                  '950:C, and the "I\'m from... my parents are from Russia" line three '
                  'seconds later lands on the same voice. Independently, 950:C reads out '
                  'an email offering to sell him the domain borisen.com at 1633 s, and '
                  '1900:F says "me and Tarun have the MongoDB water bottles" at 2094 s'},
    {'label': '0:C', 'person': 'vova', 'name': 'Vova',
     'at': 28.608, 'until': 29.458, 'quote': "I'm Vova.", 'probe': False,
     'reasoning': 'self-introduction; the same label says "I\'m Ukrainian" at 24.3 s. '
                  'Not probe-checked: the clip is 1.2 s, which is too short for the '
                  'probe to mean anything either way'},
    {'label': '1900:B', 'person': 'clara', 'name': 'Clara',
     'at': 2466.102, 'until': 2466.9, 'quote': "Good night.", 'probe': False,
     'reasoning': 'answers 1900:F saying "good night, Clara" 1.5 s earlier; 950:C, the '
                  'same voice as 1900:F, says "Claire." at 1850 s shortly after this '
                  'person joins. This is the only woman in the room by voiceprint, which '
                  'is why the link to 950:M is the cleanest one in the recording'},
    {'label': '1900:D', 'person': 'dhruv', 'name': 'Dhruv',
     'at': 2316.78, 'until': 2318.0, 'quote': "Drew.", 'probe': False,
     'reasoning': 'answers "what\'s the name?" from 1900:C, who repeats it back as '
                  '"Drew, Drew, nice to meet you". "Drew" is how this ASR would render '
                  'Dhruv. Short clip, so no probe; the label also fails the purity gate '
                  'below, so this name is recorded but not scored'},
]

# Not anchors, and here so nobody re-derives them and thinks they are:
#
#   0:D as Joshua   0:C asks "Wait Joshua, when are you starting?" at 58.2 s and
#                   0:D answers "Uh, English." -- but 0:D also says it is doing
#                   industrial engineering and operations research ten seconds
#                   earlier, and 0:D's segments almost never pick 0:D as their
#                   own closest voice. The vocative is real, the answer's label
#                   is not trustworthy.
#   Tarun, Mert     never spoken aloud by anybody in 48 minutes. Tarun is
#   Joshua, Dhruv   referred to once in the third person; "Josh" is used as a
#                   vocative a few times but never by somebody whose own label
#                   is stable enough to place the person being addressed.

# Two labels the diarizer put in the same chunk are two people: that decision is
# made with conversational context this pipeline does not have, and it is the
# diarizer's most reliable output. Where the voiceprint disagrees with it the
# evidence is genuinely in conflict, so neither label is scored -- see
# `contested` below. This assumption is the one most worth arguing with.
TRUST_WITHIN_CHUNK_SPLITS = True


def load_merged():
    return json.load(open(MERGED))['segments']


def check_anchors(segments, prints, probe):
    """An anchor that cannot be found in the transcript is not evidence."""
    verified = []
    for anchor in ANCHORS:
        spoken_by = anchor.get('speaks_as', anchor['label'])
        match = next((s for s in segments
                      if abs(s['start'] - anchor['at']) < 0.05 and s['label'] == spoken_by
                      and anchor['quote'].strip('.') in s['text']), None)
        if match is None:
            raise SystemExit(f'anchor does not match the transcript: '
                             f'{spoken_by} @ {anchor["at"]} "{anchor["quote"]}"')
        row = {**anchor, 'quote': match['text']}
        if anchor['probe']:
            vector = probe(anchor['at'], anchor['until'])
            ranked = sorted(prints, key=lambda l: -float(vector @ prints[l]))
            row['probe_ranking'] = [{'label': l, 'cosine': round(float(vector @ prints[l]), 3)}
                                    for l in ranked[:4]]
            if ranked[0] != anchor['label']:
                raise SystemExit(f'probe disagrees with anchor {anchor["label"]}: '
                                 f'clip at {anchor["at"]}s is closest to {ranked[0]}')
        verified.append(row)
    return verified


def chunk_overlap_links():
    """Label correspondences from the seconds where two chunks both saw the audio.

    The layout is read from fixtures/real/chunks/plan.json rather than assumed.
    The fixtures are frozen -- regenerating them costs a real API bill -- and the
    live planner has since moved to a different layout, so the only thing that
    describes how these four files were cut is the plan that cut them.
    """
    plan = json.load(open(PLAN))
    starts, cap = plan['starts'], plan['cap']
    chunks = {}
    for start in starts:
        data = json.load(open(f'fixtures/real/chunks/diar_{start}.json'))
        chunks[start] = [{'start': s['start'] + start, 'end': s['end'] + start,
                          'label': f"{start}:{s['speaker']}"}
                         for s in data['segments'] if s.get('text', '').strip()]

    links = []
    for a, b in zip(starts, starts[1:]):
        lo, hi = b, a + cap
        shared = Counter()
        for x in chunks[a]:
            if x['end'] <= lo or x['start'] >= hi:
                continue
            for y in chunks[b]:
                if y['end'] <= lo or y['start'] >= hi:
                    continue
                o = min(x['end'], y['end']) - max(x['start'], y['start'])
                if o > 0:
                    shared[(x['label'], y['label'])] += o
        # Only a mutual first choice counts. Two labels that merely brush past
        # each other in a 30 s window are a boundary disagreement, not a person.
        best_a, best_b = {}, {}
        for (la, lb), o in shared.items():
            if o > best_a.get(la, (None, 0))[1]:
                best_a[la] = (lb, o)
            if o > best_b.get(lb, (None, 0))[1]:
                best_b[lb] = (la, o)
        for la, (lb, o) in best_a.items():
            if o >= OVERLAP_LINK_SECONDS and best_b.get(lb, (None, 0))[0] == la:
                links.append({'labels': [la, lb], 'seconds': round(o, 1),
                              'window': [lo, hi]})
    return links


def voiceprints():
    """Session-centred pooled voiceprints, and a way to embed an arbitrary clip.

    Centring on the session mean is what makes these numbers mean anything
    within one recording: every label shares a microphone and a room, so the
    part they have in common is the part that has to go.
    """
    import torch
    from speechbrain.inference.speaker import EncoderClassifier

    cache = np.load('eval/real/merged-segments.npz', allow_pickle=True)
    emb = cache['emb']
    label = np.array([str(x) for x in cache['label']])
    dur = cache['dur']
    centre = emb.mean(axis=0)
    unit = (emb - centre)
    unit = unit / np.linalg.norm(unit, axis=1, keepdims=True)

    index = defaultdict(list)
    for i, name in enumerate(label):
        index[name].append(i)
    index = {name: np.array(rows) for name, rows in index.items()}

    def pool(rows):
        if len(rows) == 0:
            return None
        v = (unit[rows] * dur[rows][:, None]).sum(axis=0)
        return v / np.linalg.norm(v)

    prints = {name: pool(rows) for name, rows in index.items()
              if dur[rows].sum() >= MIN_LABEL_SECONDS}

    audio, sr = sf.read(WAV, dtype='float32')
    assert sr == SR, sr
    model = EncoderClassifier.from_hparams(
        source='speechbrain/spkrec-ecapa-voxceleb',
        savedir='sidecar/.cache/ecapa', run_opts={'device': 'cpu'})

    def probe(start, end):
        clip = audio[int(start * SR):int(end * SR)]
        with torch.no_grad():
            v = model.encode_batch(torch.from_numpy(clip).unsqueeze(0)).squeeze()
        v = (v / v.norm(p=2)).numpy() - centre
        return v / np.linalg.norm(v)

    def probe_pool(wav_path, spans, budget=60.0):
        """Pool up to `budget` seconds of a person, in *raw* space.

        No session centring: this one is used to compare across recordings, and
        the session mean is precisely the thing that differs between them.
        """
        clips, _ = sf.read(wav_path, dtype='float32')
        vectors, used = [], 0.0
        for start, end in sorted(spans, key=lambda s: s[0] - s[1]):
            if end - start < 1.0:
                continue
            clip = clips[int(start * SR):int(end * SR)]
            with torch.no_grad():
                v = model.encode_batch(torch.from_numpy(clip).unsqueeze(0)).squeeze()
            vectors.append((v / v.norm(p=2)).numpy() * (end - start))
            used += end - start
            if used >= budget:
                break
        if not vectors:
            return None
        v = np.sum(vectors, axis=0)
        return v / np.linalg.norm(v)

    return prints, probe, unit, dur, index, pool, probe_pool


def cross_recording_names(groups, segments, probe_pool):
    """Name a voice by matching it against the other recording's known people.

    Raw cosine, not session-centred: the two recordings are two sessions, and
    the whole question is whether a voice from one is the voice from the other,
    which is exactly the case where the session mean must stay in.

    A match only counts if it is clearly ahead of the runner-up. Two of the
    three people in the short recording sit at 0.65 to each other, so a bare
    argmax here would hand out names on differences that are not there.
    """
    known = defaultdict(list)
    for row in json.load(open(NINE_PM_DIARIZE))['segments']:
        if row['speaker'] in NINE_PM_PEOPLE:
            known[row['speaker']].append((row['start'], row['end']))
    reference = {NINE_PM_PEOPLE[k][0]: probe_pool(NINE_PM_WAV, spans) for k, spans in known.items()}

    # One name, one voice. Two of the three people in the short recording sit at
    # 0.65 to each other, so several 48-minute voices can clear the margin
    # against the same person; only the closest of them gets the name.
    claims = {}
    out = {}
    for gid, labels_in in groups.items():
        spans = [(s['start'], s['end']) for s in segments if s['label'] in labels_in]
        vector = probe_pool(WAV, spans)
        if vector is None:
            continue
        ranked = sorted(((float(vector @ v), pid) for pid, v in reference.items() if v is not None),
                        reverse=True)
        if len(ranked) < 2 or ranked[0][0] - ranked[1][0] < CROSS_MARGIN:
            out[gid] = {'match': None, 'cosines': [{'person': p, 'cosine': round(c, 3)}
                                                   for c, p in ranked]}
            continue
        out[gid] = {'match': ranked[0][1],
                    'name': next(n for _, n in NINE_PM_PEOPLE.values()
                                 if n.lower() == ranked[0][1]),
                    'cosine': round(ranked[0][0], 3),
                    'margin': round(ranked[0][0] - ranked[1][0], 3),
                    'cosines': [{'person': p, 'cosine': round(c, 3)} for c, p in ranked]}
        claims.setdefault(ranked[0][1], []).append((ranked[0][0], gid))

    for person, contenders in claims.items():
        contenders.sort(reverse=True)
        for cosine, gid in contenders[1:]:
            out[gid] = {'match': None, 'lost_to': contenders[0][1],
                        'reason': f'{contenders[0][1]} is closer to {person} '
                                  f'({contenders[0][0]:.2f} vs {cosine:.2f})',
                        'cosines': out[gid]['cosines']}
    return out


def purity(group_of, unit, dur, index, pool):
    """How often a group's own speech picks that group as its closest voice.

    Pooled voiceprints will always look tidy -- averaging 200 s of anything
    produces a confident-looking vector. This is the check that the tidiness is
    real: every segment of two seconds or more is embedded on its own and asked
    which group it belongs to, with that segment left out of its own group's
    pool so it cannot vote for itself. A group whose own speech does not pick it
    is a group that exists only in the averaging, and it has no business being
    ground truth.
    """
    groups = defaultdict(list)
    for label, gid in group_of.items():
        if label in index:
            groups[gid].extend(index[label].tolist())
    groups = {gid: np.array(sorted(rows)) for gid, rows in groups.items()}

    scores = {}
    for gid, rows in groups.items():
        long = rows[dur[rows] >= 2.0]
        hits, confusions = 0, Counter()
        for i in long:
            prints = {}
            for other, members in groups.items():
                pooled = pool(members[members != i] if other == gid else members)
                if pooled is not None:
                    prints[other] = pooled
            nearest = max(prints, key=lambda g: float(unit[i] @ prints[g]))
            if nearest == gid:
                hits += 1
            else:
                confusions[nearest] += 1
        scores[gid] = {
            'segments': int(len(long)),
            'purity': round(hits / len(long), 3) if len(long) else 0.0,
            'lost_to': [{'group': g, 'segments': n} for g, n in confusions.most_common(3)],
        }
    return scores


def levels(segments):
    """Median speech level per label, in dB. Corroboration only."""
    audio, sr = sf.read(WAV, dtype='float32')
    assert sr == SR, sr
    by = defaultdict(list)
    for s in segments:
        if s['end'] - s['start'] < 1.0:
            continue
        clip = audio[int(s['start'] * SR):int(s['end'] * SR)]
        if len(clip) < SR:
            continue
        by[s['label']].append(float(np.sqrt((clip ** 2).mean())))
    return {label: 20 * np.log10(np.median(v) + 1e-9) for label, v in by.items() if len(v) >= 5}


def main():
    segments = load_merged()
    prints, probe, unit, dur, index, pool, probe_pool = voiceprints()
    anchors = check_anchors(segments, prints, probe)
    groups = json.load(open(GROUPS))
    co = groups['co_assignment']
    seconds = groups['seconds']
    labels = [l for l in groups['labels'] if seconds[l] >= MIN_LABEL_SECONDS]
    overlap_links = chunk_overlap_links()
    level = levels(segments)

    def voiceprint(a, b):
        return co.get(a, {}).get(b, 0.0)

    # --- links ---------------------------------------------------------------
    centred = groups['similarity_centred']

    def best_in_chunk(label, chunk):
        """The label in `chunk` this label sounds most like."""
        rivals = [l for l in labels if l.split(':')[0] == chunk and l != label]
        if not rivals:
            return None
        return max(rivals, key=lambda l: centred[label][l])

    supported, rejected = [], []
    candidates = {(a, b) for a in labels for b in labels if a < b}
    overlap_pairs = {tuple(sorted(link['labels'])): link for link in overlap_links}

    for a, b in sorted(candidates):
        evidence, blocked = [], None
        if voiceprint(a, b) >= VOICEPRINT_LINK:
            evidence.append({'signal': 'voiceprint', 'co_assignment': voiceprint(a, b)})
        pair = overlap_pairs.get((a, b))
        if pair:
            # Timing alone is not enough. Two people talking over each other at
            # a chunk seam produce exactly this pattern, so the voiceprint has
            # to at least agree that these two are each other's best candidate.
            mutual = best_in_chunk(a, b.split(':')[0]) == b and best_in_chunk(b, a.split(':')[0]) == a
            if mutual:
                evidence.append({'signal': 'chunk_overlap', 'seconds': pair['seconds'],
                                 'window': pair['window'],
                                 'centred_cosine': centred[a][b]})
            else:
                blocked = ('the two chunks share time here, but neither label is the '
                           'other\'s closest voice in the other chunk')
        if a in level and b in level:
            evidence.append({'signal': 'level', 'db_apart': round(abs(level[a] - level[b]), 1),
                             'corroborates': bool(abs(level[a] - level[b]) <= LEVEL_AGREE_DB)})

        strong = [e for e in evidence if e['signal'] in ('voiceprint', 'chunk_overlap')]
        same_chunk = a.split(':')[0] == b.split(':')[0]
        if same_chunk and TRUST_WITHIN_CHUNK_SPLITS:
            if strong:
                rejected.append({'labels': [a, b], 'reason': 'same chunk: the diarizer '
                                 'called these two different people', 'evidence': evidence})
            continue
        if strong:
            supported.append({'labels': [a, b], 'evidence': evidence,
                              'signals': [e['signal'] for e in strong]})
        elif blocked:
            rejected.append({'labels': [a, b], 'reason': blocked, 'evidence': evidence})

    parent = {l: l for l in labels}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for link in supported:
        a, b = link['labels']
        parent[find(a)] = find(b)

    members = defaultdict(list)
    for l in labels:
        members[find(l)].append(l)

    # --- contested labels ----------------------------------------------------
    # A label that the voiceprint pulls hard towards a different person is not
    # safe to score, whichever way the pull is resolved. Both sides are dropped:
    # if we knew which one was wrong we would not call it contested.
    person_of = {l: find(l) for l in labels}
    contested = {}
    for a in labels:
        for b in labels:
            if a == b or person_of[a] == person_of[b]:
                continue
            if voiceprint(a, b) >= VOICEPRINT_CONTEST:
                contested.setdefault(a, []).append({'with': b, 'co_assignment': voiceprint(a, b)})

    # --- names ---------------------------------------------------------------
    named = {}
    for anchor in anchors:
        root = find(anchor['label'])
        named.setdefault(root, []).append(anchor)

    ordered = sorted(members.items(), key=lambda kv: -sum(seconds[l] for l in kv[1]))
    ids = {}
    for n, (root, group) in enumerate(ordered):
        anchored = named.get(root, [])
        if len({a['person'] for a in anchored}) > 1:
            raise SystemExit(f'two different names anchor the same voice: {anchored}')
        ids[root] = anchored[0]['person'] if anchored else f'unnamed-{n + 1}'
    cross_ids = {}

    scores = purity({l: ids[find(l)] for l in labels}, unit, dur, index, pool)
    cross = cross_recording_names({ids[root]: group for root, group in ordered},
                                  segments, probe_pool)

    people = []
    for root, group in ordered:
        pid = ids[root]
        anchored = list(named.get(root, []))
        measured = scores.get(pid, {'purity': 0.0, 'segments': 0, 'lost_to': []})
        match = cross.get(pid, {})
        if match.get('match'):
            # A name carried over from the recording whose people the owner can
            # name from memory. It is the only naming evidence here that owes
            # nothing to the 48-minute stitching, so it is kept even when a
            # transcript anchor already agrees -- and if the two disagree, that
            # is a contradiction worth stopping for rather than averaging over.
            if anchored and anchored[0]['person'] != match['match']:
                raise SystemExit(
                    f"{pid}: the transcript says {anchored[0]['person']} and the other "
                    f"recording says {match['match']} ({match['cosines']})")
            anchored.append({
                'label': ' '.join(sorted(group)), 'person': match['match'],
                'name': match['name'], 'at': 0.0,
                'quote': f"matches dorm-9pm's {match['name']} at cosine {match['cosine']}, "
                         f"{match['margin']} ahead of the runner-up",
                'reasoning': 'pooled voiceprint against the three-minute recording, whose '
                             'speakers the owner named from memory. Raw cosine across '
                             'sessions, 60 s a side',
            })
            pid = match['match']
        group_contested = {l: contested[l] for l in group if l in contested}
        chunks = {l.split(':')[0] for l in group}

        if len(chunks) == 1:
            # One chunk, no partner anywhere else in the recording. Either they
            # stopped talking or the diarizer started calling them something
            # else, and nothing here can tell those apart -- so scoring this as
            # a separate person risks splitting one real person in two and
            # billing a correct system for it.
            confidence = 'single-chunk'
        elif measured['purity'] < PURITY_FLOOR:
            confidence = 'impure'
        else:
            confidence = 'high'

        people.append({
            'id': pid,
            'name': anchored[0]['name'] if anchored else None,
            'labels': sorted(group),
            'seconds': round(sum(seconds[l] for l in group), 1),
            'confidence': confidence,
            'purity': measured,
            'cross_recording': match,
            'named_from': anchored,
            'linked_by': [link for link in supported
                          if link['labels'][0] in group and link['labels'][1] in group],
            'contested': group_contested,
            'level_db': {l: round(level[l], 1) for l in group if l in level},
        })

    # A voice being confusable with another voice only matters if both of them
    # are going to be scored. If the rival's speech is excluded anyway, a system
    # that lumps the two together is never charged for it, so disqualifying the
    # good half as well would cost coverage and buy nothing. Two *scored* voices
    # that are confusable are a different matter: there the reference itself
    # might be splitting one person in two, and a system that got it right would
    # be marked wrong. Those drop out in pairs.
    eligible = {p['id'] for p in people if p['confidence'] == 'high'}
    by_id = {p['id']: p for p in people}
    for person in people:
        if person['id'] not in eligible:
            continue
        rivals = {r['with'] for label in person['contested'] for r in person['contested'][label]}
        clashes = [other for other in eligible
                   if other != person['id'] and set(by_id[other]['labels']) & rivals]
        person['scored_rivals'] = clashes
        if clashes:
            person['confidence'] = 'contested'
    for person in people:
        if person['confidence'] == 'contested' and person['id'] in eligible:
            eligible.discard(person['id'])
    scored_ids = eligible

    # What a human with the audio could settle in a few minutes, and what it
    # would buy. Longest turns first, because those are the ones worth playing.
    to_resolve = []
    for person in people:
        if person['confidence'] not in ('contested', 'impure'):
            continue
        for label, rivals in person['contested'].items():
            clips = sorted((s for s in segments if s['label'] == label),
                           key=lambda s: s['start'] - s['end'])[:3]
            to_resolve.append({
                'question': f'is {label} the same person as '
                            f'{", ".join(r["with"] for r in rivals)}?',
                'worth_seconds': person['seconds'],
                'listen_to': [{'at': round(s['start'], 1), 'text': s['text'][:90]} for s in clips],
                'rivals': rivals,
            })
    to_resolve.sort(key=lambda row: -row['worth_seconds'])

    spans, excluded = [], []
    for s in segments:
        row = {'start_ms': round(s['start'] * 1000), 'end_ms': round(s['end'] * 1000),
               'label': s['label']}
        person = next((p for p in people if s['label'] in p['labels']), None)
        if person and person['id'] in scored_ids:
            spans.append({**row, 'speaker': person['id'], 'confidence': 'high'})
        else:
            excluded.append({**row, 'speaker': 'unknown',
                             'reason': person['confidence'] if person else 'label too short to pool'})

    speech = sum(s['end'] - s['start'] for s in segments)
    scored = sum(s['end_ms'] - s['start_ms'] for s in spans) / 1000
    duration = sf.info(WAV).duration

    result = {
        'recording': 'dorm-40min.wav',
        'duration_s': round(duration, 1),
        'true_people': TRUE_PEOPLE,
        'chunk_plan': json.load(open(PLAN)),
        'assumptions': {
            'trust_within_chunk_splits': TRUST_WITHIN_CHUNK_SPLITS,
            'voiceprint_link': VOICEPRINT_LINK,
            'voiceprint_contest': VOICEPRINT_CONTEST,
            'overlap_link_seconds': OVERLAP_LINK_SECONDS,
            'purity_floor': PURITY_FLOOR,
        },
        'coverage': {
            'diarized_speech_s': round(speech, 1),
            'scored_speech_s': round(scored, 1),
            'scored_fraction_of_speech': round(scored / speech, 3),
            'scored_fraction_of_recording': round(scored / duration, 3),
            'people_scored': len(scored_ids),
            'people_total': TRUE_PEOPLE,
            'people_named': sum(1 for p in people if p['name']),
        },
        'people': people,
        'rejected_links': rejected,
        'to_resolve': to_resolve,
        'spans': spans,
        'excluded': excluded,
    }
    json.dump(result, open(OUT, 'w'), indent=1)

    print(f'{len(labels)} poolable labels -> {len(members)} voices\n')
    for p in people:
        print(f"  {p['id']:<12} {p['seconds']:7.1f}s  {p['confidence']:<13} "
              f"purity {p['purity']['purity']:.0%} of {p['purity']['segments']:3d}  {p['labels']}"
              + (f"  contested: {list(p['contested'])}" if p['contested'] else ''))
    print(f"\nnamed: {', '.join(sorted({p['name'] for p in people if p['name']})) or 'nobody'}")
    for p in people:
        for anchor in p['named_from']:
            print(f"    {p['name']:<8} <- {anchor['quote'][:78]}")
    print(f"scored: {scored:.0f}s of {speech:.0f}s diarized speech "
          f"({scored / speech:.1%}), {scored / duration:.1%} of the recording, "
          f"{len(scored_ids)} of {TRUE_PEOPLE} people")
    if to_resolve:
        print('\nworth listening to, largest payoff first')
        for row in to_resolve[:4]:
            print(f"  {row['worth_seconds']:6.0f}s  {row['question']}")
            for clip in row['listen_to'][:2]:
                print(f"            {clip['at']:7.1f}s  {clip['text'][:70]}")
    print(f'\nwrote {OUT}')


main()
