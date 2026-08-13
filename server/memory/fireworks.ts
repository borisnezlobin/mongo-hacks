/** Fireworks serves both extraction and embeddings behind an OpenAI-compatible API. */
export const FIREWORKS_BASE_URL = process.env.FIREWORKS_BASE_URL ?? 'https://api.fireworks.ai/inference/v1';

export function fireworksKey(): string {
  const key = process.env.FIREWORKS_API_KEY;
  if (!key) throw new Error('FIREWORKS_API_KEY is required (see server/.env.example)');
  return key;
}
