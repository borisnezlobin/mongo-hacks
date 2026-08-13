import type { Hono } from 'hono';
import type { AmeliaBus } from '../lib/bus';
import type {
  Fact,
  MemoryApi,
  Person,
  Reminder,
  SearchMemoryResult,
  ServerDependencies,
} from '../../shared/contracts';

const notReady = async (): Promise<never> => {
  throw new Error('Lane B memory service is not registered yet');
};

/** Lane B replaces this scaffold without changing the import in server/index.ts. */
export function createMemoryApi(_deps: { bus: AmeliaBus }): MemoryApi {
  return {
    searchMemory: notReady as (query: string, personId?: string) => Promise<SearchMemoryResult[]>,
    getPerson: notReady as (id: string) => Promise<Person | null>,
    resolveFactState: notReady as (personId: string, attribute: string) => Promise<Fact | null>,
    createReminder: notReady as (promiseId: string, fireAt: string) => Promise<Reminder>,
    addNote: notReady as (personId: string, text: string) => Promise<Fact>,
  };
}

export function registerMemoryRoutes(_app: Hono, _deps: ServerDependencies): void {}
