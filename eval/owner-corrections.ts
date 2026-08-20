/**
 * The owner's corrections, turned into things the eval can score against.
 *
 * A landmark in `landmarks.ts` is a line whose speaker the line itself settles:
 * no listening required, and it does not move when a threshold moves. A
 * correction from the review page is a different provenance for the same
 * strength of claim — the person who was in the room, having just listened to
 * that exact span, saying who was speaking. That is at least as good as
 * inferring a speaker from a self-introduction, and better than the span labels
 * in `ground-truth.json`, which rest on voiceprint clustering.
 *
 * So corrections feed BOTH references, deliberately:
 *
 *  - As **landmarks**, because the pairwise machinery in `checkLandmarks` is the
 *    only thing here that catches a merge. Seconds-based error rates cannot:
 *    merging two people who barely overlap in time costs almost nothing in
 *    seconds, and merging one pair while splitting another leaves the speaker
 *    count looking right. That bug was live in this repository.
 *  - As **span reference**, because landmarks say nothing about coverage. A
 *    system can satisfy every constraint and still be wrong across the 99% of
 *    the recording no landmark touches.
 *
 * Text corrections feed neither: they are a transcription reference, not a
 * diarization one, and are exported separately.
 *
 * This file reads a gitignored input and every function tolerates it being
 * absent, exactly like `dormReference()`. Corrections are personal data and are
 * not committed; on a fresh clone there simply are none.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveLine, type Correction as StoredRecord } from '../server/review/corrections';
import { openQuestions } from '../server/review/questions';
import { LANDMARKS, type Landmark } from './landmarks';
import type { AttributedSegment, Span } from './scoring';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

type Dimension = 'speaker' | 'text';

interface StoredCorrection {
  id: string;
  kind?: 'assertion' | 'retraction';
  recording: string;
  utterance_id: string;
  at_ms: number;
  end_ms: number;
  original_text: string;
  original_speaker_name: string | null;
  asserts: Dimension[];
  retracts?: Dimension[];
  speaker?: { person_id: string | null; name: string };
  text?: string;
  conflicts_with?: string[];
  created_at: string;
}

interface StoredSplit {
  id: string;
  kind: 'split' | 'retraction';
  recording: string;
  utterance_id: string;
  at_ms: number;
  end_ms: number;
  original_text: string;
  original_speaker_name: string | null;
  boundaries: { from_ms: number; to_ms: number }[];
  parts: { start_ms: number; end_ms: number; text: string; speaker: { person_id: string | null; name: string } }[];
  conflicts_with?: string[];
  created_at: string;
}

interface StoredFile {
  corrections?: StoredCorrection[];
  person_renames?: { recording: string; person_id: string; to_name: string; created_at: string }[];
  splits?: StoredSplit[];
}

export function correctionsPath(): string {
  const configured = process.env.AMELIA_CORRECTIONS_PATH;
  if (configured) return isAbsolute(configured) ? configured : resolve(repoRoot, configured);
  return resolve(repoRoot, 'eval', 'real', 'corrections.json');
}

export function hasCorrections(path = correctionsPath()): boolean {
  return existsSync(path);
}

export function readCorrectionsFile(path = correctionsPath()): StoredFile {
  if (!existsSync(path)) return { corrections: [], person_renames: [] };
  return JSON.parse(readFileSync(path, 'utf8')) as StoredFile;
}

/**
 * The current speaker ruling per line: the owner's latest word on it.
 *
 * Superseded rulings are dropped here and only here. The log keeps them, and
 * {@link contestedCorrections} is how a disagreement between two of his own
 * rulings reaches a human instead of being silently averaged away.
 */
export function latestSpeakerRulings(recording: string, file = readCorrectionsFile()): StoredCorrection[] {
  const byUtterance = new Map<string, StoredCorrection[]>();
  for (const record of file.corrections ?? []) {
    if (record.recording !== recording) continue;
    byUtterance.set(record.utterance_id, [...(byUtterance.get(record.utterance_id) ?? []), record]);
  }

  const live: StoredCorrection[] = [];
  for (const history of byUtterance.values()) {
    // The same fold the page uses, imported rather than copied: a retracted
    // ruling must be invisible here, and a reference that disagreed with the
    // page about what had been retracted would be worse than no reference.
    const resolved = resolveLine(history as unknown as StoredRecord[]);
    if (!resolved?.asserted.has('speaker') || !resolved.speaker) continue;
    const ordered = [...history].sort((a, b) => a.created_at.localeCompare(b.created_at));
    const supplier = ordered
      .filter((record) => record.kind !== 'retraction' && record.asserts.includes('speaker') && record.speaker)
      .pop();
    if (supplier) live.push(supplier);
  }
  return live.sort((a, b) => a.at_ms - b.at_ms);
}

/** Splits still in force, retractions folded out. */
export function liveSplits(recording: string, file = readCorrectionsFile()): StoredSplit[] {
  const byUtterance = new Map<string, StoredSplit[]>();
  for (const record of file.splits ?? []) {
    if (record.recording !== recording) continue;
    byUtterance.set(record.utterance_id, [...(byUtterance.get(record.utterance_id) ?? []), record]);
  }
  const live: StoredSplit[] = [];
  for (const history of byUtterance.values()) {
    const latest = [...history].sort((a, b) => a.created_at.localeCompare(b.created_at)).pop();
    if (latest && latest.kind === 'split') live.push(latest);
  }
  return live.sort((a, b) => a.at_ms - b.at_ms);
}

/** Rulings the owner recorded knowing they contradicted an earlier one of his. */
export function contestedCorrections(file = readCorrectionsFile()): StoredCorrection[] {
  return (file.corrections ?? []).filter((correction) => (correction.conflicts_with?.length ?? 0) > 0);
}

const UNNAMED = /^(unnamed voice|unknown|unknown voice|speaker \d+)$/i;

/**
 * The identity a ruling pins down, as a string the pairwise check can compare.
 *
 * Two traps live here, and both were live until the generated landmarks were
 * first printed:
 *
 * 1. "Unnamed voice" is not an identity. Six of the eight people in the 48-minute
 *    recording carry that placeholder, so taking the name at face value would
 *    assert that six different voices are one person — manufacturing the exact
 *    merge the landmarks exist to catch. When he confirms a line without naming
 *    the speaker he is still saying something real ("this line is that voice"),
 *    so the stable person_id carries the constraint instead.
 * 2. `checkLandmarks` only ever compares these strings to each other, never to a
 *    system label, so an id is as good as a name — but `landmarks.ts` writes
 *    'volva' and the app writes 'Volva', and left alone those two read as
 *    different people and invent a split. Everything is folded to lower case.
 */
export function landmarkIdentity(correction: StoredCorrection): string | null {
  const name = correction.speaker?.name?.trim();
  if (name && !UNNAMED.test(name)) return name.toLowerCase();
  return correction.speaker?.person_id ? correction.speaker.person_id.toLowerCase() : null;
}

/** Span-level reference derived from his rulings. Sparse, and correct where it exists. */
export function ownerSpans(recording: string, file = readCorrectionsFile()): Span[] {
  const spans: Span[] = [...splitSpans(recording, file)];
  for (const correction of latestSpeakerRulings(recording, file)) {
    const speaker = landmarkIdentity(correction);
    if (speaker) spans.push({ speaker, start_ms: correction.at_ms, end_ms: correction.end_ms });
  }
  return spans;
}

/**
 * Why this is capped and spread rather than "all of them".
 *
 * `checkLandmarks` compares every landmark against every other, so the
 * constraint count is quadratic. Feeding 900 confirmed lines in would produce
 * ~400,000 pairs and a report nobody can read, while adding almost nothing:
 * the twelfth constraint separating two speakers catches the same merge as the
 * first. Spreading the sample evenly across the recording is what actually adds
 * information, because a merge that only happens in the last ten minutes is
 * invisible to a sample drawn from the first two.
 */
export function ownerLandmarks(
  recording: Landmark['recording'],
  options: { perSpeaker?: number; file?: StoredFile } = {},
): Landmark[] {
  const perSpeaker = options.perSpeaker ?? 12;
  const rulings = latestSpeakerRulings(recording, options.file ?? readCorrectionsFile());

  const bySpeaker = new Map<string, StoredCorrection[]>();
  for (const ruling of rulings) {
    const key = landmarkIdentity(ruling);
    if (!key) continue;
    bySpeaker.set(key, [...(bySpeaker.get(key) ?? []), ruling]);
  }

  const chosen: StoredCorrection[] = [];
  for (const group of bySpeaker.values()) {
    if (group.length <= perSpeaker) {
      chosen.push(...group);
      continue;
    }
    const step = (group.length - 1) / (perSpeaker - 1);
    for (let i = 0; i < perSpeaker; i += 1) chosen.push(group[Math.round(i * step)]);
  }

  return chosen
    .sort((a, b) => a.at_ms - b.at_ms)
    .map((correction) => ({
      recording,
      at_ms: correction.at_ms,
      end_ms: correction.end_ms,
      quote: (correction.text ?? correction.original_text).slice(0, 90),
      person: landmarkIdentity(correction)!,
      why:
        `the owner attributed this line to ${correction.speaker!.name} on the review page on `
        + `${correction.created_at.slice(0, 10)}, having listened to the span. The pipeline had it as `
        + `${correction.original_speaker_name ?? 'an unnamed voice'}`
        + (correction.conflicts_with?.length
          ? '. CONTESTED: he recorded this knowing it contradicted an earlier ruling of his, so both are in the log and neither has been resolved'
          : ''),
    }));
}

/** Text the owner rewrote: the transcription reference, not a diarization one. */
export function ownerTranscriptFixes(
  recording: string,
  file = readCorrectionsFile(),
): { utterance_id: string; at_ms: number; end_ms: number; was: string; is: string }[] {
  const byUtterance = new Map<string, StoredCorrection>();
  for (const correction of file.corrections ?? []) {
    if (correction.recording !== recording) continue;
    if (!correction.asserts.includes('text') || correction.text === undefined) continue;
    const previous = byUtterance.get(correction.utterance_id);
    if (!previous || previous.created_at <= correction.created_at) byUtterance.set(correction.utterance_id, correction);
  }
  return [...byUtterance.values()]
    .filter((correction) => correction.text!.trim() !== correction.original_text.trim())
    .sort((a, b) => a.at_ms - b.at_ms)
    .map((correction) => ({
      utterance_id: correction.utterance_id,
      at_ms: correction.at_ms,
      end_ms: correction.end_ms,
      was: correction.original_text,
      is: correction.text!,
    }));
}

export interface CorrectionConflict {
  landmark: Landmark;
  correction: StoredCorrection;
  detail: string;
}

/**
 * Where a correction disagrees with a landmark already in `landmarks.ts`.
 *
 * Reported, never resolved. A landmark in that file was reasoned from what the
 * line says; a correction was reasoned from having been in the room. When they
 * disagree one of them is wrong, and picking a winner automatically is exactly
 * how a wrong premise survives for hours.
 */
export function conflictsWithLandmarks(
  recording: Landmark['recording'],
  file = readCorrectionsFile(),
): CorrectionConflict[] {
  const conflicts: CorrectionConflict[] = [];
  const existing = LANDMARKS.filter((landmark) => landmark.recording === recording);
  for (const correction of latestSpeakerRulings(recording, file)) {
    const claimed = landmarkIdentity(correction);
    // A confirmation that leaves the speaker as an unnamed voice disagrees with
    // nothing: it is silent about the name, not in conflict with it.
    if (!claimed || claimed === correction.speaker?.person_id?.toLowerCase()) continue;
    for (const landmark of existing) {
      const overlap = Math.min(landmark.end_ms, correction.end_ms) - Math.max(landmark.at_ms, correction.at_ms);
      if (overlap <= 0) continue;
      if (landmark.person && landmark.person.toLowerCase() !== claimed) {
        conflicts.push({
          landmark,
          correction,
          detail: `landmark says ${landmark.person}, the owner's correction says ${correction.speaker!.name}`,
        });
      }
      if (landmark.notPerson && landmark.notPerson.toLowerCase() === claimed) {
        conflicts.push({
          landmark,
          correction,
          detail: `landmark says NOT ${landmark.notPerson}, the owner's correction says ${correction.speaker!.name}`,
        });
      }
    }
  }
  return conflicts;
}

/**
 * The handwritten landmarks and the generated ones, checked together.
 *
 * `checkLandmarks` filters the module-level `LANDMARKS` and cannot be given a
 * different set, and `eval/landmarks.ts` is not edited by hand — so the merged
 * check lives here. Folding it back would be a one-line signature change to
 * `checkLandmarks(recording, segments, landmarks = LANDMARKS)`, which is worth
 * doing the next time that file is open for another reason.
 *
 * Checking them together is the point. A generated landmark and a handwritten
 * one that disagree produce a constraint the system cannot satisfy either way,
 * and that is a question for the owner, not a score.
 */
export function mergedLandmarks(recording: Landmark['recording'], file = readCorrectionsFile()): Landmark[] {
  // `landmarks.ts` is inconsistent about case — 'volva' on one recording,
  // 'Joshua' on the other — and the pairwise check compares these strings
  // literally, so mixing the two sets without folding case invents splits.
  const handwritten = LANDMARKS.filter((landmark) => landmark.recording === recording).map((landmark) => ({
    ...landmark,
    ...(landmark.person ? { person: landmark.person.toLowerCase() } : {}),
    ...(landmark.notPerson ? { notPerson: landmark.notPerson.toLowerCase() } : {}),
  }));
  return [
    ...handwritten,
    ...ownerLandmarks(recording, { file }),
    ...splitLandmarks(recording, file),
    ...identityLandmarks(recording, openQuestions(recording), file),
  ];
}

export function formatOwnerCorrections(
  recording: Landmark['recording'],
  system?: AttributedSegment[],
): string {
  if (!hasCorrections()) return '  owner corrections      none on this machine (eval/real/corrections.json is absent)';
  const file = readCorrectionsFile();
  const rulings = latestSpeakerRulings(recording, file);
  const generated = ownerLandmarks(recording, { file });
  const fixes = ownerTranscriptFixes(recording, file);
  const conflicts = conflictsWithLandmarks(recording, file);
  const contested = contestedCorrections(file).filter((correction) => correction.recording === recording);
  const splits = liveSplits(recording, file);
  const claims = ownerBoundaries(recording, file);
  const answers = liveAnswers(recording, file);
  const seconds = resolvedSeconds(recording, file);

  const lines = [
    `  owner corrections      ${rulings.length} speaker rulings -> ${generated.length} generated landmarks, `
      + `${fixes.length} transcript fixes`,
  ];

  if (answers.length > 0) {
    const unsure = answers.filter((answer) => answer.answer === 'unsure').length;
    lines.push(
      `  voice questions        ${answers.length - unsure} answered, anchored to audio spans`
        + ` (worth roughly ${Math.round(seconds)}s, estimated from a retired clustering)`
        + (unsure > 0 ? `, ${unsure} left unresolved on purpose` : ''),
    );
  }

  if (claims.length > 0) {
    if (system) {
      const report = scoreBoundaries(claims, system);
      lines.push(
        `  missed boundaries      ${report.total - report.found}/${report.total} speaker changes the owner heard `
          + `and the system did not (${splits.length} split lines, ${report.collarMs}ms collar)`,
      );
      for (const miss of report.missed) {
        lines.push(
          `    MISSED   ${(miss.from_ms / 1000).toFixed(2)}-${(miss.to_ms / 1000).toFixed(2)}s `
            + `${miss.before} -> ${miss.after}  "${miss.quote}"`,
        );
      }
    } else {
      lines.push(`  missed boundaries      ${claims.length} boundary claims from ${splits.length} split lines, unscored`);
    }
  }

  for (const conflict of conflicts) {
    lines.push(`    CONFLICT  "${conflict.landmark.quote.slice(0, 34)}" ${conflict.detail}`);
  }
  for (const correction of contested) {
    lines.push(`    CONTESTED "${correction.original_text.slice(0, 34)}" recorded against a landmark; both kept`);
  }
  return lines.join('\n');
}

/**
 * "The speaker changed here, and you did not notice."
 *
 * This is a distinct kind of constraint on purpose, not a pair of per-line
 * landmarks. A landmark asks *who spoke this span*, and any labelling that gets
 * the name right satisfies it — including a single turn spread across two
 * people, as long as the name happens to match at the midpoint. A boundary
 * claim asks *did you segment here at all*, which that same output fails. The
 * two also have different cures: one is an attribution problem, the other is a
 * segmentation problem, and flattening them into one number hides which you
 * have.
 *
 * It is worth measuring because the pipeline provably cannot produce it. On the
 * line that prompted this, pyannote emits `18.22-24.38 SPEAKER_04` as one turn
 * and all eight local-segmentation windows over the boundary report continuous
 * speech. Every boundary in here is therefore ground truth that exists nowhere
 * else, and a missed-boundary count is a measurement this repository currently
 * cannot make at all.
 */
export interface BoundaryClaim {
  recording: string;
  utterance_id: string;
  /** The change is somewhere in this silence. The audio does not say where. */
  from_ms: number;
  to_ms: number;
  before: string;
  after: string;
  /** The words either side, for a report a human can read. */
  quote: string;
}

export function ownerBoundaries(recording: string, file = readCorrectionsFile()): BoundaryClaim[] {
  const claims: BoundaryClaim[] = [];
  for (const split of liveSplits(recording, file)) {
    for (let i = 1; i < split.parts.length; i += 1) {
      const before = split.parts[i - 1];
      const after = split.parts[i];
      const gap = split.boundaries[i - 1] ?? { from_ms: before.end_ms, to_ms: after.start_ms };
      claims.push({
        recording,
        utterance_id: split.utterance_id,
        from_ms: Math.min(gap.from_ms, gap.to_ms),
        to_ms: Math.max(gap.from_ms, gap.to_ms),
        before: before.speaker.name.toLowerCase(),
        after: after.speaker.name.toLowerCase(),
        quote: `${before.text.slice(-30)} | ${after.text.slice(0, 30)}`,
      });
    }
  }
  return claims;
}

export interface BoundaryReport {
  total: number;
  found: number;
  missed: BoundaryClaim[];
  collarMs: number;
}

/**
 * Did the system put a turn boundary where the owner heard one?
 *
 * A system boundary is any point where consecutive segments change speaker, and
 * also the edges of a gap in coverage. The claim is satisfied if one lands
 * inside the silence the owner cut in, widened by a collar — the same
 * tolerance idea the rest of the harness uses, because the exact instant of a
 * speaker change is not knowable and scoring to the millisecond would measure
 * nothing but jitter.
 */
export function scoreBoundaries(
  claims: BoundaryClaim[],
  system: AttributedSegment[],
  collarMs = 250,
): BoundaryReport {
  const ordered = [...system].sort((a, b) => a.start_ms - b.start_ms);
  const boundaries: number[] = [];
  for (let i = 1; i < ordered.length; i += 1) {
    if (ordered[i].speaker !== ordered[i - 1].speaker) {
      boundaries.push(ordered[i - 1].end_ms, ordered[i].start_ms);
    }
  }

  const missed = claims.filter(
    (claim) => !boundaries.some((at) => at >= claim.from_ms - collarMs && at <= claim.to_ms + collarMs),
  );
  return { total: claims.length, found: claims.length - missed.length, missed, collarMs };
}

/** Split parts are ordinary speaker claims too, so they join the span reference. */
export function splitSpans(recording: string, file = readCorrectionsFile()): Span[] {
  const spans: Span[] = [];
  for (const split of liveSplits(recording, file)) {
    for (const part of split.parts) {
      const name = part.speaker.name.trim();
      const speaker = UNNAMED.test(name) ? part.speaker.person_id?.toLowerCase() : name.toLowerCase();
      if (speaker) spans.push({ speaker, start_ms: part.start_ms, end_ms: part.end_ms });
    }
  }
  return spans;
}

/** …and landmarks, so the pairwise merge check sees them. */
export function splitLandmarks(recording: Landmark['recording'], file = readCorrectionsFile()): Landmark[] {
  const landmarks: Landmark[] = [];
  for (const split of liveSplits(recording, file)) {
    for (const part of split.parts) {
      const name = part.speaker.name.trim();
      const person = UNNAMED.test(name) ? part.speaker.person_id?.toLowerCase() : name.toLowerCase();
      if (!person) continue;
      landmarks.push({
        recording,
        at_ms: part.start_ms,
        end_ms: part.end_ms,
        quote: part.text.slice(0, 90),
        person,
        why:
          `the owner cut "${split.original_text.slice(0, 40)}" into ${split.parts.length} parts on the review `
          + `page and gave this one to ${part.speaker.name}. Diarization delivered the whole line as one turn, `
          + 'so this part has no counterpart in the system output at all',
      });
    }
  }
  return landmarks;
}

/**
 * A same-or-different answer, as a constraint the harness already understands.
 *
 * These are the strongest evidence on the page per second of his attention. One
 * answer settles whether a 457-second cluster is one person or two, and three
 * of the eight diarizer labels — 65% of all speech — currently carry no
 * constraint at all.
 *
 * They become landmark pairs rather than a new mechanism, because
 * `checkLandmarks` already derives "expect same" / "expect different" from
 * whether two landmarks name the same person. Answering `same` gives both
 * sides one synthetic identity; answering `different` gives them two. The
 * identities are synthetic on purpose: he is telling us these voices are or are
 * not the same person, not what that person is called, and inventing a name
 * would be putting words in his mouth.
 *
 * `unsure` yields nothing. On a cluster the builder marked impure that is an
 * honest answer, and turning it into a constraint would be manufacturing the
 * exact thing this file exists to avoid.
 */
interface AnswerSpan {
  start_ms: number;
  end_ms: number;
}

interface StoredIdentityAnswer {
  question_id: string;
  recording: string;
  /**
   * Provenance only, never the key to anything.
   *
   * `0:E` and `950:E` are chunk-scoped cluster names from the retired provider;
   * the product now emits global SPEAKER_00..07. His answer is a fact about two
   * stretches of audio and survives that change. Anything keyed to these names
   * does not.
   */
  label_a: string;
  label_b: string;
  /** The two stretches he actually compared. This is the durable anchor. */
  compared?: { a: AnswerSpan; b: AnswerSpan };
  answer: 'same' | 'different' | 'unsure';
  /** Derived from the retired clustering's span assignment: an estimate. */
  worth_seconds: number;
  created_at: string;
}

interface QuestionClips {
  id: string;
  label_a: string;
  label_b: string;
  clips_a: { start_ms: number; end_ms: number }[];
  clips_b: { start_ms: number; end_ms: number }[];
}

export function liveAnswers(recording: string, file = readCorrectionsFile()): StoredIdentityAnswer[] {
  const live = new Map<string, StoredIdentityAnswer>();
  const answers = ((file as { identity_answers?: StoredIdentityAnswer[] }).identity_answers ?? [])
    .filter((answer) => answer.recording === recording)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  for (const answer of answers) live.set(answer.question_id, answer);
  return [...live.values()];
}

/**
 * Roughly how much speech his answers take out of the dark.
 *
 * An estimate and not a measurement: `worth_seconds` comes from the retired
 * clustering's span assignment, which is the same clustering whose impurity put
 * these questions in the set. Useful for deciding what to answer next, wrong to
 * quote as a result.
 */
export function resolvedSeconds(recording: string, file = readCorrectionsFile()): number {
  return liveAnswers(recording, file)
    .filter((answer) => answer.answer !== 'unsure')
    .reduce((total, answer) => total + answer.worth_seconds, 0);
}

/**
 * One identity per stretch of audio, derived from every answer at once.
 *
 * Keyed on time, never on cluster names. `0:E` and `950:E` are chunk-scoped
 * labels from the retired provider and the product now emits global
 * SPEAKER_00..07; a constraint keyed to those names rots the moment anything
 * upstream is regenerated, and his answers would silently disappear with them.
 * "The voice at 819.8s is the voice at 1696.1s" is a fact about the recording
 * and stays true whatever the clusterer calls them.
 *
 * Union-find over the `same` answers, exactly as before — only the key changed.
 * `different` answers leave the components apart, which is already what the
 * pairwise check reads as "expect different".
 */
function spanKey(span: AnswerSpan): string {
  return `${span.start_ms}:${span.end_ms}`;
}

function spanIdentities(answers: StoredIdentityAnswer[]): Map<string, string> {
  const parent = new Map<string, string>();
  const find = (key: string): string => {
    if (!parent.has(key)) parent.set(key, key);
    let root = parent.get(key)!;
    while (root !== parent.get(root)) root = parent.get(root)!;
    parent.set(key, root);
    return root;
  };
  for (const answer of answers) {
    if (!answer.compared) continue;
    const a = spanKey(answer.compared.a);
    const b = spanKey(answer.compared.b);
    find(a);
    find(b);
    if (answer.answer === 'same') parent.set(find(a), find(b));
  }

  const members = new Map<string, string[]>();
  for (const key of parent.keys()) {
    const root = find(key);
    members.set(root, [...(members.get(root) ?? []), key]);
  }
  const identity = new Map<string, string>();
  for (const group of members.values()) {
    const sorted = [...group].sort();
    // Named by the earliest moment the voice is heard, so the name means
    // something to a human reading a report and nothing to a clusterer.
    const name = `voice@${(Number(sorted[0].split(':')[0]) / 1000).toFixed(1)}s`;
    for (const key of sorted) identity.set(key, name);
  }
  return identity;
}

export function identityLandmarks(
  recording: Landmark['recording'],
  _questions: QuestionClips[] = [],
  file = readCorrectionsFile(),
): Landmark[] {
  const answers = liveAnswers(recording, file).filter(
    (answer) => answer.answer !== 'unsure' && answer.compared,
  );
  if (answers.length === 0) return [];
  const identity = spanIdentities(answers);

  // Exactly the two stretches he was played, and no more.
  //
  // Each question offers three clips a side, and it is tempting to constrain
  // all six. That would import a claim he never made: the three clips on one
  // side are one voice only according to the retired clustering, and these
  // particular clusters are in the question set BECAUSE that clustering marked
  // them impure. Grouping them would answer the very thing being asked.
  const seen = new Set<string>();
  const landmarks: Landmark[] = [];
  for (const answer of answers) {
    for (const span of [answer.compared!.a, answer.compared!.b]) {
      const key = spanKey(span);
      if (seen.has(key)) continue;
      seen.add(key);
      const person = identity.get(key);
      if (!person) continue;
      landmarks.push({
        recording,
        at_ms: span.start_ms,
        end_ms: span.end_ms,
        quote: `the voice at ${(span.start_ms / 1000).toFixed(1)}s`,
        person,
        why:
          `the owner played ${(answer.compared!.a.start_ms / 1000).toFixed(1)}s and `
          + `${(answer.compared!.b.start_ms / 1000).toFixed(1)}s back to back on the review page and said they are `
          + `${answer.answer === 'same' ? 'the same person' : 'different people'}. `
          + 'Anchored to those two stretches of audio, not to a cluster id: the question came from '
          + `labels ${answer.label_a}/${answer.label_b}, which belong to a retired chunk-scoped scheme, `
          + 'while the judgement is about the recording and outlives it',
      });
    }
  }
  return landmarks;
}

