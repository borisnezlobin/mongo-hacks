/**
 * A fixture-backed MemoryApi, so Lane D is verifiable before Lane B lands.
 *
 * Mirrors fixtures/transcript.json and fixtures/seed.mjs: Yan is the owner,
 * Maya's move date is superseded (Sept 1 → Sept 15), Jules owes venue photos.
 * Email addresses are the one addition — the transcript has none and
 * draft_email needs a recipient.
 *
 * Test double only. Swap `createFixtureMemory()` for Lane B's
 * `createMemoryApi()` and nothing else changes.
 */

import type {
  Fact,
  Id,
  MemoryApi,
  Person,
  Reminder,
  SearchMemoryResult,
  Timestamp,
} from '../../shared/contracts';
// A pure string function, not a reach into Lane B's collections — the double is
// only useful while it agrees with the real thing about what counts as a change.
import { normalizeClaim } from '../memory/normalize';

const OWNER = 'owner';
const T = (iso: string): Timestamp => new Date(iso).toISOString();

const BASE_PEOPLE: Person[] = [
  {
    _id: 'p-amelia-owner',
    owner_id: OWNER,
    name: 'Yan',
    is_owner: true,
    created_at: T('2026-08-13T00:00:00Z'),
    updated_at: T('2026-08-13T00:00:00Z'),
  },
  {
    _id: 'p-maya',
    owner_id: OWNER,
    name: 'Maya',
    created_at: T('2026-08-13T00:00:05Z'),
    updated_at: T('2026-08-13T00:00:05Z'),
  },
  {
    _id: 'p-jules',
    owner_id: OWNER,
    name: 'Jules',
    created_at: T('2026-08-13T00:00:09Z'),
    updated_at: T('2026-08-13T00:00:09Z'),
  },
  {
    _id: 'p-priya',
    owner_id: OWNER,
    name: 'Priya',
    created_at: T('2026-08-13T00:00:13Z'),
    updated_at: T('2026-08-13T00:00:13Z'),
  },
];

const fact = (f: Omit<Fact, 'owner_id' | 'claim_normalized' | 'created_at'>): Fact => ({
  ...f,
  owner_id: OWNER,
  // The real normalizer, not a lowercase stand-in. It also strips accents and
  // punctuation and collapses whitespace, so "July 15." and "July 15" collide
  // in Mongo — a double that only lowercases would say they differ and quietly
  // disagree with production about whether anything changed.
  claim_normalized: normalizeClaim(f.claim),
  created_at: f.valid_from,
});

const BASE_FACTS: Fact[] = [
  // The supersession chain the demo turns on.
  fact({
    _id: 'f-maya-move-old',
    person_id: 'p-maya',
    attribute: 'move_date',
    claim: 'Moving to Oakland on September 1',
    primary_source_utterance_id: 'u2',
    valid_from: T('2026-08-13T00:00:05Z'),
    superseded_at: T('2026-08-13T00:00:18Z'),
    superseded_by: 'f-maya-move-new',
  }),
  fact({
    _id: 'f-maya-move-new',
    person_id: 'p-maya',
    attribute: 'move_date',
    claim: 'Moving to Oakland on September 15',
    primary_source_utterance_id: 'u5',
    valid_from: T('2026-08-13T00:00:18Z'),
  }),
  fact({
    _id: 'f-maya-food',
    person_id: 'p-maya',
    attribute: 'food_preference',
    claim: 'Loves Ethiopian food',
    primary_source_utterance_id: 'u3',
    valid_from: T('2026-08-13T00:00:09Z'),
  }),
  fact({
    _id: 'f-jules-food',
    person_id: 'p-jules',
    attribute: 'food_preference',
    claim: 'Loves Ethiopian food',
    primary_source_utterance_id: 'u3',
    valid_from: T('2026-08-13T00:00:09Z'),
  }),
  fact({
    _id: 'f-priya-met',
    person_id: 'p-priya',
    attribute: 'met_at',
    claim: 'Met Yan at the MongoDB hackathon',
    primary_source_utterance_id: 'u4',
    valid_from: T('2026-08-13T00:00:13Z'),
  }),
  // Not in the transcript; draft_email needs somewhere to send.
  fact({
    _id: 'f-maya-email',
    person_id: 'p-maya',
    attribute: 'email',
    claim: 'maya@example.com',
    primary_source_utterance_id: 'u2',
    valid_from: T('2026-08-13T00:00:05Z'),
  }),
  fact({
    _id: 'f-jules-email',
    person_id: 'p-jules',
    attribute: 'email',
    claim: 'jules@example.com',
    primary_source_utterance_id: 'u6',
    valid_from: T('2026-08-13T00:00:22Z'),
  }),
];

/** Jules: "I promise I'll send Yan the venue photos tonight." */
const PROMISES = [
  {
    _id: 'pr-jules-photos',
    person_id: 'p-jules',
    text: "Send Yan the venue photos tonight",
    source_utterance_id: 'u6',
  },
];

export interface FixtureMemory extends MemoryApi {
  /** Calls made, for assertions. */
  readonly calls: string[];
}

export function createFixtureMemory(): FixtureMemory {
  const calls: string[] = [];

  // Per-instance copies. `setFact` and `namePerson` write, and while the
  // fixtures were read-only it did not matter that every caller shared one
  // array — now a test that renames somebody would rename them for every test
  // after it, in file order, which is the kind of failure that looks like
  // flakiness and gets re-run rather than read.
  const PEOPLE = structuredClone(BASE_PEOPLE);
  const FACTS = structuredClone(BASE_FACTS);

  const search: MemoryApi['searchMemory'] = async (query, personId) => {
    calls.push(`searchMemory(${query}${personId ? `, ${personId}` : ''})`);
    const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
    const score = (hay: string) =>
      terms.filter((t) => hay.includes(t)).length / Math.max(terms.length, 1);

    const factHits: SearchMemoryResult[] = FACTS
      // Superseded facts are never returned — resolve_fact_state is the only
      // way to see history, which is what makes it worth calling.
      .filter((f) => !f.superseded_by)
      .filter((f) => !personId || f.person_id === personId)
      .map((f) => ({
        kind: 'fact' as const,
        id: f._id,
        person_id: f.person_id,
        text: `${PEOPLE.find((p) => p._id === f.person_id)?.name ?? f.person_id}: ${f.claim}`,
        score: score(`${f.attribute} ${f.claim}`.toLowerCase()),
        source_utterance_id: f.primary_source_utterance_id,
      }));

    const promiseHits: SearchMemoryResult[] = PROMISES.filter(
      (p) => !personId || p.person_id === personId,
    ).map((p) => ({
      kind: 'promise' as const,
      id: p._id,
      person_id: p.person_id,
      text: p.text,
      score: score(p.text.toLowerCase()),
      source_utterance_id: p.source_utterance_id,
    }));

    return [...factHits, ...promiseHits]
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
  };

  return {
    calls,
    searchMemory: search,

    async getPerson(id: Id) {
      calls.push(`getPerson(${id})`);
      return (
        PEOPLE.find((p) => p._id === id || p.name.toLowerCase() === id.toLowerCase()) ?? null
      );
    },

    async resolveFactState(personId: Id, attribute: string) {
      calls.push(`resolveFactState(${personId}, ${attribute})`);
      const person =
        PEOPLE.find((p) => p._id === personId || p.name.toLowerCase() === personId.toLowerCase())
          ?._id ?? personId;
      // Contract shape: the CURRENT fact only. The superseded chain is
      // deliberately unreachable — see TODO(contracts) in tools.ts.
      const attributes = attribute === 'move' ? ['move', 'move_date'] : [attribute];
      return FACTS.find((f) => f.person_id === person && attributes.includes(f.attribute) && !f.superseded_by) ?? null;
    },

    async createReminder(promiseId: Id, fireAt: Timestamp): Promise<Reminder> {
      calls.push(`createReminder(${promiseId}, ${fireAt})`);
      return {
        _id: `rem-${promiseId}`,
        owner_id: OWNER,
        promise_id: promiseId,
        fire_at: fireAt,
        status: 'scheduled',
        created_at: new Date().toISOString(),
      };
    },

    async addNote(personId: Id, text: string): Promise<Fact> {
      calls.push(`addNote(${personId}, ${text})`);
      return fact({
        _id: `f-note-${Date.now()}`,
        person_id: personId,
        attribute: 'note',
        claim: text,
        primary_source_utterance_id: 'amelia',
        valid_from: new Date().toISOString(),
      });
    },

    async setFact(personId: Id, attribute: string, claim: string): Promise<Fact> {
      calls.push(`setFact(${personId}, ${attribute}, ${claim})`);
      // Mutates the fixture so a set followed by a resolve in the same run
      // answers with what was just set. A double that always reports success
      // and then forgets would let a broken supersession pass its own test.
      const previous = FACTS.find(
        (f) => f.person_id === personId && f.attribute === attribute && !f.superseded_by,
      );

      // Same guard as store.setFact. Without it, restating something already
      // true supersedes a fact with itself, which spends a row and reads as a
      // change in the timeline when nothing changed — and this double is what
      // Lane D's demo runs against, so the divergence would show up on stage
      // rather than in a test.
      if (previous && previous.claim_normalized === normalizeClaim(claim)) return previous;
      const written = fact({
        _id: `f-set-${attribute}-${FACTS.length}`,
        person_id: personId,
        attribute,
        claim,
        primary_source_utterance_id: `spoken-${attribute}-${previous?._id ?? 'initial'}`,
        valid_from: new Date().toISOString(),
      });
      if (previous) {
        previous.superseded_by = written._id;
        previous.superseded_at = written.valid_from;
      }
      FACTS.push(written);
      return written;
    },

    async namePerson(personId: Id, name: string, relationship?: string) {
      calls.push(`namePerson(${personId}, ${name}${relationship ? `, ${relationship}` : ''})`);
      const person = PEOPLE.find((p) => p._id === personId);
      if (!person) return null;
      person.name = name;
      if (relationship) person.relationship = relationship;
      return person;
    },
  };
}
