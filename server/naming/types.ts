import type { Id, NameSuggestionEvent } from '../../shared/contracts';
import type { EvidenceFrame } from './rules';

export type NameEvidenceKind = NameSuggestionEvent['kind'];

/**
 * One diarized turn. `speaker` is whatever the caller uses to identify a voice
 * for the length of a conversation: a session cluster id for unnamed voices, a
 * person id for known ones. This module never resolves it, it only groups by it.
 */
export interface NamingTurn {
  id: Id;
  speaker: Id;
  text: string;
  start_ms: number;
  end_ms: number;
}

export interface KnownParticipant {
  person_id?: Id;
  speaker?: Id;
  name: string;
}

export interface NamingContext {
  conversation_id: Id;
  turns: NamingTurn[];
  /** Suppressed as a suggestion: the owner already knows their own name. */
  owner_name?: string;
  /** Never proposed for; the owner's voice is enrolled, not guessed at. */
  owner_speaker?: Id;
  /** People already on this conversation. A name that belongs to one of them is not re-proposed. */
  known_participants?: KnownParticipant[];
  /** Voices in this conversation that already carry a name. */
  named_speakers?: Record<Id, string>;
  /** Speaker -> person, used to fill `person_id` on the emitted event. */
  person_by_speaker?: Record<Id, Id>;
}

export interface NameMention {
  name: string;
  kind: NameEvidenceKind;
  /** The finer shape of the evidence, which decides how it argues with rivals. */
  frame: EvidenceFrame;
  turn_id: Id;
  speaker: Id;
  evidence: string;
  /** Confidence this mention alone justifies, before corroboration. */
  strength: number;
  /** Voice the name is about, absent for third-person references. */
  target?: Id;
  /** How the target was chosen, kept for the trace. */
  reasoning: string;
  source: 'rules' | 'llm';
}

export type SuppressionReason =
  | 'owner_name'
  | 'target_is_owner'
  | 'name_belongs_to_known_participant'
  | 'name_already_on_another_voice'
  | 'voice_already_named_differently'
  | 'voice_already_has_this_name'
  | 'contradicted_by_other_attribution'
  | 'voice_speaks_mostly_before_introduction'
  | 'no_addressee'
  | 'below_threshold';

export interface SuppressedSuggestion {
  name: string;
  reason: SuppressionReason;
  detail: string;
  speaker?: Id;
  confidence: number;
  kind: NameEvidenceKind;
  evidence: string;
}

export interface NamingResult {
  /** At or above NAME_SUGGESTION_MIN_CONFIDENCE, ready to emit. */
  suggestions: NameSuggestionEvent[];
  /** Everything the detector saw but declined to propose, with the reason why. */
  suppressed: SuppressedSuggestion[];
  mentions: NameMention[];
}
