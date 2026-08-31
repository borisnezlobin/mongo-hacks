import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertPathIsGitIgnored } from './personal-data'

describe('assertPathIsGitIgnored', () => {
  it('allows a path git is told to ignore', () => {
    expect(() => assertPathIsGitIgnored(resolve('eval/real/anything.txt'))).not.toThrow()
    expect(() => assertPathIsGitIgnored(resolve('fixtures/real/anything.wav'))).not.toThrow()
  })

  it('refuses a path git would pick up, and says what it was asked to write', () => {
    expect(() => assertPathIsGitIgnored(resolve('eval/oops.txt'), 'a transcript')).toThrow(
      /Refusing to write a transcript.*does not ignore it/s,
    )
  })

  it('allows anywhere outside the repository, because git cannot see it', () => {
    const outside = mkdtempSync(join(tmpdir(), 'amelia-'))
    expect(() => assertPathIsGitIgnored(join(outside, 'transcript.txt'))).not.toThrow()
  })
})
