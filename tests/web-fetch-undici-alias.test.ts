/**
 * The two halves of the **undici alias** the build installs, and the reason both
 * exist.
 *
 * THE BUG. The harness's web stack writes `await import("undici")`. Bun answers
 * that BARE specifier from its own built-in stub — not from the real package
 * sitting in `node_modules` — and the stub is not a drop-in:
 *
 *  * `new Agent().close` is `undefined`, so `web-fetch-http`'s `requestPinned()`
 *    threw `dispatcher.close is not a function` on EVERY fetch. `web_fetch` was
 *    dead in every qialike build on every platform, with no proxy configured.
 *  * Bun's `fetch` ignores the `dispatcher` option outright (a bogus object is
 *    accepted; the pinned `connect.lookup` is never called), so the public-address
 *    PIN that closes the DNS-rebinding window between resolution and connection
 *    was silently not applied.
 *
 * The build therefore publishes the real package under a name Bun does not
 * intercept and rewrites the specifier. Verified end to end in a compiled single
 * file by `cli-test/probes/web-fetch-undici-sea.py`: the fixed module fetches and
 * honours the pin; the unpatched one reproduces the production error verbatim.
 *
 * THE SECOND TRAP. Bundling the real undici put ONE non-ASCII character in the
 * blob — the `ä` of `Jimmy Wärting` in undici's `/*!` formdata-polyfill
 * attribution comment, which esbuild's `charset: ascii` pass skips because it
 * only escapes CODE. `bun build --compile` stores the embedded sources as UTF-16
 * when any non-ASCII survives, so that one character took the binary from
 * 103,040,480 to 124,388,832 bytes. Measured by compiling the same bundle twice,
 * with and without the umlaut: +21.5 MiB.
 *
 * Run with `bun test tests/web-fetch-undici-alias.test.ts`.
 *
 * @module qialike/web-fetch-undici-alias-test
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { escapeNonAsciiSource, patchUndiciSpecifiers } from '../apps/tui-bin/build.mjs'

const BUILD = readFileSync(join(import.meta.dir, '..', 'apps', 'tui-bin', 'build.mjs'), 'utf8')

describe('the specifier rewrite', () => {
  test('rewrites the bare specifier in both quote styles the farm contains', () => {
    // `lib/index.js` keeps the emitted double quotes…
    expect(patchUndiciSpecifiers('\tconst { Agent, fetch } = await import("undici");\n'))
      .toBe('\tconst { Agent, fetch } = await import("qialike-undici");\n')
    // …and `lib/types/*.js` the source's single quotes.
    expect(patchUndiciSpecifiers("    const { fetch } = await import('undici');\n"))
      .toBe("    const { fetch } = await import('qialike-undici');\n")
  })

  test('rewrites every occurrence, not just the first', () => {
    const source = 'await import("undici")\nawait import("undici")\n'
    expect(patchUndiciSpecifiers(source)?.match(/qialike-undici/g)).toHaveLength(2)
  })

  test('is idempotent — a second run leaves its own output alone', () => {
    const once = patchUndiciSpecifiers('await import("undici")\n')!
    expect(patchUndiciSpecifiers(once)).toBeUndefined()
  })

  test('reports "nothing to do" rather than rewriting text it did not match', () => {
    // A mention in a comment is not an import: patching it would be noise, and
    // counting it as a rewrite would hide a real anchor loss.
    expect(patchUndiciSpecifiers('// undici is loaded lazily\nconst x = 1\n')).toBeUndefined()
    expect(patchUndiciSpecifiers('const u = require("undici")\n')).toBeUndefined()
  })

  test('does not touch a specifier that merely starts with the name', () => {
    expect(patchUndiciSpecifiers('await import("undici-extra")\n')).toBeUndefined()
  })
})

describe('the non-ASCII escape', () => {
  test('escapes BMP characters, including the one that cost 21.5 MiB', () => {
    expect(escapeNonAsciiSource('Jimmy Wärting')).toBe('Jimmy W\\u00e4rting')
    expect(escapeNonAsciiSource('a — b')).toBe('a \\u2014 b')
  })

  test('escapes astral characters as the surrogate pair the runtime stores', () => {
    // A lone `\u{1F600}` is two UTF-16 units; escaping it as ONE \uXXXX would
    // emit a code point a JS string cannot hold.
    expect(escapeNonAsciiSource('💡 Tip')).toBe('\\ud83d\\udca1 Tip')
  })

  test('leaves pure ASCII alone, and says so instead of returning a copy', () => {
    expect(escapeNonAsciiSource('const a = 1\n// plain\n')).toBeUndefined()
    expect(escapeNonAsciiSource('\\u00e4 already escaped\n')).toBeUndefined()
  })

  test('is behaviour-preserving where it matters: a string literal still holds the character', () => {
    // The escaped form is the same string value — this is exactly what esbuild's
    // own `charset: ascii` does to every string in the bundle.
    const escaped = escapeNonAsciiSource('const s = "Wärting"')!
    expect(escaped).not.toContain('ä')
    // eslint-disable-next-line no-eval -- the point IS to evaluate the emitted source.
    expect(eval(`${escaped.replace('const s = ', '')}`)).toBe('Wärting')
  })
})

describe('the wiring that makes both real', () => {
  test('the alias is a name Bun does not intercept', () => {
    expect(BUILD).toContain("const UNDICI_ALIAS = 'qialike-undici'")
    expect(BUILD).not.toContain("const UNDICI_ALIAS = 'undici'")
  })

  test('the copy is transformed, never the harness store it comes from', () => {
    // The source is the harness's shared pnpm store — writing the escape pass
    // into it would corrupt a tree this repository does not own.
    expect(BUILD).toMatch(/A COPY rather than the symlink/)
    expect(BUILD).toContain('copyTree(source, copy)')
    expect(BUILD).toContain('escapeNonAsciiSource(text)')
    // The copy lands in the farm, which every build recreates from scratch.
    expect(BUILD).toContain("const copy = join(ROOT, 'apps/tui-bin/x', UNDICI_ALIAS)")
  })

  test('the alias is installed and the farm rewritten before anything is bundled', () => {
    const patch = BUILD.indexOf('  patchUndiciImports(nm)')
    const bundleCall = BUILD.indexOf('\n  bundle()\n')
    expect(patch).toBeGreaterThan(-1)
    expect(bundleCall).toBeGreaterThan(patch)
    // installUndiciAlias must run before the rewrite, or the rewrite would point
    // at a specifier that resolves to nothing.
    const install = BUILD.indexOf('installUndiciAlias(nm)', BUILD.indexOf('function patchUndiciImports'))
    const rewrite = BUILD.indexOf('patchUndiciSpecifiers(readFileSync(file', BUILD.indexOf('function patchUndiciImports'))
    expect(install).toBeGreaterThan(-1)
    expect(rewrite).toBeGreaterThan(install)
  })

  test('an anchor loss fails the build instead of shipping the broken tool', () => {
    // A harness revision that changes how undici is loaded must be noticed, not
    // silently shipped (that is the failure this whole patch exists to undo).
    expect(BUILD).toMatch(/the harness changed how it loads undici/)
    // And a missing package is fatal too: the web stack cannot work without it.
    expect(BUILD).toMatch(/the real undici is not in the farm/)
  })
})
