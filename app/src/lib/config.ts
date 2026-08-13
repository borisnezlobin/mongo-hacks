/**
 * Lane C runs against the mock stream until the server is reachable, and switches to the
 * real one the moment EXPO_PUBLIC_API_URL points somewhere that answers /health.
 */
export const API_BASE_URL = (process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000').replace(/\/+$/, '');

/** Set EXPO_PUBLIC_FORCE_MOCK=1 to rehearse the demo with no server at all. */
export const FORCE_MOCK = process.env.EXPO_PUBLIC_FORCE_MOCK === '1';

/**
 * The scripted stream is opt-in only. It exists to build the UI before the server does,
 * but once a server is reachable a fake conversation replaying itself is worse than an
 * empty screen — it is indistinguishable from real capture on stage.
 */
export const MOCK_ENABLED = FORCE_MOCK;

export const HEALTH_TIMEOUT_MS = 2_500;

/** How often the conversation view re-pulls turns while recording, as an SSE backstop. */
export const TRANSCRIPT_POLL_MS = 1_500;
