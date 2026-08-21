import { durationHelpersSource } from './format';

/**
 * The review page, served as one self-contained document.
 *
 * Hand-written CSS rather than the project's usual Tailwind because this is a
 * local operator tool served as a string from the server with no build step in
 * front of it, and the alternative — a Tailwind CDN script — costs a network
 * round trip on every load of a page whose entire purpose is that nothing
 * between a click and audio takes time.
 *
 * The performance shape that matters:
 *  - every span is fetched as its own small wav and cached as a blob URL, so a
 *    replay is a `currentTime = 0`, not a request;
 *  - selecting a line prefetches its padded version and its neighbours, so the
 *    next click is already in memory;
 *  - rows use `content-visibility: auto`, which keeps layout and paint off the
 *    ~900 lines that are not on screen without the bug surface of a virtual list.
 */
const REVIEW_PAGE_TEMPLATE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Transcript review</title>
<style>
  :root {
    --paper: #fbfaf8;
    --card: #ffffff;
    --ink: #1b1b19;
    --ink-soft: #6a6862;
    --ink-faint: #97948c;
    --rule: #e7e4dd;
    --accent: #0f6b5c;
    --accent-soft: #e6f1ee;
    --confirm: #2f7d32;
    --confirm-soft: #eaf4ea;
    --edit: #8a5a12;
    --edit-soft: #fbf1e0;
    --alarm: #a52f2f;
    --alarm-soft: #fbeaea;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    background: var(--paper);
    color: var(--ink);
    font: 15px/1.5 ui-sans-serif, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .warn {
    margin: 0 0 10px;
    padding: 10px 14px;
    border-radius: 8px;
    background: var(--alarm-bg, #fdf2f2);
    color: var(--alarm, #8c2f2f);
    font-size: 14px;
  }
  header {
    position: sticky; top: 0; z-index: 20;
    background: rgba(251,250,248,.94);
    backdrop-filter: blur(8px);
    border-bottom: 1px solid var(--rule);
    padding: 10px 20px;
    display: flex; align-items: center; gap: 18px; flex-wrap: wrap;
  }
  h1 { font-size: 15px; font-weight: 650; margin: 0; letter-spacing: -.01em; }
  .muted { color: var(--ink-soft); font-size: 13px; }
  .faint { color: var(--ink-faint); font-size: 12px; }
  .grow { flex: 1; }
  select, input[type=text], textarea {
    font: inherit; color: inherit; background: var(--card);
    border: 1px solid var(--rule); border-radius: 6px; padding: 6px 9px;
  }
  textarea { width: 100%; resize: vertical; line-height: 1.5; }
  button {
    font: inherit; font-size: 13px; cursor: pointer;
    background: var(--card); color: var(--ink);
    border: 0; box-shadow: inset 0 0 0 1px var(--rule);
    border-radius: 6px; padding: 6px 11px;
  }
  button:hover { box-shadow: inset 0 0 0 1px var(--ink-faint); }
  button.primary { background: var(--accent); color: #fff; box-shadow: none; font-weight: 600; }
  button.primary:hover { background: #0c5a4d; }
  button.good { background: var(--confirm-soft); color: var(--confirm); box-shadow: none; font-weight: 600; }
  button.danger { background: var(--alarm-soft); color: var(--alarm); box-shadow: none; font-weight: 600; }
  kbd {
    font: 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
    background: var(--paper); box-shadow: inset 0 0 0 1px var(--rule);
    border-radius: 4px; padding: 3px 5px; color: var(--ink-soft);
  }

  #people { display: flex; gap: 6px; flex-wrap: wrap; padding: 8px 20px; border-bottom: 1px solid var(--rule); }
  .chip {
    display: inline-flex; align-items: center; gap: 6px;
    background: var(--card); box-shadow: inset 0 0 0 1px var(--rule);
    border-radius: 999px; padding: 4px 6px 4px 12px; font-size: 13px;
  }
  .chip .rename { padding: 2px 7px; font-size: 11px; border-radius: 999px; box-shadow: inset 0 0 0 1px var(--rule); background: var(--paper); }
  .chip.renamed { background: var(--edit-soft); box-shadow: none; color: var(--edit); font-weight: 600; }

  main { padding: 0 0 380px; }
  .row {
    display: grid; grid-template-columns: 74px 132px 1fr 96px;
    gap: 12px; align-items: start;
    padding: 7px 20px; border-bottom: 1px solid var(--rule);
    cursor: pointer;
    content-visibility: auto; contain-intrinsic-size: 0 40px;
  }
  .row:hover { background: #f4f2ee; }
  .row.sel { background: var(--accent-soft); content-visibility: visible; }
  .row.ruled { border-left: 3px solid var(--confirm); padding-left: 17px; }
  .row.edited { border-left: 3px solid var(--edit); padding-left: 17px; }
  .row.contested { border-left: 3px solid var(--alarm); padding-left: 17px; }
  .t { font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--ink-faint); }
  .who { font-size: 13px; font-weight: 600; color: var(--accent); overflow-wrap: anywhere; }
  .who.was { color: var(--edit); }
  .who small { display: block; font-weight: 400; color: var(--ink-faint); font-size: 11px; text-decoration: line-through; }
  .say { overflow-wrap: anywhere; }
  .say.was { color: var(--edit); }
  .say del { color: var(--ink-faint); text-decoration: line-through; display: block; font-size: 13px; }
  .marks { display: flex; gap: 4px; justify-content: flex-end; flex-wrap: wrap; }
  .mark { font-size: 10px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; border-radius: 4px; padding: 2px 5px; }
  .mark.ok { background: var(--confirm-soft); color: var(--confirm); }
  .mark.ed { background: var(--edit-soft); color: var(--edit); }
  .mark.cf { background: var(--alarm-soft); color: var(--alarm); }

  #panel {
    position: fixed; left: 0; right: 0; bottom: 0; z-index: 30;
    background: var(--card); border-top: 1px solid var(--rule);
    box-shadow: 0 -6px 24px rgba(0,0,0,.07);
    padding: 12px 20px 14px; display: none;
  }
  #panel.on { display: block; }
  .panelrow { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 7px; }
  .panelrow:last-child { margin-bottom: 0; }
  .label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--ink-faint); width: 62px; flex: none; }
  .spk { padding: 5px 10px; border-radius: 999px; box-shadow: inset 0 0 0 1px var(--rule); background: var(--paper); }
  .spk.cur { background: var(--accent); color: #fff; box-shadow: none; font-weight: 600; }
  #status { font-size: 12px; color: var(--ink-soft); min-height: 16px; }
  #status.bad { color: var(--alarm); font-weight: 600; }

  .row.retracted { border-left: 3px solid var(--rule); padding-left: 17px; opacity: .62; }
  .row.skipped { border-left: 3px solid var(--edit); padding-left: 17px; }
  .mark.sk { background: var(--edit-soft); color: var(--edit); }
  .row.hassplit { border-left: 3px solid var(--accent); padding-left: 17px; }
  .mark.sp { background: var(--accent-soft); color: var(--accent); }
  .mark.rt { background: #f1efea; color: var(--ink-faint); }
  .parts { grid-column: 3 / 5; margin-top: 5px; display: flex; flex-direction: column; gap: 3px; }
  .part { display: flex; gap: 8px; font-size: 13px; background: var(--accent-soft); border-radius: 5px; padding: 4px 8px; }
  .part b { color: var(--accent); font-weight: 650; flex: none; min-width: 96px; }

  #splitter { display: none; }
  #splitter.on { display: block; }
  .wordline { line-height: 2.5; margin: 2px 0 8px; }
  .w { padding: 2px 1px; border-radius: 3px; }
  .cut {
    display: inline-block; width: 15px; margin: 0 -1px; cursor: pointer;
    text-align: center; color: var(--ink-faint); border-radius: 3px; user-select: none;
  }
  .cut:hover { background: var(--edit-soft); color: var(--edit); }
  .cut.sentence { color: var(--accent); font-weight: 700; }
  .cut.on { background: var(--accent); color: #fff; font-weight: 700; }
  .pedit { display: flex; gap: 8px; align-items: center; margin-bottom: 5px; flex-wrap: wrap; }
  .pedit .num { font-size: 11px; font-weight: 700; color: var(--ink-faint); width: 46px; flex: none; }
  .pedit .txt { flex: 1; min-width: 180px; font-size: 13px; }
  .pedit select { max-width: 260px; }
  #ask { padding: 10px 20px; border-bottom: 1px solid var(--rule); background: #f6f8f7; }
  .q { background: var(--card); border-radius: 8px; padding: 12px 14px; box-shadow: 0 1px 3px rgba(0,0,0,.06); }
  .q h2 { margin: 0 0 3px; font-size: 14px; font-weight: 650; }
  .q .worth { color: var(--accent); font-weight: 700; }
  .sides { display: flex; gap: 10px; margin: 9px 0; flex-wrap: wrap; }
  .side { flex: 1; min-width: 230px; background: var(--paper); border-radius: 6px; padding: 8px 10px; }
  .side b { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--ink-faint); }
  .side .clips { display: flex; gap: 5px; margin-top: 5px; flex-wrap: wrap; }
  .qdone { font-size: 12px; color: var(--confirm); font-weight: 600; }
  #cov { display: flex; gap: 5px; flex-wrap: wrap; padding: 7px 20px; border-bottom: 1px solid var(--rule); align-items: center; }
  .cv { font-size: 11px; border-radius: 999px; padding: 3px 9px; background: #f1efea; color: var(--ink-soft); }
  .cv.dark { background: var(--alarm-soft); color: var(--alarm); font-weight: 700; }
  .cv.done { background: var(--confirm-soft); color: var(--confirm); font-weight: 600; }
  .warnline { font-size: 11px; color: var(--edit); grid-column: 3 / 5; }
  .modepick button.on { background: var(--accent); color: #fff; box-shadow: none; font-weight: 600; }
  button.minor { font-size: 12px; padding: 5px 9px; color: var(--ink-soft); }
  #done:empty { display: none; }
  #done { padding: 12px 20px; }

  /*
   * The phone layout. One stylesheet, not a second page: two layouts drift
   * apart the first time either is touched, and he uses both.
   *
   * Everything here follows from the two things he actually does on a phone —
   * answer a same-or-different question, and rule on a line — and from the fact
   * that neither can require scrolling between hearing and deciding. Keyboard
   * shortcuts are the primary interface on the desktop and do not exist here,
   * so every one of them has a button, and the hints that explain them are
   * hidden rather than allowed to dominate a 390px column.
   */


  /*
   * The phone is not a small desktop.
   *
   * Twice he said he could not figure this out on his phone, and the second
   * time was after a responsive pass that made everything fit. Fitting was
   * never the problem: the screen still showed a tool — a transcript, a
   * roster, counters, a mode switch, a bottom sheet with nine controls — and
   * asked him to work out which part of it he was supposed to use.
   *
   * So below 760px the tool is gone. Not rearranged: not rendered. One card
   * fills the screen, carries exactly one decision, and is replaced by the
   * next one when he answers. Everything a card does not need is absent, which
   * is the only reliable way to stop it needing interpretation.
   */
  #card { display: none; }

  @media (max-width: 760px) {
    header, #stale, #ask, #cov, #people, main, #panel, #done { display: none !important; }

    #card {
      display: flex; flex-direction: column; gap: 14px;
      min-height: 100vh; min-height: 100dvh;
      padding: 26px 18px 26px; box-sizing: border-box;
    }
    .cardq { font-size: 21px; line-height: 1.3; font-weight: 650; letter-spacing: -.01em; margin: 0; }
    .cardsay {
      font-size: 17px; line-height: 1.5; color: var(--ink);
      background: var(--paper); border-radius: 10px; padding: 12px 14px;
      display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden;
    }
    .big {
      width: 100%; min-height: 54px; font-size: 16px; border-radius: 10px;
      justify-content: center; display: flex; align-items: center; text-align: center;
    }
    .choices { display: flex; flex-direction: column; gap: 8px; }
    /* Eight voices stacked full-width overflowed the screen, and scrolling to
       reach an answer is the one thing a card must never require. Two columns
       fit them all; the names are short. */
    .choices.voices { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .choices.voices .big { min-height: 50px; font-size: 15px; }
    /* The way out sits at the bottom, away from the decision, always reachable. */
    .out { margin-top: auto; display: flex; flex-direction: column; gap: 8px; padding-top: 10px; }
    .out .big { min-height: 46px; font-size: 14px; color: var(--ink-soft); }
    .out .big.primary { color: #fff; font-size: 16px; min-height: 54px; }
    .quiet { background: none; box-shadow: none; text-decoration: underline; font-size: 13px; padding: 6px; }
    .suggested { box-shadow: inset 0 0 0 2px var(--accent); }
    .cardnote { font-size: 13px; color: var(--ink-faint); margin: 0; }
    .cardlist { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 10px; }
    .cardlist li { font-size: 15px; line-height: 1.45; color: var(--ink-soft); }
    .cardlist b { color: var(--ink); }
    #card textarea, #card input[type=text] { width: 100%; font-size: 16px; padding: 10px 12px; border-radius: 10px; }
    .cardwarn { font-size: 13px; color: var(--alarm); background: var(--alarm-soft); border-radius: 8px; padding: 9px 11px; }
  }

  .banner { background: var(--alarm-soft); color: var(--alarm); border-radius: 6px; padding: 8px 12px; font-size: 13px; margin-bottom: 9px; display: none; }
  .banner.on { display: flex; gap: 10px; align-items: center; }
  .banner .grow { flex: 1; }
</style>
</head>
<body>
<header>
  <h1>Transcript review</h1>
  <select id="conv"></select>
  <span class="muted" id="summary"></span>
  <span class="modepick">
    <button id="modeQueue" class="on">Worth most next</button>
    <button id="modeTime">In order</button>
    <button id="modeSkipped">Needed more</button>
  </span>
  <span class="grow"></span>
  <span class="faint hints"><kbd>j</kbd><kbd>k</kbd> move &nbsp; <kbd>space</kbd> play line &nbsp; <kbd>c</kbd> with context &nbsp; <kbd>enter</kbd> correct as-is &nbsp; <kbd>e</kbd> edit words &nbsp; <kbd>1</kbd>-<kbd>9</kbd> speaker &nbsp; <kbd>x</kbd> split &nbsp; <kbd>u</kbd> undo</span>
</header>
<div id="card"></div>
<div id="stale"></div>
<div id="people"></div>
<div id="ask"></div>
<div id="cov"></div>
<div id="done"></div>
<main id="rows"></main>

<div id="panel">
  <div class="panelrow">
    <span class="label">Listen</span>
    <button class="primary" id="playTight">Play line <kbd style="background:rgba(255,255,255,.18);color:#fff;box-shadow:none">space</kbd></button>
    <button id="playPad">Play with context <kbd>c</kbd></button>
    <select id="pad">
      <option value="1000">&plusmn;1s of context</option>
      <option value="2500" selected>&plusmn;2.5s of context</option>
      <option value="5000">&plusmn;5s of context</option>
      <option value="10000">&plusmn;10s of context</option>
    </select>
    <label class="faint"><input type="checkbox" id="autoplay" checked> play automatically</label>
    <span class="grow"></span>
    <span class="faint" id="span"></span>
  </div>
  <div class="panelrow" id="taskHint">
    <span class="label"></span>
    <span class="faint">Play the line, then tap who said it. If it is already right, confirm it as it stands.</span>
  </div>
  <div class="panelrow">
    <span class="label">Who</span>
    <span id="speakers" style="display:flex;gap:6px;flex-wrap:wrap"></span>
  </div>
  <div class="panelrow">
    <span class="label"></span>
    <!--
      The names worth correcting are the ones no list can offer. The
      transcriber mangles them — Volva as "Vova", Dhruv as "Drew", Tarun as
      "Rune" — so the right answer is routinely a person who does not appear
      above. This read "Someone else… / Name them", which the owner did not
      connect to what he wanted; he had a line he knew was Tarun and told us he
      did not know how to say so.
    -->
    <span class="faint">Not one of these? Type who really said it&nbsp;&rarr;</span>
    <input type="text" id="newName" placeholder="Their name" style="width:170px">
    <button id="setNew">That is who said it</button>
  </div>
  <div class="panelrow">
    <span class="label"></span>
    <!--
      Naming the VOICE, not the line, and it is the more valuable of the two by
      a wide margin: this line's voice speaks hundreds of lines, so naming it
      settles all of them at once where a line correction settles one. The
      capability already existed on the roster chips at the top of the page,
      which is nowhere near where he is working — he asked for exactly this
      while looking at the picker. Same endpoint, put where the question occurs.
    -->
    <span class="faint" id="nameVoiceLead"></span>
    <input type="text" id="voiceName" placeholder="Their name" style="width:170px">
    <button id="setVoiceName">Name this voice everywhere</button>
  </div>
  <div class="panelrow" id="saidRow" style="align-items:flex-start">
    <span class="label">Said</span>
    <span style="flex:1"><textarea id="text" rows="2"></textarea></span>
  </div>
  <div class="panelrow">
    <span class="label"></span>
    <button class="primary" id="confirm">Correct as-is <kbd>enter</kbd></button>
    <button id="nextAction">Next line &rsaquo;</button>
    <button id="saveText">Save words</button>
    <span class="grow"></span>
  </div>
  <div class="panelrow">
    <span class="label"></span>
    <button class="minor" id="splitBtn">Split this line <kbd>x</kbd></button>
    <button class="minor" id="undoBtn">Undo my correction <kbd>u</kbd></button>
    <span class="grow"></span>
    <span id="status"></span>
  </div>
  <div class="banner" id="banner"><span class="grow" id="bannerText"></span><button id="bannerUndo">Undo it</button><button id="bannerHide">Keep it</button></div>
  <div id="splitter">
    <div class="panelrow" style="margin-bottom:4px">
      <span class="label">Cut</span>
      <span class="faint">Click between two words to cut there. Green marks are sentence ends; you can cut anywhere.</span>
      <span class="grow"></span>
      <button id="splitCancel">Cancel</button>
      <button class="primary" id="splitSave">Record the split</button>
    </div>
    <div class="wordline" id="words"></div>
    <div id="partsEdit"></div>
  </div>
</div>

<audio id="au" preload="auto"></audio>

<script>
/*__DURATION_HELPERS__*/
const $ = (id) => document.getElementById(id);
const au = $('au');

let convId = null;
let lines = [];
let people = [];
let index = -1;

// Blob URLs for spans already fetched. A replay must never touch the network.
const clips = new Map();
const MAX_CLIPS = 400;

function clipKey(line, pad) { return line.id + ':' + pad; }

// Spans are fetched by time range, not by line, so a candidate part of a split
// plays exactly as fast as a whole line does. Hearing part two on its own is
// the only way to tell whether a cut landed in the right silence.
function fetchClip(key, startMs, endMs) {
  const hit = clips.get(key);
  if (hit) return hit;
  const url = '/review/api/audio/' + encodeURIComponent(convId) +
    '?start_ms=' + Math.max(0, Math.round(startMs)) + '&end_ms=' + Math.round(endMs);
  const promise = fetch(url)
    .then((response) => { if (!response.ok) throw new Error('audio ' + response.status); return response.blob(); })
    .then((blob) => URL.createObjectURL(blob))
    .catch((error) => { clips.delete(key); throw error; });
  clips.set(key, promise);
  if (clips.size > MAX_CLIPS) {
    const oldest = clips.keys().next().value;
    const dying = clips.get(oldest);
    clips.delete(oldest);
    Promise.resolve(dying).then(URL.revokeObjectURL, () => {});
  }
  return promise;
}

let playingKey = null;

async function playRange(key, startMs, endMs, label, quiet) {
  if (playingKey === key && au.src) {
    au.currentTime = 0;
    au.play();
    return;
  }
  try {
    const url = await fetchClip(key, startMs, endMs);
    playingKey = key;
    au.src = url;
    au.currentTime = 0;
    await au.play();
    // Autoplay on advance must not talk over "Boris saved. Next: ...", which is
    // the only confirmation he gets that the last ruling landed.
    if (!quiet) status(label || '');
    return true;
  } catch (error) {
    // Selecting twice quickly (undo does) aborts the first play. That is the
    // browser working as designed, not a broken span, and saying otherwise
    // teaches him to distrust the one message that does mean something.
    const interrupted = error && (error.name === 'AbortError' || /interrupted|aborted/i.test(error.message || ''));
    if (!interrupted) status('could not play that span: ' + error.message, true);
    return false;
  }
}

function play(pad, quiet) {
  const line = lines[index];
  if (!line) return;
  return playRange(
    clipKey(line, pad),
    line.at_ms - pad,
    line.end_ms + pad,
    pad ? 'playing with ' + (pad / 1000) + 's either side' : 'playing the line',
    quiet,
  );
}

function prefetch(pad) {
  for (let offset = 0; offset <= 3; offset += 1) {
    const line = lines[index + offset];
    if (line) fetchClip(clipKey(line, 0), line.at_ms, line.end_ms).catch(() => {});
  }
  const current = lines[index];
  if (current) fetchClip(clipKey(current, pad), current.at_ms - pad, current.end_ms + pad).catch(() => {});
  const previous = lines[index - 1];
  if (previous) fetchClip(clipKey(previous, 0), previous.at_ms, previous.end_ms).catch(() => {});
}

function status(message, bad) {
  const element = $('status');
  element.textContent = message || '';
  element.className = bad ? 'bad' : '';
}

// One name for a voice everywhere on the page. Rows used to show six
// identical "Unnamed voice" labels while the picker and the coverage strip
// called the same voices Voice 0..7, which made the transcript unreadable and
// the two views impossible to line up.
function personName(id) {
  const person = people.find((candidate) => candidate.id === id);
  return person ? voiceLabel(person) : 'Unknown voice';
}

function stamp(ms) {
  const total = Math.floor(ms / 1000);
  const m = String(Math.floor(total / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return m + ':' + s;
}

function shownSpeaker(line) {
  if (line.split) return line.split.parts.length + ' speakers';
  return line.ruling && line.ruling.speaker ? line.ruling.speaker.name : personName(line.person_id);
}
/**
 * Which voice this line currently sits on, by id.
 *
 * Names cannot do this job: most voices in a real conversation are unnamed and
 * share the placeholder, so comparing names lit up every unnamed chip at once —
 * six of eight showing as selected, which reads as nonsense and hides the one
 * that is actually current.
 */
function shownSpeakerId(line) {
  if (line.split) return null;
  if (line.ruling && line.ruling.speaker) return line.ruling.speaker.person_id ?? null;
  return line.person_id ?? null;
}
function shownText(line) { return line.ruling && line.ruling.text !== null && line.ruling.text !== undefined ? line.ruling.text : line.text; }

function renderRow(line, i) {
  const row = document.createElement('div');
  row.className = 'row';
  row.dataset.i = String(i);
  paintRow(row, line, i);
  return row;
}

function paintRow(row, line, i) {
  const ruling = line.ruling;
  const parts = line.split ? line.split.parts : null;
  const asserted = ruling ? ruling.asserted : [];
  const speakerChanged = ruling && ruling.speaker && ruling.speaker.name !== personName(line.person_id);
  const textChanged = ruling && ruling.text !== null && ruling.text !== undefined && ruling.text !== line.text;
  const classes = ['row'];
  if (i === index) classes.push('sel');
  if ((ruling && ruling.contested) || (line.split && line.split.contested)) classes.push('contested');
  else if (parts) classes.push('hassplit');
  else if (speakerChanged || textChanged) classes.push('edited');
  else if (ruling) classes.push('ruled');
  else if (line.skipped_at) classes.push('skipped');
  else if (line.retracted) classes.push('retracted');
  row.className = classes.join(' ');

  const marks = [];
  if (ruling && ruling.contested) marks.push('<span class="mark cf">conflict</span>');
  if (asserted.indexOf('speaker') >= 0) marks.push('<span class="mark ' + (speakerChanged ? 'ed' : 'ok') + '">who</span>');
  if (asserted.indexOf('text') >= 0) marks.push('<span class="mark ' + (textChanged ? 'ed' : 'ok') + '">words</span>');
  if (parts) marks.push('<span class="mark sp">' + parts.length + ' parts</span>');
  if (!parts && !ruling && line.retracted) marks.push('<span class="mark rt">undone</span>');
  if (!parts && !ruling && line.skipped_at) {
    marks.push('<span class="mark sk" title="' + esc(line.skipped_because || 'he could not answer this from the card') + '">needed more</span>');
  }

  row.innerHTML =
    '<div class="t">' + stamp(line.at_ms) + '</div>' +
    '<div class="who' + (speakerChanged ? ' was' : '') + '">' + esc(shownSpeaker(line)) +
      (speakerChanged ? '<small>' + esc(personName(line.person_id)) + '</small>' : '') + '</div>' +
    '<div class="say' + (textChanged ? ' was' : '') + '">' + esc(shownText(line)) +
      (textChanged ? '<del>' + esc(line.text) + '</del>' : '') + '</div>' +
    '<div class="marks">' + marks.join('') + '</div>' +
    (parts
      ? '<div class="parts">' + parts.map((part) =>
          '<span class="part"><b>' + esc(part.speaker.name) + '</b> ' + esc(part.text) + '</span>').join('') + '</div>'
      : '');
}

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"]/g, (character) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]);
}

function repaint(i) {
  const row = $('rows').children[i];
  if (row) paintRow(row, lines[i], i);
}

function select(i, options) {
  if (i < 0 || i >= lines.length) return;
  const previous = index;
  index = i;
  if (previous >= 0) repaint(previous);
  repaint(index);
  const row = $('rows').children[index];
  if (row && !(options && options.noScroll)) row.scrollIntoView({ block: 'center', behavior: 'auto' });

  if (split) closeSplit();
  hideBanner();
  $('done').innerHTML = '';
  const line = lines[index];
  $('panel').className = 'on';
  $('span').textContent = stamp(line.at_ms) + ' – ' + stamp(line.end_ms) + '  (' + ((line.end_ms - line.at_ms) / 1000).toFixed(1) + 's)';
  $('text').value = shownText(line);
  renderSpeakerButtons();
  const reason = reasonById.get(line.id);
  const note = options && options.note ? options.note + ' ' : '';
  const skippedNote = line.skipped_at
    ? 'He looked at this on his phone and could not answer it'
      + (line.skipped_because ? ': ' + line.skipped_because : '')
    : '';
  status(
    line.anchor_warning
      ? note + line.anchor_warning
      : note + (skippedNote || (mode === 'queue' && reason ? 'Next: ' + reason : '')),
    Boolean(line.anchor_warning),
  );
  playingKey = null;
  prefetch(Number($('pad').value));
  if ($('autoplay').checked && !(options && options.silent)) {
    play(0, Boolean((options && options.note) || skippedNote));
  }
}

// Six of the eight voices in this recording are literally called "Unnamed
// voice", which made 1-9 a row of identical buttons. What tells them apart is
// when they first speak, how much of the room they hold, and a line long
// enough to recognise — so every voice carries all three.
function voiceLabel(person) {
  if (!person.is_unnamed || person.renamed) return person.name;
  return 'Voice ' + (person.id.split('-').pop() || '?').replace(/^p/, '');
}

function voiceDetail(person) {
  const bits = [];
  if (person.lines) bits.push(person.lines + ' lines');
  if (person.speaking_ms) bits.push(msToClock(person.speaking_ms));
  if (person.first_at_ms !== null && person.first_at_ms !== undefined) bits.push('from ' + stamp(person.first_at_ms));
  return bits.join(' · ');
}

function renderSpeakerButtons() {
  const line = lines[index];
  const currentId = shownSpeakerId(line);
  const onVoice = people.find((person) => person.id === currentId);
  $('nameVoiceLead').textContent = onVoice
    ? 'This line is on ' + voiceLabel(onVoice) + ' — ' + (onVoice.lines || 0) + ' lines here. Who is that?'
    : '';
  $('voiceName').disabled = !onVoice;
  $('setVoiceName').disabled = !onVoice;
  $('speakers').innerHTML = people
    .map((person, n) =>
      '<button class="spk' + (currentId && person.id === currentId ? ' cur' : '') + '" data-name="' + esc(person.name) +
      '" data-pid="' + esc(person.id) + '" title="' + esc(person.sample || '') + '">' +
      (n < 9 ? '<kbd style="margin-right:5px">' + (n + 1) + '</kbd>' : '') +
      esc(voiceLabel(person)) + '<small style="opacity:.65;margin-left:6px">' + esc(voiceDetail(person)) + '</small>' +
      '</button>')
    .join('');
}

async function postCorrection(payload) {
  const line = lines[index];
  const body = Object.assign({
    recording: convId,
    utterance_id: line.id,
    at_ms: line.at_ms,
    end_ms: line.end_ms,
    original_text: line.text,
    original_speaker_id: line.person_id,
    original_speaker_name: personName(line.person_id),
  }, payload);

  const response = await fetch('/review/api/correction', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) { status('save failed: ' + response.status, true); return false; }

  const data = await response.json();
  applyRuling(line, data.correction);
  repaint(index);
  refreshCounts();
  // Saving always succeeds. A landmark it disagrees with is information shown
  // beside the line, with undo one click away — never a dialog that refuses
  // the write and leaves him with nothing but the edit he wanted gone.
  if (data.conflicts && data.conflicts.length) {
    showBanner(data.conflicts.map((conflict) => conflict.detail).join(' · '));
  } else {
    hideBanner();
  }
  return true;
}

function applyRuling(line, correction) {
  const ruling = line.ruling || { speaker: null, text: null, asserted: [], contested: false };
  if (correction.asserts.indexOf('speaker') >= 0) {
    ruling.speaker = correction.speaker;
    if (ruling.asserted.indexOf('speaker') < 0) ruling.asserted.push('speaker');
  }
  if (correction.asserts.indexOf('text') >= 0) {
    ruling.text = correction.text;
    if (ruling.asserted.indexOf('text') < 0) ruling.asserted.push('text');
  }
  if (correction.conflicts_with && correction.conflicts_with.length) ruling.contested = true;
  ruling.latest_at = correction.created_at;
  line.ruling = ruling;
}

function showBanner(message) {
  $('bannerText').textContent = message;
  $('banner').className = 'banner on';
}

function hideBanner() { $('banner').className = 'banner'; }

/**
 * Take back whatever is currently recorded on this line.
 *
 * Deliberately one key. He will use this constantly — listening again and
 * changing your mind is the behaviour the page exists to make cheap, and a
 * retraction that costs a dialog is a retraction he will not bother with.
 */
async function retract() {
  // Rulings advance, so by the time he reaches for undo he is standing on the
  // next line. Undo means the thing he just did, not the blank line in front
  // of him — and it takes him back there so he can see what changed.
  if (!lines[index].ruling && !lines[index].split && lastRuledIndex >= 0 && lastRuledIndex !== index) {
    const previous = lines[lastRuledIndex];
    if (previous && (previous.ruling || previous.split)) select(lastRuledIndex, { silent: true });
  }
  const line = lines[index];
  if (!line.ruling && !line.split) { status('nothing recorded on this line'); return; }

  if (line.split) {
    const response = await fetch('/review/api/split/retract', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recording: convId, utterance_id: line.id, at_ms: line.at_ms, end_ms: line.end_ms }),
    });
    if (response.ok) { line.split = null; line.retracted = true; }
  }
  if (line.ruling) {
    const response = await fetch('/review/api/retract', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recording: convId, utterance_id: line.id, at_ms: line.at_ms, end_ms: line.end_ms, original_text: line.text }),
    });
    if (!response.ok) { status('undo failed', true); return; }
    line.ruling = null;
    line.retracted = true;
  }
  hideBanner();
  repaint(index);
  refreshCounts();
  $('text').value = shownText(line);
  renderSpeakerButtons();
  // Deliberately does not advance: taking something back means he wants
  // another look at this line, not the next one.
  lastRuledIndex = -1;
  select(index, { noScroll: true, note: 'Taken back.' });
  status('Taken back — this line is unreviewed again.');
}

function refreshCounts() {
  const ruled = lines.filter((line) => line.ruling || line.split).length;
  const contested = lines.filter((line) => line.ruling && line.ruling.contested).length;
  const left = lines.length - ruled;
  const percent = lines.length ? Math.round((ruled / lines.length) * 100) : 0;
  // "917 lines" is a wall; "884 left" is a task. Both are the same number and
  // only one of them makes a long session feel like it ends.
  // Volume is discouraging and beside the point: he does not need 915 lines,
  // he needs every voice out of the dark.
  const dark = coverage ? coverage.speakers.filter((speaker) => speaker.confirmed === 0).length : 0;
  const wanted = coverage ? coverage.speakers.reduce((sum, speaker) => sum + speaker.wanted, 0) : 0;
  const openQ = questions.filter((question) => !question.answer).length;
  const skippedCount = lines.filter((line) => line.skipped_at).length;
  $('summary').textContent =
    (openQ ? openQ + ' question' + (openQ === 1 ? '' : 's') + ' worth minutes each · ' : '') +
    (coverage ? dark + ' voices with no ground truth · ' + wanted + ' confirmations to go' : ruled + ' of ' + lines.length) +
    (contested ? ' · ' + contested + ' flagged' : '') +
    (skippedCount ? ' · ' + skippedCount + ' needed more than the card' : '');
}

/**
 * Which actions mean "done with this line".
 *
 * Naming the speaker and confirming as-is are terminal: they are the ruling he
 * came to make, so they save and move him on. Saving words is not — editing the
 * text and then naming the speaker is two rulings on one line, and advancing
 * after the first would throw away the line he was halfway through. Words
 * therefore save in place and ask the one question left, unless the speaker is
 * already settled, in which case the line really is finished.
 */
async function confirmAsIs() {
  const line = lines[index];
  if (line.split) { status('this line is split — each part carries its own speaker', true); return; }
  closeEditor();
  const ok = await postCorrection({
    asserts: ['speaker', 'text'],
    speaker: { person_id: line.person_id, name: shownSpeaker(line) },
    text: shownText(line),
  });
  if (ok) advance('Confirmed as it stood.');
}

function closeEditor() { $('saidRow').className = 'panelrow'; }

async function setSpeaker(name, personId) {
  const ok = await postCorrection({ asserts: ['speaker'], speaker: { person_id: personId || null, name: name } });
  if (ok) { closeEditor(); advance(name + ' saved.'); }
}

async function saveText() {
  const line = lines[index];
  const settled = line.ruling && line.ruling.asserted.indexOf('speaker') >= 0;
  const ok = await postCorrection({ asserts: ['text'], text: $('text').value });
  if (!ok) return;
  if (settled) { closeEditor(); advance('Words saved.'); return; }
  status('Words saved. Now tap who said it — or Next if the speaker is already right.');
}

async function loadConversation(id) {
  convId = id;
  for (const promise of clips.values()) Promise.resolve(promise).then(URL.revokeObjectURL, () => {});
  clips.clear();
  playingKey = null;
  index = -1;

  const response = await fetch('/review/api/conversation/' + encodeURIComponent(id));
  if (!response.ok) { status('could not load that conversation', true); return; }
  const data = await response.json();
  lines = data.lines;
  people = data.people;
  queue = data.queue || [];
  questions = data.questions || [];
  coverage = data.coverage || null;
  reasonById = new Map(queue.map((entry) => [entry.id, entry.reason]));

  // Reviewing a transcript the pipeline has already replaced spends the one
  // thing that cannot be regenerated — his listening — on corrections keyed to
  // lines that are about to change their ids.
  const fresh = data.freshness;
  window.__freshness = fresh;
  $('stale').innerHTML = fresh && fresh.state === 'stale'
    ? '<div class="warn">This is not the current transcript. ' + esc(fresh.detail) + '</div>'
    : '';

  $('people').innerHTML = people.map((person) =>
    '<span class="chip' + (person.renamed ? ' renamed' : '') + '">' + esc(voiceLabel(person)) +
    (person.renamed ? ' <span class="faint" style="text-decoration:line-through">' + esc(person.original_name) + '</span>' : '') +
    ' <button class="rename" data-pid="' + esc(person.id) + '">rename</button></span>').join('') +
    (data.audio.available ? '' : '<span class="chip" style="color:var(--alarm)">no local audio found for this conversation</span>');

  const container = $('rows');
  const fragment = document.createDocumentFragment();
  lines.forEach((line, i) => fragment.appendChild(renderRow(line, i)));
  container.innerHTML = '';
  container.appendChild(fragment);
  renderQuestions();
  renderCoverage();
  refreshCounts();
  $('done').innerHTML = '';
  showCard();
  window.scrollTo(0, 0);
}

$('rows').addEventListener('click', (event) => {
  const row = event.target.closest('.row');
  if (!row) return;
  const at = Number(row.dataset.i);
  select(at, { noScroll: true });
  // Quiet when the line carries an explanation, so "he could not answer this"
  // is not replaced by "playing the line" a moment later.
  play(0, Boolean(lines[at] && lines[at].skipped_at));
});

$('speakers').addEventListener('click', (event) => {
  const button = event.target.closest('.spk');
  if (button) setSpeaker(button.dataset.name, button.dataset.pid);
});

$('people').addEventListener('click', async (event) => {
  const button = event.target.closest('.rename');
  if (!button) return;
  const person = people.find((candidate) => candidate.id === button.dataset.pid);
  const next = prompt('The pipeline guesses names and gets them wrong — Vova for Volva, Drew for Dhruv, Rune for Tarun. What is this person actually called?', person.name);
  if (!next || next === person.name) return;
  const response = await fetch('/review/api/person-rename', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recording: convId, person_id: person.id, from_name: person.name, to_name: next }),
  });
  if (response.ok) await loadConversation(convId);
});

$('setVoiceName').onclick = async () => {
  const line = lines[index];
  const personId = line && shownSpeakerId(line);
  const person = people.find((candidate) => candidate.id === personId);
  const next = $('voiceName').value.trim();
  if (!person || !next || next === person.name) return;
  const response = await fetch('/review/api/person-rename', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recording: convId, person_id: person.id, from_name: person.name, to_name: next }),
  });
  if (!response.ok) { status('could not name that voice: ' + response.status, true); return; }
  $('voiceName').value = '';
  await loadConversation(convId);
  select(index);
};

$('playTight').onclick = () => play(0);
$('playPad').onclick = () => play(Number($('pad').value));
$('confirm').onclick = confirmAsIs;
$('saveText').onclick = saveText;
$('setNew').onclick = () => {
  const name = $('newName').value.trim();
  if (name) setSpeaker(name, null);
};
/**
 * The phone: one decision on screen, and the next one when it is made.
 *
 * Deliberately not a view of the panel. The panel is a workbench — play, pad
 * length, autoplay, speaker, free-text name, words, confirm, split, undo, next
 * — and every one of those is a thing to interpret before he can answer the
 * only question the line actually poses. A card renders the question and the
 * answers, and nothing else exists while it is up.
 */
let skipped = new Set();
let lastCard = null;
/**
 * A one-line receipt for the card he just filed.
 *
 * Not a dialogue and not something to dismiss: it appears on the next card and
 * goes away when he acts. Without it, skipping feels like discarding, and he
 * would use it less than he should — but a skipped line is one he has told us
 * is hard, which makes it worth more than a line nobody has looked at. The
 * whole point is that he over-uses this rather than avoiding it.
 *
 * Only set after the write actually succeeds, because a receipt for something
 * that was not saved is worse than no receipt.
 */
let receipt = null;
/** Shown once, before the first decision, and never again in this session. */
let started = false;
/** The card's own state: the decision, or the tools he asked for. */
let cardMode = 'normal';

/**
 * Does this line still need the question the card asks?
 *
 * The card asks "who said this", so a line is unanswered until somebody has
 * said who. Testing for any ruling at all was wrong: fixing the words gives the
 * line a ruling, and the card then skipped past it as though it had been
 * answered — so correcting a garbled line silently lost the chance to
 * attribute it.
 */
function needsSpeaker(line) {
  if (line.split || line.skipped_at) return false;
  return !(line.ruling && line.ruling.asserted.indexOf('speaker') >= 0);
}

function nextCard() {
  // What is waiting, once, before he starts. He asked to know whether he is
  // facing three things or three hundred, and the single-card design had made
  // that unknowable. It is shown before the first decision and never again:
  // a count on every card would turn the session into a progress bar he feels
  // he owes us, and he does not — three answers already moved the needle.
  if (!started) {
    const openQuestions = questions.filter((candidate) => !candidate.answer).length;
    const waiting = lines.filter(needsSpeaker).length;
    if (openQuestions > 0 || waiting > 0) return { kind: 'start', questions: openQuestions, waiting: waiting };
  }
  const question = questions.find((candidate) => !candidate.answer && !skipped.has(candidate.id));
  if (question) return { kind: 'question', question: question };
  for (const at of orderedIndices()) {
    const line = lines[at];
    // A skip recorded in an earlier session must not come back at him here. It
    // is answerable on a desktop, where the words can be fixed and a line can
    // be split.
    if (needsSpeaker(line) && !skipped.has(line.id)) return { kind: 'line', at: at };
  }
  return { kind: 'done' };
}

function cardStale() {
  const fresh = window.__freshness;
  return fresh && fresh.state === 'stale'
    ? '<p class="cardwarn">This transcript is out of date, so anything recorded here may not survive the next rebuild.</p>'
    : '';
}

function showCard() {
  const card = nextCard();
  const undo = lastCard ? '<button class="quiet" data-undo="1">Change my last answer</button>' : '';
  const note = receipt ? '<p class="cardnote">' + esc(receipt) + '</p>' : '';
  receipt = null;

  if (card.kind === 'start') {
    const bits = [];
    if (card.questions > 0) {
      bits.push('<li><b>' + card.questions + ' voice question' + (card.questions === 1 ? '' : 's') +
        '</b> — two clips and a yes or no. These are worth the most: each one settles minutes of speech at once.</li>');
    }
    if (card.waiting > 0) {
      bits.push('<li><b>' + card.waiting + ' line' + (card.waiting === 1 ? '' : 's') +
        '</b> — hear it, then say who spoke. Worth about a line each, and they are ordered so the most useful come first.</li>');
    }
    $('card').innerHTML = note +
      cardStale() +
      '<h2 class="cardq">Here is what is waiting</h2>' +
      '<ul class="cardlist">' + bits.join('') + '</ul>' +
      '<p class="cardnote">Stop whenever you like — everything is saved as you go, and you are not expected to reach the end.</p>' +
      '<div class="out"><button class="big primary" data-start="1">Start</button></div>';
    $('card').dataset.kind = 'start';
    return;
  }

  if (card.kind === 'done') {
    $('card').innerHTML = note +
      '<h2 class="cardq">That is everything waiting for you.</h2>' +
      '<p class="cardnote">Everything you answered is saved. You can stop any time — nothing is lost by closing this.</p>' +
      '<div class="out">' + undo + '<button class="big" data-again="1">Check again</button></div>';
    $('card').dataset.kind = 'done';
    return;
  }

  if (card.kind === 'question') {
    // No cluster ids. "0:E vs 950:E" is our bookkeeping and means nothing to
    // him; it belongs in the file the answer is written to.
    $('card').innerHTML = note +
      cardStale() +
      '<h2 class="cardq">Are these two voices the same person?</h2>' +
      '<button class="big" data-clip="a">Play the first voice</button>' +
      '<button class="big" data-clip="b">Play the second voice</button>' +
      '<div class="choices">' +
        '<button class="big" data-a="same">Yes, one person</button>' +
        '<button class="big" data-a="different">No, two people</button>' +
      '</div>' +
      '<div class="out"><button class="big" data-a="unsure">I cannot tell</button>' + undo + '</div>';
    $('card').dataset.kind = 'question';
    $('card').dataset.qid = card.question.id;
    return;
  }

  const line = lines[card.at];
  select(card.at, { noScroll: true, silent: true });
  $('card').innerHTML = note +
    cardStale() +
    '<h2 class="cardq">Who said this?</h2>' +
    '<div class="cardsay">' + esc(shownText(line)) + '</div>' +
    '<button class="big" data-replay="1">Play it again</button>' +
    (people.some((person) => person.id === line.person_id)
      ? '<p class="cardnote">We think it was ' + esc(voiceLabel(people.find((person) => person.id === line.person_id))) +
        '. Tap that to agree, or pick whoever really said it.</p>'
      : '') +
    '<div class="choices voices">' +
      people.map((person) =>
        '<button class="big' + (person.id === line.person_id ? ' suggested' : '') + '" data-voice="' + esc(person.id) + '">' +
        esc(voiceLabel(person)) + '</button>').join('') +
    '</div>' +
    '<div class="out">' +
      '<button class="quiet" data-fix="1">Something else is wrong</button>' +
      '<button class="big" data-skip="1">Skip this one</button>' + undo +
    '</div>';
  if (cardMode === 'fixing') {
    // Progressive disclosure: the tools exist, but only once he says something
    // is wrong. The default card keeps its emptiness.
    //
    // Splitting is deliberately absent. It needs word-level cut points, and on
    // a 390px column the gaps between words are ~15px targets that wrap across
    // lines; a mis-tap does not fail loudly, it records a speaker change at the
    // wrong moment and that becomes ground truth. Filing it for a laptop, which
    // is what the last button does, is the honest version.
    $('card').innerHTML =
      '<h2 class="cardq">What is wrong with it?</h2>' +
      '<div class="cardsay">' + esc(shownText(line)) + '</div>' +
      '<label class="cardnote" for="fixText">The words are wrong</label>' +
      '<textarea id="fixText" rows="3">' + esc(shownText(line)) + '</textarea>' +
      '<button class="big" data-savewords="1">Save the words</button>' +
      '<label class="cardnote" for="fixName">It was someone not in the list</label>' +
      '<input type="text" id="fixName" placeholder="Their name" autocapitalize="words">' +
      '<button class="big" data-savename="1">Save that name</button>' +
      '<div class="out">' +
        '<button class="big" data-needsplit="1">More than one person speaks here</button>' +
        '<button class="quiet" data-back="1">Back</button>' +
      '</div>';
    $('card').dataset.kind = 'line';
    $('card').dataset.at = String(card.at);
    return;
  }

  $('card').dataset.kind = 'line';
  $('card').dataset.at = String(card.at);

  // If the browser refuses to autoplay — iOS wants a gesture per element — the
  // card would otherwise sit there looking like it should be making a sound.
  // Better to say so and make the one useful button obviously the thing to tap.
  const playing = play(0, true);
  if (playing && playing.then) {
    playing.then((ok) => {
      if (ok !== false || $('card').dataset.at !== String(card.at)) return;
      const replay = $('card').querySelector('[data-replay]');
      if (!replay) return;
      replay.className = 'big primary';
      replay.textContent = 'Tap to play this line';
    });
  }
}

$('card').addEventListener('click', async (event) => {
  const kind = $('card').dataset.kind;

  if (event.target.closest('[data-again]')) { skipped = new Set(); showCard(); return; }
  if (event.target.closest('[data-start]')) { started = true; showCard(); return; }
  if (event.target.closest('[data-fix]')) { cardMode = 'fixing'; showCard(); return; }
  if (event.target.closest('[data-back]')) { cardMode = 'normal'; showCard(); return; }

  if (event.target.closest('[data-undo]')) {
    const previous = lastCard;
    lastCard = null;
    if (!previous) return;
    if (previous.kind === 'question') {
      const question = questions.find((candidate) => candidate.id === previous.id);
      if (question) question.answer = null;
    } else {
      const at = lines.findIndex((line) => line.id === previous.id);
      if (at >= 0) { index = at; await retract(); }
    }
    showCard();
    return;
  }

  if (kind === 'question') {
    const question = questions.find((candidate) => candidate.id === $('card').dataset.qid);
    if (!question) return;

    const clip = event.target.closest('[data-clip]');
    if (clip) {
      const side = clip.dataset.clip === 'a' ? question.clips_a : question.clips_b;
      await playRange('clip:' + side[0].start_ms, side[0].start_ms, side[0].end_ms, '', true);
      return;
    }
    const answer = event.target.closest('[data-a]');
    if (!answer) return;
    if (answer.dataset.a === 'unsure') skipped.add(question.id);
    await answerQuestion(question, answer.dataset.a);
    lastCard = { kind: 'question', id: question.id };
    showCard();
    return;
  }

  if (kind === 'line' && cardMode === 'fixing') {
    const at = Number($('card').dataset.at);
    const line = lines[at];
    index = at;

    if (event.target.closest('[data-savewords]')) {
      const ok = await postCorrection({ asserts: ['text'], text: $('fixText').value });
      if (!ok) return;
      // Fixing the words does not say who spoke, so he comes back to the
      // question he was on rather than being moved along.
      cardMode = 'normal';
      receipt = 'Words saved.';
      showCard();
      return;
    }

    if (event.target.closest('[data-savename]')) {
      const name = ($('fixName').value || '').trim();
      if (!name) { $('fixName').focus(); return; }
      // The transcriber mangles names — Volva as "Vova", Dhruv as "Drew",
      // Tarun as "Rune" — so the right answer is often one no list can offer.
      // A null person_id means "somebody new", which the store already accepts.
      const ok = await postCorrection({ asserts: ['speaker'], speaker: { person_id: null, name: name } });
      if (!ok) return;
      lastCard = { kind: 'line', id: line.id };
      cardMode = 'normal';
      receipt = name + ' saved.';
      showCard();
      return;
    }

    if (event.target.closest('[data-needsplit]')) {
      cardMode = 'normal';
      skipped.add(line.id);
      lastCard = null;
      const saved = await fetch('/review/api/skip', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recording: convId, utterance_id: line.id, at_ms: line.at_ms,
          end_ms: line.end_ms, original_text: line.text,
          reason: 'more than one person speaks in this line',
        }),
      }).then((response) => response.ok).catch(() => false);
      receipt = saved
        ? 'Saved for a laptop session — that one needs splitting.'
        : 'That one could not be saved — it will come round again.';
      if (!saved) { skipped.delete(line.id); } else { line.skipped_at = new Date().toISOString(); }
      showCard();
      return;
    }
    return;
  }

  if (kind === 'line') {
    const line = lines[Number($('card').dataset.at)];
    if (event.target.closest('[data-replay]')) { play(0, true); return; }
    if (event.target.closest('[data-skip]')) {
      skipped.add(line.id);
      line.skipped_at = new Date().toISOString();
      // Deliberately no undo offered after this. "Change my last answer" exists
      // to take back something that was recorded ABOUT the audio; a skip
      // asserts nothing, so there is nothing to take back, and offering it
      // would imply skipping was a commitment he has to justify. Do not make
      // this symmetrical with the answer path.
      lastCard = null;
      const saved = await fetch('/review/api/skip', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recording: convId, utterance_id: line.id, at_ms: line.at_ms,
          end_ms: line.end_ms, original_text: line.text,
        }),
      }).then((response) => response.ok).catch(() => false);
      receipt = saved
        ? 'Saved for a laptop session.'
        : 'That one could not be saved — it will come round again.';
      if (!saved) { skipped.delete(line.id); line.skipped_at = null; }
      showCard();
      return;
    }
    const voice = event.target.closest('[data-voice]');
    if (!voice) return;
    const person = people.find((candidate) => candidate.id === voice.dataset.voice);
    index = Number($('card').dataset.at);
    const ok = await postCorrection({ asserts: ['speaker'], speaker: { person_id: person.id, name: person.name } });
    if (!ok) return;
    lastCard = { kind: 'line', id: line.id };
    cardMode = 'normal';
    showCard();
  }
});

$('done').addEventListener('click', (event) => {
  if (event.target.closest('#doneToQuestions')) { $('done').innerHTML = ''; window.scrollTo(0, 0); }
  if (event.target.closest('#doneToList')) {
    $('done').innerHTML = '';
    mode = 'time';
    $('modeTime').className = 'on';
    $('modeQueue').className = '';
    select(0);
  }
});

$('nextAction').onclick = () => advance();
$('modeQueue').onclick = () => { mode = 'queue'; setModeButtons('modeQueue'); select(orderedIndices()[0] ?? 0); };
$('modeTime').onclick = () => { mode = 'time'; setModeButtons('modeTime'); status('reading in recording order'); };
$('modeSkipped').onclick = () => {
  mode = 'skipped';
  setModeButtons('modeSkipped');
  const first = orderedIndices()[0];
  if (first === undefined) { status('nothing skipped yet'); return; }
  select(first);
  status('lines he looked at on his phone and could not answer from the card alone');
};

function setModeButtons(active) {
  for (const id of ['modeQueue', 'modeTime', 'modeSkipped']) $(id).className = id === active ? 'on' : '';
}
$('pad').onchange = () => prefetch(Number($('pad').value));
$('conv').onchange = () => loadConversation($('conv').value);


/**
 * Cutting a line into parts.
 *
 * Cuts land between words, never inside one, and every cut carries the real
 * silence around it from whisper's word timings. That is what makes a split
 * usable as ground truth: the boundary it claims has a timestamp, so the eval
 * can ask whether diarization put a turn boundary anywhere near it. A cut
 * expressed as a character offset into a string could not be asked that.
 *
 * Sentence ends are marked because these lines break cleanly at them, but every
 * gap is cuttable — the case that fooled us today alternated between two people
 * per letter while spelling a name, and punctuation knows nothing about that.
 */
let split = null;
let queue = [];
let reasonById = new Map();
let mode = 'queue';
let questions = [];
let coverage = null;

/**
 * The order he works in.
 *
 * Queue order is the default because a list from 00:00 means the opening gets
 * reviewed five times and minute thirty never gets reviewed at all. Sequential
 * stays one click away — sometimes reading straight through is the right thing,
 * and the page should not insist otherwise.
 */
function orderedIndices() {
  if (mode === 'time') return lines.map((_, i) => i);
  // Lines he looked at on his phone and could not answer. He has already told
  // us these matter, which makes them worth more than a random hundred.
  if (mode === 'skipped') return lines.map((_, i) => i).filter((i) => lines[i].skipped_at);
  const position = new Map(lines.map((line, i) => [line.id, i]));
  const ordered = [];
  for (const entry of queue) {
    const at = position.get(entry.id);
    if (at !== undefined) ordered.push(at);
  }
  // Reviewed lines are not in the queue; keep them reachable at the end.
  for (const [id, at] of position) if (!reasonById.has(id)) ordered.push(at);
  return ordered;
}

/**
 * Hand him the next thing to do.
 *
 * Nothing used to advance. Every ruling saved and left him on the line he had
 * just finished, which on a phone — where the list and the panel cannot be seen
 * at once — is indistinguishable from the save having failed. A queue that
 * never moves is not a queue; it is a list with an opinion.
 *
 * Skips anything already ruled on, so re-reviewing does not walk him back
 * through finished lines.
 */
// The line his last ruling landed on, so undo can mean "undo what I just did"
// rather than "undo something about wherever I happen to be standing".
let lastRuledIndex = -1;

function advance(note) {
  lastRuledIndex = index;
  const order = orderedIndices();
  const at = order.indexOf(index);
  for (let step = at + 1; step < order.length; step += 1) {
    const candidate = order[step];
    if (!lines[candidate].ruling && !lines[candidate].split) {
      select(candidate, { note: note });
      return true;
    }
  }
  finishQueue(note);
  return false;
}

/** Running out of queue is an event, not silence. */
function finishQueue(note) {
  const ruled = lines.filter((line) => line.ruling || line.split).length;
  const openQuestions = questions.filter((question) => !question.answer).length;
  $('panel').className = '';
  $('done').innerHTML =
    '<div class="q"><h2>That is everything in the queue</h2>' +
      '<div class="muted">' + (note ? esc(note) + ' ' : '') +
      ruled + ' of ' + lines.length + ' lines now carry a ruling' +
      (openQuestions ? ', and ' + openQuestions + ' voice question' + (openQuestions === 1 ? '' : 's') + ' remain — those are worth more per tap than any line.' : '.') +
      '</div>' +
      '<div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">' +
        (openQuestions ? '<button class="primary" id="doneToQuestions">Answer a voice question</button>' : '') +
        '<button id="doneToList">Read the transcript in order</button>' +
      '</div>' +
    '</div>';
  status(note || 'queue finished');
}

function stepFrom(current, delta) {
  const order = orderedIndices();
  const at = order.indexOf(current);
  if (at < 0) return order[0] ?? 0;
  return order[Math.min(order.length - 1, Math.max(0, at + delta))];
}

/**
 * The same-or-different questions, at the top, because they are worth the most.
 *
 * One of these settles 457 seconds. A line correction settles one line. Telling
 * him what an answer buys is not decoration — it is the difference between a
 * chore and an obviously good use of two minutes.
 */
function renderQuestions() {
  const open = questions.filter((question) => !question.answer);
  const answered = questions.filter((question) => question.answer);
  const resolved = answered.filter((q) => q.answer !== 'unsure').reduce((sum, q) => sum + q.worth_seconds, 0);
  if (questions.length === 0) { $('ask').innerHTML = ''; return; }
  if (open.length === 0) {
    $('ask').innerHTML = '<div class="q"><h2>All same-or-different questions answered</h2>' +
      '<span class="muted">' + secondsToClock(resolved) + ' of speech resolved.</span></div>';
    return;
  }
  const question = open[0];
  $('ask').innerHTML =
    '<div class="q">' +
      '<h2>Are these two voices the same person?</h2>' +
      '<div class="muted">Answering this resolves roughly <span class="worth">' + secondsToClock(question.worth_seconds) + '</span> of speech ' +
        'that no other evidence in the project reaches. ' +
        '<span class="faint">Estimated: the figure comes from an older clustering, so the true total will differ.</span> ' +
        esc(question.label_a) + ' vs ' + esc(question.label_b) +
        (question.co_assignment !== null ? ' — the voiceprints agree ' + Math.round(question.co_assignment * 100) + '% of the time, which is why nobody can settle it automatically.' : '') +
        '</div>' +
      '<div class="sides">' +
        renderSide('Voice A', question.label_a, question.clips_a, 'a') +
        renderSide('Voice B', question.label_b, question.clips_b, 'b') +
      '</div>' +
      '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px">' +
        '<button class="primary" data-both="1">Play A then B</button>' +
        '<span class="faint">then decide</span>' +
      '</div>' +
      '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
        // Deliberately unstyled, all three. "Same person" carried class="good"
        // — coloured and bold while the others were plain — which makes one
        // answer to a same-or-different question the obvious tap. The first
        // three answers this page collected were all "same". That may well be
        // correct, but a button cannot be allowed to be part of the reason: this
        // is the instrument every other measurement is calibrated against.
        '<button data-ans="same">Same person</button>' +
        '<button data-ans="different">Different people</button>' +
        '<button data-ans="unsure">Can\'t tell</button>' +
        '<span class="faint">your answer is recorded against these two stretches, not the cluster names</span>' +
        '<span class="faint">' + open.length + ' open' + (answered.length ? ' · ' + secondsToClock(resolved) + ' already resolved' : '') + '</span>' +
      '</div>' +
    '</div>';
  $('ask').dataset.qid = question.id;
}

function renderSide(title, label, clips, side) {
  return '<div class="side"><b>' + title + ' · ' + esc(label) + '</b><div class="clips">' +
    clips.map((clip, n) =>
      '<button data-clip="' + side + ':' + n + '">' + ((clip.end_ms - clip.start_ms) / 1000).toFixed(1) + 's at ' + stamp(clip.start_ms) + '</button>').join('') +
    '</div></div>';
}

function currentQuestion() {
  return questions.find((question) => question.id === $('ask').dataset.qid) || null;
}

async function playClip(clip, label) {
  await playRange('clip:' + clip.start_ms + ':' + clip.end_ms, clip.start_ms, clip.end_ms, label);
}

$('ask').addEventListener('click', async (event) => {
  const question = currentQuestion();
  if (!question) return;

  const clipButton = event.target.closest('[data-clip]');
  if (clipButton) {
    const [side, n] = clipButton.dataset.clip.split(':');
    const clip = (side === 'a' ? question.clips_a : question.clips_b)[Number(n)];
    await playClip(clip, 'voice ' + side.toUpperCase() + ', ' + ((clip.end_ms - clip.start_ms) / 1000).toFixed(1) + 's');
    return;
  }

  if (event.target.closest('[data-both]')) {
    // Back to back is how a human actually tells two voices apart.
    await playClip(question.clips_a[0], 'voice A');
    au.onended = async () => { au.onended = null; await playClip(question.clips_b[0], 'voice B'); };
    return;
  }

  const answerButton = event.target.closest('[data-ans]');
  if (!answerButton) return;
  await answerQuestion(question, answerButton.dataset.ans);
});

/** One path to record an answer, whether it came from the card or the desktop. */
async function answerQuestion(question, answer) {
  const response = await fetch('/review/api/identity-answer', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recording: convId, question_id: question.id, label_a: question.label_a,
      label_b: question.label_b, answer: answer, worth_seconds: question.worth_seconds,
      // The audio he compared travels with the answer. The cluster names this
      // question came from belong to a retired scheme; the two stretches do not.
      compared: answer === 'unsure' ? undefined : {
        a: { start_ms: question.clips_a[0].start_ms, end_ms: question.clips_a[0].end_ms },
        b: { start_ms: question.clips_b[0].start_ms, end_ms: question.clips_b[0].end_ms },
      },
      shown: {
        a: question.clips_a.map((clip) => ({ start_ms: clip.start_ms, end_ms: clip.end_ms })),
        b: question.clips_b.map((clip) => ({ start_ms: clip.start_ms, end_ms: clip.end_ms })),
      },
    }),
  });
  if (!response.ok) { status('could not record that answer', true); return false; }
  question.answer = answer;
  renderQuestions();
  refreshCounts();
  status(answer === 'unsure'
    ? 'recorded as unresolved — that is a real answer here, not a gap'
    : 'answered, anchored to the two stretches you heard (about ' + secondsToClock(question.worth_seconds) + ' of speech)');
  return true;
}

/** Per-voice progress, so he can see when a voice stops being a blind spot. */
function renderCoverage() {
  if (!coverage) { $('cov').innerHTML = ''; return; }
  const dark = coverage.speakers.filter((speaker) => speaker.confirmed === 0).length;
  $('cov').innerHTML =
    '<span class="faint" style="margin-right:4px">Voices with ground truth:</span>' +
    coverage.speakers.map((speaker) => {
      const person = people.find((candidate) => candidate.id === speaker.person_id);
      const name = person ? voiceLabel(person) : speaker.person_id;
      const cls = speaker.confirmed === 0 ? 'cv dark' : (speaker.wanted === 0 ? 'cv done' : 'cv');
      return '<span class="' + cls + '" title="' + Math.round(speaker.share * 100) + '% of all speech">' +
        esc(name) + ' ' + speaker.confirmed + '/' + coverage.target_per_speaker +
        ' · ' + Math.round(speaker.share * 100) + '%</span>';
    }).join('') +
    (dark > 0
      ? '<span class="faint" style="margin-left:6px">' + dark + ' voice' + (dark === 1 ? '' : 's') + ' still with none — those are where a correction is worth most</span>'
      : '<span class="cv done" style="margin-left:6px">every voice has ground truth</span>');
}

async function openSplit() {
  const line = lines[index];
  const response = await fetch('/review/api/words/' + encodeURIComponent(convId) +
    '?start_ms=' + line.at_ms + '&end_ms=' + line.end_ms);
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    status(data.error || 'no word timings for this line, so a cut could not be timestamped', true);
    return;
  }
  const data = await response.json();
  if (data.words.length < 2) { status('this line is a single word — nothing to cut', true); return; }

  // Speakers are keyed by the word a part STARTS at, never by the part's
  // position in the list. Keying by position means adding a cut near the
  // beginning silently slides every speaker he already chose onto different
  // words — the kind of quiet corruption this whole page exists to stop.
  split = { words: data.words, gaps: data.gaps, cuts: new Set(), speakerAt: new Map() };
  if (line.split) {
    for (const boundary of line.split.boundaries) {
      const gap = data.gaps.find((candidate) => candidate.from_ms >= boundary.from_ms - 1 && candidate.to_ms <= boundary.to_ms + 1);
      if (gap) split.cuts.add(gap.index);
    }
    for (const part of line.split.parts) {
      const at = data.words.findIndex((word) => word.start_ms === part.start_ms);
      if (at >= 0) split.speakerAt.set(at, part.speaker);
    }
  }
  $('splitter').className = 'on';
  $('splitBtn').textContent = 'Splitting…';
  renderWords();
}

function closeSplit() {
  split = null;
  $('splitter').className = '';
  $('splitBtn').innerHTML = 'Split this line <kbd>x</kbd>';
  status('');
}

function splitParts() {
  const cuts = [...split.cuts].sort((a, b) => a - b);
  const bounds = [0, ...cuts, split.words.length];
  const parts = [];
  for (let i = 1; i < bounds.length; i += 1) {
    const from = bounds[i - 1];
    const slice = split.words.slice(from, bounds[i]);
    if (slice.length === 0) continue;
    parts.push({
      startIndex: from,
      start_ms: slice[0].start_ms,
      end_ms: slice[slice.length - 1].end_ms,
      text: slice.map((word) => word.text).join(' '),
      speaker: split.speakerAt.get(from) || null,
    });
  }
  return parts;
}

function splitBoundaries() {
  return [...split.cuts].sort((a, b) => a - b).map((index) => {
    const gap = split.gaps.find((candidate) => candidate.index === index);
    return { from_ms: gap.from_ms, to_ms: gap.to_ms };
  });
}

function renderWords() {
  let html = '';
  split.words.forEach((word, i) => {
    if (i > 0) {
      const gap = split.gaps.find((candidate) => candidate.index === i);
      const on = split.cuts.has(i);
      html += '<span class="cut' + (on ? ' on' : '') + (gap && gap.sentence_end ? ' sentence' : '') +
        '" data-g="' + i + '" title="cut here (' + (gap ? (gap.to_ms - gap.from_ms) + 'ms of silence' : '') + ')">' +
        (on ? '|' : '·') + '</span>';
    }
    html += '<span class="w">' + esc(word.text) + '</span>';
  });
  $('words').innerHTML = html;
  renderParts();
}

function renderParts() {
  const parts = splitParts();
  if (parts.length < 2) {
    $('partsEdit').innerHTML = '<span class="faint">Click a dot between two words to make your first cut.</span>';
    $('splitSave').disabled = true;
    return;
  }
  $('partsEdit').innerHTML = parts.map((part, n) =>
    '<div class="pedit">' +
      '<span class="num">Part ' + (n + 1) + '</span>' +
      '<button data-play="' + n + '">Play</button>' +
      '<button data-ctx="' + n + '">+ context</button>' +
      '<select data-spk="' + n + '">' +
        '<option value="">Who said this?</option>' +
        people.map((person) =>
          '<option value="' + esc(person.id) + '"' +
          (part.speaker && part.speaker.person_id === person.id ? ' selected' : '') + '>' +
          esc(voiceLabel(person)) + ' — ' + esc(voiceDetail(person)) + '</option>').join('') +
        '<option value="__new__"' + (part.speaker && !part.speaker.person_id ? ' selected' : '') + '>Someone else…</option>' +
      '</select>' +
      '<span class="txt">' + esc(part.text) + '</span>' +
      '<span class="faint">' + stamp(part.start_ms) + '–' + stamp(part.end_ms) + '</span>' +
    '</div>').join('');

  const problem = validateParts(parts);
  $('splitSave').disabled = Boolean(problem);
  status(problem || (parts.length + ' parts — play each one and check the cut is in the right silence'), Boolean(problem));
}

// Mirrors the server's rule so he finds out now, not after clicking save: a cut
// between two parts credited to the same person claims a speaker change that
// did not happen, and that would put a false negative into the one reference
// that measures missed boundaries.
function validateParts(parts) {
  for (const part of parts) if (!part.speaker) return 'every part needs a speaker';
  for (let i = 1; i < parts.length; i += 1) {
    const before = parts[i - 1].speaker;
    const after = parts[i].speaker;
    if (before.name.trim().toLowerCase() === after.name.trim().toLowerCase() ||
        (before.person_id && before.person_id === after.person_id)) {
      return 'parts ' + i + ' and ' + (i + 1) + ' are both ' + after.name +
        ', so the cut between them claims a change that did not happen — remove it or pick a different speaker';
    }
  }
  return null;
}

async function saveSplit() {
  const line = lines[index];
  const parts = splitParts();
  const problem = validateParts(parts);
  if (problem) { status(problem, true); return; }

  const response = await fetch('/review/api/split', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recording: convId,
      utterance_id: line.id,
      at_ms: line.at_ms,
      end_ms: line.end_ms,
      original_text: line.text,
      original_speaker_id: line.person_id,
      original_speaker_name: personName(line.person_id),
      boundaries: splitBoundaries(),
      parts: parts.map((part) => ({
        start_ms: part.start_ms, end_ms: part.end_ms, text: part.text, speaker: part.speaker,
      })),
    }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    status(data.error || 'could not record the split', true);
    return;
  }
  const data = await response.json();
  line.split = { boundaries: data.split.boundaries, parts: data.split.parts };
  line.retracted = false;
  closeSplit();
  repaint(index);
  refreshCounts();
  if (data.conflicts && data.conflicts.length) {
    showBanner(data.conflicts.map((conflict) => conflict.detail).join(' · '));
    status('split recorded, and flagged');
  } else {
    hideBanner();
    advance('Split recorded — ' + parts.length + ' parts.');
  }
}

$('words').addEventListener('click', (event) => {
  const cut = event.target.closest('.cut');
  if (!cut || !split) return;
  const gapIndex = Number(cut.dataset.g);
  if (split.cuts.has(gapIndex)) {
    split.cuts.delete(gapIndex);
    // The part that was starting here no longer exists; its choice goes with it.
    split.speakerAt.delete(gapIndex);
  } else {
    split.cuts.add(gapIndex);
  }
  renderWords();
});

$('partsEdit').addEventListener('click', (event) => {
  const playButton = event.target.closest('[data-play]');
  const contextButton = event.target.closest('[data-ctx]');
  if (!playButton && !contextButton) return;
  const n = Number((playButton || contextButton).dataset.play ?? (contextButton && contextButton.dataset.ctx));
  const part = splitParts()[n];
  if (!part) return;
  const pad = contextButton ? Number($('pad').value) : 0;
  playRange('part:' + lines[index].id + ':' + part.start_ms + ':' + pad, part.start_ms - pad, part.end_ms + pad,
    contextButton ? 'part ' + (n + 1) + ' with context' : 'part ' + (n + 1) + ' alone');
});

$('partsEdit').addEventListener('change', (event) => {
  const select = event.target.closest('[data-spk]');
  if (!select || !split) return;
  const part = splitParts()[Number(select.dataset.spk)];
  if (!part) return;
  if (select.value === '__new__') {
    const name = prompt('Who said this part?', '');
    if (!name) { renderParts(); return; }
    split.speakerAt.set(part.startIndex, { person_id: null, name: name.trim() });
  } else if (select.value === '') {
    split.speakerAt.delete(part.startIndex);
  } else {
    const person = people.find((candidate) => candidate.id === select.value);
    split.speakerAt.set(part.startIndex, { person_id: person.id, name: person.name });
  }
  renderParts();
});

$('splitCancel').onclick = closeSplit;
$('splitSave').onclick = saveSplit;
$('splitBtn').onclick = () => (split ? closeSplit() : openSplit());
$('undoBtn').onclick = retract;
$('bannerUndo').onclick = retract;
$('bannerHide').onclick = hideBanner;

document.addEventListener('keydown', (event) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName);
  if (typing) {
    if (event.key === 'Escape') event.target.blur();
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && event.target === $('text')) { event.preventDefault(); saveText(); }
    if (event.key === 'Enter' && event.target === $('newName')) { event.preventDefault(); $('setNew').click(); }
    return;
  }
  const pad = Number($('pad').value);
  if (event.key === 'j' || event.key === 'ArrowDown') { event.preventDefault(); select(stepFrom(index, 1)); }
  else if (event.key === 'k' || event.key === 'ArrowUp') { event.preventDefault(); select(stepFrom(index, -1)); }
  else if (event.key === ' ') { event.preventDefault(); play(event.shiftKey ? pad : 0); }
  else if (event.key === 'c') { event.preventDefault(); play(pad); }
  else if (event.key === 'Enter') { event.preventDefault(); confirmAsIs(); }
  else if (event.key === 'e') { event.preventDefault(); $('saidRow').className = 'panelrow open'; $('text').focus(); $('text').select(); }
  else if (event.key === 's') { event.preventDefault(); $('newName').focus(); }
  else if (event.key === 'x') { event.preventDefault(); split ? closeSplit() : openSplit(); }
  else if (event.key === 'u') { event.preventDefault(); retract(); }
  else if (event.key === 'Escape' && split) { event.preventDefault(); closeSplit(); }
  else if (/^[1-9]$/.test(event.key)) {
    const person = people[Number(event.key) - 1];
    if (person) { event.preventDefault(); setSpeaker(person.name, person.id); }
  }
});

(async function start() {
  const response = await fetch('/review/api/conversations');
  const data = await response.json();
  $('conv').innerHTML = data.conversations
    .map((conversation) => '<option value="' + esc(conversation.id) + '">' + esc(conversation.id) + ' · ' + conversation.lines + ' lines' + (conversation.has_audio ? '' : ' (no audio)') + '</option>')
    .join('');
  if (data.conversations.length) await loadConversation(data.conversations[0].id);
})();
</script>
</body>
</html>`;

export const REVIEW_PAGE_HTML = REVIEW_PAGE_TEMPLATE.replace('/*__DURATION_HELPERS__*/', durationHelpersSource());
