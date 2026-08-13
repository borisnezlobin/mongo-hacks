import { useCallback, useState } from 'react';
import type { SearchMemoryResult } from '../../../shared/contracts';
import { api } from './api';
import { useStore, type AmeliaState } from './store';

export interface AskResult {
  text: string;
  citations: SearchMemoryResult[];
  /** True when the answer came from the phone's own copy because the server was unreachable. */
  local: boolean;
}

function scoreMatch(haystack: string, terms: string[]): number {
  const text = haystack.toLowerCase();
  const hits = terms.filter((term) => text.includes(term));
  return hits.length / Math.max(terms.length, 1);
}

/** Keeps the ask field useful when the server is not up yet — never a dead end on stage. */
function searchLocally(state: AmeliaState, query: string): AskResult {
  const terms = query.toLowerCase().split(/\s+/).filter((term) => term.length > 2);
  const citations: SearchMemoryResult[] = [];

  for (const fact of Object.values(state.facts)) {
    if (fact.superseded_by) continue;
    const score = scoreMatch(`${fact.claim} ${fact.attribute}`, terms);
    if (score > 0) {
      citations.push({ kind: 'fact', id: fact._id, person_id: fact.person_id, text: fact.claim, score, source_utterance_id: fact.primary_source_utterance_id });
    }
  }
  for (const promise of Object.values(state.promises)) {
    const score = scoreMatch(promise.text, terms);
    if (score > 0) {
      citations.push({ kind: 'promise', id: promise._id, person_id: promise.person_id, text: promise.text, score, source_utterance_id: promise.source_utterance_id });
    }
  }
  for (const utterance of Object.values(state.utterances)) {
    const score = scoreMatch(utterance.text, terms);
    if (score > 0) {
      citations.push({ kind: 'utterance', id: utterance._id, person_id: utterance.person_id, text: utterance.text, score });
    }
  }

  citations.sort((a, b) => b.score - a.score);
  const top = citations.slice(0, 5);
  const names = new Set(top.map((item) => item.person_id && state.people[item.person_id]?.name).filter(Boolean));

  const text = top.length === 0
    ? "Nothing on that yet. Once Amelia hears it, it will be here."
    : names.size > 0
      ? `Here is what you know${names.size === 1 ? ` about ${[...names][0]}` : ''}.`
      : 'Here is what you know.';

  return { text, citations: top, local: true };
}

export function useAsk() {
  const { state } = useStore();
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<AskResult | null>(null);

  const ask = useCallback(async (query: string) => {
    const trimmed = query.trim();
    if (!trimmed) return;
    setPending(true);
    try {
      const response = await api.ask({ query: trimmed });
      setResult({ text: response.text, citations: response.citations, local: false });
    } catch {
      setResult(searchLocally(state, trimmed));
    } finally {
      setPending(false);
    }
  }, [state]);

  const clear = useCallback(() => setResult(null), []);

  return { ask, clear, pending, result };
}
