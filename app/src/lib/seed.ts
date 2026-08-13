import type { Conversation, Fact, Id, Person, PromiseMemory, Utterance } from '../../../shared/contracts';
import { OWNER_ID } from '../../../shared/contracts';

/**
 * Mirrors fixtures/transcript.json and fixtures/seed.mjs so Lane C renders real-shaped
 * data before the server exists. The ids match the fixtures exactly, so switching from
 * seeded to live data changes nothing downstream.
 */

const now = Date.now();
const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();
const days = (count: number) => count * 24 * 60 * 60 * 1000;

export const DEMO_CONVERSATION_ID = 'demo-conversation';
export const OWNER_PERSON_ID = 'p-amelia-owner';

export const seedPeople: Person[] = [
  { _id: OWNER_PERSON_ID, owner_id: OWNER_ID, name: 'Yan', is_owner: true, created_at: iso(-days(120)), updated_at: iso(0) },
  { _id: 'p-maya', owner_id: OWNER_ID, name: 'Maya', relationship: 'Friend from the climbing gym', created_at: iso(-days(64)), updated_at: iso(-days(1)) },
  { _id: 'p-jules', owner_id: OWNER_ID, name: 'Jules', relationship: 'Photographs the supper club', created_at: iso(-days(41)), updated_at: iso(-days(2)) },
  { _id: 'p-priya', owner_id: OWNER_ID, name: 'Priya', relationship: 'Met at MongoDB .local', created_at: iso(-days(7)), updated_at: iso(-days(7)) },
  { _id: 'p-omar', owner_id: OWNER_ID, name: 'Omar', relationship: "Maya's brother", created_at: iso(-days(30)), updated_at: iso(-days(9)) },
  { _id: 'p-theo', owner_id: OWNER_ID, name: 'Theo', created_at: iso(-days(18)), updated_at: iso(-days(18)) },
];

export const seedFacts: Fact[] = [
  {
    _id: 'f-maya-move-1', owner_id: OWNER_ID, person_id: 'p-maya', attribute: 'move_date',
    claim: 'Moving to Oakland on September 1', claim_normalized: 'moving to oakland on september 1',
    primary_source_utterance_id: 'u2', valid_from: iso(-days(1)),
    superseded_at: iso(-60_000), superseded_by: 'f-maya-move-2', created_at: iso(-days(1)),
  },
  {
    _id: 'f-maya-move-2', owner_id: OWNER_ID, person_id: 'p-maya', attribute: 'move_date',
    claim: 'Moving to Oakland on September 15', claim_normalized: 'moving to oakland on september 15',
    primary_source_utterance_id: 'u5', valid_from: iso(-60_000), created_at: iso(-60_000),
  },
  {
    _id: 'f-maya-food', owner_id: OWNER_ID, person_id: 'p-maya', attribute: 'food_preference',
    claim: 'Loves Ethiopian food', claim_normalized: 'loves ethiopian food',
    primary_source_utterance_id: 'u3', valid_from: iso(-days(1)), created_at: iso(-days(1)),
  },
  {
    _id: 'f-jules-food', owner_id: OWNER_ID, person_id: 'p-jules', attribute: 'food_preference',
    claim: 'Also loves Ethiopian food', claim_normalized: 'also loves ethiopian food',
    primary_source_utterance_id: 'u3', valid_from: iso(-days(1)), created_at: iso(-days(1)),
  },
  {
    _id: 'f-priya-met', owner_id: OWNER_ID, person_id: 'p-priya', attribute: 'how_we_met',
    claim: 'Met Yan at the MongoDB hackathon', claim_normalized: 'met yan at the mongodb hackathon',
    primary_source_utterance_id: 'u4', valid_from: iso(-days(7)), created_at: iso(-days(7)),
  },
  {
    _id: 'f-omar-job', owner_id: OWNER_ID, person_id: 'p-omar', attribute: 'work',
    claim: 'Teaches sixth grade in Fruitvale', claim_normalized: 'teaches sixth grade in fruitvale',
    primary_source_utterance_id: 'u-omar-1', valid_from: iso(-days(30)), created_at: iso(-days(30)),
  },
  {
    _id: 'f-theo-travel', owner_id: OWNER_ID, person_id: 'p-theo', attribute: 'recent_trip',
    claim: 'Just got back from two weeks in Lisbon', claim_normalized: 'just got back from two weeks in lisbon',
    primary_source_utterance_id: 'u-theo-1', valid_from: iso(-days(18)), created_at: iso(-days(18)),
  },
];

/** One promise fires two minutes from launch so the local notification is demonstrable. */
export const NOTIFICATION_TEST_PROMISE_ID = 'pr-jules-photos';

export const seedPromises: PromiseMemory[] = [
  {
    _id: NOTIFICATION_TEST_PROMISE_ID, owner_id: OWNER_ID, person_id: 'p-jules', source_utterance_id: 'u6',
    text: "Send Yan the venue photos", text_normalized: 'send yan the venue photos',
    due_at: iso(2 * 60_000), status: 'open', created_at: iso(-60_000),
  },
  {
    _id: 'pr-owner-oakland', owner_id: OWNER_ID, person_id: OWNER_PERSON_ID, source_utterance_id: 'u-owner-1',
    text: 'Introduce Maya to Omar before she moves', text_normalized: 'introduce maya to omar before she moves',
    due_at: iso(days(3)), status: 'open', created_at: iso(-days(1)),
  },
  {
    _id: 'pr-priya-repo', owner_id: OWNER_ID, person_id: 'p-priya', source_utterance_id: 'u-priya-2',
    text: 'Share the hackathon repo link', text_normalized: 'share the hackathon repo link',
    status: 'open', created_at: iso(-days(7)),
  },
  {
    _id: 'pr-owner-theo', owner_id: OWNER_ID, person_id: OWNER_PERSON_ID, source_utterance_id: 'u-theo-2',
    text: 'Send Theo the Lisbon coffee list', text_normalized: 'send theo the lisbon coffee list',
    status: 'done', created_at: iso(-days(17)),
  },
];

export const seedUtterances: Utterance[] = [
  { _id: 'u1', person_id: OWNER_PERSON_ID, text: "I'm Yan. I build products that help people stay close.", start_ms: 0, end_ms: 4700 },
  { _id: 'u2', person_id: 'p-maya', text: "I'm Maya, and I move to Oakland on September first.", start_ms: 5000, end_ms: 9300 },
  { _id: 'u3', person_id: 'p-jules', text: 'Maya loves Ethiopian food, and me too.', start_ms: 9700, end_ms: 13200 },
  { _id: 'u4', person_id: 'p-priya', text: "I'm Priya. I met Yan at the MongoDB hackathon today.", start_ms: 13600, end_ms: 17800 },
  { _id: 'u5', person_id: 'p-maya', text: 'Actually my move date changed to September fifteenth.', start_ms: 18200, end_ms: 22200 },
  { _id: 'u6', person_id: 'p-jules', text: "I promise I'll send Yan the venue photos tonight.", start_ms: 22600, end_ms: 26800 },
].map((partial) => ({
  ...partial,
  owner_id: OWNER_ID,
  conversation_id: DEMO_CONVERSATION_ID,
  is_final: true,
  created_at: iso(-days(1)),
  updated_at: iso(-days(1)),
}));

export const seedConversations: Conversation[] = [
  {
    _id: DEMO_CONVERSATION_ID, owner_id: OWNER_ID, started_at: iso(-days(1)), ended_at: iso(-days(1) + 27_000),
    title: 'Dinner at the supper club', participant_ids: [OWNER_PERSON_ID, 'p-maya', 'p-jules', 'p-priya'],
  },
  {
    _id: 'c-hackathon', owner_id: OWNER_ID, started_at: iso(-days(7)), ended_at: iso(-days(7) + 600_000),
    title: 'Pier 48, hackathon kickoff', participant_ids: [OWNER_PERSON_ID, 'p-priya'],
  },
  {
    _id: 'c-climbing', owner_id: OWNER_ID, started_at: iso(-days(18)), ended_at: iso(-days(18) + 420_000),
    title: 'Bouldering with Theo', participant_ids: [OWNER_PERSON_ID, 'p-theo'],
  },
];

/** Speaker who arrives unattributed in the live stream; the naming flow adopts them. */
export const UNKNOWN_PERSON_ID: Id = 'p-unknown-live';
export const UNKNOWN_VOICEPRINT_ID: Id = 'vp-unknown-live';
