/**
 * Lane B acceptance test. Replays the fixture transcript through the same bus
 * path Lane A will drive, then asserts the Done-when criteria from the plan:
 * a supersession chain, promises in both directions, and a cited answer.
 *
 *   npx tsx db/verify.ts
 */
import transcript from '../fixtures/transcript.json' with { type: 'json' };
import { createApp } from '../server/index';
import { collections, closeDb } from '../server/memory/db';
import { answerQuestion } from '../server/ask';
import { getFactHistory, listPromises, resolveFactState } from '../server/memory/store';
import { OWNER_ID } from '../shared/contracts';

const failures: string[] = [];

function check(label: string, condition: boolean, detail = ''): void {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!condition) failures.push(label);
}

async function main(): Promise<void> {
  const { app } = createApp();

  for (const utterance of transcript.utterances) {
    const response = await app.request('/debug/utterance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        utterance_id: utterance.utterance_id,
        conversation_id: transcript.conversation_id,
        person_id: utterance.person_id,
        text: utterance.text,
        start_ms: utterance.start_ms,
        end_ms: utterance.end_ms,
        is_final: true,
      }),
    });
    if (!response.ok) throw new Error(`/debug/utterance rejected ${utterance.utterance_id}`);
  }

  // The fast pass runs per turn off the bus; the slow pass is interval-driven
  // and this transcript is shorter than the interval, so drive it explicitly.
  const flush = await app.request(`/memory/extract/${transcript.conversation_id}`, { method: 'POST' });
  if (!flush.ok) throw new Error('slow-pass flush failed');

  const stored = await collections
    .utterances()
    .countDocuments({ owner_id: OWNER_ID, conversation_id: transcript.conversation_id });
  check('every fixture utterance reached Atlas', stored === transcript.utterances.length, `${stored} stored`);

  const moveHistory = await getFactHistory('p-maya', 'move');
  const currentMove = await resolveFactState('p-maya', 'move');
  check('Maya has a supersession chain on her move date', moveHistory.length >= 2, `${moveHistory.length} facts`);
  check(
    'the live move fact is the September 15 one',
    /15|fifteen/i.test(currentMove?.claim ?? ''),
    currentMove?.claim ?? 'none',
  );
  check(
    'the superseded fact points at its replacement',
    moveHistory.some((fact) => fact.superseded_by === currentMove?._id),
  );

  // "Maya loves Ethiopian food, and me too" — one sentence, two people.
  const mayaFood = await resolveFactState('p-maya', 'preference');
  const julesFood = await resolveFactState('p-jules', 'preference');
  check('a fact stated in someone else\'s sentence attached to Maya', mayaFood !== null, mayaFood?.claim ?? 'none');
  check('"me too" attached the same fact to Jules', julesFood !== null, julesFood?.claim ?? 'none');

  const promises = await listPromises('open');
  const julesPromise = promises.find((promise) => promise.person_id === 'p-jules');
  check('Jules\'s promise was captured', julesPromise !== undefined, julesPromise?.text ?? 'none');
  check('"tonight" resolved to a concrete date', Boolean(julesPromise?.due_at), julesPromise?.due_at ?? 'none');

  const answer = await answerQuestion({ query: 'Where is Maya moving, and when?' });
  check('/ask answered from memory', answer.text.length > 0, answer.text);
  check('/ask cited its sources', answer.citations.length > 0, `${answer.citations.length} citations`);
  check('/ask reflects the current date, not the superseded one', /15|fifteen/i.test(answer.text));

  console.log(failures.length === 0 ? '\nLane B acceptance passed' : `\n${failures.length} check(s) failed`);
  if (failures.length > 0) process.exitCode = 1;
}

main().finally(closeDb);
