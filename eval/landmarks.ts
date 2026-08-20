/**
 * Lines whose speaker is certain from what the line says.
 *
 * A self-introduction names its own speaker. A vocative names somebody who is
 * therefore not the speaker. Neither needs anybody to listen to the audio, and
 * neither moves when a threshold moves, which makes a handful of these the most
 * trustworthy ground truth in this repository — far more trustworthy than the
 * 1021 seconds of span labels, which rest on voiceprint clustering.
 *
 * They also catch the one failure a rate cannot. Speaker error is a fraction of
 * seconds; merging two people who barely overlap in time costs almost nothing
 * in seconds, and merging one pair while splitting another leaves the speaker
 * count looking correct. That exact bug was live in this repository:
 * `speakerCount` read 7 on the 48-minute recording, which is the true number,
 * while "Hello, I'm Boris." and "Sh I'm Vova." were both filed under one
 * 808-second speaker. Two different self-introductions on one speaker is a
 * merge, with no threshold and no argument.
 *
 * Adding landmarks only makes this stronger, and none of them require labelling
 * the ambiguous parts of the recording. If you find another line whose speaker
 * the line itself settles, put it here.
 */

import type { AttributedSegment } from './scoring'

export interface Landmark {
  recording: 'dorm-9pm' | 'dorm-40min'
  at_ms: number
  end_ms: number
  quote: string
  /** Who said it, where the line itself makes that certain. */
  person?: string
  /** Who certainly did not say it — a vocative addresses somebody else. */
  notPerson?: string
  why: string
}

export const LANDMARKS: Landmark[] = [
  {
    recording: 'dorm-40min',
    at_ms: 39_160,
    end_ms: 42_700,
    quote: 'M-A-R-T',
    notPerson: 'volva',
    why: 'Mert spelling his own name, M-E-R-T, rendered "M A R T". The owner named the '
      + 'speaker — "it was Mert speaking, not Vova" — so the voice it currently lands on '
      + 'is wrong, and this catches Mert and Vova being merged: the same merge that files '
      + '"from Russia" and "from Ukraine" as facts about one person. '
      + 'NEGATIVE ONLY, deliberately. The span is NOT one speaker: the owner was repeating '
      + 'the letters back as Mert said them ("I was repeating the letters as well"), so it '
      + 'interleaves two people at letter granularity. An earlier version of this landmark '
      + 'claimed the whole span for Mert on the reasoning that one spelling had been split '
      + 'across two labels; that reasoning was wrong and the owner corrected it. Do not use '
      + 'this as a single-speaker anchor, and do not treat the alternation here as flicker — '
      + 'it is real. He also called it "a genuinely hard case", which is the honest reading: '
      + 'two voices alternating per letter over speech that was hard to hear in the room. '
      + 'Worth knowing: whisper transcribes the name correctly at 42.18 s — "M-E-R-T." — so '
      + 'the evidence needed to name Mert is present in the transcript and is being lost '
      + 'downstream, not at transcription',
  },
  {
    recording: 'dorm-40min',
    at_ms: 20_840,
    end_ms: 21_960,
    quote: 'Where are you from?',
    person: 'volva',
    why: 'the owner states it plainly: "\'Where are you from\' was not said by Boris; it was '
      + 'said by Volva". It sat inside a single turn credited to Boris that also contains his '
      + 'own answer, so a question and the reply to it were filed as one person speaking. '
      + 'Recorded first as notPerson: boris, which was weaker than what he said and let a '
      + 'candidate satisfy it by putting the line on a third voice that is not Volva either. '
      + 'A positive claim is what he gave us, so a positive claim is what belongs here',
  },
  {
    recording: 'dorm-40min',
    at_ms: 37_760,
    end_ms: 38_600,
    quote: 'Yeah, Matt.',
    notPerson: 'volva',
    why: 'the owner: "is in fact two separate speakers, neither of whom is Vova". Kept as '
      + 'a negative constraint because he did not say which two, and inventing the pair '
      + 'would be manufacturing ground truth he did not give',
  },
  {
    recording: 'dorm-40min',
    at_ms: 71_540,
    end_ms: 74_000,
    quote: 'can I rip a seat?',
    person: 'volva',
    why: 'the owner named the speaker directly: "it was Volva who said \'Hey tarun can I '
      + 'rip a seat\'". He also corrected the name being addressed — the transcriber '
      + 'writes "Rune", the person is Tarun — so this line pins a speaker AND records '
      + 'that the vocative in it is mistranscribed. The quote deliberately excludes the '
      + 'name so the landmark survives that being fixed',
  },
  {
    recording: 'dorm-40min',
    at_ms: 71_540,
    end_ms: 74_000,
    quote: 'can I rip a seat?',
    notPerson: 'tarun',
    why: 'a vocative addresses somebody else, and this is the only constraint in the set '
      + 'that can see a merge involving Tarun, who is otherwise never named in a way the '
      + 'pipeline can currently reach',
  },
  {
    recording: 'dorm-40min',
    at_ms: 48_500,
    end_ms: 54_000,
    quote: "I'm going to do a double",
    person: 'boris',
    why: 'the owner states it directly: "I was saying that I\'m doing an IEOR major (double '
      + 'major with applied math)". First-person, and confirmed by the person who said it, '
      + 'which makes it the strongest ground truth in this file',
  },
  {
    recording: 'dorm-40min',
    at_ms: 2_317_470,
    end_ms: 2_318_010,
    quote: 'Drew.',
    person: 'dhruv',
    why: 'answers "what up, what\'s the name?" asked half a second earlier; Dhruv is '
      + 'the person the owner listed whom the transcriber renders as "Drew", and he '
      + 'arrives late, which is why nothing before this can be credited to him',
  },
  {
    recording: 'dorm-40min',
    at_ms: 2_316_390,
    end_ms: 2_317_470,
    quote: "What's your name?",
    notPerson: 'dhruv',
    why: 'asks Drew for his name, so it is somebody else. Paired with the line below, this '
      + 'is the only constraint in the set that can see a merge involving Dhruv, who has '
      + 'no span-level ground truth at all. '
      + 'This landmark used to quote "Drew, Drew, nice to meet you.", which does not exist '
      + 'in the transcript the product produces — it was the retired realtime provider\'s '
      + 'rendering, and the constraint was carried over unchecked. The question before the '
      + 'answer serves the same purpose and is really there',
  },
  {
    recording: 'dorm-40min',
    at_ms: 19_360,
    end_ms: 20_400,
    quote: "I'm Boris.",
    person: 'boris',
    why: 'self-introduction, answering "You Boris?" half a second earlier',
  },
  {
    recording: 'dorm-40min',
    at_ms: 24_500,
    end_ms: 25_640,
    quote: "Oh shit, I'm Ukrainian.",
    person: 'volva',
    why: 'the Ukrainian in the room gives his name as Vova four seconds later, and is '
      + 'referred to at 2725 s as "the Ukrainian guy" whose name is Vova',
  },
  {
    recording: 'dorm-40min',
    at_ms: 29_100,
    end_ms: 31_780,
    quote: "I'm Vova.",
    person: 'volva',
    why: 'self-introduction, answering "What\'s your name?"',
  },
  {
    recording: 'dorm-40min',
    at_ms: 58_200,
    end_ms: 60_220,
    quote: 'Wait, Joshua, what are you studying?',
    notPerson: 'joshua',
    why: 'a vocative: whoever says this is addressing Joshua, so is not Joshua',
  },
  {
    recording: 'dorm-40min',
    at_ms: 1_633_630,
    end_ms: 1_635_570,
    quote: 'Do you have interest in borisen.com',
    person: 'boris',
    why: 'reading out an unsolicited email he received offering him a domain named '
      + 'after himself; he adds "The domain, he wants me to sell"',
  },
  {
    recording: 'dorm-40min',
    at_ms: 2_465_000,
    end_ms: 2_465_900,
    quote: 'night, Clara.',
    notPerson: 'clara',
    why: 'a vocative, answered by "Good night." from somebody else 1.5 s later',
  },
  {
    recording: 'dorm-40min',
    at_ms: 2_466_830,
    // Whisper ends this at 2,467.27 s; the window used to run to 2,467.71,
    // which is where the NEXT segment starts. That overshoot reached into the
    // following speaker's span, and the landmark then resolved to him — making
    // a correct reference look like it contradicted the owner. A landmark's
    // window must be the line itself, never the gap after it.
    end_ms: 2_467_270,
    quote: 'Goodnight.',
    person: 'clara',
    why: 'answers "good night, Clara"',
  },
  {
    recording: 'dorm-9pm',
    at_ms: 5_600,
    end_ms: 15_650,
    quote: "I've had a sinus infection for like three fucking months",
    person: 'Joshua',
    why: 'the owner remembers Joshua as the one with the sinus infection',
  },
  {
    recording: 'dorm-9pm',
    at_ms: 140_390,
    end_ms: 141_290,
    quote: 'let me download Luma.',
    person: 'Boris',
    why: 'the owner remembers saying this',
  },
  {
    recording: 'dorm-9pm',
    at_ms: 121_480,
    end_ms: 126_830,
    quote: 'did you think the transit app and all the buses start from today?',
    person: 'Tarun',
    why: 'the owner remembers Tarun asking about the Transit app',
  },
]

export interface LandmarkPair {
  a: Landmark
  b: Landmark
  /** What has to be true of the system's answer. */
  expect: 'same' | 'different'
  systemA: string | null
  systemB: string | null
  verdict: 'ok' | 'merge' | 'split' | 'unresolved'
}

export interface LandmarkReport {
  covered: number
  total: number
  pairs: LandmarkPair[]
  merges: LandmarkPair[]
  splits: LandmarkPair[]
}

/** Which speaker the system puts on the middle of a landmark line. */
function speakerAt(system: AttributedSegment[], landmark: Landmark): string | null {
  const midpoint = (landmark.at_ms + landmark.end_ms) / 2
  const hit = system.find((segment) => segment.start_ms <= midpoint && segment.end_ms >= midpoint)
  if (hit) return hit.speaker
  // Fall back to whoever holds the most of the line, so a system that
  // segments differently is judged on attribution rather than on boundaries.
  let best: { speaker: string; ms: number } | null = null
  for (const segment of system) {
    const overlap =
      Math.min(segment.end_ms, landmark.end_ms) - Math.max(segment.start_ms, landmark.at_ms)
    if (overlap > 0 && (!best || overlap > best.ms)) best = { speaker: segment.speaker, ms: overlap }
  }
  return best?.speaker ?? null
}

export function checkLandmarks(
  recording: Landmark['recording'],
  system: AttributedSegment[],
): LandmarkReport {
  const landmarks = LANDMARKS.filter((landmark) => landmark.recording === recording)
  const resolved = new Map<Landmark, string | null>(
    landmarks.map((landmark) => [landmark, speakerAt(system, landmark)]),
  )

  const pairs: LandmarkPair[] = []
  for (let i = 0; i < landmarks.length; i += 1) {
    for (let j = i + 1; j < landmarks.length; j += 1) {
      const a = landmarks[i]
      const b = landmarks[j]
      let expect: 'same' | 'different' | null = null
      if (a.person && b.person) expect = a.person === b.person ? 'same' : 'different'
      // A vocative pins nothing down on its own, but paired with a line the
      // addressed person definitely said, it becomes a constraint.
      else if (a.notPerson && b.person === a.notPerson) expect = 'different'
      else if (b.notPerson && a.person === b.notPerson) expect = 'different'
      if (!expect) continue

      const systemA = resolved.get(a) ?? null
      const systemB = resolved.get(b) ?? null
      const verdict: LandmarkPair['verdict'] =
        systemA === null || systemB === null
          ? 'unresolved'
          : expect === 'same'
            ? systemA === systemB ? 'ok' : 'split'
            : systemA === systemB ? 'merge' : 'ok'
      pairs.push({ a, b, expect, systemA, systemB, verdict })
    }
  }

  return {
    covered: [...resolved.values()].filter((speaker) => speaker !== null).length,
    total: landmarks.length,
    pairs,
    merges: pairs.filter((pair) => pair.verdict === 'merge'),
    splits: pairs.filter((pair) => pair.verdict === 'split'),
  }
}

export function formatLandmarks(report: LandmarkReport): string {
  const lines = [
    `  landmark lines         ${report.covered}/${report.total} covered, ` +
      `${report.pairs.length} constraints from what the lines say`,
  ]
  if (report.merges.length === 0 && report.splits.length === 0) {
    lines.push('    no merges or splits among them')
  }
  for (const pair of [...report.merges, ...report.splits]) {
    const label = pair.verdict === 'merge' ? 'MERGE' : 'SPLIT'
    lines.push(
      `    ${label}  "${pair.a.quote.slice(0, 34)}" (${pair.a.person ?? `not ${pair.a.notPerson}`}) ` +
        `and "${pair.b.quote.slice(0, 34)}" (${pair.b.person ?? `not ${pair.b.notPerson}`}) ` +
        `both -> ${pair.verdict === 'merge' ? pair.systemA : `${pair.systemA} / ${pair.systemB}`}`,
    )
  }
  const unresolved = report.pairs.filter((pair) => pair.verdict === 'unresolved').length
  if (unresolved > 0) lines.push(`    ${unresolved} constraints unresolved: the system said nothing there`)
  return lines.join('\n')
}
