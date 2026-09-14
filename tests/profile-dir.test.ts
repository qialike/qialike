/**
 * Source guards for the STABLE embedded-profile directory (`bin.ts`).
 *
 * The bug this locks down (review item P2): `materializeProfile()` wrote the
 * three embedded layers into `mkdtempSync($TMPDIR/dsh-tui-*)` — a FRESH random
 * directory on every launch — and nothing ever removed it (the only `rmSync`
 * calls in `bin.ts` belong to `uninstall`). So every launch leaked a directory,
 * and no user layer could ever live next to the materialized files.
 *
 * It also guards the second half of the same review item: the layers were read
 * through `loadOptionalPatches(...) ?? []`, i.e. an API whose contract is "a
 * missing file means NO layer" was used for layers that are REQUIRED — one failed
 * write away from booting a composition without the TUI layer, silently.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const BIN = readFileSync(new URL('../apps/tui-bin/src/bin.ts', import.meta.url), 'utf-8')

describe('embedded profile directory', () => {
  test('① it is a stable path under the harness home, not a temp dir', () => {
    // Slice the FUNCTION (not the file): the doc comment above `profileDir`
    // deliberately names the old `mkdtempSync` call, and a file-wide check would
    // trip on that comment instead of on code.
    const mat = BIN.slice(BIN.indexOf('function materializeProfile('), BIN.indexOf('\n}\n', BIN.indexOf('function materializeProfile(')))
    expect(mat, 'no more temp-dir materialization').not.toContain('mkdtempSync')
    expect(mat, 'materializes into the stable dir').toContain('const dir = profileDir()')
    expect(BIN, 'the path derives from the harness home').toContain("join(dshHomePath(), 'profiles', 'tui')")
    // Writing it must create the directory tree (first run: the home may not
    // have a profiles/ dir yet).
    expect(mat, 'creates the directory').toContain('mkdirSync(dir, { recursive: true })')
  })

  test('② the write is content-stamped, so an unchanged layer keeps its mtime', () => {
    const sync = BIN.slice(BIN.indexOf('function syncFile('), BIN.indexOf('\n}\n', BIN.indexOf('function syncFile(')))
    expect(sync, 'syncFile exists').toContain('readFileSync(file')
    expect(sync, 'skips an identical write').toContain('=== content')
    expect(sync, 'writes when missing/different').toContain('writeFileSync(file, content)')
    // The materializer routes all three layers through it.
    for (const layer of ['root', 'base', 'tui']) {
      expect(BIN, `${layer} goes through syncFile`).toContain(`syncFile(${layer}, `)
    }
  })

  test('③ a REQUIRED layer can never degrade into "no layer"', () => {
    // The reader turns the optional API's `undefined` into a loud failure…
    const reader = BIN.slice(BIN.indexOf('function readEmbeddedLayer('), BIN.indexOf('\n}\n', BIN.indexOf('function readEmbeddedLayer(')))
    expect(reader, 'reads through the parser').toContain('loadOptionalPatches(binName, file)')
    expect(reader, 'fails loud on a missing file').toContain('layer === undefined')
    expect(reader, 'names the file').toContain('throw new Error')
    // …and BOTH required layers go through it (no `?? []` left on them).
    expect(BIN, 'base layer').toContain('readEmbeddedLayer(NAME, profile.base)')
    expect(BIN, 'tui layer').toContain('readEmbeddedLayer(NAME, profile.tui)')
    expect(BIN, 'no silent fallback for the embedded layers').not.toContain('loadOptionalPatches(NAME,')
  })

  test('④ the legacy temp dirs are swept, but never a live one', () => {
    const sweep = BIN.slice(BIN.indexOf('function sweepLegacyProfiles('), BIN.indexOf('\n}\n', BIN.indexOf('function sweepLegacyProfiles(')))
    expect(sweep, 'targets the old prefix').toContain("name.startsWith('dsh-tui-')")
    expect(sweep, 'only removes dirs older than a day').toContain('24 * 60 * 60 * 1000')
    // A running launch of the same binary still owns its directory…
    expect(sweep, 'skips young entries').toContain('continue')
    // …and cleanup must never be able to break a boot.
    expect(sweep, 'best effort').toContain('catch')
  })
})
