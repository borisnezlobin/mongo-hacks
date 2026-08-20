/**
 * Asks a model to find every line in the transcript that could identify a
 * speaker, then throws away everything it cannot prove.
 *
 * `bun run eval:name-evidence`
 *
 * The model is used only as a reader. It is good at spotting that "Goodnight,
 * Clara" names the person who answers, and at catching names whisper mangled
 * ("Larp" for Alara, "M-A-R-T" spelled out) that a regex over the seven known
 * names would miss. It is not good at being right, so every hit it returns is
 * checked back against the transcript: the quote must appear verbatim in the
 * segment it claims, at the timestamp it claims. Anything that fails that check
 * is dropped and counted, and the survivors are still only *candidate*
 * evidence -- a human decides what it means.
 *
 * Writes eval/real/name-evidence.json.
 */

import { writeFileSync } from 'node:fs'
import { hasRealRecording, missingRecordingNotice, readRealLines } from '../../fixtures/real-audio'

const RECORDING = process.argv[2] ?? 'dorm-40min'
const OUT = new URL('./name-evidence.json', import.meta.url).pathname
/**
 * Lines, not fragments. The real join produces about 770 lines for 48 minutes
 * where the retired provider produced 2,772, so a window of 220 of them holds
 * roughly three times as much speech as it used to.
 */
const WINDOW_SEGMENTS = 80
const MODEL = 'accounts/fireworks/models/gpt-oss-120b'

interface Segment {
  start: number
  label: string
  text: string
}

interface Hit {
  start: number
  label: string
  quote: string
  names: string[]
  kind: 'self_introduction' | 'addressed_by_name' | 'third_party_reference' | 'self_description'
  reading: string
}

const SYSTEM = `You are reading a diarized transcript of a conversation between seven people in a
dorm room. Each speaker label covers one voice for the whole recording, but a label is not
guaranteed to be one person: the diarizer sometimes puts two people on one label, and a line often
runs on past the end of its speaker's turn into somebody else's words. The transcript is noisy and
overlapping, and names are often misheard by the ASR.

Return every line that carries evidence about WHO a speaker is. That includes:
  self_introduction     the speaker says their own name ("I'm Vova")
  addressed_by_name     the speaker names whoever they are talking to ("Wait, Joshua, ...")
  third_party_reference the speaker names someone not being addressed
  self_description      a durable personal fact that could distinguish a speaker
                        (nationality, major, where they live, what they are working on)

Quote the line exactly as it appears, character for character. Never paraphrase, never repair the
ASR, never invent a line. Include misheard names and say what you think they are. If a window has
no such lines, return an empty list.`

function loadEnv(): void {
  try {
    process.loadEnvFile(new URL('../../.env', import.meta.url).pathname)
  } catch {
    /* ambient environment */
  }
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['hits'],
  properties: {
    hits: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['start', 'label', 'quote', 'names', 'kind', 'reading'],
        properties: {
          start: { type: 'number' },
          label: { type: 'string' },
          quote: { type: 'string' },
          names: { type: 'array', items: { type: 'string' } },
          kind: {
            type: 'string',
            enum: ['self_introduction', 'addressed_by_name', 'third_party_reference', 'self_description'],
          },
          reading: { type: 'string' },
        },
      },
    },
  },
}

async function scan(window: Segment[], attempt = 0): Promise<Hit[]> {
  const rendered = window
    .map((segment) => `${segment.start.toFixed(1)} ${segment.label} ${segment.text}`)
    .join('\n')
  const response = await fetch('https://api.fireworks.ai/inference/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.FIREWORKS_API_KEY ?? ''}`,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8_000,
      temperature: 0,
      response_format: { type: 'json_object', schema: SCHEMA },
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: rendered },
      ],
    }),
  })
  if (!response.ok) {
    if (attempt < 5 && (response.status === 503 || response.status === 429)) {
      await new Promise((resolve) => setTimeout(resolve, 2_000 * 2 ** attempt))
      return scan(window, attempt + 1)
    }
    throw new Error(`fireworks ${response.status}: ${await response.text()}`)
  }
  const payload = (await response.json()) as { choices: { message: { content: string | null } }[] }
  const content = payload.choices[0]?.message.content
  if (!content) return []
  return (JSON.parse(content) as { hits?: Hit[] }).hits ?? []
}

async function main(): Promise<void> {
  loadEnv()
  if (!hasRealRecording(RECORDING)) {
    console.error(missingRecordingNotice(RECORDING))
    process.exitCode = 1
    return
  }
  const segments: Segment[] = readRealLines(RECORDING).map((line) => ({
    start: line.start_ms / 1000,
    label: line.speaker,
    text: line.text,
  }))

  const windows: Segment[][] = []
  for (let i = 0; i < segments.length; i += WINDOW_SEGMENTS) {
    windows.push(segments.slice(i, i + WINDOW_SEGMENTS))
  }
  console.log(`${segments.length} segments in ${windows.length} windows`)

  const verified: (Hit & { verified: true })[] = []
  let hallucinated = 0
  for (const [n, window] of windows.entries()) {
    const hits = await scan(window)
    for (const hit of hits) {
      // The only claim worth keeping is one that points at a line that exists.
      // A model that reports a quote nobody said has told us nothing about the
      // recording, only about itself.
      const match = window.find(
        (segment) => Math.abs(segment.start - hit.start) < 0.6 && segment.text.includes(hit.quote.trim()),
      )
      if (!match) {
        hallucinated += 1
        continue
      }
      verified.push({ ...hit, start: match.start, label: match.label, quote: match.text, verified: true })
    }
    console.log(`  window ${n + 1}/${windows.length}: ${hits.length} claimed, ${hallucinated} unverifiable so far`)
  }

  verified.sort((a, b) => a.start - b.start)
  writeFileSync(OUT, JSON.stringify({ model: MODEL, hallucinated, hits: verified }, null, 1))
  console.log(`\n${verified.length} verified hits, ${hallucinated} discarded as unquotable`)
  for (const hit of verified) {
    console.log(`  ${hit.start.toFixed(1).padStart(7)} ${hit.label.padStart(8)} ${hit.kind.padEnd(21)} ` +
      `${hit.names.join(',').padEnd(12)} ${hit.quote.slice(0, 70)}`)
  }
  console.log(`\nwrote ${OUT}`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
