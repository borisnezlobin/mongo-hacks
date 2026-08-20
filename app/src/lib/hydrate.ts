import { useEffect } from 'react';
import type { Id } from '../../../shared/contracts';
import { api } from './api';
import { HISTORY_POLL_MS, TRANSCRIPT_POLL_MS } from './config';
import { useActions } from '../state/store';

/**
 * Pulling history from the server, in one place.
 *
 * The same fifteen-line loop used to live in both Home and the transcript, and both
 * swallowed every error with `.catch(() => {})` — so a dead server rendered as an
 * account with nothing in it. Failures now come back to the caller, which decides
 * whether to say so.
 */

/**
 * One-shot bootstrap: the people, the open loops, and the list of conversations.
 *
 * It deliberately does not pull any transcripts. It used to fetch the eight most recent
 * conversations in full, which was fine against a seven-turn fixture and is roughly
 * 22,000 utterances against real recordings — megabytes of JSON parsed on the main
 * thread before the first screen paints, to render a list of titles. Turns are fetched
 * when a transcript is actually opened.
 *
 * It lives above the tabs rather than inside Home, so returning to the Home tab does
 * not re-fire everything.
 */
export function useBootstrap(): void {
  const actions = useActions();

  useEffect(() => {
    let cancelled = false;
    let failed = false;

    const report = () => {
      if (failed || cancelled) return;
      failed = true;
      actions.notify("Couldn't reach Amelia's server, so this is only what the phone has.");
    };

    const run = async () => {
      try {
        const people = await api.listPeople();
        if (!cancelled) actions.upsertPeople(people);
      } catch {
        report();
      }

      try {
        const promises = await api.listPromises();
        if (!cancelled) actions.hydratePromises(promises);
      } catch {
        report();
      }

      try {
        const conversations = await api.listConversations();
        if (!cancelled) actions.upsertConversations(conversations);
      } catch {
        report();
      }
    };

    void run();
    return () => { cancelled = true; };
  }, [actions]);
}

/**
 * Keeps one transcript current. SSE alone is not dependable in front of an audience —
 * many reverse proxies buffer event streams — so the same REST endpoint is polled as a
 * backstop. Turns are keyed by id, so whichever path delivers first wins.
 */
export function useTranscriptPolling(
  conversationId: Id | undefined,
  onError: () => void,
  isLive = false,
): void {
  const actions = useActions();

  useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;

    const pull = async () => {
      try {
        const summary = await api.getConversation(conversationId);
        if (cancelled) return;
        // Take the server's record too: without it the screen fabricates started_at from
        // ingest time, which then wins forever and sorts the list wrongly.
        if (summary.conversation) actions.upsertConversations([summary.conversation]);
        if (summary.utterances.length > 0) actions.hydrateUtterances(summary.utterances);
      } catch {
        if (!cancelled) onError();
      }
    };

    void pull();
    /**
     * A live conversation is worth polling hard. A finished one is not: re-fetching a
     * 2,772-turn transcript every 1.5 seconds is megabytes a minute of JSON parsed on
     * the main thread to learn nothing. It still polls, slowly, because a server-driven
     * replay writes turns into a conversation this phone is not recording.
     */
    const interval = setInterval(() => void pull(), isLive ? TRANSCRIPT_POLL_MS : HISTORY_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [conversationId, actions, onError, isLive]);
}
