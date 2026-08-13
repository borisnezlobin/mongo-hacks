import { describe, expect, it } from 'vitest';
import { OWNER_ID, type UtteranceEvent } from '../../shared/contracts';
import { OWNER_PERSON_ID, detectWake } from './wake';

const utterance = (text: string, overrides: Partial<UtteranceEvent> = {}): UtteranceEvent => ({
  type: 'utterance',
  utterance_id: 'u-1',
  conversation_id: 'c-1',
  person_id: OWNER_PERSON_ID,
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

  // Regression: punctuation ABUTTING the wake phrase makes "Amelia—remind" a
  // single whitespace token. Deriving offsets by splitting that token gave
  // every sub-word the token's end, so the command lost its first word — an em
  // dash straight off an STT silently ate the verb.
  it.each([
    ['Hey Amelia—remind me tonight to email Jerry', 'remind me tonight to email Jerry'],
    ['Hey Amelia-remind me tonight', 'remind me tonight'],
    ['Hey Amelia:remind me tonight', 'remind me tonight'],
    ['Hey Amelia?where did Jerry go', 'where did Jerry go'],
    ['Hey Amelia...where did Jerry go', 'where did Jerry go'],
  ])('keeps the first command word in %j', (text, expected) => {
    expect(detectWake(utterance(text), 0.95)?.command).toBe(expected);
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

  // Regression: OWNER_ID ('owner') is the TENANT scope stamped on documents as
  // owner_id. The owner PERSON is a separate record (p-amelia-owner in
  // fixtures/seed.mjs) and that is what person_id holds. Gating on OWNER_ID
  // compares a person id to a tenant id — always false — silently disabling
  // every voice summon.
  it('gates on the owner person id, not the tenant OWNER_ID', () => {
    expect(OWNER_PERSON_ID).not.toBe(OWNER_ID);
    expect(detectWake(utterance('Hey Amelia, what about Maya'), 0.9)?.command).toBe(
      'what about Maya',
    );
    expect(
      detectWake(utterance('Hey Amelia, what about Maya', { person_id: OWNER_ID }), 0.9),
    ).toBeNull();
  });
});
