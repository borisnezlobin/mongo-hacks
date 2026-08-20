/**
 * Re-attribute whole SENTENCES against pooled voice models, as a final pass.
 *
 * Two results that were established separately and had never been combined:
 *
 *   A whisper sentence is about four times purer than a diarization turn --
 *   5.9% against 25.1% impure on dorm-40min, 15.5% against 45.8% on dorm-9pm
 *   (eval/real/sentence_purity.py) -- so it is the better unit to attribute.
 *
 *   Comparing a clip against a POOLED model of a voice beats any per-turn
 *   comparison, by a margin that dwarfs the differences between embedding
 *   models.
 *
 * Attributing sentences has been tried here once and was reverted. It settled
 * each sentence by max overlap -- whichever turn the sentence sat inside most --
 * which throws away the long-turn protection in `speakerForSpan` and moved
 * landmark errors onto labels no landmark watches instead of fixing them. The
 * unit was right; the matcher was wrong. This keeps the unit and replaces the
 * matcher.
 *
 * Measured on the real recordings, against pyannote 3.1 turns as the baseline:
 *
 *                     labels (true)  merges  splits  flicker    DER   purity
 *   dorm-40min base       8 (7)          7       5      23     42.0%   76.9%
 *              this       8 (7)          1       3       0     27.7%   80.6%
 *   dorm-9pm   base       4 (3)          0       0       0     34.1%   73.6%
 *              this       4 (3)          0       0       0     20.9%   78.6%
 *
 * Twelve landmark violations become four, and every one that remains is the
 * same 0.68 s line, "Where are you from?" -- split from Volva's other lines and
 * merged with one that is not his. The rest are fixed rather than relocated,
 * which is the distinction `eval/real/landmark-labels.mts` exists to draw:
 * Volva's other three lines land together and Boris's three land together,
 * where the turns this replaces put `M-A-R-T` on Volva and fused a question
 * with the answer to it in three places.
 *
 * `flicker` is a short line torn out of the middle of a whisper sentence, which
 * is the defect the ping-pong ceiling in word-join.measured.test.ts was written
 * to catch. This pass cannot produce one, because its units are whole
 * sentences. The raw line count rises (774 to 1,032 on dorm-40min) for the same
 * reason the merges fall -- separating a question from its answer adds a line --
 * so the two move in opposite directions and only one of them is a defect.
 *
 * Read the merge count next to the LABEL count, always: more labels lower a
 * merge count for free. The label count is unchanged here, so the merges were
 * fixed rather than fragmented away.
 *
 * THE EMBEDDER IS NOT INCIDENTAL, and it is the easiest thing here to get
 * wrong. `eval/real/embedders.py` defaults to wespeaker; the sidecar ships
 * `speechbrain/spkrec-ecapa-voxceleb`. Run the eval on its own default and the
 * same pipeline with the same constants scores worse than it does in
 * production, and every parameter in the sweep matters less than that one
 * choice. Measure against the model that actually runs:
 *   eval/real/sentence_pooled.py <stem> --embedder speechbrain/spkrec-ecapa-voxceleb
 *
 * LIVE VS FINAL. This is final-pass only and cannot be otherwise: a pool is
 * built from a whole recording's confident speech, so attributing a sentence
 * early would use speech that has not been heard yet. The live pass keeps its
 * own answer and this rewrites it, which the app already handles -- utterances
 * are revised by `utterance_id`. The pools themselves are lookbehind-only by
 * construction, so an incremental variant that re-attributes only the settled
 * tail is possible later; nothing here depends on the future.
 */

import type { SpeakerTurn } from './diarize-sidecar'
import type { TimedWord } from './word-join'

/**
 * Shortest clip worth embedding.
 *
 * Below this a clip embeds to noise rather than to a voice. Sentences under the
 * floor are not guessed and not dropped: the diarizer's own turns cover that
 * time, so this pass only ever adds information. Keeping them was worth 9.3
 * points of missed detection on dorm-9pm (11.5% down to 1.7%, against a 2.7%
 * baseline).
 */
export const SENTENCE_MIN_MS = 300

/**
 * Shortest sentence this pass is willing to attribute.
 *
 * Between SENTENCE_MIN_MS and here a clip embeds to something, but not to
 * something worth overruling the diarizer with: half-second discrimination has
 * been measured at close to chance on this audio. Those sentences are DEFERRED,
 * keeping the diarizer's turns at their own resolution.
 *
 * Swept at 0, 0.3, 0.4, 0.5, 0.6 and 0.7 s. Landmarks are zero merges and zero
 * splits on both scored recordings from 0 to 0.6 and break at 0.7 (3 merges on
 * dorm-40min), while the transcript gets steadily less choppy as it rises --
 * dorm-40min goes 1,136 lines / 93 interjections at 0 to 978 / 58 at 0.6. 500 ms
 * is interior to the safe band rather than at its edge, and it is the length
 * below which this repository has separately measured speaker discrimination to
 * be near chance, which is a reason from outside this sweep.
 */
export const SENTENCE_TRUST_MS = 500

/**
 * How much speech a pooled voice model is built from, at most.
 *
 * Swept at 10, 20, 40 and 80 seconds on both scored recordings. 20, 40 and 80
 * all reach zero merges and zero splits on both; 10 does not (7 merges on
 * dorm-40min), because a 10 s budget yields pools averaging 9 s. 40 s is taken
 * from the middle of the working range, and it is also the smallest budget
 * whose realised pools clear 20 s on average (24 s, against 15 s at a 20 s
 * budget) -- 20 s of pooled speech being the floor established independently
 * for real room audio.
 */
export const POOL_BUDGET_MS = 40_000

/**
 * Shortest turn allowed to contribute to a pool.
 *
 * A pool is meant to average away what one short clip gets wrong, so it is
 * built from long turns nobody talks over.
 *
 * This is the one constant the two recordings disagree about, so it was swept
 * on both and the value taken from where they overlap. dorm-40min reaches zero
 * merges anywhere from 0.3 s to 1.8 s and degrades from 2.0 s; dorm-9pm needs
 * at least 1.4 s and holds to 2.5 s. The intersection is 1.4 to 1.8 s -- five
 * adjacent cells with zero merges and zero splits on BOTH -- and 1.6 s is its
 * middle. Below 1.4 s dorm-9pm regresses to one merge against a baseline of
 * zero, which is the regression gate, and above 1.9 s dorm-40min loses the
 * fixes because too few stretches survive to pool from.
 */
export const POOL_MIN_TURN_MS = 1_600

export interface Sentence {
  start_ms: number
  end_ms: number
  text: string
  /**
   * Whether the run actually ended in a full stop, question mark or
   * exclamation.
   *
   * A run of words with no terminator is not a sentence, it is however much
   * speech happened to be left over, and treating it as one unit asserts that
   * all of it is one person. With punctuation missing entirely that unit is the
   * whole recording, which would overwrite every boundary the diarizer found.
   * Callers must not attribute an unterminated run.
   */
  terminated: boolean
}

/**
 * Whisper's sentences, from its own timed words.
 *
 * Requires `restorePunctuation` to have run: the timed word stream arrives
 * stripped to bare tokens, and without punctuation every recording is one
 * sentence.
 */
export function sentencesFromWords(words: readonly TimedWord[]): Sentence[] {
  const sentences: Sentence[] = []
  let current: TimedWord[] = []
  for (const word of words) {
    current.push(word)
    if (/[.?!]["')\]]*\s*$/.test(word.text)) {
      sentences.push(toSentence(current, true))
      current = []
    }
  }
  if (current.length > 0) sentences.push(toSentence(current, false))
  return sentences
}

function toSentence(words: TimedWord[], terminated: boolean): Sentence {
  return {
    start_ms: words[0].start_ms,
    end_ms: words[words.length - 1].end_ms,
    text: words.map((word) => word.text.trim()).join(' '),
    terminated,
  }
}

/**
 * Turns long enough, and clean enough, to pool a voice from.
 *
 * A stretch somebody else talks across is a stretch whose voice is a blend, and
 * a pool of blends describes nobody. That mistake has cost this repository more
 * time than any other, so overlap is excluded rather than tolerated.
 */
export function poolableStretches(
  turns: readonly SpeakerTurn[],
  minTurnMs: number = POOL_MIN_TURN_MS,
): Map<string, SpeakerTurn[]> {
  const bySpeaker = new Map<string, SpeakerTurn[]>()
  for (const turn of turns) {
    if (turn.end_ms - turn.start_ms < minTurnMs) continue
    const overlapped = turns.some(
      (other) =>
        other !== turn &&
        other.speaker !== turn.speaker &&
        other.start_ms < turn.end_ms &&
        turn.start_ms < other.end_ms,
    )
    if (overlapped) continue
    const list = bySpeaker.get(turn.speaker) ?? []
    list.push(turn)
    bySpeaker.set(turn.speaker, list)
  }
  for (const list of bySpeaker.values()) {
    list.sort((a, b) => b.end_ms - b.start_ms - (a.end_ms - a.start_ms))
  }
  return bySpeaker
}

/** The longest stretches of one speaker, up to a budget of speech. */
export function stretchesWithinBudget(
  stretches: readonly SpeakerTurn[],
  budgetMs: number = POOL_BUDGET_MS,
): { start_ms: number; end_ms: number }[] {
  const taken: { start_ms: number; end_ms: number }[] = []
  let total = 0
  for (const turn of stretches) {
    if (total >= budgetMs) break
    const end_ms = Math.min(turn.end_ms, turn.start_ms + (budgetMs - total))
    taken.push({ start_ms: turn.start_ms, end_ms })
    total += end_ms - turn.start_ms
  }
  return taken
}

/** One buffer from many, for pooling a voice out of scattered stretches. */
export function concatSamples(pieces: readonly Float32Array[]): Float32Array {
  const total = pieces.reduce((sum, piece) => sum + piece.length, 0)
  const out = new Float32Array(total)
  let at = 0
  for (const piece of pieces) {
    out.set(piece, at)
    at += piece.length
  }
  return out
}

/** Cosine of two unit-comparable vectors; 0 when either has no magnitude. */
function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 0
  return dot / Math.sqrt(normA * normB)
}

/** The pooled voice this sentence sounds most like. */
export function bestPool(vector: readonly number[], pools: ReadonlyMap<string, number[]>): string | null {
  let best: string | null = null
  let bestScore = Number.NEGATIVE_INFINITY
  for (const [speaker, pool] of pools) {
    const score = cosine(vector, pool)
    if (score > bestScore) {
      best = speaker
      bestScore = score
    }
  }
  return best
}

/**
 * Rewrite turns so each attributed sentence is one turn of its own speaker,
 * and every other instant keeps the diarizer's answer.
 *
 * The second half is what makes this safe to run: speech whisper never
 * transcribed, and sentences too short to embed, are covered by the turns that
 * were already there rather than being dropped on the floor.
 */
export function rewriteTurns(
  turns: readonly SpeakerTurn[],
  attributed: readonly { start_ms: number; end_ms: number; speaker: string }[],
): SpeakerTurn[] {
  const covered = [...attributed]
    .map((sentence) => ({ start_ms: sentence.start_ms, end_ms: sentence.end_ms }))
    .sort((a, b) => a.start_ms - b.start_ms)
  const merged: { start_ms: number; end_ms: number }[] = []
  for (const span of covered) {
    const last = merged[merged.length - 1]
    if (last && span.start_ms <= last.end_ms) last.end_ms = Math.max(last.end_ms, span.end_ms)
    else merged.push({ ...span })
  }

  const out: SpeakerTurn[] = attributed.map((sentence) => ({ ...sentence }))
  for (const turn of turns) {
    let pieces = [{ start_ms: turn.start_ms, end_ms: turn.end_ms }]
    for (const span of merged) {
      const next: { start_ms: number; end_ms: number }[] = []
      for (const piece of pieces) {
        if (span.end_ms <= piece.start_ms || span.start_ms >= piece.end_ms) {
          next.push(piece)
          continue
        }
        if (span.start_ms > piece.start_ms) {
          next.push({ start_ms: piece.start_ms, end_ms: Math.min(span.start_ms, piece.end_ms) })
        }
        if (span.end_ms < piece.end_ms) {
          next.push({ start_ms: Math.max(span.end_ms, piece.start_ms), end_ms: piece.end_ms })
        }
      }
      pieces = next
    }
    for (const piece of pieces) {
      if (piece.end_ms - piece.start_ms > 50) out.push({ ...piece, speaker: turn.speaker })
    }
  }
  out.sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms)

  // Two abutting turns of one speaker are one turn. Leaving them split makes
  // the join emit two lines for a single stretch of talking, which reads as
  // the speaker interrupting themselves.
  const coalesced: SpeakerTurn[] = []
  for (const turn of out) {
    const last = coalesced[coalesced.length - 1]
    if (last && last.speaker === turn.speaker && turn.start_ms <= last.end_ms) {
      last.end_ms = Math.max(last.end_ms, turn.end_ms)
    } else {
      coalesced.push({ ...turn })
    }
  }
  return coalesced
}
