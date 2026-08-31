/**
 * What `dropSilentRepeats` does to every recording that has both a transcript
 * and a diarization.
 *
 * The threshold in loop-repair.ts was chosen from these numbers, so this is the
 * check that it still separates them — and, more usefully, the check that it is
 * not quietly eating ordinary speech on a recording nobody looked at.
 *
 *   npx tsx eval/real/silent-runs.mts
 */
import { dropSilentRepeats, findRepeatRuns } from '../../server/audio/loop-repair'
import { readTimedTranscript, type WhisperResponse } from '../../server/audio/whisper-client'
import type { SpeakerTurn } from '../../server/audio/diarize-sidecar'
import { hasRealFixture, readRealFixture } from '../../fixtures/real-audio'

const STEMS = ['dorm-40min', 'dorm-9pm', 'ehub-haas', 'gbo-haas', 'jerry-45min', 'mentra-mtg']

for (const stem of STEMS) {
  if (!hasRealFixture(`${stem}.whisper.json`) || !hasRealFixture(`${stem}.pyannote.json`)) {
    console.log(`${stem}: needs both a transcript and a diarization`)
    continue
  }
  const transcript = readTimedTranscript(readRealFixture<WhisperResponse>(`${stem}.whisper.json`))
  const payload = readRealFixture<{ turns?: SpeakerTurn[]; segments?: SpeakerTurn[] }>(`${stem}.pyannote.json`)
  const turns = payload.turns ?? payload.segments ?? []
  const runs = findRepeatRuns(
    transcript.segments.map((s) => ({ start: s.start_ms, end: s.end_ms, text: s.text })),
  )
  const cleaned = dropSilentRepeats(transcript, turns, {
    onReport: (dropped) => {
      const at = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`
      console.log(
        `${stem}: ${runs.length} run(s), ${dropped.length} over silence` +
          (dropped.length
            ? `\n${dropped.map((r) => `    dropped ${at(r.from)} x${r.count} ${JSON.stringify(r.text)}`).join('\n')}`
            : ''),
      )
      // Compared by span, not by identity: `findRepeatRuns` ran twice, here
      // and inside the drop, so the same run is two different objects.
      const gone = new Set(dropped.map((r) => `${r.from}:${r.count}`))
      for (const run of runs.filter((r) => !gone.has(`${r.from}:${r.count}`))) {
        console.log(`    kept    ${at(run.from)} x${run.count} ${JSON.stringify(run.text)}`)
      }
    },
  })
  const lost = transcript.words.length - cleaned.words.length
  console.log(`    words ${transcript.words.length} -> ${cleaned.words.length} (${lost} dropped)\n`)
}
