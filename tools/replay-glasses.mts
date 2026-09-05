/**
 * Run the phone's glasses stack on a laptop, against the real server.
 *
 *   bun tools/replay-glasses.mts fixtures/glasses/synthetic --mode phone
 *   bun tools/replay-glasses.mts fixtures/glasses/real/<capture> --swap-faces
 *   bun tools/replay-glasses.mts <dir> --mode server
 *
 * `--mode phone` is the honest one: it builds a real GlassesSession out of the
 * same pure modules the app builds it out of — tracker, active-speaker scorer,
 * setting classifier, pre-roll ring, uploader — hands it a capture frame by
 * frame on the board's own clock, and lets it decide for itself when a
 * conversation has started. What it does not have is Apple Vision, so face
 * detection is adapted onto the sidecar's POST /face/detect; everything else,
 * including the /stream handshake, /faces/observe and /audio/owner-check, is
 * the production path. Events come back over SSE exactly as the app reads them.
 *
 * `--mode server` skips the phone entirely and posts a pre-computed
 * observations.jsonl, which is how you replay a capture whose face detection
 * you have already paid for.
 *
 * Needs the server (`bun run dev`) and the sidecar with FACE_MODELS on.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  AUDIO_FRAME_SAMPLES,
  type AmeliaEvent,
  type CaptureMode,
  type FaceObservationRequest,
  type FaceObservationResponse,
  type GlassesAudioFrame,
  type GlassesJpegFrame,
  type GlassesStatus,
  type Id,
  type OwnerCheckResponse,
  GLASSES_FRAME_AUDIO,
  GLASSES_FRAME_JPEG,
} from '../shared/contracts';
import { GlassesSession, type GlassesSessionEvent } from '../app/glasses/glasses-session';
import type { HandshakeExtras } from '../app/audio/capture-engine';
import type { BoundingBox, NormalizedPoint, Vision, VisionFace } from '../app/glasses/vision';
import {
  energyGate,
  readGlassesFixture,
  type FixtureFrame,
  type GlassesFixture,
} from '../fixtures/glasses/read-fixture';

const AUDIO_FRAME_MS = 100;
const STATUS_INTERVAL_MS = 1_000;
const DEFAULT_SETTLE_MS = 30_000;

interface Options {
  fixtureDir: string;
  mode: 'phone' | 'server';
  baseUrl: string;
  sidecarUrl: string;
  speed: number;
  swapFaces: boolean;
  settleMs: number;
}

function readOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function parseOptions(args: string[]): Options {
  const positional = args.find((arg) => !arg.startsWith('--') && !args[args.indexOf(arg) - 1]?.startsWith('--'));
  const fixture = readOption(args, 'fixture') ?? positional;
  if (!fixture) {
    console.error('usage: bun tools/replay-glasses.mts <fixture dir> [--mode phone|server]');
    process.exit(2);
  }
  return {
    fixtureDir: resolve(fixture),
    mode: readOption(args, 'mode') === 'server' ? 'server' : 'phone',
    baseUrl: readOption(args, 'base-url') ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`,
    sidecarUrl: readOption(args, 'sidecar-url') ?? process.env.SIDECAR_URL ?? 'http://127.0.0.1:8099',
    speed: Number(readOption(args, 'speed') ?? 1),
    swapFaces: args.includes('--swap-faces'),
    settleMs: Number(readOption(args, 'settle') ?? DEFAULT_SETTLE_MS),
  };
}

interface DetectedFace {
  bbox: { x: number; y: number; width: number; height: number };
  det_score: number;
  kps: number[][];
  landmark_2d_106: number[][];
  crop_jpeg_base64: string;
}

interface DetectResponse {
  faces: DetectedFace[];
  width: number;
  height: number;
}

function normalise(bbox: DetectedFace['bbox'], width: number, height: number): BoundingBox {
  return {
    x: bbox.x / width,
    y: bbox.y / height,
    width: bbox.width / width,
    height: bbox.height / height,
  };
}

function point(values: number[] | undefined, width: number, height: number): NormalizedPoint | null {
  if (!values || values.length < 2) return null;
  return { x: (values[0] as number) / width, y: (values[1] as number) / height };
}

/**
 * The mouth region, found from geometry rather than from an index table.
 *
 * InsightFace publishes the five keypoints (both eyes, nose, both mouth
 * corners) but not an authoritative index map for the 106-point set, and
 * guessing indices would be a silent source of wrong openness values. So the
 * mouth points are the landmarks that fall between the two mouth corners and
 * below the nose. That is the outer lip contour rather than the inner one, so
 * the absolute openness runs high — the active-speaker scorer correlates the
 * *change* in openness against audio energy, which this preserves.
 */
function mouthPoints(face: DetectedFace, width: number, height: number): NormalizedPoint[] {
  const nose = point(face.kps[2], width, height);
  const leftCorner = point(face.kps[3], width, height);
  const rightCorner = point(face.kps[4], width, height);
  if (!nose || !leftCorner || !rightCorner) return [];
  const minX = Math.min(leftCorner.x, rightCorner.x);
  const maxX = Math.max(leftCorner.x, rightCorner.x);
  return face.landmark_2d_106
    .map((values) => point(values, width, height))
    .filter((candidate): candidate is NormalizedPoint => candidate !== null)
    .filter((candidate) => candidate.x >= minX && candidate.x <= maxX && candidate.y > nose.y);
}

function toVisionFace(face: DetectedFace, width: number, height: number): VisionFace {
  const leftEye = point(face.kps[0], width, height);
  const rightEye = point(face.kps[1], width, height);
  const mouth = mouthPoints(face, width, height);
  return {
    bbox: normalise(face.bbox, width, height),
    quality: face.det_score,
    cropJpegBase64: face.crop_jpeg_base64 || undefined,
    landmarks:
      leftEye && rightEye
        ? { leftEye: [leftEye], rightEye: [rightEye], innerLips: mouth, outerLips: mouth }
        : undefined,
  };
}

/** Apple Vision's stand-in: the sidecar detector the harness is allowed to use. */
class SidecarVision implements Vision {
  detectCalls = 0;
  facesSeen = 0;
  lastError: string | null = null;

  constructor(private readonly sidecarUrl: string) {}

  async analyzeFrame(jpegBase64: string): Promise<VisionFace[]> {
    this.detectCalls += 1;
    const body = Buffer.from(jpegBase64, 'base64');
    const response = await fetch(`${this.sidecarUrl}/face/detect`, {
      method: 'POST',
      headers: { 'content-type': 'image/jpeg' },
      body,
    });
    if (!response.ok) {
      this.lastError = `${response.status} ${await response.text()}`;
      return [];
    }
    const detected = (await response.json()) as DetectResponse;
    this.facesSeen += detected.faces.length;
    return detected.faces.map((face) => toVisionFace(face, detected.width, detected.height));
  }
}

/**
 * Two people wearing each other's faces.
 *
 * The conflict path — face says one person, voice says another, both sure —
 * has no natural fixture, because provoking it in real life means finding two
 * people the matcher confuses. Exchanging the crops between the two largest
 * faces in every frame provokes it deterministically. With fewer than two
 * faces in frame it does nothing, and says so once.
 */
class FaceSwappingVision implements Vision {
  private warned = false;

  constructor(private readonly inner: SidecarVision) {}

  async analyzeFrame(jpegBase64: string): Promise<VisionFace[]> {
    const faces = await this.inner.analyzeFrame(jpegBase64);
    if (faces.length < 2) {
      if (!this.warned) {
        console.log('--swap-faces: fewer than two faces in frame, nothing to swap');
        this.warned = true;
      }
      return faces;
    }
    const [first, second] = faces as [VisionFace, VisionFace];
    const crop = first.cropJpegBase64;
    first.cropJpegBase64 = second.cropJpegBase64;
    second.cropJpegBase64 = crop;
    return faces;
  }
}

/** The /stream contract, spoken from Bun instead of from the phone. */
class StreamUplink {
  private socket: WebSocket | null = null;
  framesSent = 0;

  constructor(private readonly baseUrl: string) {}

  async start(conversationId: Id, extras?: HandshakeExtras): Promise<void> {
    const socket = new WebSocket(`${this.baseUrl.replace(/^http/, 'ws')}/stream`);
    await new Promise<void>((ready, fail) => {
      socket.onopen = () => ready();
      socket.onerror = () => fail(new Error('could not open /stream'));
    });
    socket.send(JSON.stringify({ conversation_id: conversationId, capture_mode: extras?.capture_mode }));
    this.socket = socket;
  }

  stop(): void {
    this.socket?.close();
    this.socket = null;
  }

  pushSamples(samples: Float32Array): void {
    if (!this.socket || this.socket.readyState !== 1) return;
    this.socket.send(new Uint8Array(samples.buffer as ArrayBuffer, samples.byteOffset, samples.byteLength));
    this.framesSent += 1;
  }
}

class ServerApi {
  observations = 0;
  ownerChecks = 0;

  constructor(private readonly baseUrl: string) {}

  async observeFace(request: FaceObservationRequest): Promise<FaceObservationResponse> {
    this.observations += 1;
    const response = await fetch(`${this.baseUrl}/faces/observe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    if (!response.ok) throw new Error(`/faces/observe ${response.status}: ${await response.text()}`);
    return (await response.json()) as FaceObservationResponse;
  }

  async ownerCheck(pcm: Float32Array): Promise<OwnerCheckResponse> {
    this.ownerChecks += 1;
    const response = await fetch(`${this.baseUrl}/audio/owner-check`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array(pcm.buffer as ArrayBuffer, pcm.byteOffset, pcm.byteLength),
    });
    if (!response.ok) throw new Error(`/audio/owner-check ${response.status}: ${await response.text()}`);
    return (await response.json()) as OwnerCheckResponse;
  }
}

interface Seen {
  identities: AmeliaEvent[];
  presence: AmeliaEvent[];
  conflicts: AmeliaEvent[];
  utterances: Map<string, { text: string; person_id?: string; final: boolean }>;
}

function emptySeen(): Seen {
  return { identities: [], presence: [], conflicts: [], utterances: new Map() };
}

function record(seen: Seen, event: AmeliaEvent): void {
  if (event.type === 'identity') seen.identities.push(event);
  if (event.type === 'presence') seen.presence.push(event);
  if (event.type === 'identity_conflict') seen.conflicts.push(event);
  if (event.type === 'utterance') {
    seen.utterances.set(event.utterance_id, {
      text: event.text,
      person_id: event.person_id,
      final: event.is_final,
    });
  }
}

/** The app's own SSE reader, minus React. */
function readEvents(baseUrl: string, seen: Seen): AbortController {
  const controller = new AbortController();
  void fetch(`${baseUrl}/events`, { signal: controller.signal })
    .then(async (response) => {
      const reader = response.body?.getReader();
      if (!reader) return;
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          const line = frame.split('\n').find((part) => part.startsWith('data: '));
          if (line) record(seen, JSON.parse(line.slice(6)) as AmeliaEvent);
        }
      }
    })
    .catch(() => {});
  return controller;
}

function audioFrameAt(fixture: GlassesFixture, index: number, tsMs: number): GlassesAudioFrame | null {
  const offset = index * AUDIO_FRAME_SAMPLES;
  if (offset + AUDIO_FRAME_SAMPLES > fixture.samples.length) return null;
  return {
    kind: GLASSES_FRAME_AUDIO,
    seq: index & 0xffff,
    ts_ms: tsMs,
    samples: fixture.samples.subarray(offset, offset + AUDIO_FRAME_SAMPLES),
  };
}

function jpegFrameOf(frame: FixtureFrame): GlassesJpegFrame {
  return {
    kind: GLASSES_FRAME_JPEG,
    seq: frame.seq,
    ts_ms: frame.ts_ms,
    width: frame.width,
    height: frame.height,
    jpeg: frame.jpeg,
  };
}

function statusAt(tsMs: number, speaking: boolean): GlassesStatus {
  return {
    type: 'status',
    ts_ms: tsMs,
    die_c: 42,
    camera: speaking ? 'burst' : 'idle',
    vad: speaking,
    fps: speaking ? 8 : 0,
    audio_drops: 0,
    frame_drops: 0,
    heap_free: 214_000,
    psram_free: 7_800_000,
  };
}

function describe(event: GlassesSessionEvent): string | null {
  if (event.type === 'state') return `session ${event.state}${event.conversationId ? ` ${event.conversationId}` : ''}`;
  if (event.type === 'mode') return `mode ${event.mode}${event.pinned ? ' (pinned)' : ''}`;
  if (event.type === 'owner-check') {
    return `owner check ${event.result.owner ? 'yes' : 'no'} at ${event.result.score.toFixed(3)} over ${event.result.duration_ms} ms`;
  }
  if (event.type === 'observation') {
    const response = event.response;
    const score = response.score === undefined ? '' : ` score ${response.score.toFixed(3)}`;
    return `face ${response.track_id}: ${response.decision} ${response.name ?? response.person_id ?? ''}${score}`.trim();
  }
  return null;
}

function buildSession(options: Options, api: ServerApi, uplink: StreamUplink, vision: Vision, clock: { ms: number }): GlassesSession {
  return new GlassesSession({
    vision,
    api,
    engine: uplink,
    requestBurst: (durationMs) => console.log(`  requested a ${durationMs} ms burst`),
    toBase64: (bytes) => Buffer.from(bytes).toString('base64'),
    emit: (event) => {
      const line = describe(event);
      if (line) console.log(`  ${line}`);
    },
    now: () => clock.ms,
    newConversationId: () => `replay-${Date.now()}`,
  });
}

async function pace(realMs: number): Promise<void> {
  if (realMs > 0) await new Promise((resume) => setTimeout(resume, realMs));
}

async function runPhone(options: Options, fixture: GlassesFixture, seen: Seen): Promise<void> {
  const gate = energyGate(fixture.samples, fixture.sampleRate);
  const api = new ServerApi(options.baseUrl);
  const uplink = new StreamUplink(options.baseUrl);
  const detector = new SidecarVision(options.sidecarUrl);
  const vision: Vision = options.swapFaces ? new FaceSwappingVision(detector) : detector;
  const clock = { ms: 0 };
  const session = buildSession(options, api, uplink, vision, clock);

  session.onLink('connected');
  let frameCursor = 0;
  let nextStatusMs = 0;
  let nextTickMs = 0;

  for (let index = 0; ; index += 1) {
    clock.ms = index * AUDIO_FRAME_MS;
    const audio = audioFrameAt(fixture, index, clock.ms);
    if (!audio) break;
    session.onAudio(audio);

    while (frameCursor < fixture.frames.length && (fixture.frames[frameCursor] as FixtureFrame).ts_ms <= clock.ms) {
      await session.onFrame(jpegFrameOf(fixture.frames[frameCursor] as FixtureFrame));
      frameCursor += 1;
    }
    if (clock.ms >= nextStatusMs) {
      session.onStatus(statusAt(clock.ms, gate.speechAt(clock.ms)));
      nextStatusMs += STATUS_INTERVAL_MS;
    }
    if (clock.ms >= nextTickMs) {
      session.tick();
      nextTickMs += STATUS_INTERVAL_MS;
    }
    await pace(AUDIO_FRAME_MS / options.speed);
  }

  session.stop();
  session.onLink('disconnected');
  console.log(
    `\npushed ${(fixture.samples.length / fixture.sampleRate).toFixed(1)}s of audio, ` +
      `${uplink.framesSent} stream frames, ${api.observations} observations, ${api.ownerChecks} owner checks`,
  );
  console.log(`vision: ${detector.detectCalls} detect calls, ${detector.facesSeen} faces${detector.lastError ? `, last error ${detector.lastError}` : ''}`);
  void seen;
}

async function runServer(options: Options, seen: Seen): Promise<void> {
  const path = join(options.fixtureDir, 'observations.jsonl');
  let lines: string[];
  try {
    lines = readFileSync(path, 'utf8').split('\n').filter((line) => line.trim().length > 0);
  } catch {
    console.error(`--mode server needs ${path}, which is not there.`);
    process.exit(2);
  }
  const api = new ServerApi(options.baseUrl);
  for (const line of lines) {
    const request = JSON.parse(line) as FaceObservationRequest & { file?: string };
    if (!request.crop_jpeg_base64 && request.file) {
      request.crop_jpeg_base64 = readFileSync(join(options.fixtureDir, request.file)).toString('base64');
    }
    const response = await api.observeFace(request);
    console.log(`  face ${response.track_id}: ${response.decision} ${response.name ?? response.person_id ?? ''}`.trimEnd());
  }
  console.log(`\nposted ${lines.length} observations`);
  void seen;
}

function report(seen: Seen): void {
  console.log('\n================ result ================');
  console.log(`identities      ${seen.identities.length}`);
  for (const event of seen.identities) {
    const identity = event as { person_id: string; name?: string; confidence: string; source?: string; score?: number };
    console.log(
      `  ${identity.name ?? identity.person_id.slice(0, 8)}  ${identity.confidence}  source ${identity.source ?? 'voice'}` +
        `${identity.score === undefined ? '' : `  ${identity.score.toFixed(3)}`}`,
    );
  }

  console.log(`presence        ${seen.presence.length}`);
  for (const event of seen.presence) {
    const presence = event as { name: string; track_state: string; source: string; speaking: boolean; is_near: boolean };
    console.log(
      `  ${presence.name}  ${presence.track_state}  source ${presence.source}` +
        `${presence.speaking ? '  speaking' : ''}${presence.is_near ? '  near' : ''}`,
    );
  }

  console.log(`conflicts       ${seen.conflicts.length}`);
  for (const event of seen.conflicts) {
    const conflict = event as { face_person_id: string; voice_person_id: string; face_score: number; voice_score: number };
    console.log(
      `  face ${conflict.face_person_id.slice(0, 8)} (${conflict.face_score.toFixed(3)}) vs ` +
        `voice ${conflict.voice_person_id.slice(0, 8)} (${conflict.voice_score.toFixed(3)})`,
    );
  }

  const finals = [...seen.utterances.values()].filter((utterance) => utterance.final);
  console.log(`utterances      ${seen.utterances.size} (${finals.length} final)`);
  for (const utterance of finals) {
    if (!utterance.text.trim()) continue;
    console.log(`  ${utterance.person_id ? utterance.person_id.slice(0, 8) : '········'}  ${utterance.text}`);
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const fixture = readGlassesFixture(options.fixtureDir);
  console.log(`fixture  ${fixture.dir}`);
  console.log(`         ${(fixture.durationMs / 1000).toFixed(1)}s, ${fixture.frames.length} frames, ${options.speed}x pace`);
  console.log(`server   ${options.baseUrl}`);
  console.log(`sidecar  ${options.sidecarUrl}`);
  console.log(`mode     ${options.mode}${options.swapFaces ? ' with swapped faces' : ''}\n`);

  const seen = emptySeen();
  const events = readEvents(options.baseUrl, seen);

  if (options.mode === 'phone') await runPhone(options, fixture, seen);
  else await runServer(options, seen);

  console.log(`\nsettling for ${options.settleMs / 1000}s while the final pass runs`);
  await pace(options.settleMs);
  events.abort();
  report(seen);
}

void main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
