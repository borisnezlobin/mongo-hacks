import { describe, expect, it } from 'vitest';
import { REVIEW_PAGE_HTML } from './page';

/**
 * The page is one responsive document, not a desktop page with a phone page
 * beside it — two would drift apart the first time either was touched.
 */
describe('the page works without a keyboard', () => {
  const shortcuts: [string, string][] = [
    ['play the line', 'id="playTight"'],
    ['play with context', 'id="playPad"'],
    ['confirm as-is', 'id="confirm"'],
    ['edit the words', 'id="editWords"'],
    ['split the line', 'id="splitBtn"'],
    ['undo', 'id="undoBtn"'],
    ['previous line', 'id="prevLine"'],
    ['next line', 'id="nextLine"'],
  ];

  it.each(shortcuts)('has a button for %s', (_label, marker) => {
    // Every one of these was keyboard-only, which made the page unusable on the
    // device he was actually holding.
    expect(REVIEW_PAGE_HTML).toContain(marker);
  });

  it('picks a speaker by tapping, not only by pressing 1-9', () => {
    expect(REVIEW_PAGE_HTML).toContain("closest('.spk')");
  });

  it('carries a small-screen layout', () => {
    expect(REVIEW_PAGE_HTML).toMatch(/@media \(max-width: 760px\)/);
  });

  it('hides the shortcut hints where there is no keyboard', () => {
    const mobile = REVIEW_PAGE_HTML.slice(REVIEW_PAGE_HTML.indexOf('@media (max-width: 760px)'));
    expect(mobile).toMatch(/\.hints[^}]*display: none/);
    expect(mobile).toMatch(/kbd \{ display: none|\.deskonly, \.hints, kbd \{ display: none/);
  });

  it('gives the transcript room instead of one word per line', () => {
    // A 1fr text column inside a four-column grid on a 390px screen produced
    // "mo / us / inv / est" stacked vertically.
    const mobile = REVIEW_PAGE_HTML.slice(REVIEW_PAGE_HTML.indexOf('@media (max-width: 760px)'));
    expect(mobile).toMatch(/\.row \{ grid-template-columns: 46px 1fr/);
  });

  it('keeps the speaker picker to one swipeable row', () => {
    const mobile = REVIEW_PAGE_HTML.slice(REVIEW_PAGE_HTML.indexOf('@media (max-width: 760px)'));
    expect(mobile).toMatch(/#speakers \{[^}]*nowrap/);
  });

  it('caps the sheet so the transcript stays visible behind it', () => {
    const mobile = REVIEW_PAGE_HTML.slice(REVIEW_PAGE_HTML.indexOf('@media (max-width: 760px)'));
    expect(mobile).toMatch(/#panel \{[^}]*max-height/);
  });

  it('offers the compare button before the answers, so he listens then decides', () => {
    const question = REVIEW_PAGE_HTML.indexOf('data-both="1"');
    const answers = REVIEW_PAGE_HTML.indexOf('data-ans="same"');
    expect(question).toBeGreaterThan(0);
    expect(question).toBeLessThan(answers);
  });
});

/**
 * The review loop: a ruling has to hand him the next thing to do.
 *
 * These read the shipped page source. That is weaker than driving a browser,
 * but the defect being guarded against is a handler that saves and returns —
 * which is visible here and was invisible to every other test in the suite
 * while it was live.
 */
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

  it('offers an explicit next, so advancing is never the only way forward', () => {
    expect(REVIEW_PAGE_HTML).toContain('id="nextAction"');
  });

  it('tells him what the task is instead of leaving him to infer it', () => {
    expect(REVIEW_PAGE_HTML).toContain('id="taskHint"');
    expect(REVIEW_PAGE_HTML).toMatch(/Play the line, then tap who said it/);
  });

  it('leads with the questions on a phone and keeps the list one tap away', () => {
    expect(REVIEW_PAGE_HTML).toContain('id="viewToggle"');
    expect(REVIEW_PAGE_HTML).toMatch(/body\.view-questions main \{ display: none|body\.view-questions[^{]*main[^{]*\{ display: none/);
    expect(REVIEW_PAGE_HTML).toContain("setView(phone && questions.some");
  });

  it('does not report an interrupted playback as a broken span', () => {
    // Undo selects twice in quick succession, which aborts the first play.
    expect(REVIEW_PAGE_HTML).toContain('AbortError');
  });
});
