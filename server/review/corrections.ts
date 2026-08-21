/**
 * What the owner said about a line, stored as deltas rather than a transcript.
 *
 * This is a working session, not a one-shot declaration. He listens, tries
 * something, hears it again and revises, and the tool has to make revising
 * cheap: a ground-truth page that punishes changing your mind collects worse
 * ground truth. So there are two kinds of record here — an assertion and a
 * retraction — and amending your own earlier assertion is ordinary supersession
 * rather than a conflict to argue about.
 *
 * The distinction that matters: a line with no record here is a line nobody has
 * looked at. A line with a record is a line the owner ruled on, and `asserts`
 * says which halves of it he vouched for. "Untouched" and "confirmed correct"
 * are different pieces of evidence and a rewritten transcript cannot tell them
 * apart — a confirmed-correct line is ground truth, an untouched line is
 * nothing at all, and today we have almost none of the former.
 *
 * The log is append-only. A later ruling on the same line supersedes an earlier
 * one for reading purposes but does not erase it, because the disagreement
 * between two of his own rulings is itself information: it is either a mistake
 * being fixed or a genuinely ambiguous passage, and only he can say which.
 *
 * PRIVACY: every record here quotes a real conversation between real people,
 * two of whom are not contributors, and the content includes health
 * information. The default path is inside `eval/real/`, which is gitignored.
 * `assertCorrectionsPathIsIgnored` refuses to write anywhere git can see.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

export type Dimension = 'speaker' | 'text';

/**
 * A retraction is an event, not a deletion.
 *
 * The log stays append-only because knowing he withdrew something is itself
 * information — a line he ruled on, listened to again and took back is a
 * different object from a line nobody ever touched. But the *effective* state
 * has to be as though it never happened: a retracted ruling reaches no eval,
 * generates no landmark and does not count as reviewed.
 */
export type RecordKind = 'assertion' | 'retraction' | 'skip';

/**
 * "I looked at this and could not answer it."
 *
 * A different state from "not reached yet", and the more useful of the two: it
 * marks the lines the phone card cannot serve — garbled words, a voice missing
 * from the list, a line that needs splitting before anyone can attribute it.
 * He has already told us those specific lines matter, which makes them worth
 * more than a random hundred.
 *
 * It asserts nothing. No dimension is claimed, so it reaches no landmark, no
 * span and no eval, and {@link resolveLine} deliberately reports a
 * skipped-only line as untouched. It exists to be *seen*, on a desktop, later.
 */

export interface CorrectionSpeaker {
  /**
   * The person this line belongs to, or null when the owner named somebody the
   * conversation does not know about yet. Distinct from `name`: reassigning a
   * line to a different voice and fixing a misheard name are different edits,
   * and the pipeline gets both wrong in different ways.
   */
  person_id: string | null;
  name: string;
}

export interface Correction {
  id: string;
  /** Absent means 'assertion': the records written before retraction existed. */
  kind?: RecordKind;
  recording: string;
  utterance_id: string;
  at_ms: number;
  end_ms: number;
  /** The line as it was shown to him, so a later pipeline change is detectable. */
  original_text: string;
  original_speaker_id: string | null;
  original_speaker_name: string | null;
  /** Which halves of the line he vouched for. Empty on a retraction. */
  asserts: Dimension[];
  /** Retractions only: which halves he is taking back. */
  retracts?: Dimension[];
  speaker?: CorrectionSpeaker;
  text?: string;
  note?: string;
  /**
   * Landmarks in `eval/landmarks.ts` this ruling contradicts.
   *
   * Recorded and reported, never resolved and — deliberately — never blocking.
   * Blocking on this stopped the owner mid-session over a landmark covering a
   * different part of the same line, which is a segmentation problem wearing a
   * conflict's clothes.
   */
  conflicts_with?: string[];
  created_at: string;
}

/** Every name this conversation knows, including ones he has corrected. */
export function rosterFor(
  people: { name: string }[],
  renames: { to_name: string }[] = [],
): Set<string> {
  return new Set([
    ...people.map((person) => person.name.trim().toLowerCase()),
    ...renames.map((rename) => rename.to_name.trim().toLowerCase()),
  ]);
}

/** A rename of a person across the whole conversation: Vova -> Volva. */
export interface PersonRename {
  id: string;
  recording: string;
  person_id: string;
  from_name: string;
  to_name: string;
  created_at: string;
}

export interface CorrectionsFile {
  version: 1;
  /** Present so a stray copy is identifiable as personal data on sight. */
  privacy: string;
  corrections: Correction[];
  person_renames: PersonRename[];
  splits: SplitRecord[];
  identity_answers: IdentityAnswer[];
}

/**
 * "Is this voice the same person as that one?"
 *
 * Worth its own record type because it is not about a line. One answer settles
 * whether a 457-second cluster is one person or two, which is more ground truth
 * than any number of line corrections, and it is answered by listening to two
 * voices rather than by reading.
 *
 * `unsure` is a real answer and is stored as one. These clusters are marked
 * impure precisely because they are hard; forcing a yes/no would put a guess
 * into the reference and we would never know which entries were guesses.
 */
export interface IdentityAnswer {
  id: string;
  recording: string;
  question_id: string;
  /**
   * Provenance only. `0:E` and `950:E` are chunk-scoped names from the retired
   * provider and the product now emits global SPEAKER_00..07, so nothing
   * downstream may key on them — his answer is about the audio, not the naming.
   */
  label_a: string;
  label_b: string;
  /**
   * The two stretches he actually compared, and the durable anchor for the
   * whole record. Without this, regenerating the question set changes
   * `question_id` and his answers silently stop counting.
   *
   * Optional only because 'unsure' records no comparison; the route rejects a
   * same/different answer that arrives without it.
   */
  compared?: { a: { start_ms: number; end_ms: number }; b: { start_ms: number; end_ms: number } };
  /** Everything he was offered, for provenance if the question set is rebuilt. */
  shown?: { a: { start_ms: number; end_ms: number }[]; b: { start_ms: number; end_ms: number }[] };
  answer: 'same' | 'different' | 'unsure';
  /**
   * What the retired clustering thought this question was worth. An estimate:
   * it is computed from that clustering's span assignment, so treat it as an
   * order of magnitude and never quote it as a measurement.
   */
  worth_seconds: number;
  note?: string;
  created_at: string;
}

export interface Conflict {
  kind: 'correction' | 'landmark';
  /** Id of the correction, or the quote of the landmark. */
  reference: string;
  dimension: Dimension;
  existing: string;
  incoming: string;
  detail: string;
}

const EMPTY: CorrectionsFile = {
  version: 1,
  privacy:
    'Personal data: verbatim speech of real people, including health information, and the '
    + 'owner\'s attributions of it. Gitignored deliberately. Do not commit, copy or upload.',
  corrections: [],
  person_renames: [],
  splits: [],
  identity_answers: [],
};

export function correctionsPath(): string {
  const configured = process.env.AMELIA_CORRECTIONS_PATH;
  if (configured) return isAbsolute(configured) ? configured : resolve(repoRoot, configured);
  return resolve(repoRoot, 'eval', 'real', 'corrections.json');
}

/**
 * Refuse to write personal data anywhere git would pick it up.
 *
 * `git check-ignore` is the only authority on this that cannot drift from the
 * actual .gitignore. A path outside the repository is fine — git cannot see it.
 */
export function assertCorrectionsPathIsIgnored(path = correctionsPath()): void {
  const absolute = resolve(path);
  if (!absolute.startsWith(repoRoot + '/')) return;
  try {
    execFileSync('git', ['check-ignore', '-q', '--no-index', absolute], { cwd: repoRoot });
  } catch {
    throw new Error(
      `Refusing to write corrections to ${absolute}: git does not ignore it, and every record `
        + 'quotes real people. Add it to .gitignore or set AMELIA_CORRECTIONS_PATH somewhere outside the repo.',
    );
  }
}

export function readCorrections(path = correctionsPath()): CorrectionsFile {
  if (!existsSync(path)) return { ...EMPTY, corrections: [], person_renames: [], splits: [], identity_answers: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<CorrectionsFile>;
    return {
      ...EMPTY,
      ...parsed,
      corrections: parsed.corrections ?? [],
      person_renames: parsed.person_renames ?? [],
      splits: parsed.splits ?? [],
      identity_answers: parsed.identity_answers ?? [],
    };
  } catch (error) {
    // Never start from empty on a parse failure: that silently discards
    // everything he has typed. Refuse instead, loudly.
    throw new Error(`corrections file at ${path} is unreadable (${(error as Error).message}); refusing to overwrite it`);
  }
}

let writeQueue: Promise<unknown> = Promise.resolve();

function writeAtomically(path: string, file: CorrectionsFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
  renameSync(temporary, path);
}

/** Serialised so two fast clicks cannot interleave a read-modify-write. */
export function mutateCorrections<T>(
  change: (file: CorrectionsFile) => { file: CorrectionsFile; result: T },
  path = correctionsPath(),
): Promise<T> {
  const next = writeQueue.then(() => {
    assertCorrectionsPathIsIgnored(path);
    const { file, result } = change(readCorrections(path));
    writeAtomically(path, file);
    return result;
  });
  writeQueue = next.catch(() => undefined);
  return next;
}

/** The current ruling per line per dimension: last writer wins for reading only. */
export function currentRulings(file: CorrectionsFile): Map<string, Correction[]> {
  const byUtterance = new Map<string, Correction[]>();
  for (const correction of file.corrections) {
    const list = byUtterance.get(correction.utterance_id) ?? [];
    list.push(correction);
    byUtterance.set(correction.utterance_id, list);
  }
  return byUtterance;
}

export interface ResolvedLine {
  speaker?: CorrectionSpeaker;
  text?: string;
  asserted: Set<Dimension>;
  contested: boolean;
  /** True when he ruled on this line at some point and has since taken it back. */
  retracted: boolean;
  latest_at: string;
}

/**
 * Fold the log for one line into the state that counts.
 *
 * Order is by `created_at`, and each dimension remembers which record currently
 * supplies it. A retraction drops the supplier; a later assertion installs a new
 * one. That handles the sequence this page will actually see all day — rule,
 * listen again, take it back, rule differently — without any record leaving the
 * log.
 */
export function resolveLine(history: Correction[]): ResolvedLine | null {
  if (history.length === 0) return null;
  const ordered = [...history].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const supplier: Partial<Record<Dimension, Correction>> = {};
  let everAsserted = false;
  let retractedSomething = false;

  for (const record of ordered) {
    if (record.kind === 'retraction') {
      for (const dimension of record.retracts ?? []) {
        if (supplier[dimension]) retractedSomething = true;
        delete supplier[dimension];
      }
      continue;
    }
    // A skip claims nothing, so it contributes no supplier and cannot make a
    // line look reviewed. It is recorded to be found, not to be scored.
    if (record.kind === 'skip') continue;
    for (const dimension of record.asserts) {
      if (dimension === 'speaker' && !record.speaker) continue;
      if (dimension === 'text' && record.text === undefined) continue;
      supplier[dimension] = record;
      everAsserted = true;
    }
  }

  const asserted = new Set(Object.keys(supplier) as Dimension[]);
  // A line whose every ruling has been withdrawn is reported as untouched, not
  // as reviewed-and-empty: it must not count toward progress or reach the eval.
  if (asserted.size === 0) {
    return everAsserted || retractedSomething
      ? {
          asserted,
          contested: false,
          retracted: true,
          latest_at: ordered[ordered.length - 1].created_at,
        }
      : null;
  }

  return {
    ...(supplier.speaker?.speaker ? { speaker: supplier.speaker.speaker } : {}),
    ...(supplier.text?.text !== undefined ? { text: supplier.text.text } : {}),
    asserted,
    contested: Object.values(supplier).some((record) => (record?.conflicts_with?.length ?? 0) > 0),
    retracted: false,
    latest_at: ordered[ordered.length - 1].created_at,
  };
}

/** Which dimensions currently carry a ruling, for building a retraction. */
export function assertedDimensions(history: Correction[]): Dimension[] {
  const resolved = resolveLine(history);
  return resolved ? [...resolved.asserted] : [];
}

const UNNAMED_SPEAKER = /^(unnamed voice|unknown|unknown voice|speaker \d+)$/i;

/**
 * Can a name in `landmarks.ts` be compared with a name in this conversation?
 *
 * Only when the roster actually contains it. The landmark file spells the
 * Ukrainian "volva"; the pipeline guessed "Vova" and that is the name on the
 * person record. Those are one man, and comparing the strings says they are
 * two — which flagged a contradiction on every line he appears in. A banner
 * that cries wolf on the most common name in the recording is worse than no
 * banner, because he will stop reading it before it is ever right.
 *
 * So: if the landmark's name is not a name this conversation knows, we cannot
 * tell a spelling variant from a real disagreement, and we say nothing. Once he
 * renames Vova to Volva the roster contains it and genuine mismatches surface
 * again. The cost is silence on a landmark naming somebody not yet in the
 * roster at all; the alternative is noise on every line.
 */
function comparable(name: string, roster: Set<string>): boolean {
  return roster.has(normaliseName(name));
}

function normaliseName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Does this ruling contradict evidence from somewhere other than himself?
 *
 * Only landmarks in `eval/landmarks.ts` count. Amending his own earlier
 * correction on the same line is deliberately NOT a conflict — it is
 * supersession, and treating it as a disagreement is what stopped the owner
 * mid-session: having edited a line's text he could not then amend it again,
 * and could not even confirm the line as-is, because his own previous edit was
 * being argued with. Changing your mind after listening again is the entire
 * point of this page.
 *
 * What comes back is informational. The caller records it alongside the ruling
 * and shows it; nothing here blocks a write, because the one time it did block,
 * the "conflict" was a landmark covering a different part of the same line —
 * a missing split wearing a contradiction's clothes.
 */
export function findConflicts(
  incoming: Pick<Correction, 'recording' | 'utterance_id' | 'at_ms' | 'end_ms' | 'asserts' | 'speaker' | 'text'>,
  file: CorrectionsFile,
  landmarks: { at_ms: number; end_ms: number; quote: string; person?: string; notPerson?: string; recording: string }[] = [],
  roster: Set<string> = new Set(),
): Conflict[] {
  const conflicts: Conflict[] = [];

  // A confirmation that leaves the speaker as an unnamed placeholder is silent
  // about who it was, so it cannot contradict a landmark that names somebody.
  // Without this, confirming any unnamed line over a landmark is blocked by a
  // conflict that does not exist.
  if (incoming.asserts.includes('speaker') && incoming.speaker && !UNNAMED_SPEAKER.test(incoming.speaker.name.trim())) {
    const claimed = normaliseName(incoming.speaker.name);
    for (const landmark of landmarks) {
      if (landmark.recording !== incoming.recording) continue;
      const overlap = Math.min(landmark.end_ms, incoming.end_ms) - Math.max(landmark.at_ms, incoming.at_ms);
      if (overlap <= 0) continue;
      if (landmark.person && comparable(landmark.person, roster) && normaliseName(landmark.person) !== claimed) {
        conflicts.push({
          kind: 'landmark',
          reference: landmark.quote,
          dimension: 'speaker',
          existing: landmark.person,
          incoming: incoming.speaker.name,
          detail: `an existing landmark over this time says ${landmark.person} said "${landmark.quote}"`,
        });
      }
      if (landmark.notPerson && comparable(landmark.notPerson, roster) && normaliseName(landmark.notPerson) === claimed) {
        conflicts.push({
          kind: 'landmark',
          reference: landmark.quote,
          dimension: 'speaker',
          existing: `not ${landmark.notPerson}`,
          incoming: incoming.speaker.name,
          detail: `an existing landmark over this time says "${landmark.quote}" was NOT ${landmark.notPerson}`,
        });
      }
    }
  }

  return conflicts;
}

/**
 * A cut through a line, and who spoke each side of it.
 *
 * This is a different claim from "who said this line", and it is stored as its
 * own thing rather than as a pile of per-line corrections, because it asserts
 * something no per-line correction can: **a speaker change happened here, and
 * diarization missed it.** That is measurable against the system's emitted turn
 * boundaries, and it is the one class of error the pipeline provably cannot
 * find for itself — pyannote emits `18.22-24.38 SPEAKER_04` as a single turn
 * with nothing nested inside, and all eight local-segmentation windows over
 * 20.84-21.96 s report one continuous speaker. The boundary was never detected,
 * so the owner's cut is the only source of truth for it.
 *
 * The cut is an interval, not an instant. The real change is somewhere in the
 * silence between the last word of one part and the first word of the next, and
 * nothing in the audio narrows it further. Storing a point would invent
 * precision and then score systems against a number nobody can know.
 */
export interface SplitBoundary {
  from_ms: number;
  to_ms: number;
}

export interface SplitPart {
  start_ms: number;
  end_ms: number;
  text: string;
  speaker: CorrectionSpeaker;
}

export interface SplitRecord {
  id: string;
  kind: 'split' | 'retraction';
  recording: string;
  utterance_id: string;
  at_ms: number;
  end_ms: number;
  original_text: string;
  original_speaker_id: string | null;
  original_speaker_name: string | null;
  boundaries: SplitBoundary[];
  parts: SplitPart[];
  conflicts_with?: string[];
  note?: string;
  created_at: string;
}

/** The split currently in force for a line, if any. */
export function resolveSplit(records: SplitRecord[], utteranceId: string): SplitRecord | null {
  const ordered = records
    .filter((record) => record.utterance_id === utteranceId)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const latest = ordered[ordered.length - 1];
  if (!latest || latest.kind === 'retraction') return null;
  return latest;
}

export function splitsByUtterance(file: CorrectionsFile): Map<string, SplitRecord> {
  const live = new Map<string, SplitRecord>();
  for (const utteranceId of new Set((file.splits ?? []).map((record) => record.utterance_id))) {
    const resolved = resolveSplit(file.splits ?? [], utteranceId);
    if (resolved) live.set(utteranceId, resolved);
  }
  return live;
}

/**
 * Why a proposed split cannot be stored as given.
 *
 * A boundary is a claim that the speaker changed. Two adjacent parts credited
 * to the same person assert a change that did not happen, which would put a
 * false negative into the one reference that measures missed boundaries — so it
 * is refused rather than recorded. This is the only refusal left in this file;
 * everything else is surfaced and saved.
 */
export function validateSplit(parts: SplitPart[]): string | null {
  if (parts.length < 2) return 'a split needs at least two parts';
  for (const part of parts) {
    if (!part.speaker?.name?.trim()) return 'every part needs a speaker before the split can be recorded';
    if (part.end_ms <= part.start_ms) return 'every part needs a positive duration';
  }
  for (let i = 1; i < parts.length; i += 1) {
    if (parts[i].start_ms < parts[i - 1].end_ms) return 'parts must not overlap';
    const before = parts[i - 1].speaker;
    const after = parts[i].speaker;
    const sameName = normaliseName(before.name) === normaliseName(after.name);
    const samePerson = before.person_id !== null && before.person_id === after.person_id;
    if (sameName || samePerson) {
      return `parts ${i} and ${i + 1} are both ${after.name}, so the cut between them claims a speaker change that did not happen. `
        + 'Give them different speakers, or remove that cut.';
    }
  }
  return null;
}

/**
 * Landmarks a split would disturb.
 *
 * Reported, never resolved, and never blocking — the same treatment corrections
 * get. The interesting case is a landmark that straddles a cut: it credits one
 * speaker with a span the owner has just said contains two. That does not make
 * either of them wrong, and it is exactly the sort of thing a person should
 * look at rather than a program decide.
 */
export function findSplitConflicts(
  split: Pick<SplitRecord, 'recording' | 'at_ms' | 'end_ms' | 'parts'>,
  landmarks: { at_ms: number; end_ms: number; quote: string; person?: string; notPerson?: string; recording: string }[],
  roster: Set<string> = new Set(),
): Conflict[] {
  const conflicts: Conflict[] = [];
  for (const landmark of landmarks) {
    if (landmark.recording !== split.recording) continue;
    if (Math.min(landmark.end_ms, split.end_ms) - Math.max(landmark.at_ms, split.at_ms) <= 0) continue;

    const touched = split.parts.filter(
      (part) => Math.min(landmark.end_ms, part.end_ms) - Math.max(landmark.at_ms, part.start_ms) > 0,
    );
    if (touched.length === 0) continue;

    const speakers = new Set(touched.map((part) => normaliseName(part.speaker.name)));
    if (landmark.person && comparable(landmark.person, roster) && touched.length > 1 && speakers.size > 1) {
      conflicts.push({
        kind: 'landmark',
        reference: landmark.quote,
        dimension: 'speaker',
        existing: landmark.person,
        incoming: [...speakers].join(' then '),
        detail: `a landmark credits "${landmark.quote}" to ${landmark.person} as one speaker, and your cut puts a boundary inside it`,
      });
      continue;
    }
    for (const part of touched) {
      const claimed = normaliseName(part.speaker.name);
      if (UNNAMED_SPEAKER.test(part.speaker.name.trim())) continue;
      if (landmark.person && comparable(landmark.person, roster) && normaliseName(landmark.person) !== claimed && touched.length === 1) {
        conflicts.push({
          kind: 'landmark',
          reference: landmark.quote,
          dimension: 'speaker',
          existing: landmark.person,
          incoming: part.speaker.name,
          detail: `a landmark says ${landmark.person} said "${landmark.quote}", and this part gives it to ${part.speaker.name}`,
        });
      }
      if (landmark.notPerson && comparable(landmark.notPerson, roster) && normaliseName(landmark.notPerson) === claimed) {
        conflicts.push({
          kind: 'landmark',
          reference: landmark.quote,
          dimension: 'speaker',
          existing: `not ${landmark.notPerson}`,
          incoming: part.speaker.name,
          detail: `a landmark says "${landmark.quote}" was NOT ${landmark.notPerson}, and this part gives it to ${part.speaker.name}`,
        });
      }
    }
  }
  return conflicts;
}


/** The answer currently in force for each question: latest wins, history kept. */
export function liveIdentityAnswers(file: CorrectionsFile): Map<string, IdentityAnswer> {
  const live = new Map<string, IdentityAnswer>();
  for (const answer of [...file.identity_answers].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    live.set(answer.question_id, answer);
  }
  return live;
}


export interface SkippedLine {
  at: string;
  /** What he said was wrong with it, when he said anything. */
  reason: string | null;
}

/** Lines he looked at and could not answer, with why when he told us. */
export function skippedLines(file: CorrectionsFile, recording: string): Map<string, SkippedLine> {
  const skipped = new Map<string, SkippedLine>();
  for (const record of file.corrections) {
    if (record.kind !== 'skip' || record.recording !== recording) continue;
    skipped.set(record.utterance_id, { at: record.created_at, reason: record.note ?? null });
  }
  // A later ruling means he came back and dealt with it; the skip stops being
  // interesting the moment it is answered.
  for (const record of file.corrections) {
    if (record.kind === 'skip' || record.kind === 'retraction') continue;
    if (record.recording !== recording) continue;
    const entry = skipped.get(record.utterance_id);
    if (entry && record.created_at > entry.at) skipped.delete(record.utterance_id);
  }
  return skipped;
}
