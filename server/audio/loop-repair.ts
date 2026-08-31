/**
 * Find where whisper got stuck repeating itself, and decode that stretch again.
 *
 * whisper-1 decodes autoregressively over a 30 s window and carries its own
 * previous text forward as context. When the audio under the window stops being
 * speech — applause, a room of overlapping voices, music — the decoder can fall
 * into a fixed point where the most likely continuation of "I'm sorry." is
 * "I'm sorry.", and it emits that until the audio changes. Measured on the
 * 160-minute eHub recording: eleven runs, 442 s of the transcript, one of them
 * 20 consecutive "I'm sorry." over the applause for a speaker walking on stage.
 *
 * The cost is not the nonsense lines. It is that a loop replaces whatever was
 * actually said: re-decoding 125:30-126:15, which the full pass rendered as
 * eight "I'm here.", returns thirty seconds of ordinary conversation. Memory
 * extraction, naming and the transcript UI were all reading the loop instead.
 *
 * The repair is a second decode of just that stretch, and the reason it works
 * is the reason the loop happened: a fresh decode starts with no context to be
 * stuck in. What it must not do is delete real speech — people do say the same
 * short thing several times in a row, and a rule that cannot tell the two apart
 * is worse than the loop. So nothing here decides. A run is only a SUSPICION,
 * cheap to raise; the isolated decode is the verdict, and when the isolated
 * decode produces the same run again the original is kept untouched.
 */

/**
 * A line and a span, in whatever unit the caller is working in.
 *
 * `findRepeatRuns` never divides or compares against a constant, so it does not
 * care whether it is handed seconds from a verbose_json body or milliseconds
 * from a TimedTranscript. Both callers exist and neither converts.
 */
interface Spanned {
  start?: number
  end?: number
  text?: string
}

/** A verbose_json segment, as the API returns it: seconds, not milliseconds. */
export interface RawSegment {
  start?: number
  end?: number
  text?: string
}

export interface RawWord {
  word?: string
  start?: number
  end?: number
}

export interface RawTranscript {
  segments?: RawSegment[]
  words?: RawWord[]
  text?: string
}

export interface RepeatRun {
  from: number
  to: number
  text: string
  count: number
}

/**
 * How many identical segments in a row are worth a second decode.
 *
 * Two is ordinary speech ("Yeah. Yeah."). Three is where the runs in the
 * measured recordings start, and since a run only costs one extra decode to
 * check, the threshold should sit at the point where a human would raise an
 * eyebrow rather than at the point where they would be certain.
 */
export const REPEAT_RUN = 3

/** Context handed to the second decode either side of the suspicious stretch. */
const PAD_SECONDS = 15

/**
 * The longest stretch worth re-decoding in one request.
 *
 * At 16 kHz mono 16-bit this is comfortably inside the 25 MB upload cap with
 * the padding added. A run longer than this is not a decoder that slipped, it
 * is minutes of audio that is not speech, and re-decoding it whole would spend
 * an upload to be told that again.
 */
const MAX_REPAIR_SECONDS = 600

/**
 * Comparison text for "is this the same line again".
 *
 * Case and surrounding punctuation vary between decodes of the same words, and
 * nothing else is stripped: `...` and a music marker are lines whose repetition
 * is exactly as suspicious as a repeated sentence, and normalising them to
 * empty would quietly exclude the longest run in the recording.
 */
function comparable(text: string): string {
  const collapsed = text.trim().toLowerCase().replace(/\s+/g, ' ')
  const trimmed = collapsed.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
  // A line made entirely of punctuation keeps its punctuation. Trimming it to
  // nothing would drop it from the runs, and `...` and a music marker repeated
  // forty times are the two longest runs in the recording this was built on.
  return trimmed || collapsed
}

/** Runs of consecutive segments whose text is the same line over and over. */
export function findRepeatRuns(segments: readonly Spanned[], minRun = REPEAT_RUN): RepeatRun[] {
  const timed = segments
    .filter((segment) => segment.start !== undefined && segment.end !== undefined)
    .filter((segment) => comparable(segment.text ?? '').length > 0)
    .sort((a, b) => (a.start as number) - (b.start as number))
  const runs: RepeatRun[] = []
  let index = 0
  while (index < timed.length) {
    let last = index
    const key = comparable(timed[index].text ?? '')
    while (last + 1 < timed.length && comparable(timed[last + 1].text ?? '') === key) last += 1
    const count = last - index + 1
    if (count >= minRun) {
      runs.push({
        from: timed[index].start as number,
        to: timed[last].end as number,
        text: (timed[index].text ?? '').trim(),
        count,
      })
    }
    index = last + 1
  }
  return runs
}

/** Whether a fresh decode of the same audio fell into the same run again. */
function reproduces(decoded: RawTranscript, run: RepeatRun, minRun: number): boolean {
  const key = comparable(run.text)
  return findRepeatRuns(decoded.segments ?? [], minRun).some((found) => comparable(found.text) === key)
}

export interface RepairReport {
  runs: RepeatRun[]
  repaired: RepeatRun[]
  kept: RepeatRun[]
}

/**
 * Re-decode every repetition run and splice back the ones that do not recur.
 *
 * `redecode` is given a span in seconds and returns whatever the transcriber
 * makes of that span alone, with times relative to the span's own start. Audio
 * access lives with the caller so this stays testable without a wav or an API
 * key.
 */
export async function repairRepeatLoops(
  transcript: RawTranscript,
  redecode: (fromSeconds: number, toSeconds: number) => Promise<RawTranscript>,
  options: { minRun?: number; duration?: number; onReport?: (report: RepairReport) => void } = {},
): Promise<RawTranscript> {
  const minRun = options.minRun ?? REPEAT_RUN
  const runs = findRepeatRuns(transcript.segments ?? [], minRun)
  const report: RepairReport = { runs, repaired: [], kept: [] }
  if (runs.length === 0) {
    options.onReport?.(report)
    return transcript
  }

  const limit = options.duration ?? Math.max(...(transcript.segments ?? []).map((s) => s.end ?? 0), 0)
  const segments = [...(transcript.segments ?? [])]
  const words = [...(transcript.words ?? [])]

  for (const run of runs) {
    if (run.to - run.from > MAX_REPAIR_SECONDS) {
      report.kept.push(run)
      continue
    }
    const from = Math.max(0, run.from - PAD_SECONDS)
    const to = Math.min(limit || run.to + PAD_SECONDS, run.to + PAD_SECONDS)
    const decoded = await redecode(from, to)
    if (reproduces(decoded, run, minRun)) {
      report.kept.push(run)
      continue
    }
    report.repaired.push(run)
    replaceSpan(segments, words, run, decoded, from)
  }

  segments.sort((a, b) => (a.start ?? 0) - (b.start ?? 0))
  words.sort((a, b) => (a.start ?? 0) - (b.start ?? 0))
  options.onReport?.(report)
  return {
    ...transcript,
    segments,
    words,
    text: segments.map((segment) => (segment.text ?? '').trim()).filter(Boolean).join(' '),
  }
}

/**
 * Swap the run's own span for the fresh decode of it.
 *
 * Only the span the loop occupied is replaced. The padding exists to give the
 * decoder context, not to overwrite lines either side that were never in doubt
 * — splicing the padding back in would duplicate them.
 */
function replaceSpan(
  segments: RawSegment[],
  words: RawWord[],
  run: RepeatRun,
  decoded: RawTranscript,
  offset: number,
): void {
  const inside = (start?: number, end?: number) =>
    start !== undefined && end !== undefined && end > run.from && start < run.to

  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (inside(segments[index].start, segments[index].end)) segments.splice(index, 1)
  }
  for (let index = words.length - 1; index >= 0; index -= 1) {
    if (inside(words[index].start, words[index].end)) words.splice(index, 1)
  }
  for (const segment of decoded.segments ?? []) {
    if (segment.start === undefined || segment.end === undefined) continue
    const start = segment.start + offset
    const end = segment.end + offset
    if (!inside(start, end)) continue
    segments.push({ start, end, text: (segment.text ?? '').trim() })
  }
  for (const word of decoded.words ?? []) {
    if (word.start === undefined || word.end === undefined) continue
    const start = word.start + offset
    const end = word.end + offset
    if (!inside(start, end)) continue
    words.push({ word: word.word ?? '', start, end })
  }
}

/**
 * The verdict the second decode cannot reach: nobody was speaking.
 *
 * Re-decoding catches a loop that is a fixed point of the DECODER — the model
 * carrying its own output forward until the audio changes. It cannot catch a
 * loop whose cause is acoustic, because a fresh decode of the same applause
 * hears the same thing and the run reproduces. Both runs left standing in the
 * eHub recording are that case: `Thank you.` six times over the applause at
 * 17:23 and again at 43:23.
 *
 * Diarization settles it, and it is already computed — the final pass diarizes
 * the same wav a moment later. A run over a span where pyannote finds no voice
 * at all is not speech that was mistranscribed; it is text over applause.
 *
 * Measured over every recording with both a transcript and a diarization:
 * ordinary segments sit at 1.00 coverage at the median and 0.81 at p05, and the
 * runs split with nothing in between — 0.00 and 0.03 for the two hallucinations,
 * 0.47, 0.87, 0.91, 1.00 and 1.00 for `David Wu.`, `Merhaba.` and `Mechanical
 * engineering.`, which are people repeating themselves and are kept.
 *
 * This is deliberately narrow. It never asks the question of ordinary text —
 * 1.3% to 17% of segments per recording sit under the threshold, and deleting
 * those would be deleting speech pyannote missed. Only an already-suspicious
 * run is put to it.
 */
export const SILENT_RUN_COVERAGE = 0.2

interface TimedSpan {
  start_ms: number
  end_ms: number
}

export interface TimedTranscriptish {
  segments: { start_ms: number; end_ms: number; text: string }[]
  words: { text: string; start_ms: number; end_ms: number }[]
  text: string
}

/** The share of a span that any diarized voice holds. */
function speechCoverage(turns: readonly TimedSpan[], from: number, to: number): number {
  if (to <= from) return 0
  const merged: [number, number][] = []
  for (const turn of [...turns].sort((a, b) => a.start_ms - b.start_ms)) {
    if (turn.end_ms <= from || turn.start_ms >= to) continue
    const span: [number, number] = [Math.max(from, turn.start_ms), Math.min(to, turn.end_ms)]
    const last = merged[merged.length - 1]
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1])
    else merged.push(span)
  }
  return merged.reduce((held, [start, end]) => held + (end - start), 0) / (to - from)
}

/** Drop repetition runs that stand over silence. Everything else is untouched. */
export function dropSilentRepeats(
  transcript: TimedTranscriptish,
  turns: readonly TimedSpan[],
  options: { minRun?: number; maxCoverage?: number; onReport?: (dropped: RepeatRun[]) => void } = {},
): TimedTranscriptish {
  const maxCoverage = options.maxCoverage ?? SILENT_RUN_COVERAGE
  const runs = findRepeatRuns(
    transcript.segments.map((segment) => ({
      start: segment.start_ms,
      end: segment.end_ms,
      text: segment.text,
    })),
    options.minRun ?? REPEAT_RUN,
  )
  const silent = runs.filter((run) => speechCoverage(turns, run.from, run.to) < maxCoverage)
  options.onReport?.(silent)
  if (silent.length === 0) return transcript

  const inside = (start: number, end: number) =>
    silent.some((run) => end > run.from && start < run.to)
  const segments = transcript.segments.filter((s) => !inside(s.start_ms, s.end_ms))
  return {
    segments,
    words: transcript.words.filter((w) => !inside(w.start_ms, w.end_ms)),
    text: segments.map((segment) => segment.text.trim()).filter(Boolean).join(' '),
  }
}
