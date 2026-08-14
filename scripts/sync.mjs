#!/usr/bin/env node
// Reports what landed on main since you last looked, whether it collides with
// your uncommitted work, and what everyone else says they are doing.
// Advisory only: it never blocks an edit and never rewrites your worktree
// unless the worktree is clean.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

const BRANCH = 'main';
const STALE_HOURS = 48;

const git = (...args) => {
  try {
    return execFileSync('git', args, { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
};

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;

const slugify = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function dirtyFiles() {
  return git('status', '--porcelain')
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3).split(' -> ').pop().trim());
}

function incomingCommits() {
  const raw = git('log', '--reverse', '--format=%h\x1f%an\x1f%ar\x1f%s', `HEAD..origin/${BRANCH}`);
  if (!raw) return [];
  return raw.split('\n').map((line) => {
    const [hash, author, when, subject] = line.split('\x1f');
    // -m diffs a merge against each parent; without it a merge commit reports no
    // files at all and its changes vanish from collision detection.
    const files = git('show', '-m', '--name-only', '--format=', hash).split('\n').filter(Boolean);
    return { hash, author, when, subject, files: [...new Set(files)] };
  });
}

/** Everything on main that this worktree does not have, merges included. */
function incomingFileSet() {
  return new Set(git('diff', '--name-only', `HEAD...origin/${BRANCH}`).split('\n').filter(Boolean));
}

function boardEntries() {
  const listing = git('ls-tree', '--name-only', `origin/${BRANCH}`, '.team/');
  return listing
    .split('\n')
    .filter((path) => path.endsWith('.md') && !path.endsWith('README.md') && !path.includes('_template'))
    .map((path) => {
      const body = git('show', `origin/${BRANCH}:${path}`);
      const field = (key) => (body.match(new RegExp(`^${key}:\\s*(.+)$`, 'm')) || [])[1]?.trim() ?? '';
      const section = (heading) =>
        (body.match(new RegExp(`^## ${heading}\\n([\\s\\S]*?)(?=\\n## |$)`, 'm')) || [])[1]?.trim() ?? '';
      return {
        who: path.replace('.team/', '').replace('.md', ''),
        updated: field('updated'),
        status: field('status'),
        now: section('Now'),
        heads: section('Heads up'),
      };
    });
}

function hoursSince(iso) {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  return (Date.now() - then) / 36e5;
}

console.log(dim('fetching...'));
git('fetch', 'origin', '--quiet');

const me = slugify(git('config', 'user.name') || 'unknown');

const myBoardFile = `.team/${me}.md`;
if (!existsSync(myBoardFile)) {
  mkdirSync('.team', { recursive: true });
  writeFileSync(
    myBoardFile,
    [
      `name: ${me}`,
      'status: active',
      `updated: ${new Date().toISOString().slice(0, 16)}Z`,
      '',
      '## Now',
      '',
      '',
      '## Heads up',
      '',
      '',
    ].join('\n'),
  );
  console.log(green(`\nMade you a board file: ${myBoardFile} — say what you're working on and commit it.`));
}
const incoming = incomingCommits();
const unpushed = git('log', '--format=%h %s', `origin/${BRANCH}..HEAD`).split('\n').filter(Boolean);
const dirty = dirtyFiles();

console.log(`\n${bold('You')}  ${me}  ${dim(`on ${git('rev-parse', '--abbrev-ref', 'HEAD')}`)}`);
console.log(`${dim('  unpushed commits:')} ${unpushed.length}   ${dim('uncommitted files:')} ${dirty.length}`);

if (incoming.length === 0) {
  console.log(green(`\nUp to date with origin/${BRANCH}.`));
} else {
  console.log(`\n${bold(`${incoming.length} new commit(s) on ${BRANCH}`)}`);
  for (const c of incoming) {
    console.log(`  ${dim(c.hash)} ${c.subject}  ${dim(`— ${c.author}, ${c.when}`)}`);
  }

  const incomingFiles = incomingFileSet();
  const collisions = dirty.filter((f) => incomingFiles.has(f));
  if (collisions.length) {
    console.log(`\n${red(bold('Collision risk'))} — these files changed on ${BRANCH} and you have uncommitted edits in them:`);
    for (const f of collisions) {
      const who = incoming.filter((c) => c.files.includes(f)).map((c) => c.author);
      console.log(`  ${yellow(f)} ${dim(`(touched by ${[...new Set(who)].join(', ')})`)}`);
    }
    console.log(dim('  Read their version before you rebase: git diff HEAD origin/main -- <file>'));
  }
}

const board = boardEntries().filter((e) => e.who !== me);
if (board.length) {
  console.log(`\n${bold('Board')} ${dim('(from origin/main)')}`);
  for (const e of board) {
    const age = hoursSince(e.updated);
    const stale = age !== null && age > STALE_HOURS;
    const label = stale ? yellow(`${e.who} (stale, ${Math.round(age)}h)`) : bold(e.who);
    console.log(`  ${label} ${dim(e.status)}`);
    if (e.now) console.log(`    ${e.now.split('\n').join('\n    ')}`);
    if (e.heads) console.log(`    ${yellow('heads up:')} ${e.heads.split('\n').join('\n    ')}`);
  }
}

if (incoming.length && dirty.length === 0) {
  console.log(`\n${dim('clean worktree, rebasing...')}`);
  try {
    execFileSync('git', ['pull', '--rebase', 'origin', BRANCH], { stdio: 'inherit' });
    console.log(green('Rebased onto origin/main.'));
  } catch {
    console.log(red('Rebase failed. Resolve, then `git rebase --continue`.'));
  }
} else if (incoming.length) {
  console.log(`\n${yellow('Not rebasing automatically — you have uncommitted work.')}`);
  console.log(dim('  Commit or stash, then: git pull --rebase origin main'));
}
