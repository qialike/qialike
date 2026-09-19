/**
 * The atomic-write FFI route inside the single-file binary: overwriting an
 * EXISTING file copies the destination's DACL onto the empty staging file and
 * publishes with `ReplaceFileW` — the one harness path that reaches
 * `GetFileSecurityW` / `SetFileSecurityW` / `ReplaceFileW` through koffi, and
 * therefore through the bundled `koffi` shim in the SEA (the suite preload
 * installs that shim at `<repo>/node_modules/koffi`; see `tests/preload.ts`).
 *
 * This is a REGRESSION GUARD with a specific history. The shim first failed to
 * strip SCALAR parameter names, so all three declarations failed to bind
 * (`unsupported argument type "uint32_t requested"`), and after that fix it
 * still rejected koffi's JS-array `_Out_` form — the `needed: [0]` size query
 * `readFileDaclWin32` performs — with `cannot read a native address from
 * object`. Both were fixed in the shim, and NOTHING in this suite pinned the
 * resulting behaviour, so a later shim change could break every overwrite again
 * silently. The DACL comparison is the assertion that matters: a write that
 * "succeeded" by skipping the DACL copy would still produce the right bytes.
 *
 * Windows only: the FFI route is selected by `platform === 'win32'`.
 *
 * Run with `bun test tests/fs-local-atomic-write.test.ts`.
 *
 * @module qialike/fs-local-atomic-write-test
 */

import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFileAtomic } from '../apps/tui-bin/x/-deepseek-ai-dsh-fs-local/lib/types/fsio.js'
import { copyFileDaclWin32, readFileDaclWin32, replaceFileWin32 } from '../apps/tui-bin/x/-deepseek-ai-dsh-fs-local/lib/types/win32.js'

/**
 * The EXPLICIT (non-inherited) ACEs of a self-relative descriptor, as comparable
 * strings. Comparing whole descriptors byte-for-byte would fail legitimately:
 * after publication Windows re-canonicalizes the file and adds the parent
 * directory's *inherited* ACEs (measured: 3 explicit → 3 explicit + 3 inherited,
 * control `0x8004` → `0x8404`), so the explicit set is the part that proves the
 * DACL was actually copied rather than merely inherited.
 * @param descriptor - a self-relative security descriptor with a DACL.
 * @returns the sorted `type:mask:sid` strings of its explicit ACEs.
 */
function explicitAces(descriptor: Buffer): string[] {
    const aclOffset = descriptor.readUInt32LE(16)
    if (aclOffset === 0) return []
    const count = descriptor.readUInt16LE(aclOffset + 4)
    const aces: string[] = []
    let offset = aclOffset + 8
    for (let index = 0; index < count; index += 1) {
        const type = descriptor.readUInt8(offset)
        const flags = descriptor.readUInt8(offset + 1)
        const size = descriptor.readUInt16LE(offset + 2)
        const mask = descriptor.readUInt32LE(offset + 4)
        const sid = descriptor.subarray(offset + 8, offset + size).toString('hex')
        if ((flags & 0x10) === 0) aces.push(`${type}:${mask.toString(16)}:${sid}`)
        offset += size
    }
    return aces.sort()
}

describe.skipIf(process.platform !== 'win32')('the atomic overwrite FFI route', () => {
  test('overwrites an existing file, preserves its DACL, and leaves no staging', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qialike-fs-atomic-'))
    const file = join(dir, 'subject.txt')
    try {
      // Create: no existing mode, so publication takes the hard-link no-replace route.
      await writeFileAtomic(file, 'FIRST\n', undefined, undefined, {}, true)
      expect(await readFile(file, 'utf8')).toBe('FIRST\n')

      const aclBefore = explicitAces(await readFileDaclWin32(file))
      expect(aclBefore.length).toBeGreaterThan(0)
      const mode = (await stat(file)).mode

      // Overwrite: a DEFINED mode is what selects the DACL-copy + ReplaceFileW publish.
      await writeFileAtomic(file, 'SECOND\n', mode, undefined, {}, undefined)
      expect(await readFile(file, 'utf8')).toBe('SECOND\n')
      // The explicit ACEs survive; a publish that skipped the DACL copy would show
      // only the parent's inherited ACEs here.
      expect(explicitAces(await readFileDaclWin32(file))).toEqual(aclBefore)

      // The publication is atomic: no staging directory survives it.
      expect(await readdir(dir)).toEqual(['subject.txt'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('the DACL primitives answer through the shim on their own', async () => {
    // The three calls the overwrite path depends on, asserted directly — including
    // the size query that goes through the JS-array out-parameter.
    const dir = await mkdtemp(join(tmpdir(), 'qialike-fs-dacl-'))
    const source = join(dir, 'source.txt')
    const destination = join(dir, 'destination.txt')
    const replacement = join(dir, 'replacement.txt')
    try {
      await writeFile(source, 'a')
      await writeFile(destination, 'b')
      await writeFile(replacement, 'c')

      const descriptor = await readFileDaclWin32(source)
      expect(descriptor.length).toBeGreaterThan(0)

      await copyFileDaclWin32(source, destination)
      expect((await readFileDaclWin32(destination)).equals(descriptor)).toBe(true)

      await replaceFileWin32(destination, replacement)
      expect(await readFile(destination, 'utf8')).toBe('c')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
