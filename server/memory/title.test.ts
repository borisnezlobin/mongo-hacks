import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversationEvent, Utterance } from '../../shared/contracts'
import { buildTranscript, titleConversation } from './title'

vi.mock('./llm', () => ({
  extractStructured: vi.fn(async () => ({ title: 'Oakland move and venue photos' })),
}))
const { extractStructured } = await import('./llm')

function utterance(text: string, startMs: number, personId?: string): Utterance {
  return {
    _id: `u-${startMs}`,
    owner_id: 'owner',
    conversation_id: 'c-1',
    person_id: personId,
    text,
    start_ms: startMs,
    end_ms: startMs + 1000,
    is_final: true,
    created_at: '2026-08-14T00:00:00.000Z',
    updated_at: '2026-08-14T00:00:00.000Z',
  }
}

function harness(utterances: Utterance[]) {
  const updates: object[] = []
  const events: ConversationEvent[] = []
  return {
    updates,
    events,
    deps: {
      utterances: { find: () => ({ toArray: async () => utterances }) },
      conversations: { updateOne: async (_f: object, u: object) => { updates.push(u) } },
      bus: { emit: (event: ConversationEvent) => events.push(event) },
      nameFor: (id: string) => ({ 'p-maya': 'Maya', 'p-yan': 'Yan' })[id],
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('conversation titling', () => {
  it('names a conversation and publishes it', async () => {
    const h = harness([utterance('I move on the first', 0, 'p-maya'), utterance('Send the photos', 2000, 'p-yan')])

    const title = await titleConversation('c-1', 'owner', h.deps)

    expect(title).toBe('Oakland move and venue photos')
    expect(h.updates[0]).toMatchObject({ $set: { title: 'Oakland move and venue photos' } })
    expect(h.events[0]).toMatchObject({ type: 'conversation', conversation_id: 'c-1' })
  })

  /** A one-line recording has nothing to name, and inventing a title is worse than none. */
  it('leaves a too-short conversation untitled without calling the model', async () => {
    const h = harness([utterance('Hello', 0, 'p-maya')])

    expect(await titleConversation('c-1', 'owner', h.deps)).toBeNull()
    expect(extractStructured).not.toHaveBeenCalled()
    expect(h.updates).toEqual([])
  })

  it('writes nothing when the model declines to name it', async () => {
    vi.mocked(extractStructured).mockResolvedValueOnce({ title: 'Untitled conversation' })
    const h = harness([utterance('mm', 0), utterance('yeah', 1000)])

    expect(await titleConversation('c-1', 'owner', h.deps)).toBeNull()
    expect(h.updates).toEqual([])
    expect(h.events).toEqual([])
  })

  it('strips the quoting and trailing punctuation models like to add', async () => {
    vi.mocked(extractStructured).mockResolvedValueOnce({ title: '"Dinner plans on Thursday."' })
    const h = harness([utterance('a', 0), utterance('b', 1000)])

    expect(await titleConversation('c-1', 'owner', h.deps)).toBe('Dinner plans on Thursday')
  })

  it('labels each line with its speaker, which is what makes a title specific', () => {
    const transcript = buildTranscript(
      [utterance('I move on the first', 0, 'p-maya'), utterance('Got it', 2000)],
      (id) => (id === 'p-maya' ? 'Maya' : undefined),
    )

    expect(transcript).toBe('Maya: I move on the first\nSomeone: Got it')
  })
})
