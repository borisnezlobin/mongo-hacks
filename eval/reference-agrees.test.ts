/**
 * The span reference and the landmarks must not contradict each other.
 *
 * They are different kinds of evidence about the same recording. Landmarks are
 * lines whose speaker the words themselves settle — several of them are the
 * owner's own corrections, given after listening. The span reference is derived
 * from voiceprint clustering, so it inherits whatever that clustering got wrong.
 *
 * Where they disagree, the landmark is right. That matters because every rate
 * this project quotes — DER, per-person recall, purity — is computed against
 * the reference, so a mislabelled span silently biases all of them, and biases
 * them worst exactly where we have the best evidence.
 *
 * This is not hypothetical. The reference labels the stretch containing the
 * owner-identified "Drew." (2317470 ms) as a single continuous `tarun` span
 * covering both the question and the answer to it — the same question-fused-
 * with-its-answer merge the pipeline was failing at, baked into the ground
 * truth we were scoring against. An investigation into a suspected false
 * identity link spent hours before finding the reference was the thing at
 * fault.
 *
 * A failure here is not a reason to edit the landmark. It means the reference
 * needs regenerating, or that span needs dropping — an unlabelled span is
 * honest, a wrongly labelled one is not.
 */

import { describe, expect, it } from 'vitest'
import { LANDMARKS } from './landmarks'
import { dormReference, ninePmReference } from './ground-truth'

interface Span {
  speaker: string
  start_ms: number
  end_ms: number
}

/** The span holding most of this landmark, which is how the scorer resolves one. */
function coveringSpeaker(spans: readonly Span[], at: number, end: number): string | null {
  let best: { speaker: string; held: number } | null = null
  for (const span of spans) {
    const held = Math.min(end, span.end_ms) - Math.max(at, span.start_ms)
    if (held <= 0) continue
    if (!best || held > best.held) best = { speaker: span.speaker, held }
  }
  return best?.speaker ?? null
}

const RECORDINGS = [
  { recording: 'dorm-40min' as const, reference: dormReference },
  { recording: 'dorm-9pm' as const, reference: ninePmReference },
]

describe('the reference agrees with what the owner settled', () => {
  for (const { recording, reference } of RECORDINGS) {
    const loaded = reference()

    it.skipIf(!loaded)(`${recording}: no span contradicts a landmark`, () => {
      if (!loaded) return
      const spans = loaded.spans as Span[]
      const known = new Set(spans.map((span) => span.speaker.toLowerCase()))

      const conflicts: string[] = []
      for (const landmark of LANDMARKS) {
        if (landmark.recording !== recording) continue
        const covering = coveringSpeaker(spans, landmark.at_ms, landmark.end_ms)
        if (!covering) continue

        const person = landmark.person?.toLowerCase()
        const notPerson = landmark.notPerson?.toLowerCase()
        const found = covering.toLowerCase()

        // A person the reference has never heard of cannot be compared: the two
        // sources name different sets of people, and absence is not disagreement.
        if (person && known.has(person) && found !== person) {
          conflicts.push(`${landmark.at_ms}ms "${landmark.quote}" is ${person}, reference says ${found}`)
        }
        if (notPerson && found === notPerson) {
          conflicts.push(`${landmark.at_ms}ms "${landmark.quote}" is NOT ${notPerson}, reference says ${found}`)
        }
      }

      expect(conflicts).toEqual([])
    })
  }
})
