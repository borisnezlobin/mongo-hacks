/**
 * Where the server might be. `EXPO_PUBLIC_API_URL` takes a comma-separated list
 * and the app uses whichever one answers `/health` first.
 *
 * A single baked-in address does not survive contact with real use. The owner
 * carries this phone between a campus network that blocks device-to-device
 * traffic entirely, a home network where the laptop's address is whatever DHCP
 * felt like, a USB cable whose link-local address changes on every reconnect,
 * and a VPN. Each of those is a different host, the value is inlined at bundle
 * time, and getting it wrong looks from inside the app exactly like an empty
 * account. Probing is cheap and happens once.
 */
export const API_CANDIDATES: readonly string[] = (
  process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000'
)
  .split(',')
  .map((candidate) => candidate.trim().replace(/\/+$/, ''))
  .filter(Boolean);

/** The first candidate, used until discovery finishes or if it finds nothing. */
export const API_BASE_URL = API_CANDIDATES[0] ?? 'http://localhost:3000';

/** Set EXPO_PUBLIC_FORCE_MOCK=1 to rehearse the demo with no server at all. */
export const FORCE_MOCK = process.env.EXPO_PUBLIC_FORCE_MOCK === '1';

/**
 * The scripted stream is opt-in only. It exists to build the UI before the server does,
 * but once a server is reachable a fake conversation replaying itself is worse than an
 * empty screen — it is indistinguishable from real capture on stage.
 */
export const MOCK_ENABLED = FORCE_MOCK;

export const HEALTH_TIMEOUT_MS = 2_500;

/** No request may hang forever: a stalled fetch looks exactly like an empty account. */
export const REQUEST_TIMEOUT_MS = 8_000;

/** How often the conversation view re-pulls turns while recording, as an SSE backstop. */
export const TRANSCRIPT_POLL_MS = 1_500;

/** The same backstop for a conversation nobody is recording, where nothing is urgent. */
export const HISTORY_POLL_MS = 20_000;
