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

/**
 * Maps a score to log-odds that a match is genuine: `slope * score + intercept`.
 *
 * Lives here rather than beside the fitting code because two independent
 * identifiers are now calibrated against each other — a voice score and a face
 * score only combine if both have been turned into probabilities first — and a
 * shared unit belongs in the shared file. `server/identity/score-norm.ts`
 * re-exports it so the fitting functions keep reading as one module.
 */
export interface Calibration {
  readonly slope: number;
  readonly intercept: number;
}

/**
 * Voice cosine → probability, anchored on the threshold we already trust.
 *
 * Derived rather than fitted, from the same 2,400-trial measurement behind
 * ATTRIBUTION_THRESHOLD (20s pooled, fixtures/real/dorm-9pm.wav):
 *
 *   genuine   mean 0.781, 5th percentile 0.746  ->  sd ~ (0.781-0.746)/1.645 = 0.021
 *   impostor  mean 0.422, 95th percentile 0.626 ->  sd ~ (0.626-0.422)/1.645 = 0.124
 *
 * For two roughly Gaussian classes the logistic slope is the mean separation
 * over the pooled variance: (0.781 - 0.422) / ((0.021^2 + 0.124^2) / 2) = 45.4,
 * rounded to 45. The intercept is then pinned so that p = 0.5 falls exactly on
 * ATTRIBUTION_THRESHOLD: intercept = -slope * 0.68 = -30.6. That is the whole
 * point of anchoring it — the probability and the accept rule cannot drift
 * apart, because they cross zero at the same score.
 *
 * Sanity: the observed impostor maximum 0.639 maps to p = 0.13, and the genuine
 * 5th percentile 0.746 to p = 0.95. Re-derive with `bun run eval:speakers`
 * whenever ATTRIBUTION_THRESHOLD moves.
 */
export const VOICE_CALIBRATION: Calibration = { slope: 45, intercept: -30.6 };

/**
 * Faces are the second identifier, and everything below is a PLACEHOLDER until
 * `bun run eval:faces` measures it on real crops. The numbers are deliberately
 * conservative: a wrong face match writes a voiceprint onto the wrong person,
 * so under-confirming costs a delay and over-confirming costs a corrupted
 * record. FACE_CONFIRM_FRAMES is the second guard — a single lucky frame never
 * confirms anybody.
 */
export const FACEPRINT_DIMS = 512;
export const MAX_FACEPRINTS_PER_PERSON = 12;
/** Cosine floor for a face match on L2-normalised InsightFace buffalo_l vectors. */
export const FACE_MATCH_THRESHOLD = 0.45;
/** The best face candidate must beat the runner-up by this much. */
export const FACE_MATCH_MARGIN = 0.08;
/** Consecutive matching frames on one track before a face claim is confirmed. */
export const FACE_CONFIRM_FRAMES = 3;
/** Detector score below which a face is not worth embedding. */
export const FACE_MIN_DET_SCORE = 0.6;
/** Longest edge of the crop the phone uploads. */
export const FACE_CROP_MAX_PX = 224;
/** Longest edge of the thumbnail stored beside a faceprint and used as an avatar. */
export const FACE_THUMBNAIL_PX = 96;
/** Slowest useful observation rate per track; the uploader throttles to it. */
export const FACE_OBSERVATION_INTERVAL_MS = 1_000;
/** Face is "near" when its box is at least this fraction of the frame height. */
export const FACE_NEAR_MIN_HEIGHT = 1 / 8;
/**
 * Face score → probability. Placeholder, same anchoring rule as the voice
 * calibration: p = 0.5 at FACE_MATCH_THRESHOLD, so intercept = -12 * 0.45.
 * The gentle slope is the honest one while the distributions are unmeasured —
 * it keeps face evidence from dominating the fused product on its own.
 * Replace both numbers with the `bun run eval:faces` fit.
 */
export const FACE_CALIBRATION: Calibration = { slope: 12, intercept: -5.4 };

/** Correlation window between mouth movement and audio energy. */
export const ACTIVE_SPEAKER_WINDOW_MS = 1_500;
/** Correlation below this is not evidence that this face is the one talking. */
export const ACTIVE_SPEAKER_MIN_SCORE = 0.3;
/** A person stays "in the room" this long after their last frame or turn. */
export const PRESENCE_TTL_MS = 15_000;

/**
 * Owner check on pre-roll audio needs as much speech as any other embedding.
 * Same floor, stated separately because the caller is a different question:
 * "is this the owner speaking" rather than "who is this cluster".
 */
export const OWNER_CHECK_MIN_MS = EMBED_MIN_MS;
/**
 * How far above the noise floor the glasses mic must sit before the speech is
 * treated as near-field, i.e. the wearer rather than the room. Placeholder;
 * re-measure with a real capture.
 */
export const OWNER_NEAR_FIELD_MARGIN_DB = 12;

/** Idle audio and frames held in memory, never on disk, flushed on trigger. */
export const PREROLL_MS = 15_000;
/** A track this old counts as persistent for setting classification. */
export const SETTING_PERSISTENT_TRACK_MS = 10_000;
/** A track shorter than this counts as transient churn — a street, not a room. */
export const SETTING_TRANSIENT_TRACK_MS = 3_000;
/** Consecutive agreeing classifications before the setting actually changes. */
export const SETTING_HYSTERESIS_S = 5;

/** No speech and no faces for this long ends a glasses conversation. */
export const GLASSES_CONVERSATION_IDLE_END_MS = 120_000;
/** One frame this often while idle, so a familiar face is still noticed. */
export const GLASSES_IDLE_POLL_MS = 5_000;
export const GLASSES_BURST_FPS = 8;
/** Camera keeps bursting this long after speech stops. */
export const GLASSES_SPEECH_HANGOVER_MS = 3_000;
/** Die temperature at which the camera halts; audio keeps running regardless. */
export const GLASSES_THERMAL_HALT_C = 80;
export const GLASSES_THERMAL_RESUME_C = 70;
export const GLASSES_SSID = 'amelia-glasses';
export const GLASSES_DEFAULT_HOST = '192.168.4.1';
export const GLASSES_WS_PORT = 80;
export const GLASSES_WS_PATH = '/ws';

export type IdentityConfidence = 'pending' | 'provisional' | 'confirmed';

/**
 * Which identifier produced a claim.
 *
 * Recorded because the two are independent and either can carry a claim alone:
 * a face confirmed over several frames is as good as a voice confirmed over
 * twenty seconds, and when both agree the claim is stronger than either. 'both'
 * is only ever written when the two agreed — disagreement is a conflict event,
 * never a fused answer.
 */
export type IdentitySource = 'voice' | 'face' | 'both';

/**
 * What the glasses think the wearer is in, which decides what gets kept.
 *
 * 'street' records only the owner and whoever is demonstrably talking to them,
 * and drops the rest at the final pass — a pavement full of strangers is not a
 * conversation. 'group' and 'gathering' keep everything the mic hears.
 */
export type CaptureMode = 'street' | 'group' | 'gathering';

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
  /**
   * Best face crop we hold for this person, as a base64 JPEG data payload.
   *
   * Denormalised from the faceprint set on purpose. Every screen that lists
   * people wants an avatar, and `GET /people` is the one call they all already
   * make; hydrating thumbnails separately would add a request per screen to
   * show something the row cannot render without. Absent for voice-only people,
   * who keep their identicon.
   */
  avatar_thumbnail?: string;
  /**
   * Last time this person was seen or heard, by either identifier.
   *
   * Written while idle as well as in conversation — recognising a familiar face
   * across the room is worth remembering even though nothing was recorded. It
   * is the only field the idle path is allowed to touch.
   */
  last_seen_at?: Timestamp;
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
  /**
   * Written because a confirmed face vouched for the speaker, not because the
   * voice cleared CROSS_SESSION_SPEECH_MS on its own.
   *
   * Face confirmation is independent evidence, so it is allowed to bypass that
   * floor — but a print harvested this way inherits the face's error, and this
   * tag is what makes those prints findable if the face matcher turns out to be
   * wrong. Absent means the print came the ordinary way.
   */
  taught_by?: 'face';
  created_at: Timestamp;
}

/**
 * A face, stored exactly like a voiceprint so it can be matched by the same code.
 *
 * `server/identity/matcher.ts` scores over `Pick<Voiceprint, '_id' | 'person_id'
 * | 'embedding' | 'session_mean'>`, so a faceprint runs through the same
 * cosine-and-margin decision with face thresholds and nothing is duplicated.
 * Faces get no Atlas vector index — the search-index allowance is spent — so
 * matching stays in process against the live print set, which is what the voice
 * path already does.
 */
export interface Faceprint {
  _id: Id;
  owner_id: Id;
  person_id: Id;
  /** L2-normalised InsightFace buffalo_l embedding, FACEPRINT_DIMS long. */
  embedding: number[];
  /** Detector score of the crop behind this print. Higher is a cleaner face. */
  quality: number;
  source_conversation_id?: Id;
  source_frame_ts?: number;
  /**
   * The crop itself, base64 JPEG at FACE_THUMBNAIL_PX. Kept because a face the
   * owner can look at is the only way to judge a match he did not make, and
   * because it becomes the person's avatar.
   */
  thumbnail?: string;
  /** Deliberately enrolled by the owner, so eviction never touches it. */
  enrolled?: boolean;
  /** The mirror of Voiceprint.taught_by: a voice vouched for this face. */
  taught_by?: 'voice';
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
  /** Which identifier carried the claim. Absent on older events means 'voice'. */
  source?: IdentitySource;
  /** The face cosine, when a face took part. Independent of `score`. */
  face_score?: number;
  /** The camera track the face claim came from, for the dev sheet. */
  face_track_id?: Id;
}

/**
 * Somebody is in the room, by face or by voice.
 *
 * Deliberately not one event per frame. The bus keeps a 4,096-event replay
 * buffer and drops SSE clients that fall 256 events behind, so per-frame face
 * observations would evict real transcript history within seconds of walking
 * into a room. Face observations therefore never reach the bus at all; this is
 * the one debounced summary that does, emitted only when something the UI would
 * render actually changed.
 */
export interface PresenceEvent {
  type: 'presence';
  /** Absent while idle: someone is here, but nothing is being recorded. */
  conversation_id?: Id;
  person_id: Id;
  name: string;
  confidence: IdentityConfidence;
  source: IdentitySource;
  speaking: boolean;
  /** Face box at least FACE_NEAR_MIN_HEIGHT of the frame — a companion, not a passer-by. */
  is_near: boolean;
  track_state: 'present' | 'lost';
  last_seen_at?: Timestamp;
  last_heard_at?: Timestamp;
}

/**
 * The face says one person and the voice says another, both confidently.
 *
 * Never resolved automatically. Two confident identifiers disagreeing is
 * evidence that two records are one person, or that one of the two matchers is
 * wrong, and both readings are questions for the owner — merging on the
 * system's own initiative is the one mistake that silently destroys history.
 * The pair is surfaced as a merge candidate carrying `reason:
 * 'face_voice_conflict'`, and nothing is written until a human says so.
 */
export interface IdentityConflictEvent {
  type: 'identity_conflict';
  conversation_id: Id;
  face_person_id: Id;
  voice_person_id: Id;
  utterance_ids: Id[];
  face_score: number;
  voice_score: number;
  start_ms: number;
  end_ms: number;
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
  | IdentityConflictEvent
  | PresenceEvent
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
  /**
   * What the capture device thinks it is in. Absent means the phone with no
   * glasses, which behaves exactly as it always has: the server treats a
   * missing mode as 'group' and keeps everything.
   */
  capture_mode?: CaptureMode;
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
 * What a camera track is claiming about who is in front of it, for the audio
 * lane to weigh against the voice.
 *
 * Deliberately small. The audio session asks the face lane a question about a
 * span of time, and this is the whole answer: who, how sure, how close, and
 * whether they were the one talking. Everything else the face lane knows stays
 * inside it.
 */
export interface FaceClaim {
  person_id?: Id;
  track_id: Id;
  confidence: IdentityConfidence;
  score: number;
  is_near: boolean;
  speaking: boolean;
}

/** One face crop the phone observed, uploaded for matching. */
export interface FaceObservationRequest {
  /**
   * Absent means idle: match only, write nothing.
   *
   * The camera runs a slow poll whenever the glasses are connected, and looking
   * at somebody is not consent to record them. Outside a conversation the
   * server matches the crop, may say who it is, and touches nothing but that
   * person's `last_seen_at` — no person is minted, no faceprint is stored, no
   * thumbnail is kept, and an unrecognised face leaves no trace at all.
   */
  conversation_id?: Id;
  capture_mode?: CaptureMode;
  /** Position in the conversation's audio clock, so claims line up with turns. */
  stream_ms?: number;
  frame_ts_ms: number;
  frame_seq: number;
  track_id: Id;
  /** Normalised to the frame, top-left origin. */
  bbox: { x: number; y: number; width: number; height: number };
  is_near: boolean;
  /** Inner-lip opening over inter-ocular distance, from the phone's landmarks. */
  mouth_openness?: number;
  /** Correlation of that opening against audio energy; see ACTIVE_SPEAKER_MIN_SCORE. */
  speaking_score?: number;
  is_active_speaker: boolean;
  det_quality?: number;
  /** JPEG crop, base64, longest edge at most FACE_CROP_MAX_PX. */
  crop_jpeg_base64: string;
}

export interface FaceObservationResponse {
  track_id: Id;
  /**
   * 'pending' is a match that has not yet held for FACE_CONFIRM_FRAMES.
   * 'unknown' is the idle answer for a face we do not know and did not store.
   */
  decision: 'matched' | 'created' | 'pending' | 'ambiguous' | 'no_face' | 'unknown';
  person_id?: Id;
  name?: string;
  confidence: IdentityConfidence;
  score?: number;
  faceprint_id?: Id;
}

/** Whether a clip is the owner speaking, at OWNER_AUTH_THRESHOLD. */
export interface OwnerCheckResponse {
  owner: boolean;
  score: number;
  duration_ms: number;
}

/** One side of a proposed merge, with enough evidence to judge it. */
export interface MergeCandidateSide {
  person_id: Id;
  name: string;
  voiceprint_id?: Id;
  duration_ms?: number;
  source_conversation_id?: Id;
}

/**
 * Two records that look like one person. Proposed, never applied.
 *
 * `reason` says which evidence raised it: 'voice' is two voiceprints scoring as
 * the same speaker, 'face_voice_conflict' is a face and a voice naming
 * different people in the same breath. The second is a stronger hint and still
 * not a decision — see IdentityConflictEvent.
 */
export interface MergeCandidate {
  score: number;
  /** Oldest person first — the one `mergePeople` would keep. */
  sides: [MergeCandidateSide, MergeCandidateSide];
  reason?: 'voice' | 'face_voice_conflict';
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
  'GET /people/duplicates': { query: { limit?: number }; response: { candidates: MergeCandidate[] } };
  'POST /faces/observe': { body: FaceObservationRequest; response: FaceObservationResponse };
  'POST /audio/owner-check': { body: ArrayBuffer; response: OwnerCheckResponse };
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

/**
 * The glasses-to-phone wire protocol.
 *
 * Declared here rather than in the app because the firmware and the phone are
 * two codebases in two languages that have to agree byte for byte, and this
 * file is the only place both sides already read. The board speaks it; the
 * phone parses it and relays the audio into `/stream` unchanged.
 *
 * Binary frames carry an 8-byte little-endian header:
 *
 *   [u8 kind][u8 flags][u16 seq][u32 ts_ms]
 *
 * JPEG frames extend it by four bytes with the image size:
 *
 *   [u8 kind][u8 flags][u16 seq][u32 ts_ms][u16 width][u16 height]
 *
 * `seq` wraps at 16 bits and is per kind, so a gap counts drops without the
 * board having to remember what it threw away. JSON text frames on the same
 * socket carry hello, status and control.
 */
export const GLASSES_FRAME_AUDIO = 0x01;
export const GLASSES_FRAME_JPEG = 0x02;
export const GLASSES_HEADER_BYTES = 8;
export const GLASSES_JPEG_HEADER_BYTES = 12;

/**
 * Audio arrives as int16 rather than float32 to halve the link cost, in frames
 * of AUDIO_FRAME_SAMPLES so one board frame becomes exactly one `/stream`
 * frame. The phone converts; nothing resamples or re-chunks.
 */
export interface GlassesAudioFrame {
  kind: typeof GLASSES_FRAME_AUDIO;
  seq: number;
  ts_ms: number;
  samples: Int16Array;
}

export interface GlassesJpegFrame {
  kind: typeof GLASSES_FRAME_JPEG;
  seq: number;
  ts_ms: number;
  width: number;
  height: number;
  jpeg: Uint8Array;
}

export type GlassesFrame = GlassesAudioFrame | GlassesJpegFrame;

/** Sent once when the phone connects, so the phone can refuse a mismatch. */
export interface GlassesHello {
  type: 'hello';
  protocol: number;
  firmware: string;
  sample_rate: number;
  frame_samples: number;
}

/** Emitted once a second whether or not anything is happening. */
export interface GlassesStatus {
  type: 'status';
  ts_ms: number;
  /** Die temperature. See GLASSES_THERMAL_HALT_C — heat is the real constraint. */
  die_c: number;
  camera: 'idle' | 'burst' | 'thermal_halt';
  /** Board-side voice activity, from energy and zero crossings on the PDM mic. */
  vad: boolean;
  fps: number;
  audio_drops: number;
  frame_drops: number;
  heap_free: number;
  psram_free: number;
  rssi?: number;
}

export type GlassesMessage = GlassesHello | GlassesStatus;

export type GlassesControl =
  | { type: 'burst'; duration_ms: number }
  | { type: 'set_fps'; fps: number }
  | { type: 'set_idle_poll_ms'; interval_ms: number }
  | { type: 'ping' };

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
