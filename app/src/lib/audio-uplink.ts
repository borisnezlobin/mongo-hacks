/**
 * Lane A owns /app/audio and exports useAudioUplink(conversationId) with exactly the
 * AudioUplink shape frozen in contracts, so Lane C consumes it directly. This module
 * stays as the single seam: every caller in Lane C imports from here, never from
 * ../../audio, which keeps the integration point to one file if Lane A moves anything.
 */
export { useAudioUplink } from '../../audio';

export const usingRealUplink = true;
