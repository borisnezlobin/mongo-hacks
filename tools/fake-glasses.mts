/**
 * The board, without the board.
 *
 *   bun tools/fake-glasses.mts --fixture fixtures/glasses/synthetic --loop
 *
 * Serves a WebSocket that speaks the firmware's protocol byte for byte and
 * replays a capture directory at realtime: hello on connect, int16 audio in
 * 1,600-sample frames, JPEG frames paced the way the camera duty cycle paces
 * them, a status message every second, and the four control messages honoured
 * rather than ignored. Point the app's glasses-host setting at it and the phone
 * cannot tell the difference, which is the whole point — the ESP32 is one
 * device on one desk, and everything downstream of it should be developable
 * without waiting for a turn with it.
 *
 * The status line is regenerated rather than replayed: `vad` comes from an
 * energy gate over the fixture's own audio and `die_c` drifts with the camera
 * state, so a fixture recorded on a cold board still exercises the thermal and
 * voice-activity paths.
 */

import { resolve } from 'node:path';

import {
  GLASSES_BURST_FPS,
  GLASSES_IDLE_POLL_MS,
  GLASSES_SPEECH_HANGOVER_MS,
  GLASSES_THERMAL_HALT_C,
  GLASSES_THERMAL_RESUME_C,
  GLASSES_WS_PATH,
  AUDIO_FRAME_SAMPLES,
  type GlassesControl,
  type GlassesHello,
  type GlassesStatus,
} from '../shared/contracts';
import { encodeAudioFrame, encodeJpegFrame } from '../app/glasses/protocol';
import {
  energyGate,
  readGlassesFixture,
  type EnergyGate,
  type FixtureFrame,
  type GlassesFixture,
} from '../fixtures/glasses/read-fixture';

const AUDIO_FRAME_MS = 100;
const STATUS_INTERVAL_MS = 1_000;
const DEFAULT_PORT = 8081;
const PROTOCOL_VERSION = 1;
/** Rough thermal model: the camera is what heats the die, and it cools slowly. */
const HEAT_PER_SECOND_C = 0.4;
const COOL_PER_SECOND_C = 0.15;
const AMBIENT_C = 38;

interface Options {
  fixtureDir: string;
  port: number;
  loop: boolean;
}

function readOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function parseOptions(args: string[]): Options {
  const fixture = readOption(args, 'fixture') ?? args.find((arg) => !arg.startsWith('--'));
  if (!fixture) {
    console.error('usage: bun tools/fake-glasses.mts --fixture <dir> [--port 8081] [--loop]');
    process.exit(2);
  }
  return {
    fixtureDir: resolve(fixture),
    port: Number(readOption(args, 'port') ?? DEFAULT_PORT),
    loop: args.includes('--loop'),
  };
}

function helloMessage(fixture: GlassesFixture): GlassesHello {
  return {
    type: 'hello',
    protocol: PROTOCOL_VERSION,
    firmware: 'fake-glasses',
    sample_rate: fixture.sampleRate,
    frame_samples: AUDIO_FRAME_SAMPLES,
  };
}

/** Everything one connected client is in the middle of doing. */
class Replay {
  private audioSeq = 0;
  private frameSeq = 0;
  private frameCursor = 0;
  private elapsedMs = 0;
  private nextFrameDueMs = 0;
  private nextStatusDueMs = 0;
  private burstUntilMs = -Infinity;
  private burstFps = GLASSES_BURST_FPS;
  private idlePollMs = GLASSES_IDLE_POLL_MS;
  private lastSpeechMs = -Infinity;
  private dieC = AMBIENT_C + 3;
  private framesThisSecond = 0;
  private audioDrops = 0;
  private frameDrops = 0;

  constructor(
    private readonly fixture: GlassesFixture,
    private readonly gate: EnergyGate,
    private readonly loop: boolean,
  ) {}

  get speaking(): boolean {
    return this.gate.speechAt(this.elapsedMs % Math.max(1, this.fixture.durationMs));
  }

  /** Bursting while there is speech, for a hangover after it, or on request. */
  get camera(): GlassesStatus['camera'] {
    if (this.dieC >= GLASSES_THERMAL_HALT_C) return 'thermal_halt';
    return this.bursting ? 'burst' : 'idle';
  }

  private get bursting(): boolean {
    if (this.elapsedMs < this.burstUntilMs) return true;
    return this.elapsedMs - this.lastSpeechMs <= GLASSES_SPEECH_HANGOVER_MS;
  }

  private get frameIntervalMs(): number {
    return this.bursting ? 1_000 / this.burstFps : this.idlePollMs;
  }

  apply(control: GlassesControl): string {
    if (control.type === 'burst') {
      this.burstUntilMs = this.elapsedMs + control.duration_ms;
      return `burst for ${control.duration_ms} ms`;
    }
    if (control.type === 'set_fps') {
      this.burstFps = Math.max(1, Math.min(GLASSES_BURST_FPS, control.fps));
      return `burst fps now ${this.burstFps}`;
    }
    if (control.type === 'set_idle_poll_ms') {
      this.idlePollMs = Math.max(AUDIO_FRAME_MS, control.interval_ms);
      return `idle poll now ${this.idlePollMs} ms`;
    }
    return 'ping';
  }

  /** One 100 ms slice of board time. Returns what the socket should send. */
  advance(): { audio: ArrayBuffer | null; frames: ArrayBuffer[]; status: GlassesStatus | null } {
    const audio = this.nextAudioFrame();
    if (this.speaking) this.lastSpeechMs = this.elapsedMs;
    this.driftTemperature();

    const frames: ArrayBuffer[] = [];
    while (this.elapsedMs >= this.nextFrameDueMs && this.fixture.frames.length > 0) {
      frames.push(this.nextJpegFrame());
      this.nextFrameDueMs += this.frameIntervalMs;
    }

    const status = this.elapsedMs >= this.nextStatusDueMs ? this.snapshot() : null;
    if (status) {
      this.nextStatusDueMs += STATUS_INTERVAL_MS;
      this.framesThisSecond = 0;
    }

    this.elapsedMs += AUDIO_FRAME_MS;
    return { audio, frames, status };
  }

  get finished(): boolean {
    return !this.loop && this.audioSeq * AUDIO_FRAME_SAMPLES >= this.fixture.samples.length;
  }

  private nextAudioFrame(): ArrayBuffer | null {
    const total = this.fixture.samples.length;
    if (total === 0) return null;
    const offset = (this.audioSeq * AUDIO_FRAME_SAMPLES) % total;
    if (!this.loop && offset + AUDIO_FRAME_SAMPLES > total) return null;
    const slice = this.fixture.samples.subarray(offset, offset + AUDIO_FRAME_SAMPLES);
    const buffer = encodeAudioFrame(this.audioSeq & 0xffff, this.elapsedMs, slice);
    this.audioSeq += 1;
    return buffer;
  }

  private nextJpegFrame(): ArrayBuffer {
    const frame = this.fixture.frames[this.frameCursor % this.fixture.frames.length] as FixtureFrame;
    this.frameCursor += 1;
    this.framesThisSecond += 1;
    const buffer = encodeJpegFrame(
      this.frameSeq & 0xffff,
      this.elapsedMs,
      frame.width,
      frame.height,
      frame.jpeg,
    );
    this.frameSeq += 1;
    return buffer;
  }

  /**
   * Heat is the constraint the firmware is shaped around, so the fake board
   * has to be able to reach the halt temperature — otherwise nothing
   * downstream of `thermal_halt` is ever exercised outside a unit test.
   */
  private driftTemperature(): void {
    const seconds = AUDIO_FRAME_MS / 1_000;
    const heating = this.camera === 'burst';
    this.dieC += heating ? HEAT_PER_SECOND_C * seconds : -COOL_PER_SECOND_C * seconds;
    this.dieC = Math.max(AMBIENT_C, Math.min(GLASSES_THERMAL_HALT_C + 1, this.dieC));
    if (this.camera === 'thermal_halt' && this.dieC <= GLASSES_THERMAL_RESUME_C) {
      this.dieC = GLASSES_THERMAL_RESUME_C - 0.1;
    }
  }

  private snapshot(): GlassesStatus {
    return {
      type: 'status',
      ts_ms: this.elapsedMs,
      die_c: Math.round(this.dieC * 10) / 10,
      camera: this.camera,
      vad: this.speaking,
      fps: this.framesThisSecond,
      audio_drops: this.audioDrops,
      frame_drops: this.frameDrops,
      heap_free: 214_000,
      psram_free: 7_800_000,
      rssi: -47,
    };
  }
}

interface SocketData {
  replay: Replay;
  ticker: ReturnType<typeof setInterval> | null;
}

/**
 * The slice of Bun's server API this tool uses.
 *
 * `@types/bun` is not a dependency here and package.json belongs to another
 * work package, so the three shapes are declared locally rather than pulling a
 * dependency into a shared file. Delete this block if bun-types ever lands.
 */
interface BoardSocket {
  data: SocketData;
  send(payload: string | ArrayBuffer): void;
  close(): void;
}

interface BoardServer {
  port: number;
  upgrade(request: Request, options: { data: SocketData }): boolean;
}

declare const Bun: {
  serve(options: {
    hostname?: string;
    port: number;
    fetch(request: Request, server: BoardServer): Response | undefined;
    websocket: {
      open(socket: BoardSocket): void;
      message(socket: BoardSocket, message: string | Uint8Array): void;
      close(socket: BoardSocket): void;
    };
  }): BoardServer;
};

function parseControl(text: string): GlassesControl | null {
  try {
    const parsed = JSON.parse(text) as GlassesControl;
    return typeof parsed?.type === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

function main(): void {
  const options = parseOptions(process.argv.slice(2));
  const fixture = readGlassesFixture(options.fixtureDir);
  const gate = energyGate(fixture.samples, fixture.sampleRate);
  console.log(`fixture ${fixture.dir}`);
  console.log(
    `        ${(fixture.durationMs / 1000).toFixed(1)}s, ${fixture.frames.length} frames, ` +
      `${fixture.sampleRate} Hz${options.loop ? ', looping' : ''}`,
  );

  const server = Bun.serve({
    hostname: '0.0.0.0',
    port: options.port,
    fetch(request, bun) {
      const url = new URL(request.url);
      if (url.pathname !== GLASSES_WS_PATH) return new Response('not found', { status: 404 });
      const upgraded = bun.upgrade(request, {
        data: { replay: new Replay(fixture, gate, options.loop), ticker: null },
      });
      return upgraded ? undefined : new Response('expected a websocket', { status: 400 });
    },
    websocket: {
      open(socket) {
        console.log('client connected');
        socket.send(JSON.stringify(helloMessage(fixture)));
        socket.data.ticker = setInterval(() => {
          const { audio, frames, status } = socket.data.replay.advance();
          if (audio) socket.send(audio);
          for (const frame of frames) socket.send(frame);
          if (status) socket.send(JSON.stringify(status));
          if (socket.data.replay.finished) socket.close();
        }, AUDIO_FRAME_MS);
      },
      message(socket, message) {
        const control = typeof message === 'string' ? parseControl(message) : null;
        if (!control) return;
        console.log(`control ${control.type}: ${socket.data.replay.apply(control)}`);
      },
      close(socket) {
        if (socket.data.ticker) clearInterval(socket.data.ticker);
        console.log('client gone');
      },
    },
  });

  console.log(`listening on ws://0.0.0.0:${server.port}${GLASSES_WS_PATH}`);
}

main();
