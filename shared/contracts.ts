export const OWNER_ID = 'owner';
export const EMBED_MIN_MS = 3_000;
// Tuned against the fixture on 2026-08-13: within-speaker cosine bottomed at
// 0.758 and cross-speaker peaked at 0.259, so 0.75 left almost no margin
// before a speaker split in two. 0.6 keeps distance from both failure modes.
export const ATTRIBUTION_THRESHOLD = 0.6;
export const OWNER_AUTH_THRESHOLD = 0.6;
export const TONIGHT_DEFAULT_HOUR = 21;
export const FAST_PASS_LOOKBACK_TURNS = 8;
export const SLOW_PASS_EVERY_N_UTTERANCES = 25;
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
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface Voiceprint {
  _id: Id;
  owner_id: Id;
  person_id: Id;
  embedding: number[];
  duration_ms: number;
  source_utterance_id?: Id;
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
  voiceprint_id?: Id;
  text: string;
  start_ms: number;
  end_ms: number;
  is_final: boolean;
}

export interface IdentityEvent {
  type: 'identity';
  conversation_id: Id;
  person_id: Id;
  voiceprint_id?: Id;
  name: string;
  utterance_ids: Id[];
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

/** Re-emitting an event with the same utterance_id replaces the earlier revision. */
export type AmeliaEvent =
  | UtteranceEvent
  | IdentityEvent
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
  'GET /memory/search': { query: { q: string; person_id?: Id }; response: SearchMemoryResult[] };
  'POST /ask': { body: AskRequest; response: AskResponse };
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
