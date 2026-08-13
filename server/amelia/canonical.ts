/**
 * Lane D's acceptance test — the canonical command, end to end against a real
 * model call. This is the gate: everything else is typechecked and unit-tested,
 * but only this proves the agent loop actually works.
 *
 *   ANTHROPIC_API_KEY=... npx tsx server/amelia/canonical.ts
 *
 * Not in the vitest suite because it costs a real API call and ~15s.
 *
 * The command is adapted from the build plan to the team's ACTUAL fixture data
 * (fixtures/transcript.json): Maya moving to Oakland, not Jerry's trip. The
 * shape is what matters — a conditional that branches on a superseded fact.
 */

import { runAmelia } from './agent';
import { createFixtureMemory } from './fixture-memory';
import { listDrafts } from './email';
import { createStepper } from './steps';
import { speak } from './tts';

const COMMAND =
  'email Maya asking how the move is going — if she has already moved, ask how Oakland is ' +
  'treating her. If she has not, ask whether she needs help packing.';

// Maya's CURRENT move date is September 15; today is well before that, so the
// only correct branch is "has not moved yet" → offer help packing.
const MOVE_DATE = new Date('2026-09-15T00:00:00Z');
const hasMoved = Date.now() >= MOVE_DATE.getTime();

const memory = createFixtureMemory();
const stepper = createStepper('canonical-run', (event) =>
  console.log(`  · [${event.step}] ${event.message}`),
);

console.log(`Command: ${COMMAND}\n`);
const result = await runAmelia({
  requestId: 'canonical-run',
  command: COMMAND,
  memory,
  stepper,
});

console.log(`\nReply: ${result.text || '(none)'}`);
console.log(
  `Tool calls: ${result.toolCallsUsed}` +
    `${result.cappedOut ? ' (hit cap)' : ''}` +
    `${result.truncated ? ' TRUNCATED' : ''}` +
    `${result.refused ? ' REFUSED' : ''}`,
);
console.log(`Memory calls: ${memory.calls.join(' | ') || '(none)'}`);

const draft = listDrafts()[0];
console.log(`\nDraft: ${draft ? `"${draft.subject}" → ${draft.to_name} <${draft.to_email}>` : '(none)'}`);
if (draft) console.log(`\n${draft.body}\n`);

const body = (draft?.body ?? '').toLowerCase();
const packing = /pack|help|before you go|move day/.test(body);
const arrived = /how is oakland|how's oakland|settled in|how are you finding/.test(body);

const checks: [string, boolean][] = [
  ['produced a spoken reply', result.text.length > 0],
  ['was not refused or truncated', !result.refused && !result.truncated],
  ['drafted an email', Boolean(draft)],
  ['addressed it from memory, not invention', draft?.to_email === 'maya@example.com'],
  [
    'called resolve_fact_state on the move date',
    memory.calls.some((c) => c.includes('resolveFactState') && /move(?:_date)?/.test(c)),
  ],
  ['stayed under the tool cap', !result.cappedOut],
  ['did not claim to have sent it', !/\b(i )?(sent|emailed) (it|her|the)\b/i.test(result.text)],
  [
    `took ONE branch — expected ${hasMoved ? '"already moved"' : '"not yet moved"'}`,
    hasMoved ? arrived && !packing : packing && !arrived,
  ],
];

console.log('Checks:');
let failed = 0;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}`);
  if (!ok) failed++;
}

// speak() swallows failures on purpose — a dead ElevenLabs should cost the
// voice, not the answer. Distinguish "not configured" from "tried and failed"
// so a 402/401 isn't mistaken for a missing key (see the console for detail).
const spoken = await speak(result.text);
console.log(
  `\nSpoken reply: ${
    spoken
      ? spoken.path
      : process.env.ELEVENLABS_API_KEY
        ? 'FAILED — key is set but TTS did not return audio (see error above)'
        : 'skipped (ELEVENLABS_API_KEY not set)'
  }`,
);

console.log(failed === 0 ? '\ncanonical command PASSES' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
