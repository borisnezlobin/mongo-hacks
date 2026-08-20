/**
 * What to do with simultaneous speech, now that something can see it.
 *
 * pyannote reports overlap — 13.6 s of it on a three-minute recording, 776 s on
 * a 48-minute one — and that is a fact about the room, not a defect. The two
 * places it changes an answer are here:
 *
 *   - pooling a voiceprint. Audio where two people talk at once embeds as
 *     neither of them, and a pooled print built from it is a blend. Blends were
 *     the whole failure of the previous pipeline: two different men scored
 *     0.850 against each other while one man scored 0.833 against himself. So
 *     identity is only ever pooled from a speaker's exclusive speech.
 *   - hedging a line. A line spoken across somebody else has no single certain
 *     speaker, and asserting one is what files one person's sentence under
 *     another person's name.
 */

import type { SpeakerTurn } from './diarize-sidecar'

/**
 * The parts of each turn where nobody else was speaking.
 *
 * A turn can be cut into several pieces or removed outright. Order is
 * preserved, and pieces are non-overlapping, so the result can be pooled
 * directly.
 */
export function exclusiveTurns(turns: readonly SpeakerTurn[]): SpeakerTurn[] {
  const ordered = [...turns].sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms)
  const exclusive: SpeakerTurn[] = []

  for (const turn of ordered) {
    let pieces = [{ start_ms: turn.start_ms, end_ms: turn.end_ms }]
    for (const other of ordered) {
      if (other === turn || other.speaker === turn.speaker) continue
      if (other.start_ms >= turn.end_ms) break
      if (other.end_ms <= turn.start_ms) continue
      pieces = pieces.flatMap((piece) => {
        const start = Math.max(piece.start_ms, other.start_ms)
        const end = Math.min(piece.end_ms, other.end_ms)
        if (start >= end) return [piece]
        return [
          { start_ms: piece.start_ms, end_ms: start },
          { start_ms: end, end_ms: piece.end_ms },
        ].filter((remainder) => remainder.end_ms > remainder.start_ms)
      })
      if (pieces.length === 0) break
    }
    for (const piece of pieces) exclusive.push({ speaker: turn.speaker, ...piece })
  }
  return exclusive
}

/**
 * The stretches where two or more different people are speaking at once.
 *
 * Computed rather than inferred from how the turns are shaped: "this word sits
 * in two turns" is not the same fact, because two consecutive turns share an
 * instant at their boundary and a word straddling it touches both without
 * anybody talking over anybody. Asking that question the sloppy way flagged 80%
 * of a three-minute recording as crosstalk when 14 seconds of it was.
 */
export function overlapRegions(turns: readonly SpeakerTurn[]): { start_ms: number; end_ms: number }[] {
  const edges: { at: number; delta: number; speaker: string }[] = []
  for (const turn of turns) {
    if (turn.end_ms <= turn.start_ms) continue
    edges.push({ at: turn.start_ms, delta: 1, speaker: turn.speaker })
    edges.push({ at: turn.end_ms, delta: -1, speaker: turn.speaker })
  }
  edges.sort((a, b) => a.at - b.at || a.delta - b.delta)

  const active = new Map<string, number>()
  const regions: { start_ms: number; end_ms: number }[] = []
  let openedAt: number | null = null
  for (const edge of edges) {
    const before = active.size
    const count = (active.get(edge.speaker) ?? 0) + edge.delta
    if (count <= 0) active.delete(edge.speaker)
    else active.set(edge.speaker, count)
    const after = active.size
    if (before < 2 && after >= 2) openedAt = edge.at
    if (before >= 2 && after < 2 && openedAt !== null) {
      if (edge.at > openedAt) regions.push({ start_ms: openedAt, end_ms: edge.at })
      openedAt = null
    }
  }
  return regions
}

/**
 * Whether a span touches any stretch of simultaneous speech.
 *
 * A span with no duration is the awkward case, and it is not rare: whisper
 * gives 744 of the 8,035 words on the 48-minute recording an end equal to their
 * start (9.3%), and 40 of 575 on the three-minute one. Intersecting those with
 * `>` answers "no overlap" for every one of them, which reads the absence of
 * duration information as evidence — and it is the opposite. A zero-length word
 * is the word with the least timing to stand on, so it is exactly the one whose
 * speaker should be settled by its neighbours rather than by a boundary it
 * happens to land on. 248 of them sit strictly inside an overlap region and
 * were scored as uncontested, so smoothSpeakers skipped them.
 *
 * What that cost, measured on dorm-40min: of 231 lines that are two words or
 * fewer sandwiched between two lines of the same other speaker — the transcript
 * ping-ponging a word at a time — 80 contain such a word. Counting them as
 * contested takes the join from 1,065 lines to 924 and those 231 to 135, and
 * dorm-9pm from 48 to 46 and 4 to 3. "I'm Vova" stays whole on SPEAKER_02,
 * which is the thing that must not regress and is asserted in
 * word-join.measured.test.ts along with the line-count movement.
 *
 * Strictly inside, not touching: a zero-length span on a region's own edge is a
 * boundary, not simultaneous speech, and the whole point of computing regions
 * rather than counting turns is to not confuse those two.
 *
 * This does not fix all of the ping-pong, and the rest was measured rather than
 * assumed. Of what remains, about 9% comes from pyannote emitting turns too
 * short to hold a word — 621 of 1,822 turns are under 250 ms, some 17 ms, and
 * 397 of those are nested inside another speaker's turn. A duration floor on
 * nested micro-turns was considered and rejected: 9% is not worth a rule that
 * can delete a real short turn, and "I'm Vova" is what a real short turn looks
 * like. The remainder is genuinely concurrent speech — two people pyannote
 * heard at once and one stream of words whisper wrote — where per-word
 * attribution alternates because both speakers really are active. That needs
 * acoustic evidence per word, not a smoothing rule, and is left alone on
 * purpose.
 */
export function inOverlap(
  regions: readonly { start_ms: number; end_ms: number }[],
  startMs: number,
  endMs: number,
): boolean {
  if (endMs <= startMs) {
    return regions.some((region) => startMs > region.start_ms && startMs < region.end_ms)
  }
  return regions.some((region) => Math.min(endMs, region.end_ms) > Math.max(startMs, region.start_ms))
}

/** Total speech in a set of turns. Only meaningful on non-overlapping spans. */
export function totalMs(turns: readonly SpeakerTurn[]): number {
  return turns.reduce((total, turn) => total + (turn.end_ms - turn.start_ms), 0)
}
