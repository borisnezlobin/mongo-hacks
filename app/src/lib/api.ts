import type {
  AskRequest,
  AskResponse,
  Conversation,
  ConversationSummary,
  DebugUtteranceRequest,
  Id,
  NamePersonRequest,
  Person,
  Reminder,
  SearchMemoryResult,
} from '../../../shared/contracts';
import { API_BASE_URL } from './config';

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
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
  searchMemory: (query: string, personId?: Id) => {
    const params = new URLSearchParams({ q: query });
    if (personId) params.set('person_id', personId);
    return request<SearchMemoryResult[]>(`/memory/search?${params.toString()}`);
  },
  ask: (body: AskRequest) => post<AskResponse>('/ask', body),
  createReminder: (promiseId: Id, fireAt: string) =>
    post<Reminder>('/reminders', { promise_id: promiseId, fire_at: fireAt }),
  debugUtterance: (body: DebugUtteranceRequest) => post('/debug/utterance', body),
};
