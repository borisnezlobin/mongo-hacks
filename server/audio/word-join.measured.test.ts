import { describe, expect, it } from 'vitest'
// hasRealFixture throws under AMELIA_REQUIRE_FIXTURES=1 rather than returning
// false, so "the fixtures are missing" fails loudly for anyone who believes
// they are validating something and skips quietly on a fresh clone.
import { hasRealFixture, readRealFixture } from '../../fixtures/real-audio'
import { checkLandmarks } from '../../eval/landmarks'
import { joinTranscriptToTurns } from './attribute-recording'
import type { SpeakerTurn } from './diarize-sidecar'
import { joinWordsToSpeakers, SNAP_MS } from './word-join'
import { readTimedTranscript, type WhisperResponse } from './whisper-client'

/**
 * The join, measured on the real recordings rather than on invented spans.
 *
 * Both inputs are saved because both are expensive — the transcript is a real
 * bill and the diarization is a CPU hour at 1.2x realtime — so this costs
 * nothing to re-run and can therefore be a test rather than a script somebody
 * ran once. Regenerate the diarization with
 * `npx tsx eval/real/diarize-fixture.mts <stem>`.
 *
 * The landmarks are the part worth trusting. They are lines whose speaker the
 * words themselves settle — a self-introduction names its own speaker, a
 * vocative names somebody who is therefore not the speaker — so they move for
 * nobody's threshold. See eval/landmarks.ts.
 */
const RECORDINGS = [
  {
    stem: 'dorm-9pm',
    recording: 'dorm-9pm' as const,
    people: 3,
    unlocatable: [] as string[],
    knownMerges: [] as string[],
    knownSplits: [] as string[],
    // 48 lines and 4 interjections before zero-length words counted as
    // contested speech; 46 and 3 after. 42 and 3 once a contested word is
    // settled by the clean words of its own sentence rather than by a window.
    pingPong: { lines: 58, interjections: 7, flicker: 0 },
    introduction: null as string | null,
  },
  {
    stem: 'dorm-40min',
    recording: 'dorm-40min' as const,
    people: 7,
    /**
     * One landmark cannot be located across two independent segmentations, and
     * saying so beats asserting something false.
     *
     * "Good night." is 800 ms, and its window (2,466,102-2,466,900 ms) was
     * written down from the chunked diarization this pipeline replaced. Whisper
     * puts those words at 2,466,830-2,467,270, so only 70 ms of the landmark's
     * window contains the reply and 208 ms of it contains the END of the
     * vocative it answers. The landmark check resolves a line by greatest
     * overlap, so it picks the vocative's speaker and reports a merge.
     *
     * The pipeline is right about the words themselves: it puts "Goodnight" on
     * SPEAKER_07 and the "Alright Oh yeah Goodnight Clara" that precedes it on
     * SPEAKER_04, which is exactly the two-person exchange the landmark
     * describes. Re-timing the landmark to whisper's boundaries would make this
     * green, and would also be editing the ground truth until it agrees, so it
     * is written down instead.
     */
    unlocatable: ['Goodnight.'],
    /**
     * Merges the pipeline really commits, every one of them confirmed by the
     * owner rather than inferred here.
     *
     * BEFORE BELIEVING A DROP IN THIS LIST, RUN
     * `npx tsx eval/real/landmark-labels.mts`.
     *
     * A shrinking merge count is not the same as a fixed error, and this list
     * cannot tell you which you have. A merge leaves the list just as readily by
     * moving onto a label no landmark occupies as by being corrected. That has
     * already happened once: a sentence-level re-segmentation took this list
     * from 6 to 4, and the label table showed `M A R T` had moved off Vova onto
     * BORIS -- still the wrong person, merely wrong somewhere unwatched -- while
     * `can I rip a seat?` moved to a label carrying no landmark at all. Nothing
     * was fixed, one genuinely new merge was added, and naming got worse.
     *
     * The blind spot is large and measured (`npx tsx eval/real/blind-spots.mts`):
     * on dorm-40min, 3 of 8 labels carry no landmark and hold 66% of diarized
     * speech; the reference scores 3 of the 7 people, so 57% of pooled speech
     * can move between speakers for free; and only 6 of the 21 person pairs can
     * be discriminated by two named lines. dorm-9pm is the honest one -- 93% of
     * its speech is labelled and all 3 pairs are covered -- which is why a
     * change that helps dorm-40min and hurts dorm-9pm should be disbelieved.
     *
     * READ THIS COUNT NEXT TO THE LABEL COUNT, ALWAYS. A merge count falls for
     * free when a system emits more labels, because two landmarks land together
     * less often the more labels there are to land on. Measured: a windowed
     * Sortformer system reached 3 merges with 6-7 labels under one constraint
     * and needed 10-30 labels to reach the same 3 under another. The second is
     * not the better system, it is the more fragmented one.
     *
     * The mirror of it has now caught three separate candidates: a headline
     * metric improving because the system UNDER-clusters. community-1 halved
     * DER on dorm-40min while fusing "I'm Boris." and "I'm Vova."; an oracle
     * linking scored 17.8% DER and 4.8% confusion with a dialogue_probe rate
     * WORSE than baseline; and a windowed run reached 33.8% DER, 8.6%
     * confusion and every per-person recall above baseline while holding 4
     * labels for 7 people and 7 merges. The reference labels 3 of the 7 people
     * on dorm-40min, so merging the other four is nearly free in DER and
     * expensive in fact.
     *
     * Three of the six entries below are a question fused with its own answer,
     * and that pattern generalises past the landmark set:
     * `python eval/real/dialogue_probe.py <stem>` counts every label holding
     * both sides of an exchange, using only the transcript. It needs no
     * reference and no voiceprint, so it also covers the 66% of dorm-40min
     * these landmarks cannot see, and it is the only merge measure available at
     * all for jerry-45min and mentra-mtg. Today: dorm-9pm 44%, dorm-40min 70%,
     * jerry-45min 82%, mentra-mtg 85%. Read it alongside this list, not instead
     * of it -- it sees breadth, these six are owner-confirmed.
     *
     * This assertion used to be `toEqual([])`, which was true only because the
     * landmark set was too small to see these. It is recorded rather than
     * hidden because it is the honest state: diarization puts these people on
     * one voice today. The list must never grow, and it should shrink — when
     * the upstream defect is fixed, delete the entries that stop firing.
     *
     * What each one is:
     *   M-A-R-T / Oh shit, I'm Ukrainian.  Mert and Vova on one voice. The
     *   M-A-R-T / I'm Vova.                owner spotted this in the app, and
     *                                      it is why "from Russia" and "from
     *                                      Ukraine" are both filed as facts
     *                                      about Vova.
     *   Where are you from? / I'm Boris.   A question fused with the answer to
     *   Where are you from? / I'm going…   it: pyannote has one unbroken turn
     *   Where are you from? / Do you hav…  over both, so the join never had a
     *                                      boundary to place.
     *   can I rip a seat? / Drew.          Vova and Dhruv on one voice.
     */
    knownMerges: ['Where are you from? / Drew.'],
    /**
     * Volva heard as two people, and it is the same one line every time.
     *
     * WHAT THESE TWO LISTS USED TO HOLD, and why the entries are gone rather
     * than commented out: the diarization turns this replaced put `M-A-R-T` on
     * Volva's voice, fused "Where are you from?" with Boris's answer to it in
     * three different places, and put "can I rip a seat?" on Dhruv — seven
     * merges and five splits, every one of them confirmed by the owner. The
     * sentence pass in server/audio/sentence-pass.ts fixes all of those. Twelve
     * violations became four.
     *
     * All four that remain are the single line "Where are you from?", which
     * lands on neither Volva (who said it) nor Boris (who did not): split from
     * Volva's other three lines and merged with one that is not his. It
     * is 0.68 s long, which is the length at which this repository has measured
     * speaker discrimination to be near chance, so it is the hardest kind of
     * line there is and the one place left to look.
     *
     * BEFORE BELIEVING A DROP IN THIS LIST, RUN
     * `npx tsx eval/real/landmark-labels.mts`. A merge leaves the list just as
     * readily by moving onto a label no landmark occupies as by being fixed,
     * and only the label table can tell the two apart. Read it next to the
     * LABEL count too — more labels lower a merge count for free.
     */
    knownSplits: [
      'Where are you from? / can I rip a seat?',
      "Where are you from? / Oh shit, I'm Ukrainian.",
      "Where are you from? / I'm Vova.",
    ],
    pingPong: { lines: 1_032, interjections: 74, flicker: 0 },
    introduction: "I'm Vova",
  },
]

/**
 * The turns the shipped pipeline ends with, which is the sentence pass output
 * where it exists and raw pyannote where it does not.
 *
 * `<stem>.sentpool.json` is the final-pass correction from
 * `server/audio/sentence-pass.ts`, saved for the same reason `<stem>.pyannote.json`
 * is: producing it costs an embedding of every sentence against the ECAPA
 * sidecar, and a measurement that has to regenerate its inputs is a measurement
 * nobody repeats.
 *
 * It is produced BY THE SHIPPED MODULE, not by a probe resembling it:
 *   sidecar/.venv/bin/python -m uvicorn app:app --app-dir sidecar --port 8099
 *   SIDECAR_URL=http://127.0.0.1:8099 npx tsx eval/real/sentence-pass-run.mts <stem>
 * which calls the same functions `session.ts` calls, over the same sidecar.
 * `eval/real/sentence_pooled.py` is the exploration harness that found the
 * constants and is not what these numbers come from -- it also defaults to a
 * different embedder, which was worth more than any constant in the sweep.
 */
function inputs(stem: string) {
  const whisper = `${stem}.whisper.json`
  const corrected = `${stem}.sentpool.json`
  const pyannote = `${stem}.pyannote.json`
  const source = hasRealFixture(corrected) ? corrected : pyannote
  if (!hasRealFixture(whisper) || !hasRealFixture(source)) return null
  const transcript = readTimedTranscript(readRealFixture<WhisperResponse>(whisper))
  const turns = readRealFixture<{ turns: SpeakerTurn[] }>(source).turns
  return { words: transcript.words, sentences: transcript.segments, turns }
}

for (const { stem, recording, people, unlocatable, knownMerges, knownSplits, pingPong, introduction } of RECORDINGS) {
  const data = inputs(stem)

  describe.skipIf(!data)(`${stem}`, () => {
    if (!data) return
    const run = joinTranscriptToTurns(data.words, data.turns, 0, data.sentences)

    /**
     * The failure a rate cannot see. Merging two people who barely overlap in
     * time costs almost nothing in seconds, and merging one pair while
     * splitting another leaves the speaker count looking right. The shipped
     * chunked pipeline had two merges and a split here.
     */
    it('keeps every landmark speaker apart, and every landmark speaker together', () => {
      const report = checkLandmarks(recording, run.segments)
      const locatable = (pair: { a: { quote: string }; b: { quote: string } }) =>
        !unlocatable.includes(pair.a.quote) && !unlocatable.includes(pair.b.quote)
      expect(report.merges.filter(locatable).map((pair) => `${pair.a.quote} / ${pair.b.quote}`).sort()).toEqual(
        [...knownMerges].sort(),
      )
      expect(report.splits.filter(locatable).map((pair) => `${pair.a.quote} / ${pair.b.quote}`).sort()).toEqual(
        [...knownSplits].sort(),
      )
      expect(report.covered).toBe(report.total)
    })

    it('finds at least as many voices as there are people known to be in the room', () => {
      // At least, not exactly: a speaker the diarizer splits is a tap to merge,
      // and two people it merges is permanent. Nothing here is told the count.
      expect(run.speakerCount).toBeGreaterThanOrEqual(people - 1)
    })

    it('puts nearly every word on a speaker', () => {
      // A word left unattributed is a word in speech pyannote heard nobody in.
      // A few is honest; a lot means the two sources are not on the same clock.
      expect(run.attributedWords / run.totalWords).toBeGreaterThan(0.95)
    })

    /**
     * SNAP_MS sits on a plateau rather than on a peak.
     *
     * This is the whole evidence for the number. A tolerance is needed at all
     * because whisper and pyannote place boundaries independently and disagree
     * by fractions of a second constantly — at zero the transcript shatters into
     * confetti. But a value that has to be fitted to a recording will be wrong
     * in the next room, so what has to be true is that the answer barely moves
     * across the neighbourhood of the shipping value.
     */
    it('is not sensitive to the exact snap tolerance', () => {
      const at = (snapMs: number) => {
        const lines = joinWordsToSpeakers(data.words, data.turns, { snapMs, segments: data.sentences })
        const attributed = lines
          .filter((line) => line.speaker)
          .reduce((total, line) => total + line.words.length, 0)
        return { lines: lines.length, attributed }
      }
      const shipping = at(SNAP_MS)
      for (const snapMs of [250, 600]) {
        const nearby = at(snapMs)
        expect(Math.abs(nearby.lines - shipping.lines) / shipping.lines).toBeLessThan(0.1)
        expect(Math.abs(nearby.attributed - shipping.attributed) / data.words.length).toBeLessThan(0.02)
      }
      // And the tolerance is doing something: without it the lines shatter.
      expect(at(0).lines).toBeGreaterThan(shipping.lines * 1.3)
    })

    /**
     * The transcript must not ping-pong a word at a time.
     *
     * WHAT IS ASSERTED HERE CHANGED, AND THE RAW LINE COUNT IS NO LONGER IT.
     * The ceiling was written to catch flicker — one speaker's phrase torn in
     * half and handed to somebody else for a word. It counted lines and short
     * interjections as a proxy, which worked while the unit of attribution was
     * a diarization turn. It stopped working once sentences became the unit,
     * because splitting a question away from the answer to it ADDS a line and
     * is the opposite of flicker. The proxy and the defect now move in opposite
     * directions, so the proxy had to go.
     *
     * What is counted instead is a short interjection whose span lies strictly
     * INSIDE one whisper sentence. That is flicker and nothing else is: a
     * two-word line that is a whole sentence is somebody saying "I know.".
     * Measured on dorm-40min, the diarization turns this replaced tear 23
     * sentences that way and the sentence pass tears none, while its raw line
     * count rises from 774 to 1,033 — which is what fixing five merges looks
     * like. dorm-9pm goes from 3 interjections to 5, and all five were read: no
     * torn sentences, one exchange counted twice from either side, the rest
     * real short turns.
     *
     * `lines` is recorded but deliberately NOT asserted. The shatter guard it
     * used to provide lives in the snap-tolerance test above, which fails if
     * the join stops holding lines together at all.
     */
    it('does not tear a sentence in half between two speakers', () => {
      const lines = joinWordsToSpeakers(data.words, data.turns, { segments: data.sentences })
      const interjections = lines.filter(
        (line, index) =>
          index > 0 &&
          index < lines.length - 1 &&
          line.words.length <= 2 &&
          lines[index - 1].speaker !== null &&
          lines[index - 1].speaker === lines[index + 1].speaker &&
          line.speaker !== lines[index - 1].speaker,
      )
      const flicker = interjections.filter((line) =>
        data.sentences.some(
          (sentence) => sentence.start_ms < line.start_ms && line.end_ms < sentence.end_ms,
        ),
      )
      expect(flicker.length).toBeLessThanOrEqual(pingPong.flicker)
      expect(interjections.length).toBeLessThanOrEqual(pingPong.interjections)
    })

    it.skipIf(!introduction)('leaves a two-word self-introduction on the person introducing themselves', () => {
      const lines = joinWordsToSpeakers(data.words, data.turns, { segments: data.sentences })
      const at = lines.findIndex((line) => line.text.includes(introduction as string))
      expect(at).toBeGreaterThan(0)
      expect(lines[at].speaker).not.toBeNull()
      expect(lines[at].speaker).not.toBe(lines[at - 1].speaker)
      expect(lines[at].speaker).not.toBe(lines[at + 1]?.speaker)
    })
  })
}
