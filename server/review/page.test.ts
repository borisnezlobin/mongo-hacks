import { describe, expect, it } from 'vitest';
import { REVIEW_PAGE_HTML } from './page';

/**
 * The page is one responsive document, not a desktop page with a phone page
 * beside it — two would drift apart the first time either was touched.
 */
describe('the phone shows one decision, not a tool', () => {
  const phone = () => REVIEW_PAGE_HTML.slice(REVIEW_PAGE_HTML.indexOf('@media (max-width: 760px)'));

  it('renders none of the workbench on a small screen', () => {
    // Twice he could not work out what to do on his phone, the second time
    // after a responsive pass that made everything fit. Fitting was never the
    // problem: the screen was still a tool. Below 760px these are not
    // rearranged, they are absent.
    expect(phone()).toMatch(/header, #stale, #ask, #cov, #people, main, #panel, #done \{ display: none/);
  });

  it('gives the card the whole screen', () => {
    expect(phone()).toMatch(/#card \{[^}]*min-height: 100dvh/);
  });

  it('offers exactly the controls a question needs and nothing else', () => {
    const card = REVIEW_PAGE_HTML.slice(REVIEW_PAGE_HTML.indexOf('if (card.kind === \'question\')'));
    const controls = [...card.slice(0, 1200).matchAll(/data-(clip|a)="([a-z]+)"/g)].map((match) => match[0]);
    expect(controls).toEqual([
      'data-clip="a"', 'data-clip="b"', 'data-a="same"', 'data-a="different"', 'data-a="unsure"',
    ]);
  });

  it('does not put our cluster ids in front of him', () => {
    // "0:E vs 950:E" is bookkeeping from a retired scheme. It belongs in the
    // file the answer is written to, not next to the buttons.
    const card = REVIEW_PAGE_HTML.slice(
      REVIEW_PAGE_HTML.indexOf('function showCard'),
      REVIEW_PAGE_HTML.indexOf('$(\'card\').addEventListener'),
    );
    expect(card).not.toContain('label_a');
    expect(card).not.toContain('label_b');
  });

  it('neither answer is styled as the recommended one', () => {
    const card = REVIEW_PAGE_HTML.slice(REVIEW_PAGE_HTML.indexOf('data-a="same"'), REVIEW_PAGE_HTML.indexOf('data-a="unsure"'));
    expect(card).not.toContain('primary');
  });

  it('always offers a way past a card he cannot answer', () => {
    expect(REVIEW_PAGE_HTML).toContain('data-a="unsure"');
    expect(REVIEW_PAGE_HTML).toContain('data-skip="1"');
  });

  it('fits the voices without making him scroll to an answer', () => {
    expect(phone()).toMatch(/\.choices\.voices \{ display: grid; grid-template-columns: 1fr 1fr/);
  });

  it('says the run is over and that stopping is fine', () => {
    expect(REVIEW_PAGE_HTML).toContain('That is everything waiting for you.');
    expect(REVIEW_PAGE_HTML).toMatch(/You can stop any time/);
  });

  it('names the guess rather than leaving a ring to be decoded', () => {
    expect(REVIEW_PAGE_HTML).toContain('We think it was ');
  });

  it('keeps the full tool on a desktop', () => {
    for (const marker of ['id="panel"', 'id="rows"', 'id="cov"', 'id="ask"', 'id="splitBtn"']) {
      expect(REVIEW_PAGE_HTML).toContain(marker);
    }
  });

  it('has no leftover phone affordances from the layout it replaced', () => {
    for (const dead of ['viewToggle', 'prevLine', 'nextLine', 'editWords', 'mobonly', 'panelLine', 'view-questions']) {
      expect(REVIEW_PAGE_HTML, dead + ' should be gone').not.toContain(dead);
    }
  });
});

describe('a ruling hands over the next line', () => {
  const body = (name: string) => {
    const at = REVIEW_PAGE_HTML.indexOf(`function ${name}(`);
    expect(at, `${name} should exist`).toBeGreaterThan(-1);
    return REVIEW_PAGE_HTML.slice(at, REVIEW_PAGE_HTML.indexOf('\n}', at));
  };

  it('advances after confirming a line as it stands', () => {
    expect(body('confirmAsIs')).toContain('advance(');
  });

  it('advances after naming the speaker', () => {
    expect(body('setSpeaker')).toContain('advance(');
  });

  it('advances after recording a split', () => {
    expect(body('saveSplit')).toContain('advance(');
  });

  it('does NOT advance after saving words while the speaker is unsettled', () => {
    // Editing the words and then naming the speaker is two rulings on one line.
    // Advancing after the first throws away the line he was halfway through.
    const saveText = body('saveText');
    expect(saveText).toContain('settled');
    expect(saveText).toMatch(/if \(settled\)[^\n]*advance\(/);
    expect(saveText).toContain('Now tap who said it');
  });

  it('never advances on undo, and goes back to what it undid', () => {
    const retract = body('retract');
    expect(retract).not.toContain('advance(');
    expect(retract).toContain('lastRuledIndex');
  });

  it('ends the queue with somewhere to go rather than silence', () => {
    const finish = body('finishQueue');
    expect(finish).toContain('doneToQuestions');
    expect(finish).toContain('doneToList');
  });

  it('skips lines that already carry a ruling', () => {
    expect(body('advance')).toMatch(/!lines\[candidate\]\.ruling/);
  });

  it('says what was saved when it moves him on', () => {
    expect(REVIEW_PAGE_HTML).toContain("advance('Confirmed as it stood.')");
    expect(REVIEW_PAGE_HTML).toContain("saved.'");
  });

  it('offers an explicit next on the desktop, so advancing is never the only way forward', () => {
    expect(REVIEW_PAGE_HTML).toContain('id="nextAction"');
  });

  it('tells him what the task is instead of leaving him to infer it', () => {
    expect(REVIEW_PAGE_HTML).toContain('id="taskHint"');
    expect(REVIEW_PAGE_HTML).toMatch(/Play the line, then tap who said it/);
  });

  it('hands the phone the next card the moment one is answered', () => {
    const handler = REVIEW_PAGE_HTML.slice(REVIEW_PAGE_HTML.indexOf("$('card').addEventListener"));
    expect((handler.match(/showCard\(\)/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it('does not report an interrupted playback as a broken span', () => {
    // Undo selects twice in quick succession, which aborts the first play.
    expect(REVIEW_PAGE_HTML).toContain('AbortError');
  });
});

describe('skipping records that he looked and could not answer', () => {
  it('sends the skip rather than only hiding the card', () => {
    expect(REVIEW_PAGE_HTML).toContain("'/review/api/skip'");
  });

  it('does not offer to undo a skip, and says why', () => {
    // Asymmetry on purpose: "Change my last answer" takes back something
    // recorded about the audio. A skip asserts nothing, so there is nothing to
    // take back, and offering it would imply skipping was a commitment.
    const handler = REVIEW_PAGE_HTML.slice(REVIEW_PAGE_HTML.indexOf("closest('[data-skip]')"));
    expect(handler.slice(0, 900)).toContain('lastCard = null');
    expect(REVIEW_PAGE_HTML).toMatch(/Do not make\s*\n?\s*\/\/ this symmetrical/);
  });

  it('keeps a skipped line off the phone once it is recorded', () => {
    expect(REVIEW_PAGE_HTML).toContain('!line.skipped_at');
  });

  it('makes them findable on a desktop instead of losing them', () => {
    expect(REVIEW_PAGE_HTML).toContain('id="modeSkipped"');
    expect(REVIEW_PAGE_HTML).toContain("mode === 'skipped'");
    expect(REVIEW_PAGE_HTML).toContain('needed more than the card');
  });

  it('says so out loud when the browser refuses to autoplay', () => {
    // A card that looks like it should be making a sound and is not reads as
    // broken. iOS wants a gesture per element, so the fallback has to be the
    // obvious thing to tap.
    expect(REVIEW_PAGE_HTML).toContain('Tap to play this line');
  });
});
