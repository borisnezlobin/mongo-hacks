import { loadEnv, requireEnv } from './env';

/** Fireworks serves both extraction and embeddings behind an OpenAI-compatible API. */
export function fireworksBaseUrl(): string {
  loadEnv();
  return process.env.FIREWORKS_BASE_URL ?? 'https://api.fireworks.ai/inference/v1';
}

export function fireworksKey(): string {
  return requireEnv('FIREWORKS_API_KEY');
}
