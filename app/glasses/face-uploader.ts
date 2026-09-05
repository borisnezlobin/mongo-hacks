/**
 * Face crops going to the server, at a rate the uplink can carry.
 *
 * The camera bursts at up to 8 fps and the phone is on cellular, so uploading
 * every frame of every track is neither possible nor useful — a face does not
 * change between frames. One observation per track per second is enough for
 * the server's consecutive-frame confirmation, with two exceptions that are
 * genuinely news: a track nobody has seen before, and the moment a track
 * starts or stops being the one talking.
 */

import {
  FACE_OBSERVATION_INTERVAL_MS,
  type FaceObservationRequest,
  type FaceObservationResponse,
  type Id,
} from '../../shared/contracts';

/** Beyond this the queue is behind the camera, and stale crops are worth less than new ones. */
export const MAX_IN_FLIGHT = 3;

export interface FaceObserveApi {
  observeFace(request: FaceObservationRequest): Promise<FaceObservationResponse>;
}

export interface FaceUploaderDeps {
  api: FaceObserveApi;
  now(): number;
  onResponse?(response: FaceObservationResponse, request: FaceObservationRequest): void;
  onError?(error: unknown): void;
}

export type FaceObservation = Omit<FaceObservationRequest, 'stream_ms'> & { stream_ms?: number };

interface TrackState {
  lastSentAtMs: number;
  wasActiveSpeaker: boolean;
}

export class FaceUploader {
  private readonly tracks = new Map<Id, TrackState>();
  private inFlightCount = 0;
  private droppedCount = 0;

  constructor(private readonly deps: FaceUploaderDeps) {}

  get inFlight(): number {
    return this.inFlightCount;
  }

  /** Crops the queue was too far behind to send. Shown in the dev sheet, not hidden. */
  get dropped(): number {
    return this.droppedCount;
  }

  reset(): void {
    this.tracks.clear();
  }

  forget(trackId: Id): void {
    this.tracks.delete(trackId);
  }

  /** True when this observation was actually sent rather than throttled or dropped. */
  observe(request: FaceObservation): boolean {
    const state = this.tracks.get(request.track_id);
    if (state && !this.isDue(state, request)) return false;
    return this.send(request, state);
  }

  /**
   * Pre-roll frames, replayed once a conversation starts.
   *
   * These bypass the throttle: they are already sparse, they carry the
   * retroactive stream_ms the caller worked out from the audio clock, and they
   * are the only record of who was in the room before recording began.
   */
  observeRetroactive(requests: FaceObservation[]): void {
    for (const request of requests) this.dispatch(request);
  }

  private isDue(state: TrackState, request: FaceObservation): boolean {
    if (state.wasActiveSpeaker !== request.is_active_speaker) return true;
    return this.deps.now() - state.lastSentAtMs >= FACE_OBSERVATION_INTERVAL_MS;
  }

  private send(request: FaceObservation, state: TrackState | undefined): boolean {
    if (this.inFlightCount >= MAX_IN_FLIGHT) {
      this.droppedCount += 1;
      return false;
    }
    const next = state ?? { lastSentAtMs: 0, wasActiveSpeaker: false };
    next.lastSentAtMs = this.deps.now();
    next.wasActiveSpeaker = request.is_active_speaker;
    this.tracks.set(request.track_id, next);
    this.dispatch(request);
    return true;
  }

  private dispatch(request: FaceObservation): void {
    this.inFlightCount += 1;
    void this.deps.api
      .observeFace(request as FaceObservationRequest)
      .then((response) => this.deps.onResponse?.(response, request as FaceObservationRequest))
      .catch((error) => this.deps.onError?.(error))
      .finally(() => {
        this.inFlightCount -= 1;
      });
  }
}
