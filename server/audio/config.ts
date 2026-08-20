/**
 * Every tunable the audio lane reads, resolved once and reported out loud.
 *
 * The values in shared/contracts.ts were measured on real room audio. An
 * environment file can still override them — venues differ — but an override
 * that loosens a measured floor is refused, not obeyed. `server/.env` used to
 * quietly set EMBED_MIN_MS=1600, which put every identification squarely in the
 * ~27% equal-error zone, and nothing anywhere said so. Overrides are now
 * printed on first read, and unsafe ones are printed and ignored.
 */

import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ATTRIBUTION_THRESHOLD,
  CONFIRMED_SPEECH_MS,
  EMBED_MIN_MS,
  PROVISIONAL_SPEECH_MS,
} from '../../shared/contracts'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')

export interface AudioConfig {
  /** Pooled speech below which a cluster is not embedded for identification. */
  embedMinMs: number
  /** Pooled speech before a hedged name may be shown. */
  provisionalSpeechMs: number
  /** Pooled speech before an identification is treated as settled. */
  confirmedSpeechMs: number
  /** Cosine floor for a match, on session-mean-subtracted embeddings. */
  attributionThreshold: number
  /** Server-VAD trailing silence. Short values shatter turns; see below. */
  silenceMs: number
  sidecarUrl: string
  /** Where session audio is retained so the final pass has something to send. */
  retainDir: string
  /** Hard cap on retained audio. Beyond it the recorder stops writing. */
  retainMaxMs: number
  retainEnabled: boolean
  /** Whether to rebuild the transcript from whisper and pyannote when recording stops. */
  finalPassEnabled: boolean
  /** Whether to search long VAD turns for a speaker change. See session.ts. */
  windowSplitEnabled: boolean
  /**
   * Whether to bias transcription toward known people's names.
   *
   * Off, and off on measurement rather than on caution.
   *
   * READ THIS BEFORE TURNING IT ON. The cost is not noise, and it is not
   * hallucinated names — the failure everyone expects did not happen. The cost
   * is DELETION. A prompted transcript silently loses whole utterances, and a
   * missing sentence leaves no trace to notice: nothing is misspelled, nothing
   * looks wrong, the line simply is not there. Facts, promises and identity
   * are all extracted downstream from this text, so a question somebody asked
   * and this file dropped is a fact that will never exist and no one will ever
   * go looking for. A misspelled name is visible and a user fixes it in a tap;
   * a deleted sentence is invisible and permanent. That asymmetry is the
   * reason for the default, not the size of the numbers below.
   *
   * Measured on a 140 s
   * excerpt of the dorm recording (6:40-9:00), whisper-1, three runs per
   * condition, with five decoy terms in the vocabulary that nobody says:
   *
   *   bare                      333 words/run avg (338/322/338)
   *   vocabulary prompt         274-288 words/run, byte-identical across runs
   *   decoy insertions          0 of 5 decoys, in 9 prompted runs
   *   "Alara" (a real name)     0/3 runs bare, 3/3 runs prompted
   *
   * So the prompt does exactly what it promises on names — "Alarm Martini"
   * becomes "Alara Martini" every time — and it costs 15% of the words. The
   * losses are not filler. Whole utterances vanish: "You know what's
   * beautiful, though?", "How would you understand that?", "The only thing I
   * would be focused on is..." all present bare and absent prompted. A
   * transcript that quietly drops a question somebody asked is worse than one
   * that spells their friend's name wrong, because facts are extracted from it
   * and the missing sentence leaves no trace to notice.
   *
   * The decoy result is worth keeping, and worth not over-reading: with ten
   * terms this did not invent a name, but that was measured at ten terms on one
   * excerpt, and it says nothing about a vocabulary of fifty.
   *
   * Turning this on needs someone to find a prompt format that fixes names
   * WITHOUT shortening the transcript, and to demonstrate it by word count
   * against a bare run — not by reading the names and stopping there, which is
   * how this nearly shipped. Plain comma-separated terms were the best of the
   * three formats tried on names and the worst on length.
   */
  vocabularyEnabled: boolean
  /** Transcription model for the final pass. Timings and words, not speakers. */
  whisperModel: string
  openaiApiKey: string
}

const notes: string[] = []

/**
 * A floor that exists because it was measured. Raising it is the caller's
 * business; lowering it is a request to be wrong more often, so it is refused.
 */
function atLeast(name: string, measured: number, env: Record<string, string | undefined>): number {
  const raw = env[name]
  if (raw === undefined || raw === '') return measured
  const value = Number(raw)
  if (!Number.isFinite(value)) {
    notes.push(`${name}="${raw}" is not a number; using the measured ${measured}`)
    return measured
  }
  if (value < measured) {
    notes.push(
      `${name}=${value} is below the measured floor ${measured} and was ignored. ` +
        'Re-measure with `bun run eval:speakers` before lowering it.',
    )
    return measured
  }
  if (value !== measured) notes.push(`${name}=${value} overrides the measured ${measured}`)
  return value
}

function number(name: string, fallback: number, env: Record<string, string | undefined>): number {
  const value = Number(env[name] ?? fallback)
  if (!Number.isFinite(value)) return fallback
  if (value !== fallback) notes.push(`${name}=${value} overrides the default ${fallback}`)
  return value
}

function flag(name: string, fallback: boolean, env: Record<string, string | undefined>): boolean {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  return raw !== '0' && raw.toLowerCase() !== 'false' && raw.toLowerCase() !== 'off'
}

/**
 * 200 ms of trailing silence splits mid-sentence breathing into separate turns.
 * Measured on the dorm recording, the last twelve seconds fragmented into nine
 * turns of one to three words each, and a two-word turn carries no usable
 * voiceprint. Turn boundaries stopped being load-bearing once the clusterer
 * pooled turns by voice, so the aggressive value costs segmentation and buys
 * nothing.
 */
const DEFAULT_SILENCE_MS = 500

/**
 * Retained audio is 16 kHz mono int16 on disk: 32 kB/s, 115 MB/hour. (The
 * "230 MB/hour" this comment used to quote was the float32 in-memory figure,
 * not what SessionRecorder writes, so the cap was set from a number twice the
 * real one.)
 *
 * The old 45-minute cap was below the length of the first real conversation
 * this product ever recorded — 48 min 22 s of dorm room — so the very first
 * genuine use would have silently lost its ending. A 48-minute conversation is
 * a normal case, not an outlier, and the cap has to be set from what the disk
 * costs rather than from what seemed long: four hours is 461 MB, which is one
 * afternoon's recording and less than a phone video of the same length.
 *
 * The cap is a disk guard, not a product limit. Hitting it is reported rather
 * than absorbed — see SessionRecorder.isTruncated and FinalPassReport.
 */
const DEFAULT_RETAIN_MAX_MS = 4 * 60 * 60 * 1000

export function readAudioConfig(env: Record<string, string | undefined> = process.env): AudioConfig {
  notes.length = 0
  const retainDirRaw = env.AUDIO_RETAIN_DIR ?? '.recordings'
  return {
    embedMinMs: atLeast('EMBED_MIN_MS', EMBED_MIN_MS, env),
    provisionalSpeechMs: atLeast('PROVISIONAL_SPEECH_MS', PROVISIONAL_SPEECH_MS, env),
    confirmedSpeechMs: atLeast('CONFIRMED_SPEECH_MS', CONFIRMED_SPEECH_MS, env),
    attributionThreshold: number('ATTRIBUTION_THRESHOLD', ATTRIBUTION_THRESHOLD, env),
    silenceMs: number('OPENAI_SILENCE_MS', DEFAULT_SILENCE_MS, env),
    sidecarUrl: env.SIDECAR_URL ?? 'http://127.0.0.1:8099',
    retainDir: isAbsolute(retainDirRaw) ? retainDirRaw : join(REPO_ROOT, retainDirRaw),
    retainMaxMs: number('AUDIO_RETAIN_MAX_MS', DEFAULT_RETAIN_MAX_MS, env),
    retainEnabled: flag('AUDIO_RETAIN', true, env),
    finalPassEnabled: flag('AUDIO_FINAL_PASS', true, env),
    windowSplitEnabled: flag('AUDIO_WINDOW_SPLIT', true, env),
    vocabularyEnabled: flag('AUDIO_ASR_VOCABULARY', false, env),
    whisperModel: env.OPENAI_WHISPER_MODEL ?? 'whisper-1',
    openaiApiKey: env.OPENAI_API_KEY ?? '',
  }
}

let cached: AudioConfig | null = null

/** Resolved once per process, and announced the first time anything asks. */
export function audioConfig(): AudioConfig {
  if (cached) return cached
  cached = readAudioConfig()
  for (const note of notes) console.warn(`audio config: ${note}`)
  return cached
}

/** Tests and the replay harness re-resolve after changing the environment. */
export function resetAudioConfig(): void {
  cached = null
}

/** The overrides the last read found, for the harness to print alongside numbers. */
export function configNotes(): readonly string[] {
  return [...notes]
}
