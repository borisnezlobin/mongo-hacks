import { defineConfig } from 'vitest/config'

/**
 * The only reason this file exists is to keep the gate honest.
 *
 * Vitest's default excludes cover `node_modules` and `dist` but know nothing
 * about `.claude/worktrees/`, where agent worktrees put a second full checkout
 * of this repository. With one present, `bun run test` collects every suite
 * twice — once from here and once from a copy at some other commit — and
 * reports a total that looks like growth. It is not: a run that says 369 tests
 * passed when the repository has 194 is running somebody else's branch and
 * calling it yours, and a failure in that copy is a failure nobody can locate.
 *
 * Vitest does not read .gitignore, so ignoring the directory for git is not
 * enough on its own. Both are needed and both are here.
 */
export default defineConfig({
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.claude/**',
      '**/.{idea,git,cache,output,temp}/**',
    ],
  },
})
