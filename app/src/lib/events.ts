import EventSource from 'react-native-sse';
import type { AmeliaEvent, BusEventName } from '../../../shared/contracts';
import { API_BASE_URL, FORCE_MOCK, HEALTH_TIMEOUT_MS } from './config';
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
export function subscribeToEvents(
  onEvent: (event: AmeliaEvent) => void,
  onSource: (source: StreamSource) => void,
  mockOptions?: MockStreamOptions,
): StreamHandle {
  let stopped = false;
  let source: EventSource<BusEventName> | null = null;
  let mock: StreamHandle | null = null;

  const fallBackToMock = () => {
    if (stopped || mock) return;
    source?.removeAllEventListeners();
    source?.close();
    source = null;
    onSource('mock');
    mock = startMockStream(onEvent, mockOptions);
  };

  void (async () => {
    const up = await serverIsUp();
    if (stopped) return;
    if (!up) {
      fallBackToMock();
      return;
    }

    source = new EventSource<BusEventName>(`${API_BASE_URL}/events`, {
      headers: { Accept: 'text/event-stream' },
    });
    source.addEventListener('open', () => onSource('live'));
    source.addEventListener('error', fallBackToMock);
    for (const name of EVENT_NAMES) {
      source.addEventListener(name, (event) => {
        const parsed = parse(event.data);
        if (parsed) onEvent(parsed);
      });
    }
  })();

  return {
    stop() {
      stopped = true;
      source?.removeAllEventListeners();
      source?.close();
      source = null;
      mock?.stop();
      mock = null;
    },
  };
}
