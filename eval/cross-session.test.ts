import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Fact, Person, PromiseMemory, Utterance, Voiceprint } from '../shared/contracts';
import { AmeliaBus } from '../server/lib/bus';
import { createIdentityService, type IdentityService } from '../server/identity/service';
import { createLocalDriver, type LocalDriver } from '../server/storage/local-driver';
import { hasRealFixture, missingFixtureNotice, readRealFixture } from '../fixtures/real-audio';

const FIXTURE = 'cross-session.json';

/**
 * The acceptance test for the whole product.
 *
 * "Across sessions it's really important that we can ID people" — everything
 * else is in service of this. It runs on real ECAPA voiceprints taken from the
 * owner's own dorm recording, split into two disjoint halves that each carry
 * their own session mean, and it restarts the storage driver in between so
 * recognition has to survive a cold process the way it does in real life.
 *
 * Regenerate the fixture with eval/real/export_sessions.py.
 */

const here = dirname(fileURLToPath(import.meta.url));

interface SessionFixture {
  session_mean: number[];
  speakers: Record<string, { embedding: number[]; duration_ms: number }>;
}

const fixture = hasRealFixture(FIXTURE)
  ? readRealFixture<{ enroll: SessionFixture; test: SessionFixture }>(FIXTURE)
  : ({ enroll: { session_mean: [], speakers: {} }, test: { session_mean: [], speakers: {} } } as {
      enroll: SessionFixture;
      test: SessionFixture;
    });

let dataDir: string;
let driver: LocalDriver;

function serviceFor(active: LocalDriver): IdentityService {
  return createIdentityService({
    collections: {
      people: active.collection<Person>('people'),
      voiceprints: active.collection<Voiceprint>('voiceprints'),
      utterances: active.collection<Utterance>('utterances'),
      facts: active.collection<Fact>('facts'),
      promises: active.collection<PromiseMemory>('promises'),
    },
    bus: new AmeliaBus(),
  });
}

/** Close the store and open it again, the way restarting the server would. */
async function restart(): Promise<IdentityService> {
  await driver.close();
  driver = await createLocalDriver({ dataDir });
  return serviceFor(driver);
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'amelia-cross-session-'));
  driver = await createLocalDriver({ dataDir });
});

afterEach(async () => {
  await driver.close();
  rmSync(dataDir, { recursive: true, force: true });
});

/** The user taps an unnamed voice and types a name. That is the enrollment. */
async function nameFromFirstHalf(service: IdentityService, name: string): Promise<string> {
  const speaker = fixture.enroll.speakers[name];
  const { person } = await service.enroll({
    name,
    duration_ms: speaker.duration_ms,
    embedding: speaker.embedding,
    session_mean: fixture.enroll.session_mean,
  });
  return person._id;
}

function secondHalf(name: string) {
  const speaker = fixture.test.speakers[name];
  return {
    embedding: speaker.embedding,
    duration_ms: speaker.duration_ms,
    session_mean: fixture.test.session_mean,
    conversation_id: 'c-day-two',
    utterance_ids: [`u-${name}`],
  };
}

const notice = hasRealFixture(FIXTURE) ? '' : ` — ${missingFixtureNotice(FIXTURE)}`;

describe.skipIf(!hasRealFixture(FIXTURE))(`recognising people across sessions${notice}`, () => {
  it('recognises a named voice in a later session, after a restart', async () => {
    const first = serviceFor(driver);
    const joshId = await nameFromFirstHalf(first, 'Josh');
    const meId = await nameFromFirstHalf(first, 'Me');

    const second = await restart();

    const josh = await second.attributeSpeaker(secondHalf('Josh'));
    expect(josh.status).toBe('matched');
    if (josh.status !== 'matched') throw new Error('unreachable');
    expect(josh.person_id).toBe(joshId);

    const me = await second.attributeSpeaker(secondHalf('Me'));
    expect(me.status).toBe('matched');
    if (me.status !== 'matched') throw new Error('unreachable');
    expect(me.person_id).toBe(meId);
    expect(me.person_id).not.toBe(joshId);
  });

  it('does not hand a stranger somebody else\'s name', async () => {
    const first = serviceFor(driver);
    await nameFromFirstHalf(first, 'Josh');
    await nameFromFirstHalf(first, 'Me');

    const second = await restart();

    // Tarun never spoke in the enrolling half, so he is genuinely unknown and
    // the only two people who exist are Josh and the owner. Any match at all is
    // therefore a false accept. Stated unconditionally on purpose: this is the
    // assertion the whole scoring metric exists to protect, and the earlier
    // version of it would have passed if he were matched to some third person.
    const tarun = await second.attributeSpeaker(secondHalf('Tarun'));
    expect(tarun.status).not.toBe('matched');
  });

  it('keeps the named person after a restart rather than minting a duplicate', async () => {
    const first = serviceFor(driver);
    const joshId = await nameFromFirstHalf(first, 'Josh');

    const second = await restart();
    await second.attributeSpeaker(secondHalf('Josh'));

    const people = await driver.collection<Person>('people').find({}).toArray();
    const joshes = people.filter((person) => person.name === 'Josh');
    expect(joshes).toHaveLength(1);
    expect(joshes[0]._id).toBe(joshId);
  });

  it('reinforces the voiceprint set so later rooms have more to match against', async () => {
    const first = serviceFor(driver);
    const joshId = await nameFromFirstHalf(first, 'Josh');
    const before = await driver
      .collection<Voiceprint>('voiceprints')
      .find({ person_id: joshId })
      .toArray();

    const second = await restart();
    const match = await second.attributeSpeaker(secondHalf('Josh'));

    const after = await driver
      .collection<Voiceprint>('voiceprints')
      .find({ person_id: joshId })
      .toArray();

    // Only a confirmed identification earns a new print; a provisional guess
    // must not teach the system anything it might have to unlearn.
    if (match.status === 'matched' && match.identity_confidence === 'confirmed') {
      expect(after.length).toBeGreaterThan(before.length);
      expect(after.some((print) => print.session_mean?.length)).toBe(true);
    } else {
      expect(after.length).toBe(before.length);
    }
  });
});
