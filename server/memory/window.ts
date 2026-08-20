import type { Id, Utterance } from '../../shared/contracts';

/**
 * Turning a stream of finalized utterances into units of extraction work.
 *
 * Real speech is not one fact per turn. A 48-minute recording of seven people
 * produced 2,772 finalized segments, 61% of which are three words or fewer:
 * "Yeah.", "Oh,", "Wait,". Spending one LLM call per segment is thousands of
 * calls for a conversation whose entire text is 57KB, and it cannot keep up
 * with the speech that produced it. Extraction is therefore batched over
 * windows of turns, and the size of a window is set by how much was actually
 * said rather than by how many times somebody took a breath.
 */

/**
 * Raw transcript characters that fill a window.
 *
 * Measured on the 48-minute recording: the whole transcript is 57,079
 * characters, so 3,500 splits it into roughly 17 windows of a few minutes of
 * speech each — long enough that a fact split across several turns lands
 * inside one window, short enough to stay well inside the model's useful
 * attention and the reply token cap.
 */
export const WINDOW_CHAR_BUDGET = 3_500;

/**
 * How long a fact may wait before it is extracted.
 *
 * The product promise is that memories appear while you are still talking, so
 * the budget alone is not enough: that recording only averages ~1,180
 * characters of speech per minute, so a window would take three minutes to
 * fill. A one-minute ceiling means anything said is extracted within about a
 * minute of being said, and it bounds the cost of a conversation at one call
 * per elapsed minute regardless of how fast people talk.
 */
export const WINDOW_MAX_WAIT_MS = 60_000;

/**
 * Transcript carried from the previous window into the next one.
 *
 * A claim is regularly split over a boundary — the question in one turn, the
 * answer in the next. Overlapping turns are fully citable, not context-only:
 * the append-only idempotency index on (source utterance, normalized claim)
 * collapses the duplicate when both windows extract the same thing.
 */
export const WINDOW_OVERLAP_CHARS = 800;

/**
 * Content words a window must contain before it is worth a call at all.
 *
 * Insurance against a recorder left running in a quiet room, where the wait
 * timer would otherwise fire once a minute forever on windows containing
 * nothing but "mhm".
 *
 * Measured on the 48-minute recording, cut into one-minute windows: the
 * *thinnest* real minute of that conversation still holds 55 content words and
 * the median holds 83, while 39% of individual segments hold none at all. A
 * floor of 12 therefore sits about four times below anything real speech
 * produces — it suppresses empty air and nothing else. It saved no calls on
 * that recording; it is there for the empty case, not the busy one.
 */
export const WINDOW_MIN_CONTENT_WORDS = 12;

/** Same speaker, no meaningful pause: one turn that was transcribed in pieces. */
export const TURN_COALESCE_GAP_MS = 1_500;

/**
 * Closed-class and backchannel English.
 *
 * Deliberately generic: function words, discourse markers and acknowledgement
 * tokens. Nothing here is drawn from what any particular conversation was
 * about, and the list is only ever used to decide whether a window is empty —
 * never to drop an utterance, which would risk discarding "I'm a sophomore"
 * for containing exactly one content word.
 */
const FILLER_WORDS = new Set(
  (
    'a an and are as at be been being but by can cant could did didnt do does doesnt dont for from ' +
    'had has have he her here him his how i id if ill im in into is it its ive just me mine my no ' +
    'not of off oh on or our out she should so some such than that thats the their them then there ' +
    'these they this those to too us was we well were what when where which who whom why will with ' +
    'would you your youre ' +
    'yeah yea yep yup yes nah nope ok okay uh um umm huh hmm mhm mm mmm er ah aha oh ohh right sure ' +
    'wait really exactly totally true nice cool damn wow haha lol hey hi hello bye ' +
    'like know gonna gotta wanna kinda sorta actually literally basically anyway mean say said ' +
    'thing things stuff guy guys dude bro man ' +
    'get got go going going one two go come came see saw look looks'
  ).split(' '),
);

const WORD_PATTERN = /[a-z0-9']+/g;

/**
 * Words left after stripping fillers. Apostrophes are folded out first so
 * "don't" and "dont" are the same token, and single letters never count.
 */
export function contentWordCount(text: string): number {
  const words = text.toLowerCase().match(WORD_PATTERN) ?? [];
  let count = 0;
  for (const word of words) {
    const bare = word.replace(/'/g, '');
    if (bare.length > 1 && !FILLER_WORDS.has(bare)) count += 1;
  }
  return count;
}

export function windowContentWords(utterances: Utterance[]): number {
  return utterances.reduce((total, utterance) => total + contentWordCount(utterance.text), 0);
}

export function windowChars(utterances: Utterance[]): number {
  return utterances.reduce((total, utterance) => total + utterance.text.length, 0);
}

/**
 * A speaker's turn as the model sees it.
 *
 * `utterance_id` is the first segment of the run, and it is what a claim cites.
 * The alternative — asking the model to pick which of five fragments of one
 * sentence a fact came from — is a guess dressed as precision, and the segment
 * where the speaker started talking is both real and stable across replays.
 */
export interface CoalescedTurn {
  utterance_id: Id;
  person_id?: Id;
  member_utterance_ids: Id[];
  text: string;
  start_ms: number;
  end_ms: number;
}

export function coalesceTurns(utterances: Utterance[]): CoalescedTurn[] {
  const turns: CoalescedTurn[] = [];
  for (const utterance of utterances) {
    const text = utterance.text.trim();
    if (!text) continue;
    const open = turns[turns.length - 1];
    const sameSpeaker = open && open.person_id === utterance.person_id;
    const continuous = open && utterance.start_ms - open.end_ms <= TURN_COALESCE_GAP_MS;
    if (open && sameSpeaker && continuous) {
      open.text = `${open.text} ${text}`;
      open.end_ms = Math.max(open.end_ms, utterance.end_ms);
      open.member_utterance_ids.push(utterance._id);
      continue;
    }
    turns.push({
      utterance_id: utterance._id,
      ...(utterance.person_id ? { person_id: utterance.person_id } : {}),
      member_utterance_ids: [utterance._id],
      text,
      start_ms: utterance.start_ms,
      end_ms: utterance.end_ms,
    });
  }
  return turns;
}

/** Split a whole stored conversation into windows for an offline sweep. */
export function splitIntoWindows(
  utterances: Utterance[],
  budgetChars = WINDOW_CHAR_BUDGET,
  overlapChars = WINDOW_OVERLAP_CHARS,
): Utterance[][] {
  const windows: Utterance[][] = [];
  let pending: Utterance[] = [];
  let emittedThrough = -1;
  utterances.forEach((utterance, index) => {
    pending.push(utterance);
    if (windowChars(pending) < budgetChars) return;
    windows.push(pending);
    emittedThrough = index;
    pending = trailingChars(pending, overlapChars);
  });
  if (emittedThrough < utterances.length - 1 && pending.length > 0) windows.push(pending);
  return windows;
}

/** The tail of a window, up to a character budget, oldest-first. */
export function trailingChars(utterances: Utterance[], budget: number): Utterance[] {
  const tail: Utterance[] = [];
  let used = 0;
  for (let index = utterances.length - 1; index >= 0; index -= 1) {
    const utterance = utterances[index];
    if (!utterance) break;
    used += utterance.text.length;
    if (used > budget && tail.length > 0) break;
    tail.unshift(utterance);
  }
  return tail;
}

/**
 * The live buffer for one conversation.
 *
 * Utterances are never discarded here — a window that is too thin to be worth
 * a call keeps accumulating rather than being thrown away, and whatever is
 * still buffered when the conversation ends is swept from storage anyway.
 */
export class ConversationWindow {
  private pending: Utterance[] = [];
  private openedAtMs: number | undefined;

  /**
   * The clock starts on the first *new* utterance, not on the overlap tail
   * carried over from the last window — otherwise a conversation that goes
   * quiet would keep firing the wait timer on turns it has already extracted.
   */
  add(utterance: Utterance, nowMs: number): void {
    if (this.openedAtMs === undefined) this.openedAtMs = nowMs;
    this.pending.push(utterance);
  }

  get size(): number {
    return this.pending.length;
  }

  /** Milliseconds until the wait timer would fire, or undefined when idle. */
  waitRemainingMs(nowMs: number): number | undefined {
    if (this.openedAtMs === undefined) return undefined;
    return Math.max(0, this.openedAtMs + WINDOW_MAX_WAIT_MS - nowMs);
  }

  isReady(nowMs: number): boolean {
    if (this.pending.length === 0) return false;
    if (windowContentWords(this.pending) < WINDOW_MIN_CONTENT_WORDS) return false;
    if (windowChars(this.pending) >= WINDOW_CHAR_BUDGET) return true;
    return this.waitRemainingMs(nowMs) === 0;
  }

  /**
   * Hand the window over for extraction and start the next one from the
   * overlap tail, so a sentence straddling the boundary is seen whole once.
   */
  take(): Utterance[] {
    const taken = this.pending;
    this.pending = [];
    this.openedAtMs = undefined;
    for (const utterance of trailingChars(taken, WINDOW_OVERLAP_CHARS)) {
      this.pending.push(utterance);
    }
    return taken;
  }

  /** Everything buffered, including the overlap tail, without resetting. */
  peek(): Utterance[] {
    return [...this.pending];
  }

  clear(): void {
    this.pending = [];
    this.openedAtMs = undefined;
  }
}
