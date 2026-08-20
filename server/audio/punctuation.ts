/**
 * Put whisper's punctuation back onto whisper's own timed words.
 *
 * A verbose_json response describes the same audio twice. `segments` is prose —
 * " Yo guys, what up, you Boris?" — and `words` is the timed stream the speaker
 * join needs, which arrives stripped to bare tokens: Yo, guys, what, up, you,
 * Boris. Joining at word level is not negotiable (see word-join.ts), so without
 * this the transcript the owner reads is one long run-on, fact extraction runs
 * over unpunctuated text, and the vocative rules in server/naming, which key on
 * a comma or a stop to tell a name being used from a name merely adjacent,
 * have nothing to fire on.
 *
 * The two views are *nearly* the same token sequence in the same order, and
 * "nearly" is where transcripts get corrupted. They disagree over dropped
 * filler, contractions and hyphens split differently, and numerals spelled one
 * way here and another there. So the match is a longest-common-subsequence
 * alignment on normalised tokens, never a positional zip: a word that does not
 * align keeps exactly the text it arrived with. Losing or reordering a word is
 * far worse than an unpunctuated one, because a run-on is visible downstream
 * and a missing sentence is not. The output is therefore always the same words,
 * in the same order, with the same timings — only `text` can change.
 */

import type { TimedWord } from './word-join'

export interface TextSegment {
  start_ms: number
  end_ms: number
  text: string
}

/**
 * How many segments are aligned against their words at a time.
 *
 * The alignment is chunked rather than run over the whole recording because an
 * LCS over 8,000 words against 8,000 tokens is 64 million cells, and because a
 * local disagreement should stay local. Chunking costs accuracy only at the
 * seams — a word landing on the wrong side of a chunk boundary simply fails to
 * align and keeps its raw text — so the chunk is made large enough that seams
 * are rare (about eighty of them across a 48-minute recording) and small enough
 * that the DP stays trivial.
 */
const SEGMENTS_PER_CHUNK = 24

/**
 * How much of a chunk must align before its punctuation is trusted at all.
 *
 * Below this the two views are describing different things — a chunk boundary
 * landing badly, or whisper having rewritten a passage — and applying a partial
 * match would sprinkle punctuation onto the wrong words. Nothing is applied to
 * such a chunk; every word in it survives unchanged.
 */
const MIN_CHUNK_MATCH_RATIO = 0.6

export function restorePunctuation<T extends TimedWord>(
  words: readonly T[],
  segments: readonly TextSegment[],
): T[] {
  if (words.length === 0 || segments.length === 0) return [...words]

  const ordered = [...segments].sort((a, b) => a.start_ms - b.start_ms)
  const out = [...words]

  let wordCursor = 0
  for (let at = 0; at < ordered.length; at += SEGMENTS_PER_CHUNK) {
    const chunk = ordered.slice(at, at + SEGMENTS_PER_CHUNK)
    const isLast = at + SEGMENTS_PER_CHUNK >= ordered.length
    const until = chunk[chunk.length - 1].end_ms
    let wordEnd = wordCursor
    while (wordEnd < words.length && (isLast || words[wordEnd].start_ms < until)) wordEnd += 1
    if (wordEnd === wordCursor) continue

    const tokens = chunk.flatMap((segment) => tokenize(segment.text))
    applyChunk(out, wordCursor, wordEnd, tokens)
    wordCursor = wordEnd
  }
  return out
}

function applyChunk<T extends TimedWord>(
  out: T[],
  from: number,
  to: number,
  tokens: readonly string[],
): void {
  if (tokens.length === 0) return
  const wordKeys = out.slice(from, to).map((word) => normalize(word.text))
  const tokenKeys = tokens.map(normalize)
  const pairs = commonSubsequence(wordKeys, tokenKeys)
  if (pairs.length < (to - from) * MIN_CHUNK_MATCH_RATIO) return
  for (const [wordIndex, tokenIndex] of pairs) {
    out[from + wordIndex] = { ...out[from + wordIndex], text: tokens[tokenIndex] }
  }
}

/**
 * Index pairs of a longest common subsequence of two token key arrays.
 *
 * Equality here is normalised-exact, so every pair returned is a token the two
 * views agree on character for character once case and punctuation are set
 * aside; anything fuzzier would start assigning one word's punctuation to
 * another word that merely resembles it.
 */
function commonSubsequence(left: readonly string[], right: readonly string[]): [number, number][] {
  const width = right.length + 1
  const lengths = new Int32Array((left.length + 1) * width)
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      lengths[i * width + j] =
        left[i] === right[j] && left[i] !== ''
          ? lengths[(i + 1) * width + j + 1] + 1
          : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1])
    }
  }

  const pairs: [number, number][] = []
  let i = 0
  let j = 0
  while (i < left.length && j < right.length) {
    if (left[i] === right[j] && left[i] !== '') {
      pairs.push([i, j])
      i += 1
      j += 1
    } else if (lengths[(i + 1) * width + j] >= lengths[i * width + j + 1]) {
      i += 1
    } else {
      j += 1
    }
  }
  return pairs
}

function tokenize(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean)
}

/** Case, surrounding punctuation and apostrophe style set aside; nothing else. */
function normalize(token: string): string {
  return token
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
}
