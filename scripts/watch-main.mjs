#!/usr/bin/env node
// Polls origin/main and prints only when something new lands. Run it in a spare
// terminal while you work: `bun run watch`.

import { execFileSync } from 'node:child_process';

const INTERVAL_MS = Number(process.env.WATCH_INTERVAL_MS ?? 120_000);
const git = (...args) => {
  try {
    return execFileSync('git', args, { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
};

let lastSeen = git('rev-parse', 'origin/main');
console.log(`watching origin/main from ${lastSeen.slice(0, 7)}, every ${INTERVAL_MS / 1000}s`);

const tick = () => {
  git('fetch', 'origin', '--quiet');
  const head = git('rev-parse', 'origin/main');
  if (!head || head === lastSeen) return;

  const commits = git('log', '--reverse', '--format=%h %an: %s', `${lastSeen}..${head}`).split('\n').filter(Boolean);
  const files = [...new Set(git('diff', '--name-only', lastSeen, head).split('\n').filter(Boolean))];
  const mine = new Set(
    git('status', '--porcelain').split('\n').filter(Boolean).map((l) => l.slice(3).split(' -> ').pop().trim()),
  );
  const collisions = files.filter((f) => mine.has(f));

  console.log(`\n\x1b[1m[${new Date().toLocaleTimeString()}] main moved\x1b[0m`);
  for (const c of commits) console.log(`  ${c}`);
  if (collisions.length) {
    console.log(`  \x1b[31mtouches files you have open:\x1b[0m ${collisions.join(', ')}`);
  }
  console.log('  \x1b[2mbun run sync\x1b[0m');
  lastSeen = head;
};

setInterval(tick, INTERVAL_MS);
