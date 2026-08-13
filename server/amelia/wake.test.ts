import { describe, expect, it } from 'vitest';
import { OWNER_ID, type UtteranceEvent } from '../../shared/contracts';
import { detectWake } from './wake';

const utterance = (text: string, overrides: Partial<UtteranceEvent> = {}): UtteranceEvent => ({
  type: 'utterance',
  utterance_id: 'u-1',
  conversation_id: 'c-1',
  person_id: OWNER_ID,
  text,
  start_ms: 0,
  end_ms: 3_200,
  is_final: true,
  ...overrides,
});

describe('detectWake', () => {
  it('extracts the command after the wake phrase', () => {
    expect(detectWake(utterance('Hey Amelia, where did Jerry go?'), 0.9)?.command).toBe(
      'where did Jerry go?',
    );
  });

  it('tolerates casing and stray punctuation', () => {
    // Regression: a bare punctuation token ("--") is a word in the original but
    // vanishes under normalization, so counting words in both strings drifts.
    expect(detectWake(utterance('HEY, AMELIA -- what is up'), 0.9)?.command).toBe('what is up');
  });

  it('takes the command from a mid-turn wake phrase', () => {
    expect(detectWake(utterance('so anyway hey amelia remind me tonight'), 0.9)?.command).toBe(
      'remind me tonight',
    );
  });

  it('rejects a speaker below the owner auth threshold', () => {
    expect(detectWake(utterance('Hey Amelia, do a thing'), 0.4)).toBeNull();
  });

  it('fails closed when Lane A supplies no confidence', () => {
    expect(detectWake(utterance('Hey Amelia, do a thing'))).toBeNull();
  });

  it('rejects a non-owner speaker however confident', () => {
    expect(detectWake(utterance('Hey Amelia, do a thing', { person_id: 'p-jerry' }), 0.99)).toBeNull();
  });

  it('ignores turns without the wake phrase', () => {
    expect(detectWake(utterance('where did Jerry go'), 0.9)).toBeNull();
  });

  it('ignores a bare wake phrase carrying no command', () => {
    expect(detectWake(utterance('hey amelia'), 0.9)).toBeNull();
  });

  it('ignores non-final turns', () => {
    expect(detectWake(utterance('Hey Amelia, do a thing', { is_final: false }), 0.9)).toBeNull();
  });
});
