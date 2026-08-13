import EventSource from 'react-native-sse';
import type { AmeliaEvent, BusEventName } from '../../../shared/contracts';
import { API_BASE_URL, FORCE_MOCK, HEALTH_TIMEOUT_MS, MOCK_ENABLED } from './config';
import { startMockStream, type MockStreamOptions } from './mock-sse';

const EVENT_NAMES: BusEventName[] = [
  'utterance',
  'identity',
  'fact',
  'promise',
  'amelia_step',
  'amelia_audio',
];

export type StreamSource = 'connecting' | 'live' | 'mock';

export interface StreamHandle {
  stop(): void;
}

async function serverIsUp(): Promise<boolean> {
  if (FORCE_MOCK) return false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(`${API_BASE_URL}/health`, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function parse(data: string | null): AmeliaEvent | null {
  if (!data) return null;
  try {
    return JSON.parse(data) as AmeliaEvent;
  } catch {
    return null;
  }
}

/**
 * Subscribes to the live event stream, or the scripted mock when the server is not up.
 * Falls back to the mock on connection error too, so the demo never shows a dead screen.
 */
const RETRY_INTERVAL_MS = 5_000;

export function subscribeToEvents(
  onEvent: (event: AmeliaEvent) => void,
  onSource: (source: StreamSource) => void,
  mockOptions?: MockStreamOptions,
): StreamHandle {
  let stopped = false;
  let source: EventSource<BusEventName> | null = null;
  let mock: StreamHandle | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;

  const closeSource = () => {
    source?.removeAllEventListeners();
    source?.close();
    source = null;
  };

  const stopMock = () => {
    mock?.stop();
    mock = null;
  };

  /**
   * The mock is a stopgap, never a destination. We keep probing /health while it plays,
   * so the moment the server comes up the scripted conversation is torn down and replaced
   * by the real stream. Without this, a single failed probe at launch — a server still
   * booting, a laptop that changed wifi — stranded the app on fake data for the session.
   */
  const fallBackToMock = () => {
    if (stopped) return;
    closeSource();
    if (MOCK_ENABLED && !mock) {
      onSource('mock');
      mock = startMockStream(onEvent, mockOptions);
    }
    scheduleRetry();
  };

  const scheduleRetry = () => {
    if (stopped || retry) return;
    retry = setTimeout(() => {
      retry = null;
      void connect();
    }, RETRY_INTERVAL_MS);
  };

  const connect = async () => {
    if (stopped || source) return;
    const up = await serverIsUp();
    if (stopped) return;
    if (!up) {
      fallBackToMock();
      return;
    }

    source = new EventSource<BusEventName>(`${API_BASE_URL}/events`, {
      headers: { Accept: 'text/event-stream' },
    });
    source.addEventListener('open', () => {
      // Live data wins: drop the scripted stream so the two never interleave.
      stopMock();
      onSource('live');
    });
    source.addEventListener('error', fallBackToMock);
    for (const name of EVENT_NAMES) {
      source.addEventListener(name, (event) => {
        const parsed = parse(event.data);
        if (parsed) onEvent(parsed);
      });
    }
  };

  void connect();

  return {
    stop() {
      stopped = true;
      if (retry) clearTimeout(retry);
      retry = null;
      closeSource();
      stopMock();
    },
  };
}
