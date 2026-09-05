import { describe, expect, it } from 'vitest';
import {
  AUDIO_FRAME_SAMPLES,
  GLASSES_CONVERSATION_IDLE_END_MS,
  GLASSES_FRAME_AUDIO,
  GLASSES_FRAME_JPEG,
  type FaceObservationRequest,
  type GlassesAudioFrame,
  type GlassesJpegFrame,
  type GlassesStatus,
  type Id,
} from '../../shared/contracts';
import { AUDIO_FRAME_MS } from './preroll';
import {
  GlassesSession,
  OWNER_CHECK_INTERVAL_MS,
  evaluateStart,
  shouldEndConversation,
  type GlassesSessionEvent,
} from './glasses-session';
import type { VisionFace } from './vision';

const LOUD = 0.5;
const QUIET = 0.002;

function audioFrame(seq: number, tsMs: number, amplitude: number): GlassesAudioFrame {
  const samples = new Int16Array(AUDIO_FRAME_SAMPLES).fill(Math.round(amplitude * 32_000));
  return { kind: GLASSES_FRAME_AUDIO, seq, ts_ms: tsMs, samples };
}

function jpegFrame(seq: number, tsMs: number): GlassesJpegFrame {
  return { kind: GLASSES_FRAME_JPEG, seq, ts_ms: tsMs, width: 640, height: 480, jpeg: new Uint8Array([1, 2]) };
}

function status(tsMs: number, vad: boolean): GlassesStatus {
  return {
    type: 'status', ts_ms: tsMs, die_c: 44, camera: vad ? 'burst' : 'idle', vad,
    fps: 4, audio_drops: 0, frame_drops: 0, heap_free: 1, psram_free: 1,
  };
}

const nearFace = (x: number): VisionFace => ({
  bbox: { x, y: 0.2, width: 0.35, height: 0.35 },
  cropJpegBase64: 'crop',
  landmarks: {
    leftEye: [{ x: x + 0.1, y: 0.3 }],
    rightEye: [{ x: x + 0.25, y: 0.3 }],
    innerLips: [{ x: x + 0.17, y: 0.45 }, { x: x + 0.17, y: 0.47 }],
    outerLips: [{ x: x + 0.17, y: 0.44 }, { x: x + 0.17, y: 0.48 }],
  },
});

/** A mouth whose opening rate follows the loudness pattern the harness plays. */
function companionMouth(index: number): VisionFace[] {
  const phase = index % 10;
  const openness = phase < 5 ? 0.02 + phase * 0.04 : 0.22;
  const face = nearFace(0.3);
  return [{
    ...face,
    landmarks: {
      ...face.landmarks!,
      innerLips: [{ x: 0.47, y: 0.45 }, { x: 0.47, y: 0.45 + openness * 0.15 }],
    },
  }];
}

interface HarnessOptions {
  owner?: boolean;
  faces?: VisionFace[];
  facesFor?: (index: number) => VisionFace[];
}

function harness(options: HarnessOptions = {}) {
  let now = 0;
  const events: GlassesSessionEvent[] = [];
  const observed: FaceObservationRequest[] = [];
  const started: { id: Id; mode?: string }[] = [];
  const pushed: { samples: number; amplitude: number }[] = [];
  const ownerChecks: number[] = [];
  let stops = 0;
  let visionCalls = 0;

  const session = new GlassesSession({
    vision: {
      analyzeFrame: async () => (options.facesFor ? options.facesFor(visionCalls++) : options.faces ?? []),
    },
    api: {
      async observeFace(request) {
        observed.push(request);
        return { track_id: request.track_id, decision: 'pending', confidence: 'pending' };
      },
      async ownerCheck(pcm) {
        ownerChecks.push(pcm.length);
        return { owner: options.owner ?? false, score: 0.8, duration_ms: (pcm.length / 16_000) * 1_000 };
      },
    },
    engine: {
      async start(id, extras) {
        started.push({ id, mode: extras?.capture_mode });
      },
      stop: () => {
        stops += 1;
      },
      pushSamples: (samples) => pushed.push({ samples: samples.length, amplitude: samples[0] ?? 0 }),
    },
    requestBurst: () => {},
    toBase64: () => 'frame',
    emit: (event) => events.push(event),
    now: () => now,
    newConversationId: () => 'c-glasses',
  });

  return {
    session,
    events,
    observed,
    started,
    pushed,
    ownerChecks,
    stops: () => stops,
    at(ms: number) {
      now = ms;
    },
    /** Fills the ring with speech-level audio so an owner check has something to send. */
    async speak(frames: number, startMs = 0) {
      for (let index = 0; index < frames; index += 1) {
        const at = startMs + index * AUDIO_FRAME_MS;
        now = at;
        session.onAudio(audioFrame(index, at, LOUD));
      }
    },
    async quiet(frames: number, startMs = 0) {
      for (let index = 0; index < frames; index += 1) {
        const at = startMs + index * AUDIO_FRAME_MS;
        now = at;
        session.onAudio(audioFrame(index, at, QUIET));
      }
    },
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

describe('evaluateStart', () => {
  const base = { mode: 'group' as const, vad: false, nearField: false, companionSpeaking: false };

  it('starts nothing on silence', () => {
    expect(evaluateStart(base)).toBe('idle');
  });

  it('asks the server about near-field speech it has no answer for', () => {
    expect(evaluateStart({ ...base, vad: true, nearField: true })).toBe('owner-check');
  });

  it('starts on the owner and stays idle on anyone else', () => {
    expect(evaluateStart({ ...base, vad: true, nearField: true, ownerCheck: true })).toBe('start');
    expect(evaluateStart({ ...base, vad: true, nearField: true, ownerCheck: false })).toBe('idle');
  });

  it('starts on a speaking companion in a room but never on a street', () => {
    expect(evaluateStart({ ...base, companionSpeaking: true })).toBe('start');
    expect(evaluateStart({ ...base, mode: 'gathering', companionSpeaking: true })).toBe('start');
    expect(evaluateStart({ ...base, mode: 'street', companionSpeaking: true })).toBe('idle');
  });

  it('ignores room speech that is not near-field', () => {
    expect(evaluateStart({ ...base, vad: true, nearField: false, ownerCheck: true })).toBe('idle');
  });
});

describe('shouldEndConversation', () => {
  it('ends after the idle window with no speech and no faces', () => {
    expect(shouldEndConversation({ lastSpeechMs: 0, lastNearFaceMs: 0, nowMs: GLASSES_CONVERSATION_IDLE_END_MS }))
      .toBe(true);
    expect(shouldEndConversation({ lastSpeechMs: 0, lastNearFaceMs: 0, nowMs: 10_000 })).toBe(false);
  });

  it('a face in the room keeps it alive even in silence', () => {
    expect(shouldEndConversation({
      lastSpeechMs: 0,
      lastNearFaceMs: GLASSES_CONVERSATION_IDLE_END_MS,
      nowMs: GLASSES_CONVERSATION_IDLE_END_MS + 1_000,
    })).toBe(false);
  });
});

describe('glasses session', () => {
  it('connecting starts nothing', async () => {
    const h = harness();
    h.session.onLink('connected');
    expect(h.session.state).toBe('idle');
    await h.quiet(20);
    h.session.onStatus(status(2_000, false));
    await settle();
    expect(h.started).toHaveLength(0);
  });

  it('idle observations carry no conversation id, so nothing is stored', async () => {
    const h = harness({ faces: [nearFace(0.2)] });
    h.session.onLink('connected');
    await h.session.onFrame(jpegFrame(1, 0));
    expect(h.observed).toHaveLength(1);
    expect(h.observed[0].conversation_id).toBeUndefined();
    expect(h.observed[0].stream_ms).toBeUndefined();
  });

  /** A familiar face is a card, not consent. Nothing about it starts a recording. */
  it('a face alone never starts a conversation', async () => {
    const h = harness({ faces: [nearFace(0.2)] });
    h.session.onLink('connected');
    for (let index = 0; index < 10; index += 1) await h.session.onFrame(jpegFrame(index, index * 200));
    await settle();
    expect(h.session.state).toBe('idle');
    expect(h.started).toHaveLength(0);
  });

  it('owner speech starts a conversation and flushes pre-roll before live audio', async () => {
    const h = harness({ owner: true });
    h.session.onLink('connected');
    await h.quiet(20, 0);
    await h.speak(40, 2_000);
    h.session.onStatus(status(6_000, true));
    await settle();

    expect(h.started).toEqual([{ id: 'c-glasses', mode: 'group' }]);
    expect(h.session.state).toBe('recording');
    // Everything the ring held went out before anything new did.
    expect(h.pushed.length).toBeGreaterThanOrEqual(40);
    expect(h.pushed.every((frame) => frame.samples === AUDIO_FRAME_SAMPLES)).toBe(true);
    expect(h.session.preroll.audioFrames).toBe(0);

    const before = h.pushed.length;
    h.session.onAudio(audioFrame(99, 6_100, LOUD));
    expect(h.pushed).toHaveLength(before + 1);
  });

  it('replays pre-roll faces with a retroactive stream_ms on the audio clock', async () => {
    const h = harness({ owner: true, faces: [nearFace(0.2)] });
    h.session.onLink('connected');
    await h.quiet(20, 0);
    await h.speak(40, 2_000);
    await h.session.onFrame(jpegFrame(1, 4_000));
    h.session.onStatus(status(6_000, true));
    await settle();

    const replayed = h.observed.filter((request) => request.conversation_id === 'c-glasses');
    expect(replayed.length).toBeGreaterThan(0);
    // The ring starts at 0 ms of board time; the frame at 4,000 ms is 4,000 ms in.
    expect(replayed[0].stream_ms).toBe(4_000);
  });

  it('a voice that is not the owner leaves it idle', async () => {
    const h = harness({ owner: false });
    h.session.onLink('connected');
    await h.quiet(20, 0);
    await h.speak(40, 2_000);
    h.session.onStatus(status(6_000, true));
    await settle();
    expect(h.started).toHaveLength(0);
    expect(h.session.state).toBe('idle');
  });

  it('rate-limits owner checks rather than asking on every frame', async () => {
    const h = harness({ owner: false });
    h.session.onLink('connected');
    await h.quiet(20, 0);
    await h.speak(40, 2_000);
    for (let index = 0; index < 8; index += 1) {
      h.at(6_000 + index * 100);
      h.session.onStatus(status(6_000 + index * 100, true));
      await settle();
    }
    expect(h.ownerChecks).toHaveLength(1);

    h.at(6_000 + OWNER_CHECK_INTERVAL_MS);
    h.session.onStatus(status(11_000, true));
    await settle();
    expect(h.ownerChecks).toHaveLength(2);
  });

  /**
   * The one case the owner check cannot cover: somebody else opens the
   * conversation, and waiting three seconds for a round trip would lose it.
   */
  it('group mode starts on a companion whose lips move with the sound', async () => {
    const h = harness({ owner: false, facesFor: companionMouth });
    h.session.onLink('connected');
    await h.quiet(10, 0);

    for (let index = 0; index < 40; index += 1) {
      const at = 1_000 + index * 100;
      h.at(at);
      h.session.onAudio(audioFrame(index, at, index % 10 < 5 ? LOUD : QUIET));
      h.session.onStatus(status(at, true));
      await h.session.onFrame(jpegFrame(index, at));
      await settle();
      if (h.started.length > 0) break;
    }

    expect(h.started).toEqual([{ id: 'c-glasses', mode: 'group' }]);
  });

  it('street mode ignores a speaking companion', async () => {
    const h = harness({ owner: false, faces: [nearFace(0.2)] });
    h.session.onLink('connected');
    h.session.pinMode('street');
    await h.quiet(20, 0);
    for (let index = 0; index < 12; index += 1) {
      h.session.onStatus(status(index * 200, true));
      await h.session.onFrame(jpegFrame(index, index * 200));
    }
    await settle();
    expect(h.started).toHaveLength(0);
  });

  it('ends after the idle window and stops the uplink', async () => {
    const h = harness({ owner: true });
    h.session.onLink('connected');
    await h.quiet(20, 0);
    await h.speak(40, 2_000);
    h.session.onStatus(status(6_000, true));
    await settle();
    expect(h.session.state).toBe('recording');

    h.at(6_000 + GLASSES_CONVERSATION_IDLE_END_MS);
    h.session.tick();
    expect(h.stops()).toBe(1);
    expect(h.session.state).toBe('idle');
    expect(h.session.conversationId).toBeNull();
  });

  it('losing the link clears the pre-roll and the room it was reading', async () => {
    const h = harness();
    h.session.onLink('connected');
    await h.speak(20, 0);
    h.session.pinMode('street');
    expect(h.session.preroll.audioFrames).toBeGreaterThan(0);

    h.session.onLink('disconnected');
    expect(h.session.state).toBe('disconnected');
    expect(h.session.preroll.audioFrames).toBe(0);
    expect(h.session.mode).toBe('group');
  });
});
