/** Does the text model put a boundary where the owner heard one? One passage, printed. */
import { readRealFixture } from '../../fixtures/real-audio'
import { extractStructured } from '../../server/memory/llm'
import { readTimedTranscript, type WhisperResponse } from '../../server/audio/whisper-client'

const stem = process.argv[2]
const fromS = Number(process.argv[3])
const toS = Number(process.argv[4])
const transcript = readTimedTranscript(readRealFixture<WhisperResponse>(`${stem}.whisper.json`))
const words = [...transcript.words].sort((a, b) => a.start_ms - b.start_ms)
const slice = words.filter((word) => word.start_ms >= fromS * 1000 && word.start_ms < toS * 1000)
const numbered = slice.map((word, index) => `${index}\t${word.text.trim()}`).join('\n')
console.log(slice.map((word, index) => `${index}:${word.text.trim()}`).join(' '))

const SYSTEM = `You segment a conversation transcript by speaker.

You are given consecutive words from one recording of several people talking, numbered from 0. There are no speaker labels and no punctuation you can trust. Decide where one person stops speaking and a different person starts.

Return the index of the FIRST word of each new speaker's stretch. Do not return 0. Judge it on what the words mean as a conversation: a question and its answer are different people, an answer to a greeting is a different person from the greeter, somebody naming themselves is not the person who asked, somebody being addressed by name is not the person speaking. Where the words read as one person continuing, return nothing for that stretch.

You are not told how many speakers or how many changes there are. Returning too many is as wrong as returning too few.`

const reply = await extractStructured<{ boundaries: number[] }>({
  system: SYSTEM,
  user: numbered,
  schema: {
    type: 'object',
    properties: { boundaries: { type: 'array', items: { type: 'integer' } } },
    required: ['boundaries'],
  },
  maxTokens: 8_000,
})
console.log('proposed:', reply.boundaries)
for (const index of reply.boundaries ?? []) {
  if (slice[index]) console.log(`   ${index}  ${(slice[index].start_ms / 1000).toFixed(2)}s  ${JSON.stringify(slice[index].text)}`)
}
