/**
 * Join whisper's words to pyannote's speakers, at word level.
 *
 * Two sources, each doing the one thing it is good at. Whisper transcribes a
 * whole file coherently and has no idea who is talking; pyannote knows who is
 * talking and not what they said. Asking one model for both is what produced
 * the transcript the owner called "pretty bad" — fragments like "but like",
 * "Yeah. That's", "No, alright," — because it was transcribing 16-minute chunks
 * of seven-way crosstalk.
 *
 * The join is at WORD level and not at segment level. A whisper segment
 * routinely spans a speaker change, so attributing whole segments hands one
 * person the other's words, which is the single most expensive mistake this
 * system can make: facts and promises are filed against whoever the utterance
 * says was speaking.
 *
 * That is true and it understates the case in the wrong direction. Measured by
 * eval/real/sentence_purity.py, the pyannote turn this file already trusts is
 * the dirtier unit of the two:
 *
 *                        impure units   speech misattributed
 *   dorm-40min  turns        25.1%              8.1%
 *               sentences     5.9%              1.9%
 *   dorm-9pm    turns        45.8%             10.6%
 *               sentences    15.5%              2.5%
 *
 * So a sentence is roughly four times purer than a turn, and word-level
 * attribution is right for both reasons rather than only the stated one.
 * Attributing whole SENTENCES was tried on the strength of those numbers and
 * reverted: settling each sentence by the turn holding most of it cut landmark
 * merges 6 to 4, and printing the labels rather than counting collisions showed
 * the errors had moved onto labels no landmark watches rather than being fixed.
 * The sentence-as-unit idea is still sound; max-overlap was the wrong way to
 * spend it, because it trades away the long-turn protection speakerForSpan
 * exists to provide. See that function's comment, and run
 * eval/real/landmark-labels.mts before believing any drop in the merge count.
 */

import type { SpeakerTurn } from './diarize-sidecar'
import { inOverlap, overlapRegions } from './overlap'

/** The shape both whisper-client and StreamBuffer already produce. */
export interface TimedWord {
  text: string
  start_ms: number
  end_ms: number
}

export interface AttributedTurn {
  /** Null when the word landed in speech pyannote heard nobody in. */
  speaker: string | null
  text: string
  start_ms: number
  end_ms: number
  words: TimedWord[]
  /** How many of this line's words were spoken while somebody else was talking. */
  overlappedWords: number
  /**
   * True when most of this line was spoken over somebody else.
   *
   * Most, not any. A line is several seconds long and a single interjection
   * touches it, so "any" is a far wider net than the overlap it is protecting
   * against:
   *
   *                words spoken over    lines touching it    lines mostly it
   *   3 min             11%                  46%                   3%
   *   48 min            30%                  73%                  30%
   *
   * Extraction refuses to file a fact below 'confirmed', so hedging on "any"
   * would put three quarters of the long recording out of its reach to protect
   * the third of it that is genuinely contested. A line whose every other word
   * is clean has a speaker we are not in doubt about.
   */
  overlapped: boolean
}

/**
 * How far a word may reach to find a speaker when it lands in no turn at all.
 *
 * This matters more than it looks. Whisper and pyannote place boundaries
 * independently and disagree by fractions of a second constantly, so without a
 * tolerance every disagreement orphans a word onto its own unattributed line
 * and the transcript reads as confetti.
 *
 * 400 ms is the reference implementation's value, kept rather than fitted.
 * Swept on both real recordings (`bun run eval:diarization --snap`, and
 * asserted in word-join.measured.test.ts):
 *
 *              3 min, 575 words        48 min, 8,035 words
 *      0 ms    103 lines  92.2%        1764 lines  89.8%
 *    100 ms     36 lines  99.3%         548 lines  99.1%
 *    250 ms     35 lines  99.5%         540 lines  99.2%
 *    400 ms     35 lines  99.7%  <-     526 lines  99.4%  <- shipping
 *    600 ms     35 lines  99.7%         526 lines  99.5%
 *   1000 ms     35 lines  99.8%         523 lines  99.6%
 *
 * The answer is flat from 100 ms to a second and falls off a cliff at zero, so
 * the number is taken from the middle of a plateau rather than from a peak —
 * which is the only kind of constant that survives a different room. Beyond the
 * tolerance the word really is in silence and stays unattributed, rather than
 * being handed to whoever spoke nearby.
 */
export const SNAP_MS = 400

/**
 * Silence inside one speaker's run that still reads as one line.
 *
 * Two seconds, from the reference implementation. It is a paragraph-break knob,
 * not an accuracy knob: nothing downstream changes its mind about who spoke
 * because two of their sentences arrived as one line or two.
 */
export const TURN_GAP_MS = 2_000

/**
 * Speech a turn must hold before its speaker label is worth repeating.
 *
 * Not a smoothing knob and not a guess. Measured on both real recordings, by
 * cutting clips out of single reference spans and asking two independent
 * speaker-embedding architectures whether two clips are the same person
 * (`eval/real/duration_floor.py`):
 *
 *                wespeaker AUC / EER      ECAPA AUC / EER
 *      0.5 s        0.585 / 0.42            0.588 / 0.45
 *      1.0 s        0.744 / 0.32            0.706 / 0.35
 *      2.0 s        0.855 / 0.24            0.842 / 0.24
 *      4.0 s        0.935 / 0.13            0.929 / 0.13
 *
 * At half a second the decision is a coin flip on this microphone, whichever
 * model asks it, so a label attached to that much speech carries no information
 * and every downstream consumer treats it as if it did: facts get filed against
 * whoever the label names. Withholding the name is the honest output, and the
 * pipeline already has somewhere to put it — an unattributed line.
 *
 * ZERO, and measured rather than assumed. The diagnosis holds -- a turn under
 * half a second carries the right label 44% of the time on dorm-40min and 13%
 * on dorm-9pm, against 77-92% for turns over four seconds -- but blanking those
 * labels is a bad trade. Scored against the reference spans by
 * `eval/real/abstain_cost.mts`, every floor removes about 2.7 right names for
 * each wrong one:
 *
 *   dorm-40min   named   accuracy of what is left   right lost   wrong lost
 *          0 ms  99.9%          83.9%                     0            0
 *        500 ms  94.2%          84.5%                   135           46
 *       1500 ms  83.1%          86.6%                   378          158
 *       3000 ms  65.2%          87.6%                   848          258
 *
 * Two and a half points of precision for a sixth of the transcript going dark,
 * and `eval/real/abstain_sweep.mts` shows the line count rising 774 -> 1204 and
 * two-word interjections 102 -> 197 as unattributed lines cut runs in half.
 * Worst of all it cannot reach the case that motivated it: "Where are you
 * from?" sits inside a single 6.16-second turn, so no turn-length floor sees
 * it, and that merge survives every value here.
 *
 * Kept as a measured zero rather than deleted, because the floor is the right
 * shape for a different unit -- a fragment inside an impure turn, once
 * something can find the seam -- and this is the instrument that will price it.
 */
export const MIN_TURN_MS = 0

/** Milliseconds of a word's span that a turn holds. */
function overlapMs(turn: SpeakerTurn, startMs: number, endMs: number): number {
  return Math.min(endMs, turn.end_ms) - Math.max(startMs, turn.start_ms)
}

/**
 * Who was speaking across this span: the turn this word is most characteristic
 * of, measured as the share of that turn the word occupies.
 *
 * This replaced a rule that picked whichever turn held the most of the word.
 * That earlier rule was rejected once on measurement and then reinstated, and
 * the history is worth keeping because both readings were partly right.
 *
 * When somebody cuts across a person who has the floor, pyannote emits a long
 * turn for the floor-holder AND a short turn for the interjection. A word
 * inside the interjection lies fully in both, so greatest-overlap ties and the
 * floor-holder wins — which means a long turn absorbs everything spoken across
 * it. On the owner's recording one 19-second turn swallowed a 24-second stretch
 * containing a question, a third person spelling his name, and the owner
 * stating his own major, and credited all of it to one speaker. He noticed
 * immediately; it was the first thing he said about the transcript.
 *
 * Scoring by fit was measured against that and looked worse: it moved no
 * landmark verdict and more than doubled the line count, 519 to 1200. Both
 * observations were true and neither was the whole picture. The line explosion
 * was flicker, not turns — fixed by smoothing over a neighbourhood, see
 * smoothSpeakers. And no landmark moved because no landmark covered the case;
 * the owner then told us in his own words which of those lines was his, and
 * that landmark is now in the set. Against it:
 *
 *   greatest overlap   519 lines   3 merge verdicts   the owner's line WRONG
 *   this rule + smooth 800 lines   1 merge verdict    the owner's line right
 *
 * The remaining merge is a landmark whose window was written from the
 * segmentation this replaces, not a pipeline error.
 *
 * The general lesson, which is why this is written down at length: a metric
 * built from the thing you are replacing will prefer the thing you are
 * replacing. The person who was in the room outranks it.
 */
export function speakerForSpan(
  turns: readonly SpeakerTurn[],
  startMs: number,
  endMs: number,
  snapMs: number = SNAP_MS,
  minTurnMs: number = MIN_TURN_MS,
): string | null {
  let best: { speaker: string; fit: number; held: number; length: number } | null = null
  for (const turn of turns) {
    if (turn.start_ms >= endMs) break
    const held = overlapMs(turn, startMs, endMs)
    if (held <= 0) continue
    const length = turn.end_ms - turn.start_ms
    const fit = held / Math.max(length, 1)
    if (!best || fit > best.fit || (fit === best.fit && held > best.held)) {
      best = { speaker: turn.speaker, fit, held, length }
    }
  }
  // A turn shorter than the floor is a turn whose label was read off too little
  // speech to be worth anything, so it names nobody rather than naming the
  // wrong person. It still blocks the snap below: the word was heard, and
  // handing it to a neighbour is exactly the error being avoided.
  if (best) return best.length < minTurnMs ? null : best.speaker

  let nearest: string | null = null
  let gap = snapMs
  for (const turn of turns) {
    if (turn.end_ms - turn.start_ms < minTurnMs) continue
    const distance =
      turn.start_ms > endMs ? turn.start_ms - endMs : startMs > turn.end_ms ? startMs - turn.end_ms : 0
    if (distance < gap) {
      gap = distance
      nearest = turn.speaker
    }
  }
  return nearest
}

/**
 * Group words into lines a person would recognise, one speaker each.
 *
 * Turns are cut wherever the speaker changes and wherever one speaker pauses
 * for longer than the gap. Unattributed words group together as well, so a
 * stretch pyannote heard nobody in stays as readable text with no name on it
 * rather than disappearing.
 */
/**
 * Words a single speaker must hold before it counts as a turn.
 *
 * Whisper transcribes whichever voice dominates each moment, so inside a
 * stretch where two people talk at once the per-word winner alternates and the
 * transcript ping-pongs a word at a time — 1,501 lines where 795 describe the
 * same conversation. Somebody who holds the floor for one word between two
 * words of somebody else did not take a turn. A real turn survives its
 * neighbourhood; flicker does not.
 */
const SMOOTH_RADIUS = 2

/**
 * A whisper sentence, used as a neighbourhood and never as a unit of attribution.
 *
 * The distinction matters and the file header states the other half of it: a
 * whisper segment routinely spans a speaker change, so giving a whole segment
 * to one speaker hands one person the other's words. Nothing below does that.
 * What the sentence is used for is narrower — deciding which of two speakers
 * owns a word that was spoken while both were talking, using the words of the
 * same sentence that nobody talked over.
 */
export interface TranscriptSegment { start_ms: number; end_ms: number }

/** Which transcript sentence each word belongs to, or -1 for none. */
function sentenceOfWord(
  words: readonly TimedWord[],
  segments: readonly TranscriptSegment[],
): number[] {
  return words.map((word) => {
    const midpoint = (word.start_ms + word.end_ms) / 2
    return segments.findIndex(
      (segment) => segment.start_ms <= midpoint && midpoint <= segment.end_ms,
    )
  })
}

/** The one speaker a set of votes agrees on, or null when they do not agree. */
function outrightWinner(votes: Map<string, number>): string | null {
  let winner: string | null = null
  let best = 0
  let tied = false
  for (const [candidate, count] of votes) {
    if (count > best) { best = count; winner = candidate; tied = false }
    else if (count === best) tied = true
  }
  return tied ? null : winner
}

/**
 * Speakers each transcript sentence holds in the parts nobody talked over.
 *
 * Whisper's sentence boundaries are the third independent source in this join
 * and the only one that knows where an utterance begins and ends — pyannote
 * knows where a voice changes, and a voice changing is not the same event.
 */
function cleanSpeakersBySentence(
  perWord: readonly (string | null)[],
  contested: readonly boolean[],
  sentence: readonly number[],
): Map<number, Map<string, number>> {
  const clean = new Map<number, Map<string, number>>()
  for (const [index, id] of sentence.entries()) {
    const speaker = perWord[index]
    if (id < 0 || contested[index] || !speaker) continue
    const votes = clean.get(id) ?? new Map<string, number>()
    votes.set(speaker, (votes.get(speaker) ?? 0) + 1)
    clean.set(id, votes)
  }
  return clean
}

/**
 * Settle contested words, preferring the sentence they belong to over a window.
 *
 * Two rules, tried in that order, and both confined to simultaneous speech for
 * the reason recorded below.
 *
 * The sentence rule exists because a five-word window is a poor description of
 * an utterance. On dorm-9pm somebody asks "Also, Josh, tomorrow, do you want to
 * go to the game night at the Steam Union?" and Josh answers "Um, what time is
 * it?". pyannote hears both voices across the last three words of the question
 * — genuinely, its segmentation model reports two speakers over 59.4-60.1 s —
 * so those words are contested, and the shorter of the two turns wins them.
 * That put "the Steam Union?" on the answerer, which splits one question across
 * two people and leaves the vocative with no unambiguous reply after it. The
 * clean words of that sentence all name one speaker, and they are much better
 * evidence about its last three words than the words either side of a boundary.
 *
 * Where the sentence's clean words do NOT agree, it says nothing and the
 * neighbourhood decides. That is not a fallback for rare cases; whisper
 * sentences span a real speaker change often, and a sentence that does has
 * nothing to contribute about who owns its contested part.
 *
 * Measured on both recordings, no landmark verdict moves in either direction
 * and no merge or split appears:
 *
 *                          lines   two-word interjections   words on a speaker
 *   dorm-40min   window     924            135                     99.38%
 *                sentence   774            102                     99.38%
 *   dorm-9pm     window      46              3                     99.65%
 *                sentence    42              3                     99.65%
 *
 * "I'm Vova" stays whole and stays on a speaker of its own, which is the thing
 * that must not regress; it is uncontested speech, so neither rule reaches it.
 *
 * What it buys downstream, with no naming rule changed: the "Also, Josh"
 * vocative goes from SPEAKER_03 at 0.231 — "the turn replies to the voice that
 * just spoke, but another voice is as likely" — to SPEAKER_00 at 0.413, "the
 * next voice to speak answers the address". SPEAKER_00 is the voice that says
 * "Um, what time is it?", so the address now has one reply rather than a
 * fragment of the question in front of it. Still under the threshold, so Josh
 * is not nameable yet; a perfect diarization of the same audio reaches 0.55.
 */
function smoothSpeakers(
  perWord: readonly (string | null)[],
  contested: readonly boolean[],
  sentence: readonly number[] = [],
): (string | null)[] {
  const clean = cleanSpeakersBySentence(perWord, contested, sentence)
  return perWord.map((speaker, index) => {
    // Only smooth inside simultaneous speech. That is the only place the
    // flicker comes from — whisper following whichever voice dominates — and
    // outside it a short turn is a real one. Smoothing everywhere ate exactly
    // the turns this product cannot afford to lose: "I'm Vova" is two words, so
    // it was absorbed into the neighbouring speaker, and a self-introduction
    // swallowed by the person being introduced to is how a room full of people
    // stays nameless.
    if (!contested[index]) return speaker
    // A word nobody was heard speaking stays that way. Smoothing settles which
    // of two speakers said something; it must never invent a speaker for speech
    // that reached no turn at all, which is what SNAP_MS decides and what the
    // unattributed line exists to show honestly.
    if (speaker === null) return null
    // Who the rest of this sentence belongs to, where the rest of it was not
    // spoken over. See the note above smoothSpeakers: a sentence whose clean
    // words all name one speaker is the strongest evidence available about its
    // contested words, and a neighbourhood of five words is a poor substitute
    // for it because the neighbourhood is a window, not an utterance.
    const sentenceVotes = clean.get(sentence[index] ?? -1)
    const agreed = sentenceVotes && outrightWinner(sentenceVotes)
    // No agreement means the sentence really does span a speaker change, which
    // whisper's sentences do routinely. Then it says nothing, and the
    // neighbourhood decides as before.
    if (agreed) return agreed
    const counts = new Map<string, number>()
    for (let i = Math.max(0, index - SMOOTH_RADIUS); i <= Math.min(perWord.length - 1, index + SMOOTH_RADIUS); i += 1) {
      const candidate = perWord[i]
      if (candidate) counts.set(candidate, (counts.get(candidate) ?? 0) + 1)
    }
    // Ties keep the word's own speaker. Smoothing is there to overrule a lone
    // flicker, so it needs a strict majority against what the audio said; on an
    // even split the word's own turn is the better evidence, and anything else
    // drags boundary words backwards into the previous speaker.
    let winner = speaker
    let best = counts.get(speaker) ?? 0
    for (const [candidate, count] of counts) {
      if (count > best) { best = count; winner = candidate }
    }
    return winner
  })
}

export function joinWordsToSpeakers(
  words: readonly TimedWord[],
  turns: readonly SpeakerTurn[],
  options: {
    snapMs?: number
    gapMs?: number
    minTurnMs?: number
    segments?: readonly TranscriptSegment[]
  } = {},
): AttributedTurn[] {
  const snapMs = options.snapMs ?? SNAP_MS
  const gapMs = options.gapMs ?? TURN_GAP_MS
  const minTurnMs = options.minTurnMs ?? MIN_TURN_MS
  const ordered = [...turns].sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms)
  const regions = overlapRegions(ordered)

  const sorted = [...words].sort((a, b) => a.start_ms - b.start_ms)
  const perWord = sorted.map((word) =>
    speakerForSpan(ordered, word.start_ms, word.end_ms, snapMs, minTurnMs),
  )
  const contested = sorted.map((word) => inOverlap(regions, word.start_ms, word.end_ms))
  const smoothed = smoothSpeakers(perWord, contested, sentenceOfWord(sorted, options.segments ?? []))

  const lines: AttributedTurn[] = []
  for (const [index, word] of sorted.entries()) {
    const speaker = smoothed[index]
    const contested = inOverlap(regions, word.start_ms, word.end_ms)
    const current = lines[lines.length - 1]
    if (current && current.speaker === speaker && word.start_ms - current.end_ms < gapMs) {
      current.text += ` ${word.text.trim()}`
      current.end_ms = Math.max(current.end_ms, word.end_ms)
      current.words.push(word)
      if (contested) current.overlappedWords += 1
      continue
    }
    lines.push({
      speaker,
      text: word.text.trim(),
      start_ms: word.start_ms,
      end_ms: word.end_ms,
      words: [word],
      overlappedWords: contested ? 1 : 0,
      overlapped: false,
    })
  }
  for (const line of lines) line.overlapped = line.overlappedWords * 2 > line.words.length
  return lines
}

/** Speech each speaker holds, for the pooling that identity is asked about. */
export function speechMsBySpeaker(turns: readonly SpeakerTurn[]): Map<string, number> {
  const totals = new Map<string, number>()
  for (const turn of turns) {
    totals.set(turn.speaker, (totals.get(turn.speaker) ?? 0) + (turn.end_ms - turn.start_ms))
  }
  return totals
}
