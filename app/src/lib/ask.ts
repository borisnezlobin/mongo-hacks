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

const STOPWORDS = new Set([
  'who', 'whos', 'what', 'whats', 'when', 'where', 'why', 'how', 'is', 'are', 'was', 'were',
  'the', 'a', 'an', 'and', 'or', 'of', 'for', 'about', 'tell', 'me', 'do', 'does', 'did',
  'i', 'know', 'my', 'his', 'her', 'their', 'they', 'she', 'he', 'it', 'to', 'with', 'again',
]);

function terms(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/['’]s\b/g, '')
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 1 && !STOPWORDS.has(term));
}

function scoreMatch(haystack: string, queryTerms: string[]): number {
  if (queryTerms.length === 0) return 0;
  const text = haystack.toLowerCase();
  return queryTerms.filter((term) => text.includes(term)).length / queryTerms.length;
}

/**
 * "Who's Maya" is a question ABOUT Maya, not a search for sentences containing the word.
 * So a named person in the query wins: we answer from that person's own current facts
 * rather than from whoever happened to say their name.
 */
function resolveSubject(state: AmeliaState, queryTerms: string[]) {
  for (const person of Object.values(state.people)) {
    if (person.is_owner) continue;
    const first = person.name.trim().split(/\s+/)[0]?.toLowerCase();
    if (first && first.length > 1 && queryTerms.includes(first)) return person;
  }
  return null;
}

/** Keeps the ask field useful when the server is not up yet — never a dead end on stage. */
function searchLocally(state: AmeliaState, query: string): AskResult {
  const queryTerms = terms(query);
  const subject = resolveSubject(state, queryTerms);

  if (subject) {
    const facts = Object.values(state.facts)
      .filter((fact) => fact.person_id === subject._id && !fact.superseded_by)
      .sort((a, b) => b.valid_from.localeCompare(a.valid_from));
    const promises = Object.values(state.promises)
      .filter((promise) => promise.person_id === subject._id && promise.status === 'open');

    const citations: SearchMemoryResult[] = [
      ...facts.map((fact) => ({
        kind: 'fact' as const, id: fact._id, person_id: fact.person_id, text: fact.claim,
        score: 1, source_utterance_id: fact.primary_source_utterance_id,
      })),
      ...promises.map((promise) => ({
        kind: 'promise' as const, id: promise._id, person_id: promise.person_id, text: promise.text,
        score: 0.9, source_utterance_id: promise.source_utterance_id,
      })),
    ];

    const detail = subject.relationship ? `${subject.name} — ${subject.relationship}.` : `${subject.name}.`;
    const text = citations.length === 0
      ? `${detail} Nothing else recorded yet.`
      : `${detail} Here is what you know, most recent first.`;
    return { text, citations: citations.slice(0, 6), local: true };
  }

  const citations: SearchMemoryResult[] = [];
  for (const fact of Object.values(state.facts)) {
    if (fact.superseded_by) continue;
    const score = scoreMatch(`${fact.claim} ${fact.attribute}`, queryTerms);
    if (score > 0) {
      citations.push({ kind: 'fact', id: fact._id, person_id: fact.person_id, text: fact.claim, score, source_utterance_id: fact.primary_source_utterance_id });
    }
  }
  for (const promise of Object.values(state.promises)) {
    const score = scoreMatch(promise.text, queryTerms);
    if (score > 0) {
      citations.push({ kind: 'promise', id: promise._id, person_id: promise.person_id, text: promise.text, score, source_utterance_id: promise.source_utterance_id });
    }
  }
  // Raw transcript lines are the weakest evidence, so they only rank above nothing.
  for (const utterance of Object.values(state.utterances)) {
    const score = scoreMatch(utterance.text, queryTerms);
    if (score > 0) {
      citations.push({ kind: 'utterance', id: utterance._id, person_id: utterance.person_id, text: utterance.text, score: score * 0.5 });
    }
  }

  citations.sort((a, b) => b.score - a.score);
  const top = citations.slice(0, 5);
  const text = top.length === 0
    ? 'Nothing on that yet. Once Amelia hears it, it will be here.'
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
