/**
 * What the room called people, and what the naming pass made of it.
 *
 *   npx tsx eval/real/name-evidence.mts <stem>
 *
 * Prints every suggestion with the sentence it was inferred from, so a wrong
 * one is visible as a wrong one rather than as a name. Also prints the voices
 * that hold the most speech and got no name, because on a recording of an event
 * those are the people whose names were said on a stage and missed.
 */
import { suggestNames } from '../../server/naming/index'
import { readRealLines, readRealRecording } from '../../fixtures/real-audio'

const stem = process.argv[2] ?? 'ehub-haas'
// One composition of the pipeline, same as the seed script and the review page.
const run = readRealRecording(stem)
const lines = readRealLines(stem)

const suggested = suggestNames({ conversation_id: stem, turns: lines })
const clock = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`

console.log(`${suggested.suggestions.length} suggestion(s) over ${lines.length} lines\n`)
for (const suggestion of suggested.suggestions) {
  const voice = suggestion.session_speaker ?? suggestion.person_id ?? '?'
  console.log(`  ${suggestion.name} -> ${voice}  (confidence ${suggestion.confidence ?? '?'})`)
  console.log(`      ${JSON.stringify(suggestion.evidence ?? '')}`)
}

const named = new Set(
  suggested.suggestions.map((s) => s.session_speaker ?? s.person_id).filter(Boolean) as string[],
)
console.log('\nunnamed voices holding the most speech:')
const held = [...run.speechMsBySpeaker.entries()].sort((a, b) => b[1] - a[1])
for (const [voice, ms] of held.filter(([voice]) => !named.has(voice)).slice(0, 8)) {
  const first = lines.find((line) => line.speaker === voice)
  console.log(`  ${voice} ${Math.round(ms / 1000)}s  first at ${clock(first?.start_ms ?? 0)}: ${JSON.stringify((first?.text ?? '').slice(0, 70))}`)
}
