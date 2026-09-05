/**
 * Which microphone a recording listens to.
 *
 * The glasses mic replaces the phone's when the board is connected, never runs
 * alongside it. Two mics on one conversation would be two copies of the same
 * room arriving on one stream, which diarisation reads as two speakers saying
 * everything twice.
 *
 * With no glasses this hands back exactly the phone source it was given, so a
 * phone that has never seen a board behaves as it always has.
 */

export interface MicrophoneSource {
  acquire(onSamples: (samples: Float32Array) => void): Promise<void>;
  release(): void;
}

export interface GlassesMicrophone extends MicrophoneSource {
  /** False whenever the link is not up, which is most of the time. */
  readonly available: boolean;
}

export function chooseMicrophoneSource(
  glasses: GlassesMicrophone | null | undefined,
  phone: MicrophoneSource,
): MicrophoneSource {
  return glasses?.available ? glasses : phone;
}
