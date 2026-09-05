/**
 * Talk to the real board and write down what it says.
 *
 * Join the `amelia-glasses` softAP, then:
 *
 *   bun tools/glasses-smoke.mts --duration 30 --burst 5000
 *
 * It parses the socket with app/glasses/protocol.ts — the same codec the phone
 * runs, so a capture that reads correctly here reads correctly there — and
 * writes fixtures/glasses/real/<stamp>/ with audio.wav, frames/NNNNNN.jpg,
 * frames.jsonl and status.jsonl. That directory is the fixture format the
 * replay tools consume.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  GLASSES_DEFAULT_HOST,
  GLASSES_FRAME_AUDIO,
  GLASSES_WS_PATH,
  GLASSES_WS_PORT,
  type GlassesFrame,
  type GlassesStatus,
} from '../shared/contracts';
import {
  encodeControl,
  parseGlassesFrame,
  parseGlassesMessage,
} from '../app/glasses/protocol';

interface Options {
  host: string;
  durationMs: number;
  burstMs: number;
  outDir: string;
}

function readOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function stampNow(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function parseOptions(args: string[]): Options {
  const host = readOption(args, 'host') ?? GLASSES_DEFAULT_HOST;
  return {
    host,
    durationMs: Number(readOption(args, 'duration') ?? 30) * 1000,
    burstMs: Number(readOption(args, 'burst') ?? 0),
    outDir: readOption(args, 'out') ?? join('fixtures/glasses/real', stampNow()),
  };
}

/** 16-bit mono PCM, header written once the length is known. */
function encodeWav(samples: Int16Array, sampleRate: number): Buffer {
  const data = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function concatSamples(chunks: Int16Array[]): Int16Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const all = new Int16Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.length;
  }
  return all;
}

/**
 * Sequence numbers are per kind and wrap at 16 bits, so a gap is the count of
 * frames the board threw away before they ever reached the socket.
 */
class SeqGaps {
  private last: number | null = null;
  missing = 0;

  observe(seq: number): void {
    if (this.last !== null) {
      this.missing += (seq - this.last - 1 + 0x10000) % 0x10000;
    }
    this.last = seq;
  }
}

class Capture {
  readonly audioChunks: Int16Array[] = [];
  readonly frameLines: string[] = [];
  readonly statusLines: string[] = [];
  readonly audioGaps = new SeqGaps();
  readonly frameGaps = new SeqGaps();
  sampleRate = 16000;
  bytesThisSecond = 0;
  framesThisSecond = 0;
  frameCount = 0;
  lastStatus: GlassesStatus | null = null;

  constructor(readonly dir: string) {
    mkdirSync(join(dir, 'frames'), { recursive: true });
  }

  addAudio(seq: number, tsMs: number, samples: Int16Array): void {
    this.audioGaps.observe(seq);
    this.audioChunks.push(samples);
    void tsMs;
  }

  addJpeg(frame: Extract<GlassesFrame, { width: number }>): void {
    this.frameGaps.observe(frame.seq);
    const name = `${String(this.frameCount).padStart(6, '0')}.jpg`;
    writeFileSync(join(this.dir, 'frames', name), frame.jpeg);
    this.frameLines.push(
      JSON.stringify({
        file: `frames/${name}`,
        seq: frame.seq,
        ts_ms: frame.ts_ms,
        width: frame.width,
        height: frame.height,
        bytes: frame.jpeg.byteLength,
      }),
    );
    this.frameCount += 1;
    this.framesThisSecond += 1;
  }

  addStatus(status: GlassesStatus): void {
    this.lastStatus = status;
    this.statusLines.push(JSON.stringify(status));
  }

  flush(): void {
    writeFileSync(
      join(this.dir, 'audio.wav'),
      encodeWav(concatSamples(this.audioChunks), this.sampleRate),
    );
    writeFileSync(join(this.dir, 'frames.jsonl'), `${this.frameLines.join('\n')}\n`);
    writeFileSync(join(this.dir, 'status.jsonl'), `${this.statusLines.join('\n')}\n`);
  }
}

function handleBinary(capture: Capture, data: ArrayBuffer): void {
  capture.bytesThisSecond += data.byteLength;
  const frame = parseGlassesFrame(data);
  if (frame === null) {
    console.warn('dropped a frame the parser could not read');
    return;
  }
  if (frame.kind === GLASSES_FRAME_AUDIO) {
    capture.addAudio(frame.seq, frame.ts_ms, frame.samples);
    return;
  }
  capture.addJpeg(frame);
}

function handleText(capture: Capture, text: string): void {
  capture.bytesThisSecond += text.length;
  const message = parseGlassesMessage(text);
  if (message === null) return;
  if (message.type === 'hello') {
    capture.sampleRate = message.sample_rate;
    console.log(
      `hello: protocol ${message.protocol}, ${message.firmware}, ` +
        `${message.sample_rate} Hz, ${message.frame_samples}-sample frames`,
    );
    return;
  }
  capture.addStatus(message);
}

function reportLine(capture: Capture): string {
  const status = capture.lastStatus;
  const kbps = ((capture.bytesThisSecond * 8) / 1000).toFixed(0);
  const head = `${capture.framesThisSecond} fps | ${kbps} kbps`;
  if (status === null) return `${head} | waiting for a status message`;
  return (
    `${head} | die ${status.die_c.toFixed(1)} C | ${status.camera} | ` +
    `vad ${status.vad ? 'speech' : 'quiet'} | ` +
    `drops a${status.audio_drops}/f${status.frame_drops} | ` +
    `gaps a${capture.audioGaps.missing}/f${capture.frameGaps.missing}`
  );
}

function startReporting(capture: Capture): ReturnType<typeof setInterval> {
  return setInterval(() => {
    console.log(reportLine(capture));
    capture.bytesThisSecond = 0;
    capture.framesThisSecond = 0;
  }, 1000);
}

function summarise(capture: Capture, options: Options): void {
  const seconds = options.durationMs / 1000;
  console.log(
    `\nwrote ${capture.dir}: ${capture.frameCount} frames, ` +
      `${(capture.audioChunks.length * 100) / 1000}s of audio over ${seconds}s`,
  );
  console.log(
    `sequence gaps: ${capture.audioGaps.missing} audio, ${capture.frameGaps.missing} jpeg`,
  );
}

async function run(options: Options): Promise<number> {
  const url = `ws://${options.host}:${GLASSES_WS_PORT}${GLASSES_WS_PATH}`;
  console.log(`connecting to ${url}`);
  const socket = new WebSocket(url);
  socket.binaryType = 'arraybuffer';

  const capture = new Capture(options.outDir);
  let reporter: ReturnType<typeof setInterval> | undefined;
  let finished = false;

  return new Promise<number>((resolve) => {
    const finish = (code: number) => {
      if (finished) return;
      finished = true;
      if (reporter !== undefined) clearInterval(reporter);
      capture.flush();
      summarise(capture, options);
      socket.close();
      resolve(code);
    };

    socket.onopen = () => {
      console.log('connected');
      if (options.burstMs > 0) {
        socket.send(encodeControl({ type: 'burst', duration_ms: options.burstMs }));
        console.log(`asked for a ${options.burstMs} ms burst`);
      }
      reporter = startReporting(capture);
      setTimeout(() => finish(0), options.durationMs);
    };

    socket.onmessage = (event) => {
      if (typeof event.data === 'string') {
        handleText(capture, event.data);
        return;
      }
      handleBinary(capture, event.data as ArrayBuffer);
    };

    socket.onerror = () => {
      console.error(`could not talk to ${url}. Is the Mac on the amelia-glasses network?`);
      finish(1);
    };

    socket.onclose = () => finish(0);
  });
}

process.exit(await run(parseOptions(process.argv.slice(2))));
