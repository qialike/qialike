/**
 * Regression test for the "titles invisible until restart" bug.
 *
 * The SEA build (`apps/tui-bin/build.mjs`) compiles several panel entries
 * (index.tsx, panels/conversation.tsx, sessions.tsx, …) as SEPARATE esbuild
 * bundles. Any module they share and that keeps its mutable state at module
 * top level is therefore duplicated: each bundle copy gets its own cache, a
 * title written through the runtime entry's copy never reaches the sidebar
 * copy (which keeps its own empty map after one disk load), and the title only
 * appears after a restart re-reads the disk file.
 *
 * session-titles.ts anchors its cache on a process-global object to defeat
 * this. This test reproduces the duplication the way the build does — bundling
 * the module twice into two independent files, importing both into one
 * process — and asserts they share one cache.
 *
 * Run with `bun test tests/title-cache-sharing.test.ts`.
 *
 * @module qialike/title-cache-sharing-test
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const TITLE_SRC = join(HERE, '../packages/qialike-app/src/session-titles.ts')

// Isolate the title cache before any lazy disk load.
const home = mkdtempSync(join(tmpdir(), 'qialike-title-share-'))
process.env.DSH_HOME = home

const outDir = mkdtempSync(join(tmpdir(), 'qialike-title-share-bundle-'))
const bundleA = join(outDir, 'a.mjs')
const bundleB = join(outDir, 'b.mjs')

afterAll(async () => {
  rmSync(home, { recursive: true, force: true })
  rmSync(outDir, { recursive: true, force: true })
})

describe('duplicated module copies share one title cache', () => {
  test('two independent bundles see each other\'s writes', async () => {
    // Bundle the module twice into two standalone files (each inlines its own
    // copy of session-titles.ts — the same duplication the SEA build produces
    // when index.tsx and panels/conversation.tsx are separate entries).
    for (const outfile of [bundleA, bundleB]) {
      await build({
        entryPoints: [TITLE_SRC],
        bundle: true,
        platform: 'node',
        format: 'esm',
        outfile,
        logLevel: 'silent',
      })
    }
    const a = await import(bundleA)
    const b = await import(bundleB)

    const id = 'session-shared-cache-0001'
    a.rememberTitle(id, 'shared-title')
    // The second copy — the one the sidebar reads — must see the write made
    // through the first copy. Before the global-anchored fix it returned
    // undefined until a restart re-read the disk file.
    expect(b.sessionDisplayTitle(id)).toBe('shared-title')
    // And the reverse direction (user rename via the list entry, read by the
    // sidebar entry) works too.
    b.renameTitle(id, 'renamed')
    expect(a.sessionDisplayTitle(id)).toBe('renamed')
  })
})
