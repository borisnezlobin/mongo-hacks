/**
 * The readable transcript of a recording, through the code that ships.
 *
 *   npx tsx eval/real/write-transcript.mts <stem>
 *
 * Everything here is the final pass in the order `session.ts` runs it: the
 * saved whisper payload, the diarization, the sentence pass's corrected turns,
 * the silent-run drop, then `joinWordsToSpeakers`. Nothing is re-derived and
 * no threshold is re-tuned — the point is a transcript a person can read that
 * is the same one the product would produce.
 *
 * Writes eval/real/<stem>.transcript.txt, which is gitignored along with the
 * rest of the real-people data.
 */
import { writeFileSync } from 'node:fs'
import { readRealRecording } from '../../fixtures/real-audio'
import { assertPathIsGitIgnored } from '../../server/lib/personal-data'

const stem = process.argv[2]
if (!stem) throw new Error('usage: tsx eval/real/write-transcript.mts <stem>')

// One composition of the pipeline: fixture choice, silent-run drop, join.
const run = readRealRecording(stem)
const lines = run.segments.filter((segment) => segment.text.trim())

const clock = (ms: number) =>
  `${Math.floor(ms / 3600000)}:${String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0')}:` +
  `${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`

const body = lines
  .map((line) => `[${clock(line.start_ms)}] ${line.speaker ?? 'unattributed'}\n${line.text}\n`)
  .join('\n')
const path = new URL(`./${stem}.transcript.txt`, import.meta.url).pathname
// This file is every word real people said in a room. Checked before the write,
// not after, and against git rather than against a hardcoded directory.
assertPathIsGitIgnored(path, 'a transcript')
writeFileSync(path, body)

const attributed = lines.filter((line) => line.speaker)
const words = (line: { text: string }) => line.text.split(/\s+/).filter(Boolean).length
const total = lines.reduce((sum, line) => sum + words(line), 0)
console.log(
  `${stem}: ${lines.length} lines, ${attributed.length} attributed, ` +
    `${attributed.reduce((sum, line) => sum + words(line), 0)}/${total} words ` +
    `(${Math.round((100 * attributed.reduce((sum, line) => sum + words(line), 0)) / total)}%), ` +
    `${new Set(attributed.map((line) => line.speaker)).size} voices -> ${path}`,
)
