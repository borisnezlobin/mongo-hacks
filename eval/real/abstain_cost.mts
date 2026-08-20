/**
 * Does withholding a name below the floor remove more wrong names than right ones?
 *
 * The sweep next door prices abstention in speech that goes dark. That is only
 * half the trade: silence is worth paying for if what it replaces was wrong. So
 * this scores every word against the reference spans, at each floor, and splits
 * the change into the two things that matter — wrong names removed, and right
 * names removed.
 *
 *   npx tsx eval/real/dump-reference.mts dorm-40min eval/real/dorm-40min.reference.json
 *   npx tsx eval/real/abstain_cost.mts eval/real/dorm-9pm.reference.json eval/real/dorm-40min.reference.json
 *
 * The reference spans come from voiceprint clustering, so they are not
 * independent evidence about voiceprint clustering. They are used here only to
 * compare two configurations of the same join against the same yardstick, which
 * is a weaker claim than "this is the accuracy" and is the only one they can
 * support.
 */

import { readFileSync } from 'node:fs'
import { hasRealFixture, readRealFixture } from '../../fixtures/real-audio'
import type { SpeakerTurn } from '../../server/audio/diarize-sidecar'
import { joinWordsToSpeakers } from '../../server/audio/word-join'
import { readTimedTranscript, type WhisperResponse } from '../../server/audio/whisper-client'

const FLOORS = [0, 250, 500, 750, 1_000, 1_500, 2_000, 3_000]
interface Span { speaker: string; start_ms: number; end_ms: number }

for (const [stem, referencePath] of [['dorm-9pm', process.argv[2]], ['dorm-40min', process.argv[3]]]) {
  if (!referencePath || !hasRealFixture(`${stem}.pyannote.json`)) continue
  const transcript = readTimedTranscript(readRealFixture<WhisperResponse>(`${stem}.whisper.json`))
  const turns = readRealFixture<{ turns: SpeakerTurn[] }>(`${stem}.pyannote.json`).turns
  const spans = (JSON.parse(readFileSync(referencePath, 'utf8')).spans as Span[])
    .sort((a, b) => a.start_ms - b.start_ms)

  // One person per diarization label, by the milliseconds they share. This is
  // the most generous reading of the labelling available, so any error it still
  // shows is an error no relabelling could remove.
  const tally = new Map<string, Map<string, number>>()
  for (const turn of turns) {
    for (const span of spans) {
      const shared = Math.min(turn.end_ms, span.end_ms) - Math.max(turn.start_ms, span.start_ms)
      if (shared <= 0) continue
      const per = tally.get(turn.speaker) ?? new Map<string, number>()
      per.set(span.speaker, (per.get(span.speaker) ?? 0) + shared)
      tally.set(turn.speaker, per)
    }
  }
  const personOf = new Map<string, string>()
  for (const [label, per] of tally) {
    let best = 0
    let who = ''
    for (const [person, ms] of per) if (ms > best) { best = ms; who = person }
    personOf.set(label, who)
  }

  const truthOf = (start: number, end: number): string | null => {
    const at = (start + end) / 2
    const span = spans.find((candidate) => candidate.start_ms <= at && at < candidate.end_ms)
    return span?.speaker ?? null
  }

  console.log(`\n${stem}`)
  console.log('   floor   judged   named   right    wrong    unnamed   right lost   wrong lost')
  let baseline: (string | null)[] = []
  for (const minTurnMs of FLOORS) {
    const lines = joinWordsToSpeakers(transcript.words, turns, { minTurnMs, segments: transcript.segments })
    const perWord = new Map<string, string | null>()
    for (const line of lines) {
      for (const word of line.words) perWord.set(`${word.start_ms}:${word.end_ms}`, line.speaker)
    }
    const judged = transcript.words
      .map((word) => ({ truth: truthOf(word.start_ms, word.end_ms), said: perWord.get(`${word.start_ms}:${word.end_ms}`) ?? null }))
      .filter((entry) => entry.truth !== null)
    const verdicts = judged.map((entry) => (entry.said === null ? null : personOf.get(entry.said) === entry.truth))
    if (minTurnMs === 0) baseline = verdicts.map((v) => (v === null ? null : v ? 'right' : 'wrong'))
    const right = verdicts.filter((v) => v === true).length
    const wrong = verdicts.filter((v) => v === false).length
    const unnamed = verdicts.filter((v) => v === null).length
    const rightLost = verdicts.filter((v, i) => v === null && baseline[i] === 'right').length
    const wrongLost = verdicts.filter((v, i) => v === null && baseline[i] === 'wrong').length
    console.log(
      `  ${String(minTurnMs).padStart(5)}   ${String(judged.length).padStart(6)}` +
      `  ${(100 * (right + wrong) / judged.length).toFixed(1).padStart(5)}%` +
      `  ${(100 * right / Math.max(right + wrong, 1)).toFixed(1).padStart(5)}%` +
      `  ${(100 * wrong / Math.max(right + wrong, 1)).toFixed(1).padStart(6)}%` +
      `   ${String(unnamed).padStart(7)}   ${String(rightLost).padStart(10)}   ${String(wrongLost).padStart(10)}`,
    )
  }
}
