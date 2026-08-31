/**
 * Refuse to write real people's speech anywhere git would pick it up.
 *
 * This started in `server/review/corrections.ts`, where every record quotes
 * somebody who never agreed to appear in a shared repository. It is not a fact
 * about corrections. The same is true of a transcript, a diarization, a set of
 * candidate labels — anything derived from the recordings — and the moment a
 * second writer existed the rule needed one home rather than a copy.
 *
 * `git check-ignore` is the only authority on this that cannot drift from the
 * actual .gitignore. A path outside the repository is fine: git cannot see it.
 */

import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const repoRoot = resolve(new URL('../..', import.meta.url).pathname)

export function assertPathIsGitIgnored(path: string, what = 'personal data'): void {
  const absolute = resolve(path)
  if (!absolute.startsWith(repoRoot + '/')) return
  try {
    execFileSync('git', ['check-ignore', '-q', '--no-index', absolute], { cwd: repoRoot })
  } catch {
    throw new Error(
      `Refusing to write ${what} to ${absolute}: git does not ignore it, and this file quotes ` +
        'real people. Add it to .gitignore, or write somewhere outside the repository.',
    )
  }
}
