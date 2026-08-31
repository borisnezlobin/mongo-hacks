export const OWNER_ID = 'owner';
/**
 * Speaker-identification calibration.
 *
 * MEASURED, not guessed. The previous values were tuned against a synthetic
 * TTS fixture where within-speaker cosine bottomed at 0.758 and cross-speaker
 * peaked at 0.259. Real far-field room audio is nothing like that. Measured on
 * fixtures/real/dorm-9pm.wav (3 speakers, 3 minutes, phone on a desk), with
 * speaker-homogeneous segments from provider diarization:
 *
 *   per-segment ECAPA cosine   same-speaker mean 0.329, cross-speaker mean 0.162
 *                              equal-error rate ~27%  <- unusable per turn
 *
 * Pooling is what rescues it. Identifying a speaker from pooled speech against
 * a centroid enrolled from a disjoint half of the recording:
 *
 *   2-6s pooled    65-75% correct   <- a coin flip wearing a name tag
 *   8s  pooled     88%
 *   20s pooled     100%
 *
 * So: never claim an identity from a single turn, and never claim one below
 * PROVISIONAL_SPEECH_MS. Re-measure with `bun run eval:speakers` after changing
 * the microphone, the room, or the embedding model — these numbers are a
 * property of the recording conditions, not of the code.
 */

/**
 * Speech below this is not embedded for identification at all.
 *
 * This gates a speaker's POOLED speech in a session, not an individual turn —
 * see session.ts, which sums speechMsFor(speaker) before embedding. A speaker
 * with thirty sub-second turns totalling 25s clears it comfortably; it only
 * excludes someone whose entire contribution to a session is under 3s. Short
 * turns are not discarded for identification, they inherit their cluster's
 * identity, so what misfiles them is the cluster being wrong rather than this.
 * Worth stating because 80% of turns in every real recording here are under
 * three seconds, and reading this as a per-turn gate makes it look like the
 * cause of a problem it has nothing to do with.
 */
export const EMBED_MIN_MS = 3_000;

/**
 * Pooled speech required before we will show a name at all, hedged. Around
 * this point accuracy crosses ~88%, which is worth showing as a guess but not
 * as a fact.
 */
export const PROVISIONAL_SPEECH_MS = 8_000;
// Defensible within a session and useless across one: at 8s of pooled speech,
// 97.5% of genuine cross-recording links fall below ATTRIBUTION_THRESHOLD and
// no threshold separates the distributions at all. Never link sessions on this.

/**
 * Pooled speech required before an identification is treated as settled and
 * allowed to reinforce the person's voiceprint set. Measured 100% at 20s.
 *
 * That 100% was measured WITHIN one recording — enrolling from one half of a
 * session and testing on the other, where both sides share a room, a
 * microphone and a gain setting. It does not transfer to recognising the same
 * person in a different conversation; for that, see CROSS_SESSION_SPEECH_MS.
 */
export const CONFIRMED_SPEECH_MS = 20_000;

/**
 * Pooled speech required before a voice is worth STORING as a voiceprint.
 *
 * Recognising someone across conversations is a harder problem than
 * recognising them within one, and the gap is large. Measured over 1,620
 * cross-recording trials on four real conversations (eval/real/model_transfer.py),
 * same-person against different-person cosine on pooled models:
 *
 *   pooled per side   same person (p5 / median)   different people (max)   missed at 0.68
 *      8s                 0.325 / 0.541                  0.513                97.5%
 *     20s                 0.587 / 0.712                  0.621                32.7%
 *     60s                 0.781 / 0.764 min              0.627                 0.0%
 *
 * No two different people ever reached 0.68 at any pool size — the observed
 * error is always a MISS, never a false link.
 *
 * Crucially the failure is ASYMMETRIC, and that decides where the gate belongs.
 * Miss rate at 0.68, enrolled print against query cluster:
 *
 *                    query 20s   query 60s   query 120s
 *   enrolled  20s      18-33%       1.7%        1.7%
 *   enrolled  60s        1.7%       0.0%        0.0%
 *   enrolled 120s        1.7%       0.0%        0.0%
 *
 * A print backed by a minute recognises a 20s cluster almost perfectly. Only
 * thin-against-thin fails. So this is a floor on what we WRITE, not on what we
 * are willing to match — a weak print is the thing that generates a duplicate
 * next session, and declining to store one is better than storing it.
 *
 * Better, but not unconditionally: this gate must never apply to somebody who
 * has NO print yet. A thin print misses 18-33% against another thin cluster;
 * no print misses 100% and guarantees the duplicate the gate exists to prevent.
 * The rule is "do not add a weak print to a person already known", not "do not
 * record this person".
 *
 * It must NOT be used to gate creating a person: measured over the 21 clusters
 * in four real conversations, a 60s mint floor strands a third of voices
 * permanently, and every speaker in a three-minute conversation fails to clear
 * it — that session would end with nobody identified. Minting stays at
 * CONFIRMED_SPEECH_MS, which is the right bar for filing facts within a session.
 *
 * Re-measure after changing the microphone, the room, or the embedding model.
 */
export const CROSS_SESSION_SPEECH_MS = 60_000;

/**
 * Cosine floor for a match, on RAW pooled embeddings.
 *
 * Measured over 2,400 trials on fixtures/real/dorm-9pm.wav, enrolling from one
 * half of the recording and testing on the other, at 20s of pooled speech:
 *
 *   same speaker      mean 0.781, 5th percentile 0.746
 *   different speaker mean 0.422, 95th percentile 0.626, max 0.639
 *
 * There is a clean gap between 0.639 and 0.746, and 0.68 sits in it: zero false
 * accepts and zero misses. The impostor trials deliberately include a speaker
 * who was never enrolled, because in this product most voices are strangers.
 *
 * Note this is RAW cosine, not session-mean-subtracted. Centering was tried
 * first and is wrong as the gate: with only a handful of enrolled people the
 * session mean is dominated by those people rather than by the room, so
 * subtracting it makes their centered prints near-antipodal and collapses the
 * comparison onto a single axis. Every voice then scores strongly as either one
 * person or the other, and "nobody I know" stops being expressible — a stranger
 * scored 0.499 against a friend on that axis. Absolute distance is exactly what
 * rejecting a stranger requires, so the gate keeps it. session_mean is still
 * recorded on every print; it is useful for telling enrolled people apart once
 * there are enough of them, and for re-deriving a channel estimate later.
 */
export const ATTRIBUTION_THRESHOLD = 0.68;

/**
 * The best candidate must beat the runner-up by this much. Two people who
 * score 0.71 and 0.70 are not an identification, they are a guess between two
 * roommates, and the cost of getting it wrong is a fact filed under the wrong
 * person forever.
 */
export const ATTRIBUTION_MARGIN = 0.05;

/** Amelia acts on the owner's voice, so it is held to a stricter bar. */
export const OWNER_AUTH_THRESHOLD = 0.72;

/** Cosine below which two turns in ONE session are different speakers. */
export const SESSION_LINK_THRESHOLD = 0.25;

/**
 * Voiceprints kept per person. Each session that confirms someone contributes
 * one, so a person recorded in a lecture hall, a dorm, and a cafe accumulates
 * prints for all three and is matched against the closest. Oldest is evicted.
 */
export const MAX_VOICEPRINTS_PER_PERSON = 12;

export type IdentityConfidence = 'pending' | 'provisional' | 'confirmed';

/** Below this a name overheard in conversation is not worth proposing. */
export const NAME_SUGGESTION_MIN_CONFIDENCE = 0.5;

export const TONIGHT_DEFAULT_HOUR = 21;
/*
 * FAST_PASS_LOOKBACK_TURNS and SLOW_PASS_EVERY_N_UTTERANCES were removed.
 *
 * Both counted turns, and a turn is not a unit of information: eight turns of
 * "yeah" is not eight turns of anything. Measured on a real 48-minute
 * conversation, 96% of eight-turn spans were under twenty seconds and the
 * median held 147 characters across three speakers — far too little context to
 * see a fact that a person states across a few sentences. The extraction
 * window now flushes on accumulated content and elapsed time instead; see
 * server/memory/window.ts, where the thresholds carry their evidence.
 */
export const AMELIA_MAX_TOOL_CALLS = 5;
export const SSE_DEBOUNCE_MS = 200;
/**
 * Inference runs on Fireworks (OpenAI-compatible endpoints) for both extraction
 * and embeddings. EMBEDDING_DIMS is baked into the applied Atlas vector index —
 * verify it against the live model with `npx tsx db/probe-embeddings.ts` before
 * applying indexes, because the three-index cap means there is no second try.
 */
export const EXTRACTION_MODEL = 'accounts/fireworks/models/gpt-oss-120b';
export const EMBEDDING_MODEL = 'nomic-ai/nomic-embed-text-v1.5';
export const EMBEDDING_DIMS = 768;
export const VOICEPRINT_DIMS = 192;

export type Id = string;
export type Timestamp = string;

export interface Person {
  _id: Id;
  owner_id: Id;
  name: string;
  relationship?: string;
  is_owner?: boolean;
  /**
   * A voice we can tell apart but cannot put a name to yet.
   *
   * Explicit rather than inferred. The app used to decide this by regex-testing
   * the display name against /^(unknown|unnamed|speaker)/i, which quietly means
   * anyone actually called "Unknown" can never be treated as named.
   */
  is_unnamed?: boolean;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface Voiceprint {
  _id: Id;
  owner_id: Id;
  person_id: Id;
  /** Raw L2-normalised ECAPA embedding, exactly as the sidecar returned it. */
  embedding: number[];
  /**
   * Mean of every embedding in the session this print was captured in.
   *
   * Recorded, but NOT how prints are compared. Matching uses raw cosine — see
   * ATTRIBUTION_THRESHOLD for the measurement and for why centering on this
   * mean was tried and rejected. It is kept because it is the only surviving
   * estimate of the room and microphone a print was captured in, which a proper
   * channel model would need, and because once enough people are enrolled it is
   * useful for telling *known* people apart. Absent on older prints.
   */
  session_mean?: number[];
  /** Pooled speech behind this print. More is better; see CONFIRMED_SPEECH_MS. */
  duration_ms: number;
  /**
   * The user created this print deliberately — an explicit enrollment, or the
   * print captured when they tapped to name a voice. It is the only kind we
   * know to be correct, so eviction never touches it.
   */
  enrolled?: boolean;
  source_utterance_id?: Id;
  source_conversation_id?: Id;
  created_at: Timestamp;
}

export interface Conversation {
  _id: Id;
  owner_id: Id;
  started_at: Timestamp;
  ended_at?: Timestamp;
  title?: string;
  participant_ids: Id[];
}

export interface Utterance {
  _id: Id;
  owner_id: Id;
  conversation_id: Id;
  person_id?: Id;
  /**
   * How much the `person_id` on this turn is worth.
   *
   * Extraction refuses to file a fact against anyone below 'confirmed'. Without
   * this it could only see whether a speaker had a name, so a provisional guess
   * — which real audio produces constantly — was indistinguishable from a
   * settled identity, and the contract's rule that provisional identities must
   * not be used to file facts was unenforceable in the one place it mattered.
   */
  identity_confidence?: IdentityConfidence;
  voiceprint_id?: Id;
  text: string;
  start_ms: number;
  end_ms: number;
  is_final: boolean;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface Fact {
  _id: Id;
  owner_id: Id;
  person_id: Id;
  attribute: string;
  claim: string;
  claim_normalized: string;
  primary_source_utterance_id: Id;
  embedding?: number[];
  valid_from: Timestamp;
  superseded_at?: Timestamp;
  superseded_by?: Id;
  created_at: Timestamp;
}

export interface PromiseMemory {
  _id: Id;
  owner_id: Id;
  person_id: Id;
  source_utterance_id: Id;
  text: string;
  text_normalized: string;
  due_at?: Timestamp;
  /** The speaker's own wording ("tonight"), kept beside the resolved ISO date. */
  due_phrase?: string;
  embedding?: number[];
  status: 'open' | 'done' | 'cancelled';
  created_at: Timestamp;
}

export interface Reminder {
  _id: Id;
  owner_id: Id;
  promise_id: Id;
  fire_at: Timestamp;
  status: 'scheduled' | 'sent' | 'cancelled';
  created_at: Timestamp;
}

export interface UtteranceEvent {
  type: 'utterance';
  utterance_id: Id;
  conversation_id: Id;
  person_id?: Id;
  /** See Utterance.identity_confidence — facts are only filed on 'confirmed'. */
  identity_confidence?: IdentityConfidence;
  voiceprint_id?: Id;
  text: string;
  start_ms: number;
  end_ms: number;
  is_final: boolean;
  /**
   * This line is gone: drop it from the transcript rather than revising it.
   *
   * The final pass rebuilds the transcript from a whole-file transcription and
   * a whole-file diarization, and carries the live pass's utterance ids across
   * by time overlap. Most lines revise. A few have no counterpart at all —
   * live-pass fragments that the coherent transcript simply does not contain —
   * and without a way to say so they would sit under the corrected transcript
   * holding text nobody said and a name nobody agreed to.
   *
   * Only ever set alongside empty text, and never for a line the correction
   * merely reworded.
   */
  superseded?: boolean;
}

export interface IdentityEvent {
  type: 'identity';
  conversation_id: Id;
  person_id: Id;
  voiceprint_id?: Id;
  name: string;
  utterance_ids: Id[];
  /**
   * How much this claim is worth. 'provisional' must be rendered as a guess
   * ("probably Tarun"), never as a plain name, and must not be used to file
   * facts or promises against the person.
   */
  confidence: IdentityConfidence;
  /** Margin-checked cosine behind the claim, for the trace and for debugging. */
  score?: number;
}

/**
 * Emitted the moment a speaker cluster is recognised as somebody, before we
 * know who. The UI shows "Attributing…" against these utterances rather than
 * "Unknown speaker", because attribution is asynchronous by design: text must
 * never wait on identity. A later IdentityEvent for the same utterance_ids
 * replaces it.
 */
export interface SpeakerPendingEvent {
  type: 'speaker_pending';
  conversation_id: Id;
  session_speaker: Id;
  utterance_ids: Id[];
  /** Speech pooled for this cluster so far. */
  speech_ms: number;
  /** Speech needed before any name is offered, so the UI can show progress. */
  provisional_speech_ms: number;
  /** Why we have not named them: still listening, or listened and unsure. */
  reason: 'gathering' | 'no_match' | 'ambiguous';
}

/**
 * A conversation gained a title, or ended. Emitted when recording stops and the
 * transcript has been named, so an open list updates without a reload.
 */
export interface ConversationEvent {
  type: 'conversation';
  conversation_id: Id;
  title?: string;
  ended_at?: Timestamp;
  /**
   * Recording outran the retained-audio cap, so the speaker-correction pass
   * could not see the end of the conversation.
   *
   * The transcript text is unaffected — only attribution past `covered_to_ms`
   * is less certain. This is surfaced because the alternative is a transcript
   * that is quietly worse at the end with nothing to say so, and the recordings
   * long enough to hit a cap are the ones most worth trusting.
   */
  audio_truncated?: boolean;
  /** How far into the conversation the correction pass could actually see. */
  covered_to_ms?: number;
}

export interface FactEvent {
  type: 'fact';
  fact_id: Id;
  person_id: Id;
  attribute: string;
  claim: string;
  superseded_fact_id?: Id;
}

export interface PromiseEvent {
  type: 'promise';
  promise_id: Id;
  person_id: Id;
  text: string;
  due_at?: Timestamp;
  status: PromiseMemory['status'];
}

export interface AmeliaStepEvent {
  type: 'amelia_step';
  request_id: Id;
  step: 'wake' | 'authorize' | 'search' | 'reason' | 'act' | 'reply' | 'denied' | 'error';
  message: string;
}

export interface AmeliaAudioEvent {
  type: 'amelia_audio';
  request_id: Id;
  text: string;
  audio_url?: string;
  mime_type?: string;
}

/**
 * A name for an unnamed voice, overheard in the conversation itself.
 *
 * People say each other's names constantly — "Also Josh, tomorrow…", "I'm
 * Tarun" — and that is by far the cheapest enrollment signal available. This
 * proposes; it never renames anybody on its own. The user confirms with one
 * tap, and only then does the voice become a named person.
 */
export interface NameSuggestionEvent {
  type: 'name_suggestion';
  conversation_id: Id;
  /** The session cluster this name is proposed for, or a known person. */
  session_speaker?: Id;
  person_id?: Id;
  name: string;
  /** 0-1. Below NAME_SUGGESTION_MIN_CONFIDENCE it is not shown. */
  confidence: number;
  /** The exact words that produced the suggestion, so the user can judge it. */
  evidence: string;
  evidence_utterance_id?: Id;
  kind: 'vocative' | 'self_introduction' | 'third_person_reference';
}

/** Re-emitting an event with the same utterance_id replaces the earlier revision. */
export type AmeliaEvent =
  | UtteranceEvent
  | IdentityEvent
  | SpeakerPendingEvent
  | NameSuggestionEvent
  | ConversationEvent
  | FactEvent
  | PromiseEvent
  | AmeliaStepEvent
  | AmeliaAudioEvent;

export type BusEventName = AmeliaEvent['type'];

export interface StreamHandshake {
  conversation_id: Id;
}

/** Binary websocket frames are float32 PCM, 16 kHz mono, 100 ms: 1,600 samples / 6,400 bytes. */
export const AUDIO_FRAME_SAMPLES = 1_600;
export const AUDIO_FRAME_BYTES = 6_400;

export interface SearchMemoryResult {
  kind: 'fact' | 'promise' | 'utterance';
  id: Id;
  person_id?: Id;
  text: string;
  score: number;
  source_utterance_id?: Id;
}

export interface MemoryApi {
  searchMemory(query: string, personId?: Id): Promise<SearchMemoryResult[]>;
  getPerson(id: Id): Promise<Person | null>;
  resolveFactState(personId: Id, attribute: string): Promise<Fact | null>;
  createReminder(promiseId: Id, fireAt: Timestamp): Promise<Reminder>;
  addNote(personId: Id, text: string): Promise<Fact>;
  /**
   * Set the current value of one attribute, superseding whatever it was.
   *
   * The write goes through the same append-only path extraction uses, so a
   * value corrected out loud keeps its history exactly like one lifted from a
   * turn — `resolve_fact_state` still answers with the current claim, and the
   * old one is still reachable behind `superseded_by`. A second way to write
   * facts would be a second thing to keep consistent with supersession, and
   * the first thing to forget.
   *
   * Saying something already true is a no-op rather than a fact superseding
   * itself.
   */
  setFact(personId: Id, attribute: string, claim: string): Promise<Fact>;
  /**
   * Name a person, or correct the name they already have.
   *
   * Names are not facts: `Person.name` is what every screen renders and what
   * the identity lane re-files past utterances under, so it is a field rather
   * than a supersession chain. Returns null when the person is gone.
   */
  namePerson(personId: Id, name: string, relationship?: string): Promise<Person | null>;
}

export interface AudioUplink {
  state: 'idle' | 'connecting' | 'streaming' | 'error';
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface ServerDependencies {
  bus: {
    emit(event: AmeliaEvent): void;
    subscribe(listener: (event: AmeliaEvent) => void): () => void;
  };
  memory: MemoryApi;
}

export interface MergePeopleRequest {
  person_ids: Id[];
}

export interface NamePersonRequest {
  name: string;
  relationship?: string;
}

export interface AskRequest {
  query: string;
  person_id?: Id;
  conversation_id?: Id;
  requester_voiceprint_id?: Id;
}

export interface AskResponse {
  request_id: Id;
  text: string;
  authorized: boolean;
  citations: SearchMemoryResult[];
  audio_url?: string;
}

export interface EnrollVoiceRequest {
  person_id?: Id;
  name?: string;
  utterance_id?: Id;
  duration_ms: number;
  embedding?: number[];
}

export interface EnrollVoiceResponse {
  person: Person;
  voiceprint: Omit<Voiceprint, 'embedding'>;
}

export interface ConversationSummary {
  conversation: Conversation;
  utterances: Utterance[];
  participants: Person[];
}

/**
 * Every HTTP surface the app may rely on.
 *
 * This drifted badly: `POST /promises/:id/status` has existed in
 * server/memory/index.ts the whole time but was missing here, so a reader
 * working from the contract concluded closing a loop had no server endpoint
 * and left it local-only. A route that is not in this list may as well not
 * exist — add it here in the same change that adds it to the server.
 */
export interface ApiContract {
  'GET /health': { response: { ok: true; service: 'amelia' } };
  'GET /events': { response: AmeliaEvent };
  'POST /debug/utterance': { body: DebugUtteranceRequest; response: UtteranceEvent };
  'POST /audio/enroll': { body: EnrollVoiceRequest; response: EnrollVoiceResponse };
  'POST /people/:id/name': { body: NamePersonRequest; response: Person };
  'POST /people/merge': { body: MergePeopleRequest; response: Person };
  'GET /people': { response: Person[] };
  'GET /people/:id': { response: Person };
  'GET /conversations': { response: Conversation[] };
  'GET /conversations/:id': { response: ConversationSummary };
  'DELETE /conversations/:id': { response: { deleted: true; utterances: number; facts: number; promises: number } };
  'GET /promises': { query: { status?: PromiseMemory['status'] }; response: PromiseMemory[] };
  'POST /promises/:id/status': { body: { status: PromiseMemory['status'] }; response: PromiseMemory };
  'GET /memory/search': { query: { q: string; person_id?: Id }; response: SearchMemoryResult[] };
  'POST /ask': { body: AskRequest; response: AskResponse };
  'GET /memory/changes': { query: { limit?: number }; response: unknown[] };
  'POST /reminders': { body: { promise_id: Id; fire_at: Timestamp }; response: Reminder };
  'POST /glasses/webhook': { body: unknown; response: { accepted: boolean } };
}

export interface DebugUtteranceRequest {
  utterance_id?: Id;
  conversation_id: Id;
  person_id?: Id;
  voiceprint_id?: Id;
  text: string;
  start_ms: number;
  end_ms: number;
  is_final?: boolean;
}
