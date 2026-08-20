/**
 * The transcript review page: the owner's corrections, at the speed of listening.
 *
 * Everything here is local-only by construction. It serves real people's speech
 * off the owner's disk to a browser on the same machine and writes his rulings
 * to a gitignored file. Nothing leaves the laptop; do not put this behind a
 * tunnel, and do not add an endpoint that copies the audio anywhere.
 */
import type { Hono } from 'hono';
import type { Person, ServerDependencies, Utterance } from '../../shared/contracts';
import { LANDMARKS } from '../../eval/landmarks';
import { getStorage } from '../storage';
import { findConversationAudio } from './audio-source';
import {
  assertCorrectionsPathIsIgnored,
  correctionsPath,
  assertedDimensions,
  currentRulings,
  findConflicts,
  findSplitConflicts,
  mutateCorrections,
  liveIdentityAnswers,
  readCorrections,
  resolveLine,
  rosterFor,
  splitsByUtterance,
  validateSplit,
  type Correction,
  type Dimension,
  type SplitPart,
  type SplitRecord,
} from './corrections';
import { gapsBetween, wordsForLine } from './words';
import { REVIEW_PAGE_HTML } from './page';
import { readWavLayout, sliceWav } from './wav-slice';
import { freshnessOf } from './freshness';
import { anchorCorrections, summariseAnchors } from './anchor';
import { rankLines, speakerCoverage, TARGET_PER_SPEAKER } from './queue';
import { openQuestions } from './questions';

const MAX_SLICE_MS = 120_000;

interface CorrectionRequest {
  recording: string;
  utterance_id: string;
  at_ms: number;
  end_ms: number;
  original_text: string;
  original_speaker_id: string | null;
  original_speaker_name: string | null;
  asserts: Dimension[];
  speaker?: { person_id: string | null; name: string };
  text?: string;
  note?: string;
  acknowledge_conflict?: boolean;
}

export function registerReviewRoutes(app: Hono, _deps: ServerDependencies): void {
  app.get('/review', (context) =>
    context.html(REVIEW_PAGE_HTML, 200, {
      // The page quotes a private conversation. Nothing should keep a copy.
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    }),
  );

  app.get('/review/api/conversations', async (context) => {
    const storage = await getStorage();
    const conversations = await storage
      .collection<{ _id: string; started_at?: string; participant_ids?: string[] }>('conversations')
      .find({})
      .toArray();
    const summaries = await Promise.all(
      conversations.map(async (conversation) => ({
        id: conversation._id,
        started_at: conversation.started_at ?? null,
        lines: await storage.collection<Utterance>('utterances').countDocuments({ conversation_id: conversation._id }),
        has_audio: findConversationAudio(conversation._id) !== null,
      })),
    );
    summaries.sort((a, b) => (b.started_at ?? '').localeCompare(a.started_at ?? ''));
    return context.json({ conversations: summaries, corrections_path: correctionsPath() });
  });

  app.get('/review/api/conversation/:id', async (context) => {
    const conversationId = context.req.param('id');
    const storage = await getStorage();

    const utterances = await storage
      .collection<Utterance>('utterances')
      .find({ conversation_id: conversationId })
      .sort({ start_ms: 1 })
      .toArray();
    if (utterances.length === 0) return context.json({ error: 'no lines for that conversation' }, 404);

    const peopleIds = [...new Set(utterances.map((utterance) => utterance.person_id).filter(Boolean))] as string[];
    const people = await storage.collection<Person>('people').find({}).toArray();
    const known = people.filter((person) => peopleIds.includes(person._id));

    const file = readCorrections();
    // Corrections are keyed by line id, and the seed regenerates ids
    // positionally. Re-key on the span and the words he was actually looking
    // at, so a re-seed moves his work with the transcript instead of dropping
    // it onto whichever line inherited the id.
    const anchorLines = utterances.map((utterance) => ({
      id: utterance._id,
      at_ms: utterance.start_ms,
      end_ms: utterance.end_ms,
      text: utterance.text,
    }));
    const anchored = anchorCorrections(
      file.corrections.filter((correction) => correction.recording === conversationId),
      anchorLines,
    );
    const history = new Map<string, typeof file.corrections>();
    for (const entry of anchored) {
      if (!entry.utterance_id || entry.state === 'orphaned') continue;
      history.set(entry.utterance_id, [...(history.get(entry.utterance_id) ?? []), entry.correction]);
    }
    for (const [key, value] of currentRulings(file)) if (!history.has(key)) history.set(key, value);
    const unsettled = new Map(
      anchored
        .filter((entry) => entry.state === 'ambiguous' || entry.state === 'rekeyed')
        .map((entry) => [entry.correction.id, entry] as const),
    );
    const flaggedLines = new Map<string, string>();
    for (const entry of unsettled.values()) {
      if (entry.utterance_id) flaggedLines.set(entry.utterance_id, entry.detail);
    }
    const splits = splitsByUtterance(file);
    const renames = new Map(
      file.person_renames
        .filter((rename) => rename.recording === conversationId)
        .map((rename) => [rename.person_id, rename.to_name] as const),
    );

    // A confirmation counts for the voice he PUT the line on, not the one the
    // pipeline guessed — otherwise correcting a line credits coverage to the
    // speaker who did not say it.
    const confirmedBySpeaker = new Map<string, number>();
    const audioPath = findConversationAudio(conversationId);
    const audio = audioPath
      ? { available: true, duration_ms: (await readWavLayout(audioPath)).durationMs }
      : { available: false, duration_ms: 0 };

    const lines = utterances.map((utterance) => {
      const ruling = resolveLine(history.get(utterance._id) ?? []);
      return {
        id: utterance._id,
        at_ms: utterance.start_ms,
        end_ms: utterance.end_ms,
        text: utterance.text,
        person_id: utterance.person_id ?? null,
        identity_confidence: utterance.identity_confidence ?? null,
        ruling:
          ruling && ruling.asserted.size > 0
            ? {
                speaker: ruling.speaker ?? null,
                text: ruling.text ?? null,
                asserted: [...ruling.asserted],
                contested: ruling.contested,
                latest_at: ruling.latest_at,
              }
            : null,
        // A line he ruled on and then took back. Not reviewed, but not
        // untouched either, and worth showing so he can see where he has been.
        retracted: ruling?.retracted ?? false,
        split: splits.get(utterance._id)
          ? { boundaries: splits.get(utterance._id)!.boundaries, parts: splits.get(utterance._id)!.parts }
          : null,
        anchor_warning: flaggedLines.get(utterance._id) ?? null,
      };
    });

    for (const line of lines) {
      const ruling = line.ruling;
      const person = ruling?.speaker?.person_id ?? (ruling ? line.person_id : null);
      if (ruling && ruling.asserted.includes('speaker') && person) {
        confirmedBySpeaker.set(person, (confirmedBySpeaker.get(person) ?? 0) + 1);
      }
      for (const part of line.split?.parts ?? []) {
        if (part.speaker.person_id) {
          confirmedBySpeaker.set(part.speaker.person_id, (confirmedBySpeaker.get(part.speaker.person_id) ?? 0) + 1);
        }
      }
    }

    return context.json({
      conversation_id: conversationId,
      audio,
      people: known.map((person) => {
        const spoken = utterances.filter((utterance) => utterance.person_id === person._id);
        const speakingMs = spoken.reduce((total, utterance) => total + (utterance.end_ms - utterance.start_ms), 0);
        // Six of eight voices in this recording are called "Unnamed voice", so a
        // picker showing only names offers six identical options. What tells
        // them apart is when they speak, how much, and what they sound like —
        // so every voice carries its own share of the room and a line long
        // enough to recognise.
        const sample = [...spoken].sort((a, b) => b.text.length - a.text.length)[0];
        return {
          id: person._id,
          name: renames.get(person._id) ?? person.name,
          original_name: person.name,
          renamed: renames.has(person._id),
          is_unnamed: person.is_unnamed ?? false,
          lines: spoken.length,
          speaking_ms: speakingMs,
          first_at_ms: spoken.length ? spoken[0].start_ms : null,
          sample: sample ? sample.text.slice(0, 70) : null,
          sample_at_ms: sample ? sample.start_ms : null,
          sample_end_ms: sample ? sample.end_ms : null,
        };
      }),
      lines,
      freshness: freshnessOf(conversationId, utterances.map((utterance) => ({
        start_ms: utterance.start_ms,
        text: utterance.text,
      }))),
      corrections_path: correctionsPath(),
      // What to look at next, and why. Ordering is computed here so the page
      // does not have to re-ask after every save: the greedy pass already
      // interleaves voices as though each queued line had been confirmed.
      queue: rankLines(
        conversationId,
        anchorLines.map((line) => ({
          id: line.id,
          at_ms: line.at_ms,
          end_ms: line.end_ms,
          person_id: utterances.find((utterance) => utterance._id === line.id)?.person_id ?? null,
        })),
        new Set(lines.filter((line) => line.ruling !== null || line.split).map((line) => line.id)),
        confirmedBySpeaker,
      ),
      coverage: {
        target_per_speaker: TARGET_PER_SPEAKER,
        speakers: speakerCoverage(
          utterances.map((utterance) => ({
            id: utterance._id,
            at_ms: utterance.start_ms,
            end_ms: utterance.end_ms,
            person_id: utterance.person_id ?? null,
          })),
          confirmedBySpeaker,
        ),
      },
      // The highest-value thing on the page: one answer settles hundreds of
      // seconds, where a line correction settles one line.
      questions: (() => {
        const answers = liveIdentityAnswers(file);
        return openQuestions(conversationId).map((question) => ({
          ...question,
          answer: answers.get(question.id)?.answer ?? null,
          answered_at: answers.get(question.id)?.created_at ?? null,
        }));
      })(),
      anchors: summariseAnchors(anchored),
      counts: {
        lines: lines.length,
        ruled: lines.filter((line) => line.ruling !== null).length,
        retracted: lines.filter((line) => line.retracted).length,
        contested: lines.filter((line) => line.ruling?.contested).length,
        remaining: lines.filter((line) => line.ruling === null && !line.split).length,
        split: lines.filter((line) => line.split).length,
      },
    });
  });

  /**
   * A span of the recording, cut by byte offset and returned as its own wav.
   *
   * Deliberately not a Range request over the whole file: the browser would
   * have to wait on the container before the first sample, and the owner is
   * going to click hundreds of these.
   */
  app.get('/review/api/audio/:id', async (context) => {
    const conversationId = context.req.param('id');
    const path = findConversationAudio(conversationId);
    if (!path) return context.json({ error: 'no local recording found for that conversation' }, 404);

    const startMs = Number(context.req.query('start_ms') ?? 0);
    const endMs = Number(context.req.query('end_ms') ?? 0);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      return context.json({ error: 'start_ms and end_ms must be finite with end after start' }, 400);
    }
    const slice = await sliceWav(path, Math.max(0, startMs), Math.min(endMs, startMs + MAX_SLICE_MS));

    return new Response(new Uint8Array(slice.wav), {
      headers: {
        'Content-Type': 'audio/wav',
        'Content-Length': String(slice.wav.length),
        // Private speech: cacheable in this browser tab, nowhere else.
        'Cache-Control': 'private, max-age=3600',
        'X-Span-Start-Ms': String(slice.startMs),
        'X-Span-End-Ms': String(slice.endMs),
      },
    });
  });

  /** The names this conversation knows, so a landmark spelling can be judged. */
  async function rosterOf(conversationId: string, file: ReturnType<typeof readCorrections>): Promise<Set<string>> {
    const storage = await getStorage();
    const people = await storage.collection<Person>('people').find({}).toArray();
    return rosterFor(
      people,
      file.person_renames.filter((rename) => rename.recording === conversationId),
    );
  }

  app.post('/review/api/correction', async (context) => {
    const body = await context.req.json<CorrectionRequest>();
    if (!Array.isArray(body.asserts) || body.asserts.length === 0) {
      return context.json({ error: 'a correction has to assert something: speaker, text, or both' }, 400);
    }
    if (body.asserts.includes('speaker') && !body.speaker?.name?.trim()) {
      return context.json({ error: 'asserting a speaker requires a name' }, 400);
    }
    if (body.asserts.includes('text') && typeof body.text !== 'string') {
      return context.json({ error: 'asserting text requires the text' }, 400);
    }

    // Conflicts are recorded and returned, never blocking. This used to answer
    // 409 and refuse the write; it stopped the owner mid-session over his own
    // previous edit, and over a landmark covering a different part of the same
    // line. Surfacing means the line is marked and the eval reports it — not
    // that he is prevented from working.
    const file = readCorrections();
    const conflicts = findConflicts(body, file, LANDMARKS, await rosterOf(body.recording, file));

    const correction: Correction = {
      id: crypto.randomUUID(),
      kind: 'assertion',
      recording: body.recording,
      utterance_id: body.utterance_id,
      at_ms: body.at_ms,
      end_ms: body.end_ms,
      original_text: body.original_text,
      original_speaker_id: body.original_speaker_id ?? null,
      original_speaker_name: body.original_speaker_name ?? null,
      asserts: body.asserts,
      ...(body.speaker ? { speaker: { person_id: body.speaker.person_id, name: body.speaker.name.trim() } } : {}),
      ...(body.text !== undefined ? { text: body.text } : {}),
      ...(body.note ? { note: body.note } : {}),
      ...(conflicts.length > 0 ? { conflicts_with: conflicts.map((conflict) => conflict.reference) } : {}),
      created_at: new Date().toISOString(),
    };

    await mutateCorrections((current) => ({
      file: { ...current, corrections: [...current.corrections, correction] },
      result: null,
    }));

    return context.json({ ok: true, correction, conflicts }, 201);
  });

  /**
   * Take a ruling back.
   *
   * Retracting is not disagreeing. "I clicked the wrong thing" and "I listened
   * again and I was wrong" are both going to happen constantly, and both are
   * healthy — this page exists so he can change his mind cheaply once he has
   * heard the audio. The event is appended rather than the earlier record being
   * deleted, so the history survives, but the effective state is as if the
   * ruling never happened: no landmark, no span, not counted as reviewed.
   */
  app.post('/review/api/retract', async (context) => {
    const body = await context.req.json<{
      recording: string;
      utterance_id: string;
      at_ms: number;
      end_ms: number;
      original_text?: string;
      dimensions?: Dimension[];
      reason?: string;
    }>();

    const file = readCorrections();
    const history = currentRulings(file).get(body.utterance_id) ?? [];
    const live = assertedDimensions(history);
    const dimensions = (body.dimensions?.length ? body.dimensions : live).filter((dimension) =>
      live.includes(dimension),
    );
    if (dimensions.length === 0) {
      return context.json({ error: 'there is no ruling on that line to take back', retracted: [] }, 409);
    }

    const retraction: Correction = {
      id: crypto.randomUUID(),
      kind: 'retraction',
      recording: body.recording,
      utterance_id: body.utterance_id,
      at_ms: body.at_ms,
      end_ms: body.end_ms,
      original_text: body.original_text ?? '',
      original_speaker_id: null,
      original_speaker_name: null,
      asserts: [],
      retracts: dimensions,
      ...(body.reason ? { note: body.reason } : {}),
      created_at: new Date().toISOString(),
    };

    await mutateCorrections((current) => ({
      file: { ...current, corrections: [...current.corrections, retraction] },
      result: null,
    }));

    return context.json({ ok: true, retracted: dimensions, retraction }, 201);
  });

  app.post('/review/api/person-rename', async (context) => {
    const body = await context.req.json<{ recording: string; person_id: string; from_name: string; to_name: string }>();
    if (!body.to_name?.trim()) return context.json({ error: 'a rename needs a name' }, 400);
    const rename = {
      id: crypto.randomUUID(),
      recording: body.recording,
      person_id: body.person_id,
      from_name: body.from_name,
      to_name: body.to_name.trim(),
      created_at: new Date().toISOString(),
    };
    await mutateCorrections((current) => ({
      file: { ...current, person_renames: [...current.person_renames, rename] },
      result: null,
    }));
    return context.json({ ok: true, rename }, 201);
  });

  /**
   * The words of one line, with the gaps a cut can go in.
   *
   * Word timings come from whisper, which is the only thing here that knows
   * where a word actually starts. Without them a split could only be expressed
   * as a character offset, which carries no time and is therefore useless as
   * ground truth — so when the timed transcript is missing, splitting is
   * refused with a reason rather than faked by spreading words evenly.
   */
  app.get('/review/api/words/:id', (context) => {
    const conversationId = context.req.param('id');
    const startMs = Number(context.req.query('start_ms'));
    const endMs = Number(context.req.query('end_ms'));
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      return context.json({ error: 'start_ms and end_ms are required' }, 400);
    }
    const words = wordsForLine(conversationId, startMs, endMs);
    if (!words) {
      return context.json(
        {
          error: 'no word timings for this conversation, so a cut could not be given a timestamp. '
            + `Splitting needs ${conversationId}.whisper.json alongside the recording.`,
        },
        404,
      );
    }
    return context.json({ words, gaps: gapsBetween(words) });
  });

  /**
   * Record a cut and who spoke each side of it.
   *
   * The parts also become ordinary speaker rulings, because each one is a
   * perfectly good per-line attribution — but the boundaries are kept
   * separately, because "the speaker changed here" is a claim about
   * segmentation that no per-line attribution can express, and it is the claim
   * the pipeline cannot make for itself.
   */
  app.post('/review/api/split', async (context) => {
    const body = await context.req.json<{
      recording: string;
      utterance_id: string;
      at_ms: number;
      end_ms: number;
      original_text: string;
      original_speaker_id: string | null;
      original_speaker_name: string | null;
      boundaries: { from_ms: number; to_ms: number }[];
      parts: SplitPart[];
      note?: string;
    }>();

    const invalid = validateSplit(body.parts ?? []);
    if (invalid) return context.json({ error: invalid }, 400);

    const file = readCorrections();
    const conflicts = findSplitConflicts(body, LANDMARKS, await rosterOf(body.recording, file));
    const split: SplitRecord = {
      id: crypto.randomUUID(),
      kind: 'split',
      recording: body.recording,
      utterance_id: body.utterance_id,
      at_ms: body.at_ms,
      end_ms: body.end_ms,
      original_text: body.original_text,
      original_speaker_id: body.original_speaker_id ?? null,
      original_speaker_name: body.original_speaker_name ?? null,
      boundaries: body.boundaries ?? [],
      parts: body.parts.map((part) => ({
        ...part,
        speaker: { person_id: part.speaker.person_id, name: part.speaker.name.trim() },
      })),
      ...(conflicts.length > 0 ? { conflicts_with: conflicts.map((conflict) => conflict.reference) } : {}),
      ...(body.note ? { note: body.note } : {}),
      created_at: new Date().toISOString(),
    };

    await mutateCorrections((current) => ({
      file: { ...current, splits: [...current.splits, split] },
      result: null,
    }));
    return context.json({ ok: true, split, conflicts }, 201);
  });

  /** Take a split back, same append-only treatment as any other retraction. */
  app.post('/review/api/split/retract', async (context) => {
    const body = await context.req.json<{ recording: string; utterance_id: string; at_ms: number; end_ms: number }>();
    const file = readCorrections();
    if (!splitsByUtterance(file).has(body.utterance_id)) {
      return context.json({ error: 'there is no split on that line to take back' }, 409);
    }
    const retraction: SplitRecord = {
      id: crypto.randomUUID(),
      kind: 'retraction',
      recording: body.recording,
      utterance_id: body.utterance_id,
      at_ms: body.at_ms,
      end_ms: body.end_ms,
      original_text: '',
      original_speaker_id: null,
      original_speaker_name: null,
      boundaries: [],
      parts: [],
      created_at: new Date().toISOString(),
    };
    await mutateCorrections((current) => ({
      file: { ...current, splits: [...current.splits, retraction] },
      result: null,
    }));
    return context.json({ ok: true }, 201);
  });

  /**
   * Answer a same-or-different question.
   *
   * `unsure` is stored like any other answer rather than discarded. These
   * clusters are flagged impure because they are genuinely hard, and a page
   * that only accepts yes/no would convert "I cannot tell" into a coin flip
   * inside the reference, where nobody could ever find it again.
   */
  app.post('/review/api/identity-answer', async (context) => {
    const body = await context.req.json<{
      recording: string;
      question_id: string;
      label_a: string;
      label_b: string;
      answer: 'same' | 'different' | 'unsure';
      worth_seconds?: number;
      compared?: { a: { start_ms: number; end_ms: number }; b: { start_ms: number; end_ms: number } };
      shown?: { a: { start_ms: number; end_ms: number }[]; b: { start_ms: number; end_ms: number }[] };
      note?: string;
    }>();
    if (!['same', 'different', 'unsure'].includes(body.answer)) {
      return context.json({ error: "answer must be 'same', 'different' or 'unsure'" }, 400);
    }
    // A same/different answer with no spans is not usable ground truth: the
    // cluster names it came from are from a retired scheme, so the audio he
    // compared is the only part of it that will still mean something later.
    if (body.answer !== 'unsure' && (!body.compared?.a?.end_ms || !body.compared?.b?.end_ms)) {
      return context.json({ error: 'an answer must record the two stretches of audio it compared' }, 400);
    }
    const answer = {
      id: crypto.randomUUID(),
      recording: body.recording,
      question_id: body.question_id,
      label_a: body.label_a,
      label_b: body.label_b,
      answer: body.answer,
      ...(body.compared ? { compared: body.compared } : {}),
      ...(body.shown ? { shown: body.shown } : {}),
      worth_seconds: body.worth_seconds ?? 0,
      ...(body.note ? { note: body.note } : {}),
      created_at: new Date().toISOString(),
    };
    await mutateCorrections((current) => ({
      file: { ...current, identity_answers: [...current.identity_answers, answer] },
      result: null,
    }));
    return context.json({ ok: true, answer }, 201);
  });

  app.get('/review/api/health', (context) => {
    let ignored = true;
    let reason: string | null = null;
    try {
      assertCorrectionsPathIsIgnored();
    } catch (error) {
      ignored = false;
      reason = (error as Error).message;
    }
    const file = readCorrections();
    return context.json({
      corrections_path: correctionsPath(),
      gitignored: ignored,
      reason,
      corrections: file.corrections.length,
      person_renames: file.person_renames.length,
    });
  });
}
