import { useCallback, useEffect, useRef, useState } from 'react';
import type { AudioUplink, Id } from '../../../shared/contracts';

/**
 * Lane A owns /app/audio and exports useAudioUplink(conversationId) with exactly the
 * AudioUplink shape frozen in contracts. Until that file lands, this stand-in satisfies
 * the same type so the recording control is fully built and demoable.
 *
 * INTEGRATION (one line, when Lane A pushes):
 *   import { useAudioUplink } from '../../audio';
 *   export { useAudioUplink };
 * and delete the fallback below. Nothing else in Lane C changes — every caller is typed
 * against AudioUplink, not against this implementation.
 */

const CONNECT_DELAY_MS = 650;

export function useAudioUplink(conversationId: Id): AudioUplink {
  const [state, setState] = useState<AudioUplink['state']>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  useEffect(() => {
    setState('idle');
  }, [conversationId]);

  const start = useCallback(async () => {
    setState('connecting');
    await new Promise<void>((resolve) => {
      timer.current = setTimeout(resolve, CONNECT_DELAY_MS);
    });
    setState('streaming');
  }, []);

  const stop = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    setState('idle');
  }, []);

  return { state, start, stop };
}

export const usingRealUplink = false;
