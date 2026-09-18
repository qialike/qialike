/**
 * Guard for the remote-access instructions in both READMEs.
 *
 * `dsh web`'s own flag parser refuses `--host 0.0.0.0` outright (it would expose
 * remote code execution to the network), yet both READMEs advertised exactly
 * that invocation as the headless recipe for months: a user following the docs
 * got `error: --host 0.0.0.0 is intentionally not supported yet for safety` and
 * exit 1, with nothing in the terminal pointing back at the doc. The refusal
 * lives in the installed harness (`dsh-web-app`'s startup command), not in this
 * repo, so a rename or a harness bump can silently invalidate the wording again
 * — this pins it.
 *
 * Run with `bun test tests/web-remote-docs.test.ts`.
 *
 * @module qialike/web-remote-docs-test
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const DOCS = ['README.md', 'README.zh.md'] as const

describe('the remote-access recipe names a flag the web profile accepts', () => {
  for (const doc of DOCS) {
    test(`${doc} never tells the user to run \`qialike web --host 0.0.0.0\``, () => {
      const text = readFileSync(join(REPO, doc), 'utf8')
      expect(text).not.toContain('qialike web --host 0.0.0.0')
      // The refusal is the reason the tunnel recipe exists: say so, so the next
      // reader does not "restore" the bind-all line as a missing option.
      expect(text).toContain('--host 0.0.0.0')
      expect(text).toContain('intentionally not supported')
      expect(text).toContain('ssh -L')
    })
  }

  test('both READMEs describe the token URL the server actually prints', () => {
    for (const doc of DOCS) {
      const text = readFileSync(join(REPO, doc), 'utf8')
      expect(text, doc).toContain('?token=')
      expect(text, doc).toContain('EADDRINUSE')
    }
  })
})
