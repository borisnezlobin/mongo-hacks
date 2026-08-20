/**
 * Scores speaker attribution on both real recordings.
 *
 *   bun run eval:diarization                    every baseline, both recordings
 *   bun run eval:diarization --system=pipeline  the real pipeline, if it is wired
 *   bun run eval:diarization --recording=9pm    just the three-minute regression
 *
 * Read `unexplained speech` and nothing else, until you have also read what
 * this harness cannot see -- which it prints at the end, every run, on purpose.
 *
 * The baselines exist so that a number has something to be better than:
 *
 *   oracle       the reference replayed back at itself. Must be 0.0%. If it is
 *                not, the harness is broken and every other number is noise.
 *   one-voice    one speaker for the whole recording. This is the score you get
 *                for doing nothing, and it is not as bad as you would hope,
 *                because one person does most of the talking.
 *   per-chunk    the RETIRED realtime provider's chunked diarization, with its
 *                chunk-scoped labels left un-stitched. Nothing in the product
 *                produces this any more; it is kept only as the score for not
 *                solving the problem at all -- fine segmentation, no idea that
 *                the same person spans two chunks. Never read it as current
 *                behaviour. For dorm-40min that is `dorm-40min.merged.json`,
 *                whose transcript also differs materially from whisper's: it
 *                is a baseline for speaker spans, not a transcript to quote.
 *   stitch       server/audio's attributeDiarizedSegments over the frozen chunk
 *                fixtures. No API calls, no money, so it can be re-run on every
 *                change. This is the thing under test.
 *
 * The stitch is scored three ways, and the order matters. First over everything
 * it produced. Then with the 19% of speech it flags as crosstalk thrown away,
 * which is what abstaining actually costs -- the abstained speech becomes
 * missed, and `unexplained speech` goes up rather than down. Only last, and
 * labelled as such, the flattering number: the score over just the speech it
 * felt confident about. That third number is the one that has already fooled
 * this project once, so it is printed with the other two or not at all.
 */

import { readFileSync } from 'node:fs'
import { hasRealFixture, missingFixtureNotice, readRealFixture, realFixturePath } from '../fixtures/real-audio'
import { joinTranscriptToTurns } from '../server/audio/attribute-recording'
import { readTimedTranscript, type WhisperResponse } from '../server/audio/whisper-client'
import { readWav } from '../server/audio/wav'
import { DORM_WAV, NINE_PM_WAV, dormReference, ninePmReference } from './ground-truth'
import { checkLandmarks, formatLandmarks, type Landmark } from './landmarks'
import { formatOwnerCorrections } from './owner-corrections'
import type { SpeakerTurn } from '../server/audio/diarize-sidecar'
import type { AttributionRun } from '../server/audio/attribute-recording'
import { joinWordsToSpeakers, SNAP_MS } from '../server/audio/word-join'
import {
  collarSensitivity,
  formatScore,
  percent,
  referenceOverlapMs,
  score,
  type AttributedSegment,
  type Reference,
} from './scoring'

interface Case {
  name: string
  wav: string
  /**
   * The retired provider's chunked diarization, kept only as the per-chunk
   * baseline. Not an input to anything the product runs.
   */
  retiredChunkDiarization: string
  recording: Landmark['recording']
  reference: Reference
}

/** The retired provider's saved chunked diarization, as chunk-scoped labels. */
function chunkLabels(fixture: string): AttributedSegment[] | null {
  if (!hasRealFixture(fixture)) return null
  const raw = readRealFixture<{
    segments: { start: number; end: number; label?: string; speaker?: string }[]
  }>(fixture)
  return raw.segments.map((segment) => ({
    speaker: segment.label ?? segment.speaker ?? '?',
    start_ms: Math.round(segment.start * 1000),
    end_ms: Math.round(segment.end * 1000),
  }))
}

/** pyannote's turns for a recording, as the sidecar returned them. */
function turns(stem: string): SpeakerTurn[] | null {
  const fixture = `${stem}.pyannote.json`
  if (!hasRealFixture(fixture)) return null
  return readRealFixture<{ turns: SpeakerTurn[] }>(fixture).turns
}

/** whisper's words for a recording, as the API returned them. */
function whisperTranscript(stem: string) {
  const fixture = `${stem}.whisper.json`
  if (!hasRealFixture(fixture)) return null
  return readTimedTranscript(readRealFixture<WhisperResponse>(fixture))
}

function whisperWords(stem: string): { text: string; start_ms: number; end_ms: number }[] | null {
  return whisperTranscript(stem)?.words ?? null
}

/**
 * The shipping pipeline, over inputs that have already been paid for.
 *
 * Both halves are expensive and neither is random: the transcript is a real
 * bill and the diarization is a CPU hour at 1.2x realtime, so they are saved
 * and this scores the join over them. Regenerate them with
 * `npx tsx eval/real/diarize-fixture.mts <stem>` when the diarizer changes.
 */
function pipeline(stem: string): AttributionRun | null {
  const transcript = whisperTranscript(stem)
  const diarized = turns(stem)
  if (!transcript || !diarized) return null
  const overlapMs = simultaneousMs(diarized)
  return joinTranscriptToTurns(transcript.words, diarized, overlapMs, transcript.segments)
}

function simultaneousMs(diarized: SpeakerTurn[]): number {
  let total = 0
  for (let i = 0; i < diarized.length; i += 1) {
    for (let j = i + 1; j < diarized.length; j += 1) {
      if (diarized[j].start_ms >= diarized[i].end_ms) break
      if (diarized[j].speaker === diarized[i].speaker) continue
      total += Math.max(
        0,
        Math.min(diarized[i].end_ms, diarized[j].end_ms) -
          Math.max(diarized[i].start_ms, diarized[j].start_ms),
      )
    }
  }
  return total
}

function oracle(reference: Reference): AttributedSegment[] {
  return reference.spans.map((span) => ({ ...span }))
}

function oneVoice(reference: Reference): AttributedSegment[] {
  const start = Math.min(...reference.spans.map((span) => span.start_ms))
  const end = Math.max(...reference.spans.map((span) => span.end_ms))
  return [{ speaker: 'everyone', start_ms: start, end_ms: end }]
}

/** Accepts the short name or the fixture name, because both get typed. */
function matches(only: string | null, names: string[]): boolean {
  return only === null || names.includes(only)
}

function cases(only: string | null): Case[] {
  const out: Case[] = []
  const ninePm = ninePmReference()
  if (ninePm && matches(only, ['9pm', 'dorm-9pm'])) {
    out.push({
      name: 'dorm-9pm (3 min, 3 people, ground truth from the room)',
      wav: NINE_PM_WAV,
      retiredChunkDiarization: 'dorm-9pm.diarize.json',
      recording: 'dorm-9pm',
      reference: ninePm,
    })
  }
  const dorm = dormReference()
  if (dorm && matches(only, ['40min', 'dorm-40min'])) {
    out.push({
      name: 'dorm-40min (48 min, 7 people, partial ground truth)',
      wav: DORM_WAV,
      retiredChunkDiarization: 'dorm-40min.merged.json',
      recording: 'dorm-40min',
      reference: dorm,
    })
  }
  return out
}

function reportCoverage(): void {
  const dorm = dormReference()
  if (!dorm) return
  const { coverage, people } = dorm.meta
  console.log('\nground truth for dorm-40min')
  console.log(
    `  ${coverage.scored_speech_s.toFixed(0)} s of ${coverage.diarized_speech_s.toFixed(0)} s of diarized speech ` +
      `is confident enough to score (${percent(coverage.scored_fraction_of_speech)})`,
  )
  console.log(
    `  ${coverage.people_scored} of ${dorm.truePeople} people are scored; ` +
      `${coverage.people_named} of the voices carry a name somebody said out loud, ` +
      `scored or not`,
  )
  const overlap = referenceOverlapMs(dorm)
  console.log(
    `  ${(overlap / 1000).toFixed(0)} s of the scored speech has two of those people ` +
      `talking at once, and is scored as if it did not`,
  )
  for (const person of people) {
    const mark = person.confidence === 'high' ? 'scored  ' : 'withheld'
    console.log(
      `    ${mark} ${(person.name ?? person.id).padEnd(11)} ${person.seconds.toFixed(0).padStart(5)} s  ` +
        `${person.confidence.padEnd(13)} ${person.labels.join(' ')}`,
    )
  }
}

/**
 * The part of the report that cannot be gamed, because it is not a number.
 *
 * Every one of these is a way a system could look good here and be wrong in the
 * room, and none of them shows up in the score above.
 */
function limitations(): void {
  console.log(`
what these numbers cannot see
  the reference and the   The 48-minute span labels were built by pooling ECAPA
  stitch share a method   over the same chunked diarization and agglomerating
                          it -- which is what server/audio's stitch does. So a
                          near-zero score there is substantially the reference
                          agreeing with itself, and it is not evidence the
                          stitch is right. The parts that are independent are
                          the chunk-seam correspondences, the transcript
                          landmarks, and the match against the other recording,
                          and those are the parts to trust. This is the single
                          biggest caveat on this page.
  overlapped speech        The reference gives every instant to exactly one
                           person, because the diarizer it came from does. In a
                           dorm room with seven people that is simply false for
                           a large part of the recording, and a system that
                           correctly reports two simultaneous speakers is
                           scored as if it had invented one of them.
  the 60% we withheld      Most of the long recording is excluded. It is not
                           excluded at random: it is the confusable voices, the
                           people who only spoke inside one chunk, and the
                           quiet ones. So these scores are measured on the easy
                           three speakers, and the real number is worse.
  four unlabelled people   Three people are in the reference. The other four
                           are in the excluded time, so a system that never
                           finds them loses nothing here. Watch the speaker
                           count, not the error rate, for that.
  false alarm is an upper  Reference silence means "the diarizer heard nothing
  bound                    there", not "nobody spoke". Speech it dropped will
                           be charged to any system that catches it.
  reference boundaries     They come from a model, not a person with a
                           waveform. The collar sweep is there to show how much
                           of any result is boundary placement; if the sweep is
                           wide, the result is about edges, not about people.
  landmarks are few        Ten lines carry certain speakers. They caught a
                           merge the error rate could not see, but ten lines
                           cannot tell you a system is good -- only that it is
                           broken. Add more; they cost nothing to check.
  one room, one phone      Both recordings are the same microphone in the same
                           building. Nothing here measures a different room, a
                           different phone, or a person this pipeline has met
                           before in another conversation.`)
}

function show(
  label: string,
  testCase: Case,
  reference: Reference,
  segments: AttributedSegment[],
): void {
  console.log(formatScore(label, score(reference, segments)))
  console.log(formatLandmarks(checkLandmarks(testCase.recording, segments)))
  // What the owner said on the review page, and where it disagrees with the
  // landmarks reasoned from the transcript. Absent on a fresh clone.
  console.log(formatOwnerCorrections(testCase.recording, segments))
  const sweep = collarSensitivity(reference, segments)
  console.log(
    '  collar sweep           ' +
      sweep.map((row) => `${row.collarMs}ms ${percent(row.unexplainedRate)}`).join('   '),
  )
}

/**
 * The pipeline, scored three ways, deliberately in this order.
 *
 * It marks some of its own output as spoken across somebody else. That is the
 * right thing for it to do and the wrong thing to score around: hiding those
 * lines makes the remaining ones look cleaner without a single attribution
 * having improved. So the first number covers everything, the second shows what
 * abstaining costs, and the flattering third is printed last with a warning
 * attached to it.
 */
function reportPipeline(testCase: Case, run: AttributionRun): void {
  const all = run.segments.map((segment) => ({
    speaker: segment.speaker,
    start_ms: segment.start_ms,
    end_ms: segment.end_ms,
  }))
  const confident = run.segments
    .filter((segment) => segment.confident)
    .map((segment) => ({ speaker: segment.speaker, start_ms: segment.start_ms, end_ms: segment.end_ms }))
  const contestedShare = run.totalSpeechMs === 0 ? 0 : run.contestedMs / run.totalSpeechMs

  console.log(
    `\n  ${run.speakerCount} speakers found, ${(run.overlapMs / 1000).toFixed(0)} s of simultaneous ` +
      `speech detected, ${percent(contestedShare)} of its own lines spoken across somebody ` +
      `(${(run.contestedMs / 1000).toFixed(0)} s)`,
  )
  console.log(
    `  ${run.attributedWords}/${run.totalWords} words put on a speaker ` +
      `(${percent(run.attributedWords / (run.totalWords || 1))})`,
  )
  show('pipeline — everything it produced', testCase, testCase.reference, all)
  show('pipeline — abstaining on overlapped lines (that speech becomes missed)', testCase, testCase.reference, confident)

  // Same system, same output, reference narrowed to the speech it was willing
  // to commit on. Always the best-looking of the three, and it measures nothing
  // except how much it declined to answer.
  const narrowed: Reference = {
    ...testCase.reference,
    excluded: [
      ...testCase.reference.excluded,
      ...run.segments
        .filter((segment) => !segment.confident)
        .map((segment) => ({ speaker: 'contested', start_ms: segment.start_ms, end_ms: segment.end_ms })),
    ],
  }
  show(
    'pipeline — scored only where it was confident  [FLATTERING, do not quote alone]',
    testCase,
    narrowed,
    confident,
  )
}

/**
 * The word-join's snap tolerance, swept on both recordings.
 *
 * SNAP_MS is the one number the join has, and this is the evidence for it. What
 * it must show is a plateau rather than a peak: whisper and pyannote disagree
 * about boundaries by fractions of a second constantly, so a tolerance is
 * needed at all, but any value that has to be fitted to a recording is a value
 * that will be wrong in the next room.
 */
function sweepSnap(stem: string): void {
  const words = whisperWords(stem)
  const diarized = turns(stem)
  if (!words || !diarized) return
  console.log('\n  snap sweep (word-join tolerance vs lines produced and words attributed)')
  for (const snapMs of [0, 100, 250, 400, 600, 1_000, 2_000]) {
    const lines = joinWordsToSpeakers(words, diarized, { snapMs })
    const attributed = lines
      .filter((line) => line.speaker)
      .reduce((total, line) => total + line.words.length, 0)
    console.log(
      `    ${String(snapMs).padStart(4)} ms  ${String(lines.length).padStart(4)} lines  ` +
        `${String(attributed).padStart(5)}/${words.length} words attributed ` +
        `(${percent(attributed / words.length)})` +
        (snapMs === SNAP_MS ? '   <- shipping' : ''),
    )
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const wanted = args.find((arg) => arg.startsWith('--system='))?.split('=')[1] ?? null
  const only = args.find((arg) => arg.startsWith('--recording='))?.split('=')[1] ?? null
  const sweep = args.includes('--snap')

  if (!hasRealFixture('dorm-9pm.diarize.json')) {
    console.error(missingFixtureNotice('dorm-9pm.diarize.json'))
    process.exitCode = 1
    return
  }

  const selected = cases(only)
  if (selected.length === 0) {
    // Silence here reads as "the run was fine and found nothing to say", which
    // is how a typo in --recording costs somebody ten minutes.
    console.error(
      `\nno recording matched --recording=${only}. ` +
        `Try 9pm / dorm-9pm, or 40min / dorm-40min, or leave it off for both.`,
    )
    process.exitCode = 1
    return
  }

  reportCoverage()

  for (const testCase of selected) {
    console.log(`\n${'='.repeat(78)}\n${testCase.name}`)

    const systems: { label: string; segments: AttributedSegment[] }[] = []
    if (!wanted || wanted === 'oracle') {
      systems.push({ label: 'oracle (the reference, replayed)', segments: oracle(testCase.reference) })
    }
    if (!wanted || wanted === 'one-voice') {
      systems.push({ label: 'one-voice (everything is one person)', segments: oneVoice(testCase.reference) })
    }
    if (!wanted || wanted === 'per-chunk') {
      const raw = chunkLabels(testCase.retiredChunkDiarization)
      if (raw) systems.push({ label: 'per-chunk (RETIRED provider, unstitched)', segments: raw })
    }
    for (const system of systems) {
      show(system.label, testCase, testCase.reference, system.segments)
    }

    if (!wanted || wanted === 'pipeline') {
      const run = pipeline(testCase.recording)
      if (run) reportPipeline(testCase, run)
      else console.log('\n  pipeline: no saved diarization for this recording; run eval/real/diarize-fixture.mts')
    }
    if (sweep) sweepSnap(testCase.recording)
  }

  limitations()
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
