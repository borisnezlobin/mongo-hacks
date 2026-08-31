import { describe, expect, it } from 'vitest'
import { dropSilentRepeats, findRepeatRuns, repairRepeatLoops, type RawTranscript } from './loop-repair'

const segment = (start: number, end: number, text: string) => ({ start, end, text })
const word = (start: number, end: number, text: string) => ({ start, end, word: text })

/** A run of one line repeated, the shape a stuck decoder produces. */
function loop(from: number, count: number, text: string) {
  return Array.from({ length: count }, (_, index) => segment(from + index, from + index + 0.6, text))
}

describe('findRepeatRuns', () => {
  it('finds a line repeated past the threshold', () => {
    const runs = findRepeatRuns([segment(0, 1, 'Hello.'), ...loop(10, 5, "I'm sorry.")])
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ count: 5, text: "I'm sorry." })
  })

  it('leaves a line said twice alone', () => {
    expect(findRepeatRuns([...loop(0, 2, 'Yeah.'), segment(5, 6, 'Right.')])).toHaveLength(0)
  })

  it('ignores case and the punctuation around a line, which varies between decodes', () => {
    const runs = findRepeatRuns([segment(0, 1, 'Thank you.'), segment(1, 2, 'thank you'), segment(2, 3, '"Thank you!"')])
    expect(runs).toHaveLength(1)
  })

  it('treats a repeated non-word marker as a run, since that is the longest one measured', () => {
    expect(findRepeatRuns(loop(0, 6, '🎵'))).toHaveLength(1)
    expect(findRepeatRuns(loop(0, 6, '...'))).toHaveLength(1)
  })

  it('does not join two different lines that alternate', () => {
    const runs = findRepeatRuns([
      segment(0, 1, 'Yes.'),
      segment(1, 2, 'No.'),
      segment(2, 3, 'Yes.'),
      segment(3, 4, 'No.'),
    ])
    expect(runs).toHaveLength(0)
  })
})

describe('repairRepeatLoops', () => {
  const stuck: RawTranscript = {
    segments: [segment(0, 5, 'Please welcome him to the stage.'), ...loop(20, 6, "I'm sorry."), segment(40, 44, 'Right, so.')],
    words: [
      word(0, 5, 'Please'),
      ...loop(20, 6, "I'm sorry.").map((s) => word(s.start, s.end, 'sorry')),
      word(40, 44, 'Right'),
    ],
  }

  it('replaces a run the isolated decode does not reproduce', async () => {
    const fresh: RawTranscript = {
      segments: [segment(15, 18, 'It has been an incredible campus for us.')],
      words: [word(15, 18, 'incredible')],
    }
    const repaired = await repairRepeatLoops(stuck, async () => fresh, { duration: 44 })
    const texts = (repaired.segments ?? []).map((s) => s.text)
    expect(texts).not.toContain("I'm sorry.")
    expect(texts).toContain('It has been an incredible campus for us.')
    expect(texts).toContain('Right, so.')
  })

  it('keeps a run the isolated decode produces again, because then it is speech', async () => {
    const same: RawTranscript = { segments: loop(15, 6, "I'm sorry."), words: [] }
    const repaired = await repairRepeatLoops(stuck, async () => same, { duration: 44 })
    expect((repaired.segments ?? []).filter((s) => s.text === "I'm sorry.")).toHaveLength(6)
  })

  it('splices only the run, not the context the second decode was given', async () => {
    // The padding is there so the decoder has something to condition on. A
    // repair that pasted it back would duplicate the lines either side.
    const fresh: RawTranscript = {
      segments: [segment(5, 9, 'Please welcome him to the stage.'), segment(15, 18, 'Actual speech.')],
      words: [],
    }
    const repaired = await repairRepeatLoops(stuck, async () => fresh, { duration: 44 })
    const welcomes = (repaired.segments ?? []).filter((s) => s.text === 'Please welcome him to the stage.')
    expect(welcomes).toHaveLength(1)
    expect(welcomes[0].start).toBe(0)
  })

  it('drops the words the loop produced along with its segments', async () => {
    const fresh: RawTranscript = { segments: [segment(15, 18, 'Actual speech.')], words: [word(15, 18, 'Actual')] }
    const repaired = await repairRepeatLoops(stuck, async () => fresh, { duration: 44 })
    expect((repaired.words ?? []).map((w) => w.word)).toEqual(['Please', 'Actual', 'Right'])
  })

  it('leaves a transcript with no runs untouched, and spends nothing', async () => {
    const clean: RawTranscript = { segments: [segment(0, 1, 'One.'), segment(1, 2, 'Two.')], words: [] }
    let calls = 0
    const repaired = await repairRepeatLoops(clean, async () => {
      calls += 1
      return {}
    })
    expect(calls).toBe(0)
    expect(repaired).toBe(clean)
  })

  it('does not re-decode a run longer than one upload can carry', async () => {
    const long: RawTranscript = { segments: loop(0, 700, '🎵'), words: [] }
    let calls = 0
    await repairRepeatLoops(long, async () => {
      calls += 1
      return {}
    }, { duration: 701 })
    expect(calls).toBe(0)
  })

  it('reports what it changed and what it left', async () => {
    let report: { repaired: unknown[]; kept: unknown[] } | undefined
    await repairRepeatLoops(stuck, async () => ({ segments: [segment(15, 18, 'Speech.')] }), {
      duration: 44,
      onReport: (value) => {
        report = value
      },
    })
    expect(report?.repaired).toHaveLength(1)
    expect(report?.kept).toHaveLength(0)
  })
})

describe('dropSilentRepeats', () => {
  const line = (start_ms: number, end_ms: number, text: string) => ({ start_ms, end_ms, text })
  const said = (start_ms: number, end_ms: number, text: string) => ({ start_ms, end_ms, text })
  const voice = (start_ms: number, end_ms: number) => ({ start_ms, end_ms })

  /** Six identical lines over one span, the shape both kept runs in eHub had. */
  const applause = (from: number) =>
    Array.from({ length: 6 }, (_, index) => line(from + index * 700, from + index * 700 + 500, 'Thank you.'))

  const transcript = {
    segments: [line(0, 3000, 'That is all from me.'), ...applause(4000), line(20000, 23000, 'Next up.')],
    words: [
      said(0, 3000, 'me'),
      ...applause(4000).map((s) => said(s.start_ms, s.end_ms, 'Thank')),
      said(20000, 23000, 'Next'),
    ],
    text: '',
  }

  it('drops a run nobody was speaking under', () => {
    const cleaned = dropSilentRepeats(transcript, [voice(0, 3000), voice(20000, 23000)])
    expect(cleaned.segments.map((s) => s.text)).toEqual(['That is all from me.', 'Next up.'])
    expect(cleaned.words.map((w) => w.text)).toEqual(['me', 'Next'])
  })

  it('keeps a run a voice holds, because that is a person repeating themselves', () => {
    // `Mechanical engineering.` six times on dorm-40min: coverage 1.00.
    const cleaned = dropSilentRepeats(transcript, [voice(0, 23000)])
    expect(cleaned.segments).toHaveLength(8)
    expect(cleaned).toBe(transcript)
  })

  it('keeps a run at the coverage of the real ones and drops it at the coverage of the fakes', () => {
    // The measured split: 0.47 (`David Wu.`) survives, 0.03 (applause) does not.
    const span = applause(4000)
    const from = span[0].start_ms
    const to = span[span.length - 1].end_ms
    const half = voice(from, from + Math.round((to - from) * 0.47))
    const sliver = voice(from, from + Math.round((to - from) * 0.03))
    expect(dropSilentRepeats(transcript, [half]).segments).toHaveLength(8)
    expect(dropSilentRepeats(transcript, [sliver]).segments).toHaveLength(2)
  })

  it('counts overlapping voices once, so crosstalk cannot exceed full coverage', () => {
    // pyannote reports simultaneous speech as separate turns; summing them
    // reached 145% on one eHub span. A share of a span is never over 1.
    const span = applause(4000)
    const from = span[0].start_ms
    const to = span[span.length - 1].end_ms
    const width = to - from
    const overlapping = [
      voice(from, from + Math.round(width * 0.1)),
      voice(from, from + Math.round(width * 0.1)),
      voice(from, from + Math.round(width * 0.1)),
    ]
    expect(dropSilentRepeats(transcript, overlapping).segments).toHaveLength(2)
  })

  it('never asks the question of ordinary text, only of a run', () => {
    const ordinary = {
      segments: [line(0, 1000, 'One.'), line(1000, 2000, 'Two.'), line(2000, 3000, 'Three.')],
      words: [said(0, 1000, 'One')],
      text: '',
    }
    expect(dropSilentRepeats(ordinary, []).segments).toHaveLength(3)
  })

  it('reports what it dropped', () => {
    let dropped: { count: number; text: string }[] = []
    dropSilentRepeats(transcript, [voice(0, 3000)], { onReport: (runs) => (dropped = runs) })
    expect(dropped).toHaveLength(1)
    expect(dropped[0]).toMatchObject({ count: 6, text: 'Thank you.' })
  })
})
