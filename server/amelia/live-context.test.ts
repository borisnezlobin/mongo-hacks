import { describe, expect, it, vi } from 'vitest';
import type { AmeliaEvent, MemoryApi, ServerDependencies } from '../../shared/contracts';
import { AmeliaBus } from '../lib/bus';
import { hasExplicitChangeCue, registerLiveContextInterventions } from './live-context';

function dependencies() {
  const bus = new AmeliaBus();
  const memory = {
    getPerson: vi.fn().mockResolvedValue({ name: 'Maya' }),
    searchMemory: vi.fn().mockResolvedValue([
      { kind: 'promise', id: 'pr-pack', person_id: 'p-owner', text: 'Help Maya pack', score: 0.82 },
    ]),
  } as unknown as MemoryApi;
  return { bus, memory } satisfies ServerDependencies;
}

function correction(): AmeliaEvent {
  return {
    type: 'utterance',
    utterance_id: 'u-change',
    conversation_id: 'c-live',
    person_id: 'p-maya',
    text: 'Actually my move date changed to September twentieth.',
    start_ms: 0,
    end_ms: 2000,
    is_final: true,
  };
}

function replacement(overrides: Partial<Extract<AmeliaEvent, { type: 'fact' }>> = {}): AmeliaEvent {
  return {
    type: 'fact',
    fact_id: 'f-new',
    person_id: 'p-maya',
    attribute: 'move',
    claim: 'Maya moves to Oakland on September 20.',
    superseded_fact_id: 'f-old',
    ...overrides,
  };
}

describe('live context interventions', () => {
  it('recognizes explicit correction language without treating ordinary claims as corrections', () => {
    expect(hasExplicitChangeCue('Actually, it was pushed to Friday.')).toBe(true);
    expect(hasExplicitChangeCue('I am moving on Friday.')).toBe(false);
  });

  it('speaks an actionable replacement after an explicit correction from the same person', async () => {
    const deps = dependencies();
    const emitted: AmeliaEvent[] = [];
    deps.bus.subscribe((event) => emitted.push(event));
    const speakImpl = vi.fn().mockResolvedValue({
      audio_url: '/amelia/audio/context.mp3',
      path: '/tmp/context.mp3',
      mime_type: 'audio/mpeg',
    });
    registerLiveContextInterventions(deps, { speakImpl, cooldownMs: 0 });

    deps.bus.emit(correction());
    deps.bus.emit(replacement());

    await vi.waitFor(() => expect(speakImpl).toHaveBeenCalledOnce());
    expect(emitted).toContainEqual(expect.objectContaining({
      type: 'amelia_step',
      request_id: 'context-f-new',
      step: 'reason',
    }));
    expect(emitted).toContainEqual(expect.objectContaining({
      type: 'amelia_audio',
      request_id: 'context-f-new',
      text: 'That changed: Maya moves to Oakland on September 20. I found 1 related open loop worth reviewing.',
      audio_url: '/amelia/audio/context.mp3',
    }));
    expect(emitted).toContainEqual(expect.objectContaining({
      type: 'amelia_step',
      request_id: 'context-f-new',
      step: 'act',
      message: 'Flagged 1 related open loop for review',
    }));
  });

  it('does not interrupt for sensitive attributes or replacements without a live correction cue', async () => {
    const deps = dependencies();
    const speakImpl = vi.fn().mockResolvedValue(null);
    registerLiveContextInterventions(deps, { speakImpl, cooldownMs: 0 });

    deps.bus.emit(replacement());
    deps.bus.emit(correction());
    deps.bus.emit(replacement({ fact_id: 'f-health', attribute: 'health' }));

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(speakImpl).not.toHaveBeenCalled();
  });
});
