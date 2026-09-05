import { describe, expect, it } from 'vitest';
import { chooseMicrophoneSource, type GlassesMicrophone, type MicrophoneSource } from './mic-source';

const phone: MicrophoneSource = { acquire: async () => {}, release: () => {} };

const glasses = (available: boolean): GlassesMicrophone => ({
  available,
  acquire: async () => {},
  release: () => {},
});

describe('choosing a microphone', () => {
  it('uses the phone when there is no board', () => {
    expect(chooseMicrophoneSource(null, phone)).toBe(phone);
    expect(chooseMicrophoneSource(undefined, phone)).toBe(phone);
  });

  it('uses the phone while the board is not connected', () => {
    expect(chooseMicrophoneSource(glasses(false), phone)).toBe(phone);
  });

  /** Never both: two mics on one stream reads as everyone saying everything twice. */
  it('replaces the phone with the glasses once the board is there', () => {
    const board = glasses(true);
    expect(chooseMicrophoneSource(board, phone)).toBe(board);
  });
});
