import type {
  AskRequest,
  AskResponse,
  Conversation,
  ConversationSummary,
  DebugUtteranceRequest,
  Id,
  NamePersonRequest,
  Person,
  PromiseMemory,
  Reminder,
  SearchMemoryResult,
} from '../../../shared/contracts';
import { REQUEST_TIMEOUT_MS } from './config';
import { apiUrl } from './urls';

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

/** A request that never returns is indistinguishable from an empty account. */
export class NetworkError extends Error {
  constructor(readonly cause: unknown) {
    super('Amelia could not reach the server.');
    this.name = 'NetworkError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(apiUrl(path), {
      ...init,
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch (error) {
    throw new NetworkError(error);
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new ApiError(`${init?.method ?? 'GET'} ${path} failed`, response.status);
  }
  return (await response.json()) as T;
}

const post = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body) });

export const api = {
  health: () => request<{ ok: true; service: 'amelia' }>('/health'),
  listPeople: () => request<Person[]>('/people'),
  getPerson: (id: Id) => request<Person>(`/people/${id}`),
  namePerson: (id: Id, body: NamePersonRequest) => post<Person>(`/people/${id}/name`, body),
  mergePeople: (personIds: Id[]) => post<Person>('/people/merge', { person_ids: personIds }),
  listConversations: () => request<Conversation[]>('/conversations'),
  getConversation: (id: Id) => request<ConversationSummary>(`/conversations/${id}`),
  deleteConversation: (id: Id) =>
    request<{ utterances: number; facts: number; promises: number }>(`/conversations/${id}`, {
      method: 'DELETE',
    }),
  listPromises: (status?: PromiseMemory['status']) =>
    request<PromiseMemory[]>(status ? `/promises?status=${status}` : '/promises'),
  setPromiseStatus: (id: Id, status: PromiseMemory['status']) =>
    post<PromiseMemory>(`/promises/${id}/status`, { status }),
  searchMemory: (query: string, personId?: Id) => {
    const params = new URLSearchParams({ q: query });
    if (personId) params.set('person_id', personId);
    return request<SearchMemoryResult[]>(`/memory/search?${params.toString()}`);
  },
  ask: (body: AskRequest) => post<AskResponse>('/ask', body),
  summon: (text: string) =>
    post<{ text: string; steps: unknown[] }>('/amelia/summon', { text }),
  createReminder: (promiseId: Id, fireAt: string) =>
    post<Reminder>('/reminders', { promise_id: promiseId, fire_at: fireAt }),
  debugUtterance: (body: DebugUtteranceRequest) => post('/debug/utterance', body),
};
