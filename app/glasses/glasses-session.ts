/**
 * When the glasses start recording, and when they stop.
 *
 * Looking at somebody is not consent to record them, so connecting the board
 * starts nothing: the camera polls slowly, faces are matched but never stored,
 * and audio goes only into a fifteen-second ring in memory. A conversation
 * begins on evidence that one is happening — the owner's own voice at
 * near-field, or in a room rather than a street, a companion whose lips move
 * with the sound. A familiar face on its own never starts anything; it
 * surfaces a card and touches last_seen_at, which is the whole of it.
 *
 * Every collaborator is injected and every decision is a named function, so
 * the machine can be driven from a fixture with no board, no camera and no
 * server.
 */

import {
  GLASSES_CONVERSATION_IDLE_END_MS,
  GLASSES_SPEECH_HANGOVER_MS,
  OWNER_CHECK_MIN_MS,
  type CaptureMode,
  type FaceObservationResponse,
  type GlassesAudioFrame,
  type GlassesJpegFrame,
  type GlassesStatus,
  type Id,
  type OwnerCheckResponse,
} from '../../shared/contracts';
import type { HandshakeExtras } from '../audio/capture-engine';
import {
  ActiveSpeakerScorer,
  AudioEnvelope,
  mouthOpenness,
  pickActiveSpeaker,
  type SpeakerCandidate,
} from './active-speaker';
import { FaceTracker, type FaceTrack } from './face-tracker';
import { FaceUploader, type FaceObservation, type FaceObserveApi } from './face-uploader';
import type { GlassesLinkStatus } from './glasses-link';
import { audioFrameToFloat32 } from './protocol';
import { PrerollBuffer, alignToAudioClock, type PrerollContents } from './preroll';
import { SettingClassifier, featuresFrom, type VadSample } from './setting';
import type { Vision } from './vision';

export type GlassesSessionState = 'disconnected' | 'idle' | 'arming' | 'recording' | 'ending';

/**
 * How long an owner check stands, and how far apart two of them must sit.
 *
 * One number for both because they are the same question: an answer older than
 * this is stale enough to be worth asking again, and asking again sooner than
 * this is asking the same clip twice.
 */
export const OWNER_CHECK_INTERVAL_MS = 5_000;
/** A near track has to hold the audio this long before it counts as a companion talking. */
export const COMPANION_SPEAKING_MS = 1_000;
const VAD_HISTORY_MS = 60_000;
const TRACK_HISTORY_MS = 60_000;

export interface OwnerCheckApi {
  ownerCheck(pcm: Float32Array): Promise<OwnerCheckResponse>;
}

export interface CaptureUplink {
  start(conversationId: Id, handshakeExtras?: HandshakeExtras): Promise<void>;
  stop(): void;
  pushSamples(samples: Float32Array): void;
}

export type GlassesSessionEvent =
  | { type: 'state'; state: GlassesSessionState; conversationId?: Id }
  | { type: 'mode'; mode: CaptureMode; pinned: boolean }
  | { type: 'owner-check'; result: OwnerCheckResponse }
  | { type: 'observation'; response: FaceObservationResponse }
  | { type: 'frame'; frame: GlassesJpegFrame; tracks: FaceTrack[]; activeTrackId: Id | null };

export interface GlassesSessionDeps {
  vision: Vision;
  api: FaceObserveApi & OwnerCheckApi;
  engine: CaptureUplink;
  requestBurst(durationMs: number): void;
  /** JPEG bytes to base64, which has no portable implementation across Bun and RN. */
  toBase64(bytes: Uint8Array): string;
  emit(event: GlassesSessionEvent): void;
  now(): number;
  newConversationId(): Id;
}

export interface StartInput {
  mode: CaptureMode;
  /** The board's own voice activity detector. */
  vad: boolean;
  /** Glasses-mic level above its noise floor: the wearer rather than the room. */
  nearField: boolean;
  /** The last owner check, if one is recent enough to still mean anything. */
  ownerCheck?: boolean;
  companionSpeaking: boolean;
}

export type StartDecision = 'idle' | 'owner-check' | 'start';

/**
 * The one rule about starting, stated once.
 *
 * On a street the owner's voice is the only thing that may start a recording,
 * because everything else within earshot is a stranger. In a room a companion
 * demonstrably talking to the wearer is evidence enough, and waiting three
 * seconds for a server round trip would lose their opening sentence.
 */
export function evaluateStart(input: StartInput): StartDecision {
  if (input.companionSpeaking && input.mode !== 'street') return 'start';
  if (!input.vad || !input.nearField) return 'idle';
  if (input.ownerCheck === undefined) return 'owner-check';
  return input.ownerCheck ? 'start' : 'idle';
}

export interface EndInput {
  lastSpeechMs: number;
  lastNearFaceMs: number;
  nowMs: number;
}

/** Nobody has spoken and nobody is here. Two minutes of that is the end of it. */
export function shouldEndConversation(input: EndInput): boolean {
  const lastSign = Math.max(input.lastSpeechMs, input.lastNearFaceMs);
  return input.nowMs - lastSign >= GLASSES_CONVERSATION_IDLE_END_MS;
}

function snapshotTrack(track: FaceTrack): FaceTrack {
  return { ...track };
}

function concatFrames(frames: readonly GlassesAudioFrame[]): Float32Array {
  const total = frames.reduce((sum, frame) => sum + frame.samples.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const frame of frames) {
    out.set(audioFrameToFloat32(frame), offset);
    offset += frame.samples.length;
  }
  return out;
}

export class GlassesSession {
  readonly tracker = new FaceTracker();
  readonly classifier = new SettingClassifier();
  readonly preroll = new PrerollBuffer();
  readonly envelope = new AudioEnvelope();
  readonly scorer = new ActiveSpeakerScorer();
  readonly uploader: FaceUploader;

  private phase: GlassesSessionState = 'disconnected';
  private conversation: Id | null = null;
  private starting = false;
  private pendingLive: GlassesAudioFrame[] = [];
  private vadHistory: VadSample[] = [];
  private trackHistory: FaceTrack[] = [];
  private boardSpeaking = false;
  private lastSpeechMs = 0;
  private lastNearFaceMs = 0;
  private ownerCheckAtMs = -Infinity;
  private ownerCheckResult: boolean | undefined;
  private ownerCheckInFlight = false;
  private activeTrackId: Id | null = null;
  private activeSinceMs = 0;
  private firstAudioTsMs: number | null = null;

  constructor(private readonly deps: GlassesSessionDeps) {
    this.uploader = new FaceUploader({
      api: deps.api,
      now: deps.now,
      onResponse: (response) => deps.emit({ type: 'observation', response }),
    });
  }

  get state(): GlassesSessionState {
    return this.phase;
  }

  get conversationId(): Id | null {
    return this.conversation;
  }

  get mode(): CaptureMode {
    return this.classifier.mode;
  }

  pinMode(mode: CaptureMode): void {
    this.classifier.pin(mode);
    this.deps.emit({ type: 'mode', mode: this.classifier.mode, pinned: true });
  }

  unpinMode(): void {
    this.classifier.unpin();
    this.deps.emit({ type: 'mode', mode: this.classifier.mode, pinned: false });
  }

  onLink(status: GlassesLinkStatus): void {
    if (status === 'connected') {
      if (this.phase === 'disconnected') this.setPhase('idle');
      return;
    }
    if (this.phase === 'recording' || this.phase === 'arming') this.endConversation();
    this.forgetTheRoom();
    this.setPhase('disconnected');
  }

  onStatus(status: GlassesStatus): void {
    this.boardSpeaking = status.vad;
    if (status.vad) this.lastSpeechMs = status.ts_ms;
    this.vadHistory.push({ ts_ms: status.ts_ms, speech: status.vad });
    this.vadHistory = this.vadHistory.filter((sample) => status.ts_ms - sample.ts_ms <= VAD_HISTORY_MS);
    this.evaluate();
  }

  onAudio(frame: GlassesAudioFrame): void {
    if (this.firstAudioTsMs === null) this.firstAudioTsMs = frame.ts_ms;
    this.envelope.push(audioFrameToFloat32(frame), frame.ts_ms);
    if (this.phase === 'recording') {
      this.deps.engine.pushSamples(audioFrameToFloat32(frame));
      return;
    }
    // Held rather than buffered into the ring: the ring has already been
    // drained, and these frames belong after it, not before.
    if (this.starting) {
      this.pendingLive.push(frame);
      return;
    }
    this.preroll.pushAudio(frame);
  }

  /** One camera frame: detect, track, score, upload, and reconsider. */
  async onFrame(frame: GlassesJpegFrame): Promise<void> {
    if (this.phase === 'disconnected') return;
    const faces = await this.deps.vision.analyzeFrame(this.deps.toBase64(frame.jpeg));
    const tracks = this.tracker.update(faces, frame.ts_ms);
    this.rememberTracks(tracks);

    const active = this.scoreTracks(tracks, frame.ts_ms);
    this.noteActive(active, frame.ts_ms);
    if (tracks.some((track) => track.is_near)) this.lastNearFaceMs = frame.ts_ms;

    for (const track of tracks) this.uploadTrack(track, frame, active);
    // Snapshots, not the live track objects: the tracker mutates those in
    // place, so a stored reference would replay this frame's face with the
    // bounding box and crop of whatever the person did fifteen seconds later.
    if (this.phase !== 'recording') {
      this.preroll.pushFrame(frame, tracks.map(snapshotTrack), active ?? undefined);
    }
    this.deps.emit({ type: 'frame', frame, tracks, activeTrackId: active });
    this.evaluate();
  }

  /** Once a second: re-read the room, and give up on a conversation that is over. */
  tick(): void {
    if (this.phase === 'disconnected') return;
    const now = this.deps.now();
    this.trackHistory = this.trackHistory.filter((track) => now - track.last_seen_ms <= TRACK_HISTORY_MS);
    const before = this.classifier.mode;
    const mode = this.classifier.push(featuresFrom(this.trackHistory, this.vadHistory, now));
    if (mode !== before) this.deps.emit({ type: 'mode', mode, pinned: this.classifier.pinned });
    if (this.phase !== 'recording') return;
    if (shouldEndConversation({ lastSpeechMs: this.lastSpeechMs, lastNearFaceMs: this.lastNearFaceMs, nowMs: now })) {
      this.endConversation();
    }
  }

  /** The owner ended it by hand. Same path as running out of conversation. */
  stop(): void {
    if (this.phase === 'recording' || this.phase === 'arming') this.endConversation();
  }

  private scoreTracks(tracks: FaceTrack[], tsMs: number): Id | null {
    const candidates: SpeakerCandidate[] = [];
    for (const track of tracks) {
      const openness = mouthOpenness(track.face);
      if (openness === undefined) continue;
      this.scorer.push(track.track_id, openness, tsMs);
      candidates.push({ track_id: track.track_id, score: this.scorer.score(track.track_id, this.envelope, tsMs) });
    }
    return pickActiveSpeaker(candidates, this.boardSpeaking);
  }

  private noteActive(active: Id | null, tsMs: number): void {
    if (active !== this.activeTrackId) {
      this.activeTrackId = active;
      this.activeSinceMs = tsMs;
    }
  }

  private companionSpeaking(nowMs: number): boolean {
    if (!this.activeTrackId) return false;
    const track = this.tracker.live.find((candidate) => candidate.track_id === this.activeTrackId);
    if (!track?.is_near) return false;
    return nowMs - this.activeSinceMs >= COMPANION_SPEAKING_MS;
  }

  private uploadTrack(track: FaceTrack, frame: GlassesJpegFrame, active: Id | null): void {
    const crop = track.face.cropJpegBase64;
    if (!crop) return;
    this.uploader.observe({
      conversation_id: this.conversation ?? undefined,
      capture_mode: this.mode,
      stream_ms: this.streamMsFor(frame.ts_ms),
      frame_ts_ms: frame.ts_ms,
      frame_seq: frame.seq,
      track_id: track.track_id,
      bbox: track.bbox,
      is_near: track.is_near,
      mouth_openness: mouthOpenness(track.face),
      det_quality: track.face.quality,
      is_active_speaker: active === track.track_id,
      crop_jpeg_base64: crop,
    });
  }

  private streamMsFor(tsMs: number): number | undefined {
    if (this.phase !== 'recording' || this.firstAudioTsMs === null) return undefined;
    return Math.max(0, tsMs - this.firstAudioTsMs);
  }

  private rememberTracks(tracks: FaceTrack[]): void {
    for (const track of tracks) {
      if (!this.trackHistory.includes(track)) this.trackHistory.push(track);
    }
  }

  private evaluate(): void {
    if (this.phase !== 'idle' && this.phase !== 'arming') return;
    const now = this.deps.now();
    const decision = evaluateStart({
      mode: this.mode,
      vad: this.boardSpeaking,
      nearField: this.envelope.isNearField(),
      ownerCheck: this.freshOwnerCheck(now),
      companionSpeaking: this.companionSpeaking(now),
    });
    if (decision === 'start') {
      void this.startConversation();
      return;
    }
    if (decision === 'owner-check') {
      this.setPhase('arming');
      void this.runOwnerCheck(now);
      return;
    }
    if (this.phase === 'arming' && !this.ownerCheckInFlight) this.setPhase('idle');
  }

  private freshOwnerCheck(nowMs: number): boolean | undefined {
    return nowMs - this.ownerCheckAtMs < OWNER_CHECK_INTERVAL_MS ? this.ownerCheckResult : undefined;
  }

  /**
   * At most one check in the air and at most one every five seconds. Without
   * the limit a quiet room with a fan in it re-asks the server whether the
   * owner is talking ten times a second, for as long as the glasses are on.
   */
  private async runOwnerCheck(nowMs: number): Promise<void> {
    if (this.ownerCheckInFlight) return;
    const frames = this.preroll.newestAudio(OWNER_CHECK_MIN_MS);
    if (frames.length * 100 < OWNER_CHECK_MIN_MS) return;

    this.ownerCheckInFlight = true;
    this.ownerCheckAtMs = nowMs;
    try {
      const result = await this.deps.api.ownerCheck(concatFrames(frames));
      this.ownerCheckResult = result.owner;
      this.deps.emit({ type: 'owner-check', result });
    } catch {
      // Unreachable is not "not the owner": leave the answer unknown so the
      // next attempt asks again rather than deciding on a network failure.
      this.ownerCheckResult = undefined;
    } finally {
      this.ownerCheckInFlight = false;
    }
    this.evaluate();
  }

  /**
   * Order matters and is the reason this is not three lines.
   *
   * The ring is drained before the socket is even opened, so nothing new lands
   * in it; the ring's audio goes out first; the observations follow with a
   * stream_ms taken from the audio clock rather than the board's; and only then
   * does live audio start flowing. Any other order puts the opener after the
   * reply, or puts a face claim against the wrong turn.
   */
  private async startConversation(): Promise<void> {
    if (this.starting || this.phase === 'recording') return;
    this.starting = true;
    const conversationId = this.deps.newConversationId();
    const mode = this.mode;
    const contents = this.preroll.drain();

    try {
      await this.deps.engine.start(conversationId, { capture_mode: mode });
    } catch {
      this.starting = false;
      this.pendingLive = [];
      this.setPhase('idle');
      return;
    }

    this.conversation = conversationId;
    this.firstAudioTsMs = contents.firstAudioTsMs;
    for (const frame of contents.audio) this.deps.engine.pushSamples(audioFrameToFloat32(frame));
    this.uploader.observeRetroactive(retroactiveObservations(contents, conversationId, mode));
    for (const frame of this.pendingLive) this.deps.engine.pushSamples(audioFrameToFloat32(frame));

    this.pendingLive = [];
    this.starting = false;
    this.setPhase('recording', conversationId);
    this.deps.requestBurst(GLASSES_SPEECH_HANGOVER_MS);
  }

  private endConversation(): void {
    this.setPhase('ending', this.conversation ?? undefined);
    this.deps.engine.stop();
    this.conversation = null;
    this.starting = false;
    this.pendingLive = [];
    this.firstAudioTsMs = null;
    this.ownerCheckResult = undefined;
    this.ownerCheckAtMs = -Infinity;
    this.setPhase('idle');
  }

  /** The link dropped. Nothing observed about a room we can no longer see survives. */
  private forgetTheRoom(): void {
    this.classifier.reset();
    this.preroll.clear();
    this.tracker.reset();
    this.scorer.reset();
    this.envelope.reset();
    this.uploader.reset();
    this.trackHistory = [];
    this.vadHistory = [];
    this.boardSpeaking = false;
    this.activeTrackId = null;
    this.firstAudioTsMs = null;
    this.ownerCheckResult = undefined;
    this.ownerCheckAtMs = -Infinity;
  }

  private setPhase(phase: GlassesSessionState, conversationId?: Id): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.deps.emit({ type: 'state', state: phase, conversationId });
  }
}

/** Pre-roll frames replayed onto the conversation's own clock. */
export function retroactiveObservations(
  contents: PrerollContents,
  conversationId: Id,
  captureMode: CaptureMode,
): FaceObservation[] {
  const observations: FaceObservation[] = [];
  for (const entry of contents.frames) {
    const streamMs = alignToAudioClock(entry.frame.ts_ms, contents.audio);
    for (const track of entry.tracks) {
      if (!track.face.cropJpegBase64) continue;
      observations.push({
        conversation_id: conversationId,
        capture_mode: captureMode,
        stream_ms: streamMs,
        frame_ts_ms: entry.frame.ts_ms,
        frame_seq: entry.frame.seq,
        track_id: track.track_id,
        bbox: track.bbox,
        is_near: track.is_near,
        is_active_speaker: entry.active_track_id === track.track_id,
        crop_jpeg_base64: track.face.cropJpegBase64,
      });
    }
  }
  return observations;
}
