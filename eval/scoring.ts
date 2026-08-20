/**
 * Diarization scoring, written so that abstaining cannot be mistaken for being
 * right.
 *
 * The failure this exists to prevent has already happened here once: a pass
 * that simply declined to label 7% of the audio scored seven points better
 * than the pass it was supposed to be correcting, because speaker error was
 * being computed over the speech a system *claims* rather than over the speech
 * that actually happened. So the headline number in this module is
 * `unexplainedRate`: reference speech that ended up on the wrong person plus
 * reference speech nobody said anything about, over all reference speech. There
 * is no way to improve it by saying less.
 *
 * Everything is measured in milliseconds of audio, never in segments or turns.
 * Segment counts reward whichever system happens to chop the recording the same
 * way the reference does, which is not the thing we care about.
 */

/** A stretch of one speaker's speech on the recording's timeline. */
export interface Span {
  speaker: string
  start_ms: number
  end_ms: number
}

/**
 * What a system under test is expected to return.
 *
 * `speaker` may be anything stable within one run — a cluster id, a person id,
 * a name. Scoring finds the best one-to-one mapping onto the real people, so
 * calling somebody `cluster-4` is not an error and calling two people
 * `cluster-4` is.
 */
export interface AttributedSegment {
  speaker: string
  start_ms: number
  end_ms: number
  text?: string
}

/** The signature `eval:diarization` expects a system under test to provide. */
export type AttributeRecording = (wavPath: string) => Promise<AttributedSegment[]>

/**
 * Ground truth, including the parts of it we do not trust.
 *
 * `excluded` is not a formality. Ground truth here is partial on purpose, and a
 * span we are unsure about must cost a system nothing in either direction —
 * otherwise the harness is measuring our uncertainty and calling it their
 * error. Excluded time is removed from the reference, from the system output
 * and from every denominator, and the fraction removed is reported next to
 * every number so nobody can quote a score without also quoting how much of the
 * recording it was computed over.
 */
export interface Reference {
  /** Speech attributed to a specific person with enough confidence to score. */
  spans: Span[]
  /** Time deliberately not scored: uncertain attribution, or genuine overlap. */
  excluded: Span[]
  /** Length of the recording, so coverage can be stated against the whole thing. */
  durationMs: number
  /** How many distinct people were really in the room, including any never labelled. */
  truePeople: number
}

export interface PersonScore {
  person: string
  referenceMs: number
  correctMs: number
  /** Correctly attributed speech over that person's total speech. */
  recall: number
  /** Where the rest of their speech went, largest first. */
  confusedWith: { speaker: string; ms: number }[]
}

export interface Score {
  /** Reference speech left after removing excluded time. This is the denominator. */
  scoredMs: number
  correctMs: number
  /** Reference speech the system covered, but attributed to the wrong person. */
  confusionMs: number
  /** Reference speech the system produced nothing for at all. */
  missedMs: number
  /** System speech where the reference says nobody was speaking. */
  falseAlarmMs: number
  /** (confusion + missed) / scored. Cannot be improved by saying less. */
  unexplainedRate: number
  /** NIST-style (missed + false alarm + confusion) / scored, for comparability. */
  der: number
  mapping: Map<string, string>
  /** System speakers that no real person mapped onto: over-splitting, made visible. */
  spuriousSpeakers: string[]
  systemSpeakers: number
  truePeople: number
  perPerson: PersonScore[]
  /** Fraction of all labelled speech withheld from scoring as uncertain. */
  excludedRate: number
  excludedMs: number
  /** All speech anybody attempted to label, scored and withheld together. */
  labelledMs: number
  collarMs: number
}

/** Exported because eval/speakers.mts scores per-person coverage with it. */
export function overlapMs(a: Span, b: Span): number {
  return Math.max(0, Math.min(a.end_ms, b.end_ms) - Math.max(a.start_ms, b.start_ms))
}

function totalMs(spans: Span[]): number {
  return spans.reduce((sum, span) => sum + Math.max(0, span.end_ms - span.start_ms), 0)
}

/** Union of spans as a sorted, non-overlapping list. Speaker labels are dropped. */
function flatten(spans: Span[]): { start_ms: number; end_ms: number }[] {
  const sorted = [...spans]
    .filter((span) => span.end_ms > span.start_ms)
    .sort((a, b) => a.start_ms - b.start_ms)
  const out: { start_ms: number; end_ms: number }[] = []
  for (const span of sorted) {
    const last = out[out.length - 1]
    if (last && span.start_ms <= last.end_ms) last.end_ms = Math.max(last.end_ms, span.end_ms)
    else out.push({ start_ms: span.start_ms, end_ms: span.end_ms })
  }
  return out
}

/** Everything in `spans` that does not fall inside `holes`. */
function subtract<T extends Span>(spans: T[], holes: { start_ms: number; end_ms: number }[]): T[] {
  let current = spans.filter((span) => span.end_ms > span.start_ms)
  for (const hole of holes) {
    const next: T[] = []
    for (const span of current) {
      if (hole.end_ms <= span.start_ms || hole.start_ms >= span.end_ms) {
        next.push(span)
        continue
      }
      if (hole.start_ms > span.start_ms) next.push({ ...span, end_ms: hole.start_ms })
      if (hole.end_ms < span.end_ms) next.push({ ...span, start_ms: hole.end_ms })
    }
    current = next
  }
  return current.filter((span) => span.end_ms > span.start_ms)
}

/**
 * Collapse overlapping spans that belong to the same person.
 *
 * The reference is assembled from diarizer segments, and two segments carrying
 * the same label sometimes overlap by a few milliseconds. Left alone, that time
 * is counted twice in the denominator and once in the numerator, which is how a
 * reference scored against itself came out at -0.1%.
 */
function mergeSameSpeaker(spans: Span[]): Span[] {
  const bySpeaker = new Map<string, Span[]>()
  for (const span of spans) {
    const list = bySpeaker.get(span.speaker) ?? []
    list.push(span)
    bySpeaker.set(span.speaker, list)
  }
  const out: Span[] = []
  for (const [speaker, list] of bySpeaker) {
    for (const merged of flatten(list)) out.push({ speaker, ...merged })
  }
  return out.sort((a, b) => a.start_ms - b.start_ms)
}

/**
 * A no-score band either side of every reference boundary.
 *
 * The reference boundaries here come from a diarizing model, not from somebody
 * with a waveform editor, so they are accurate to a few hundred milliseconds at
 * best. Without a collar a large slice of every score is the two segmentations
 * disagreeing about where a word started, which moves when the ground truth is
 * corrected and therefore hides real changes. The collar is why these numbers
 * survive small edits to the ground truth; `collarSensitivity` shows how much
 * it is doing.
 */
function collarHoles(reference: Span[], collarMs: number): { start_ms: number; end_ms: number }[] {
  if (collarMs <= 0) return []
  const edges: { start_ms: number; end_ms: number }[] = []
  for (const span of reference) {
    edges.push({ start_ms: span.start_ms - collarMs, end_ms: span.start_ms + collarMs })
    edges.push({ start_ms: span.end_ms - collarMs, end_ms: span.end_ms + collarMs })
  }
  return flatten(edges.map((edge) => ({ ...edge, speaker: '' })))
}

/**
 * Maximum-weight one-to-one assignment (Jonker-Volgenant / Hungarian).
 *
 * Brute-forcing permutations was fine for three people; with seven people and a
 * system that over-splits into a dozen clusters it is millions of arrangements,
 * and a harness nobody wants to wait for is a harness nobody runs.
 */
export function assign(weights: number[][]): number[] {
  const n = weights.length
  const m = weights[0]?.length ?? 0
  if (n === 0 || m === 0) return new Array(n).fill(-1)
  const size = Math.max(n, m)
  const cost: number[][] = Array.from({ length: size }, (_, i) =>
    Array.from({ length: size }, (_, j) => -(weights[i]?.[j] ?? 0)),
  )

  const INF = Number.POSITIVE_INFINITY
  const u = new Array(size + 1).fill(0)
  const v = new Array(size + 1).fill(0)
  const p = new Array(size + 1).fill(0)
  const way = new Array(size + 1).fill(0)

  for (let i = 1; i <= size; i += 1) {
    p[0] = i
    let j0 = 0
    const minv = new Array(size + 1).fill(INF)
    const used = new Array(size + 1).fill(false)
    do {
      used[j0] = true
      const i0 = p[j0]
      let delta = INF
      let j1 = 0
      for (let j = 1; j <= size; j += 1) {
        if (used[j]) continue
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j]
        if (cur < minv[j]) {
          minv[j] = cur
          way[j] = j0
        }
        if (minv[j] < delta) {
          delta = minv[j]
          j1 = j
        }
      }
      for (let j = 0; j <= size; j += 1) {
        if (used[j]) {
          u[p[j]] += delta
          v[j] -= delta
        } else {
          minv[j] -= delta
        }
      }
      j0 = j1
    } while (p[j0] !== 0)
    do {
      const j1 = way[j0]
      p[j0] = p[j1]
      j0 = j1
    } while (j0 !== 0)
  }

  const result = new Array(n).fill(-1)
  for (let j = 1; j <= size; j += 1) {
    const i = p[j] - 1
    if (i < n && j - 1 < m && (weights[i]?.[j - 1] ?? 0) > 0) result[i] = j - 1
  }
  return result
}

export interface ScoreOptions {
  /** No-score band either side of each reference boundary. Default 250 ms. */
  collarMs?: number
}

export function score(reference: Reference, system: AttributedSegment[], options: ScoreOptions = {}): Score {
  const collarMs = options.collarMs ?? 250
  const uncertain = flatten(reference.excluded)
  const holes = flatten([
    ...reference.excluded,
    ...collarHoles(reference.spans, collarMs).map((hole) => ({ ...hole, speaker: '' })),
  ])

  const ref = subtract(mergeSameSpeaker(reference.spans), holes)
  const sys = subtract(
    system.map((segment) => ({
      speaker: segment.speaker,
      start_ms: segment.start_ms,
      end_ms: segment.end_ms,
    })),
    holes,
  )

  const people = [...new Set(ref.map((span) => span.speaker))].sort()
  const speakers = [...new Set(sys.map((span) => span.speaker))].sort()

  const table = people.map(() => speakers.map(() => 0))
  const personIndex = new Map(people.map((person, i) => [person, i]))
  const speakerIndex = new Map(speakers.map((speaker, i) => [speaker, i]))
  let coveredMs = 0
  for (const r of ref) {
    for (const s of sys) {
      if (s.start_ms >= r.end_ms) continue
      const overlap = overlapMs(r, s)
      if (overlap === 0) continue
      coveredMs += overlap
      table[personIndex.get(r.speaker)!][speakerIndex.get(s.speaker)!] += overlap
    }
  }

  const chosen = assign(table)
  const mapping = new Map<string, string>()
  let correctMs = 0
  chosen.forEach((speakerIdx, personIdx) => {
    if (speakerIdx < 0) return
    mapping.set(people[personIdx], speakers[speakerIdx])
    correctMs += table[personIdx][speakerIdx]
  })

  const scoredMs = totalMs(ref)
  // Reference spans can overlap each other: the diarization the reference is
  // built from lets two labels share an instant, and two people really do talk
  // at once here. Where that happens a system span is counted against both, so
  // covered time can exceed reference time and the arithmetic can go slightly
  // negative. Clamping keeps a headline rate from reading as -0.1%, and
  // `referenceOverlapMs` says how much of this is going on.
  const confusionMs = Math.max(0, coveredMs - correctMs)
  const missedMs = Math.max(0, scoredMs - coveredMs)
  // System speech landing where the reference says nobody spoke. Reported apart
  // from `unexplainedRate` because it is a different mistake: inventing speech,
  // rather than mis-attributing it. It still enters the NIST-style DER.
  const falseAlarmMs = Math.max(0, totalMs(sys) - coveredMs)

  const perPerson: PersonScore[] = people.map((person, i) => {
    const referenceMs = totalMs(ref.filter((span) => span.speaker === person))
    const mapped = mapping.get(person)
    const correct = mapped ? table[i][speakerIndex.get(mapped)!] : 0
    const confusedWith = speakers
      .map((speaker, j) => ({ speaker, ms: table[i][j] }))
      .filter((entry) => entry.ms > 0 && entry.speaker !== mapped)
      .sort((a, b) => b.ms - a.ms)
    return {
      person,
      referenceMs,
      correctMs: correct,
      recall: referenceMs === 0 ? 0 : correct / referenceMs,
      confusedWith,
    }
  })

  // Everything anybody attempted to label, uncertain parts included. Excluded
  // time is measured against this rather than against the scored remainder, so
  // "we scored 40% of the labelled speech" is a statement about the recording
  // and not about how wide a collar happened to be set.
  const labelledMs = totalMs(
    flatten([...reference.spans, ...reference.excluded]).map((span) => ({ ...span, speaker: '' })),
  )
  const excludedMs = labelledMs - totalMs(subtract(reference.spans, uncertain))

  return {
    scoredMs,
    correctMs,
    confusionMs,
    missedMs,
    falseAlarmMs,
    unexplainedRate: scoredMs === 0 ? 1 : (confusionMs + missedMs) / scoredMs,
    der: scoredMs === 0 ? 1 : (confusionMs + missedMs + falseAlarmMs) / scoredMs,
    mapping,
    spuriousSpeakers: speakers.filter((speaker) => ![...mapping.values()].includes(speaker)),
    systemSpeakers: speakers.length,
    truePeople: reference.truePeople,
    perPerson,
    excludedRate: labelledMs === 0 ? 0 : excludedMs / labelledMs,
    excludedMs,
    labelledMs,
    collarMs,
  }
}

/**
 * The same score at three collars.
 *
 * A result that only holds at one collar width is a result about boundary
 * placement, not about who was speaking. If these three numbers are far apart,
 * do not quote any of them as the improvement.
 */
export function collarSensitivity(
  reference: Reference,
  system: AttributedSegment[],
  collars: number[] = [0, 250, 500],
): { collarMs: number; unexplainedRate: number; der: number }[] {
  return collars.map((collarMs) => {
    const result = score(reference, system, { collarMs })
    return { collarMs, unexplainedRate: result.unexplainedRate, der: result.der }
  })
}

/**
 * How much of the reference has two people talking at the same instant.
 *
 * Every metric here treats one instant as belonging to one person, so this is
 * the size of the assumption. It is not an error to be fixed -- the room really
 * was like that -- it is a number to quote whenever somebody asks how precise
 * the scores are.
 */
export function referenceOverlapMs(reference: Reference): number {
  const spans = [...reference.spans].sort((a, b) => a.start_ms - b.start_ms)
  let overlap = 0
  for (let i = 0; i < spans.length; i += 1) {
    for (let j = i + 1; j < spans.length && spans[j].start_ms < spans[i].end_ms; j += 1) {
      if (spans[j].speaker !== spans[i].speaker) overlap += overlapMs(spans[i], spans[j])
    }
  }
  return overlap
}

export function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

export function formatScore(title: string, result: Score): string {
  const lines: string[] = [
    '',
    title,
    `  scored over            ${(result.scoredMs / 1000).toFixed(0)} s of the ` +
      `${(result.labelledMs / 1000).toFixed(0)} s of labelled speech ` +
      `(${percent(result.excludedRate)} withheld as uncertain, rest to the ${result.collarMs} ms collar)`,
    `  unexplained speech     ${percent(result.unexplainedRate)}   <- headline: wrong person or no answer`,
    `    of which wrong       ${percent(result.confusionMs / (result.scoredMs || 1))}`,
    `    of which missed      ${percent(result.missedMs / (result.scoredMs || 1))}`,
    `  false alarm            ${percent(result.falseAlarmMs / (result.scoredMs || 1))}   (speech claimed where there was none)`,
    `  diarization error rate ${percent(result.der)}`,
    // Never on a line of its own. A count of 7 against 7 real people looked
    // like a success on this recording while two people were merged and a third
    // was split -- the two errors cancelled in the count. So the count is
    // printed welded to the thing that would have caught that, and the landmark
    // check (eval/landmarks.ts) is what actually settles it.
    `  speakers found         ${result.systemSpeakers} for ${result.truePeople} real people ` +
      `— a matching count proves nothing on its own; ${percent(result.unexplainedRate)} of scored ` +
      `speech is unexplained, and only the landmark check below can see a merge that ` +
      `cancels a split`,
  ]
  if (result.spuriousSpeakers.length > 0) {
    lines.push(`  unmapped speakers      ${result.spuriousSpeakers.slice(0, 12).join(', ')}`)
  }
  lines.push('  per person')
  for (const person of [...result.perPerson].sort((a, b) => b.referenceMs - a.referenceMs)) {
    const worst = person.confusedWith[0]
    lines.push(
      `    ${person.person.padEnd(14)} recall ${percent(person.recall).padStart(6)} ` +
        `over ${(person.referenceMs / 1000).toFixed(0).padStart(4)} s` +
        (worst ? `   mostly lost to ${worst.speaker} (${(worst.ms / 1000).toFixed(0)} s)` : ''),
    )
  }
  return lines.join('\n')
}
