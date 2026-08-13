import type { LlmProvider } from './provider';
import { createAnthropicProvider } from './provider-anthropic';
import { createFireworksProvider } from './provider-fireworks';

export type ProviderId = 'anthropic' | 'fireworks';

/**
 * AMELIA_PROVIDER picks the backend. When unset we auto-select on which key is
 * actually present, so the demo runs on whatever the team has — Anthropic wins
 * a tie because the plan's delegation table specifies Opus for this lane.
 */
export function resolveProviderId(): ProviderId {
  const explicit = process.env.AMELIA_PROVIDER?.toLowerCase();
  if (explicit === 'anthropic' || explicit === 'fireworks') return explicit;
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.FIREWORKS_API_KEY) return 'fireworks';
  return 'anthropic';
}

let cached: LlmProvider | null = null;

export function getProvider(): LlmProvider {
  if (cached) return cached;
  cached = resolveProviderId() === 'fireworks' ? createFireworksProvider() : createAnthropicProvider();
  console.log(`[amelia] provider: ${cached.id} (${cached.model})`);
  return cached;
}

/** Tests only. */
export function resetProvider(): void {
  cached = null;
}
