/**
 * Lane C runs against the mock stream until the server is reachable, and switches to the
 * real one the moment EXPO_PUBLIC_API_URL points somewhere that answers /health.
 */
export const API_BASE_URL = (process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000').replace(/\/+$/, '');

/** Set EXPO_PUBLIC_FORCE_MOCK=1 to rehearse the demo with no server at all. */
export const FORCE_MOCK = process.env.EXPO_PUBLIC_FORCE_MOCK === '1';

export const HEALTH_TIMEOUT_MS = 2_500;
