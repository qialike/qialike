/**
 * `delete` / `move`: the workspace fence, and the mutations themselves.
 *
 * The fence is the point of the plugin, so the tests lead with it:
 *  - the workspace root ITSELF is refused (`contains(root, root)` is true, so
 *    the equality check must come first — otherwise `delete('.')` passes and
 *    takes the whole tree with it);
 *  - only the workspace root is writable: NOT the harness's `writableRoots()`
 *    temp grants. That asymmetry with `write` is deliberate and pinned below —
 *    `write` needs the shared temp area for mkstemp-family tools, an
 *    irreversible recursive `delete` must not range over other processes' files;
 *  - `read-only` refuses, `danger-full-access` delegates;
 *  - `move` fences BOTH ends, so it cannot be used to ingest or exfiltrate.
 *
 * The fake `ctx.fs` mirrors `LocalFileSystem`'s contract for the three methods
 * the plugin uses (`resolve` / `processPath` / `contains`); `contains` stays the
 * real implementation's `relative()` rule verbatim, because the equality-first
 * ordering only has meaning against that rule.
 *
 * Run with `bun test tests/fs-tools.test.ts`.
 *
 * @module qialike/fs-tools-test
 */

import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { apply } from '../packages/qialike-app/src/fs-tools.ts'

type Mode = 'read-only' | 'workspace-write' | 'danger-full-access'

interface Tool {
  name: string
  execute: (args: unknown, exec: unknown) => Promise<unknown>
}

/** Build a plugin context whose only services are the three the plugin injects. */
function rig(workspaceRoot: string, mode: Mode) {
  const tools = new Map<string, Tool>()
  const fs = {
    async resolve(path: string, opts?: { cwd?: string }) {
      const base = opts?.cwd ?? workspaceRoot
      const abs = isAbsolute(path) ? path : join(base, path)
      // Mirror the real backend: canonical when it exists, lexical otherwise
      // (a move destination may not exist yet).
      let key = abs
      try {
        key = await realpath(abs)
      } catch {
        key = abs
      }
      return { targetKey: key, displayPath: key }
    },
    processPath: (target: { targetKey: string }) => target.targetKey,
    contains(parent: { targetKey: string }, child: { targetKey: string }) {
      const rel = relative(parent.targetKey, child.targetKey)
      return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
    },
    async lstat(path: string) {
      try {
        const info = await lstat(path)
        return { version: 'v', type: info.isDirectory() ? 'directory' : info.isSymbolicLink() ? 'symlink' : 'file' }
      } catch {
        return undefined
      }
    },
  }
  const ctx = {
    tools: { register: (def: Tool) => { tools.set(def.name, def) } },
    fs,
    sandboxPolicy: {
      resolve: () => ({ mode, workspaceRoot }),
    },
  }
  apply(ctx as never)
  return {
    /** Run one registered tool against the given arguments. */
    run: (name: string, args: unknown) => {
      const tool = tools.get(name)
      if (tool === undefined) throw new Error(`no such tool: ${name}`)
      return tool.execute(args, { agent: undefined, signal: undefined })
    },
    names: () => [...tools.keys()].sort(),
  }
}

/** A canonical temp workspace plus a sibling directory outside it. */
async function sandbox() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'qialike-fs-tools-')))
  const workspace = join(base, 'workspace')
  const outside = join(base, 'outside')
  await mkdir(workspace)
  await mkdir(outside)
  return { base, workspace, outside }
}

describe('registration', () => {
  test('registers delete and move', async () => {
    const { workspace } = await sandbox()
    expect(rig(workspace, 'workspace-write').names()).toEqual(['delete', 'move'])
  })
})

describe('the workspace fence', () => {
  test('deletes a file inside the workspace', async () => {
    const { workspace } = await sandbox()
    const file = join(workspace, 'a.txt')
    await writeFile(file, 'x')
    const result = (await rig(workspace, 'workspace-write').run('delete', { path: 'a.txt' })) as { kind: string }
    expect(result.kind).toBe('file')
    expect(existsSync(file)).toBe(false)
  })

  test('refuses the workspace root itself — `contains(root, root)` must not decide', async () => {
    const { workspace } = await sandbox()
    await writeFile(join(workspace, 'keep.txt'), 'x')
    for (const path of ['.', workspace]) {
      await expect(rig(workspace, 'workspace-write').run('delete', { path })).rejects.toThrow(/workspace root itself/)
    }
    // Nothing was taken with it.
    expect(existsSync(join(workspace, 'keep.txt'))).toBe(true)
  })

  test('refuses a path outside the workspace — and the temp grants do NOT extend here', async () => {
    const { workspace, outside } = await sandbox()
    const victim = join(outside, 'victim.txt')
    await writeFile(victim, 'x')
    await expect(rig(workspace, 'workspace-write').run('delete', { path: victim })).rejects.toThrow(/outside the workspace/)
    expect(existsSync(victim)).toBe(true)
  })

  test('a sibling of the workspace is outside, not "under" it', async () => {
    // Guards the classic prefix bug: `/tmp/x/workspace-evil` must not look like
    // it lives inside `/tmp/x/workspace`.
    const { base, workspace } = await sandbox()
    const sibling = join(base, 'workspace-evil')
    await mkdir(sibling)
    const victim = join(sibling, 'v.txt')
    await writeFile(victim, 'x')
    await expect(rig(workspace, 'workspace-write').run('delete', { path: victim })).rejects.toThrow(/outside the workspace/)
    expect(existsSync(victim)).toBe(true)
  })

  // The asymmetry with `write` is deliberate, and this pins its safe side: the
  // write fence may create in the platform temp area (mkstemp-family tools need
  // it), while `delete` must not range over the host's SHARED temp tree — a
  // recursive removal there harms other processes and there is no undo. On POSIX
  // the workspace fixture itself lives under that temp root, which is exactly why
  // "outside" must stay a sibling of it: wiring `writableRoots()` into this fence
  // turned this test red, and it must stay red.
  test.skipIf(process.platform === 'win32')('refuses the platform temp area even though `write` may create there', async () => {
    const { workspace } = await sandbox()
    const victim = join(tmpdir(), `qialike-fs-tools-temp-${Date.now()}.txt`)
    await writeFile(victim, 'x')
    try {
      await expect(rig(workspace, 'workspace-write').run('delete', { path: victim })).rejects.toThrow(/outside the workspace/)
      expect(existsSync(victim)).toBe(true)
    } finally {
      await rm(victim, { force: true })
    }
  })

  // An alias spelling must not become a way out: `resolve` canonicalizes through
  // the junction, so the checked key is the outside path even though the model
  // named a path that starts inside the workspace.
  test.skipIf(process.platform !== 'win32')('a junction alias of an outside directory stays outside', async () => {
    const { workspace, outside } = await sandbox()
    const victim = join(outside, 'victim.txt')
    await writeFile(victim, 'x')
    await symlink(outside, join(workspace, 'alias'), 'junction')
    await expect(
      rig(workspace, 'workspace-write').run('delete', { path: join('alias', 'victim.txt') }),
    ).rejects.toThrow(/outside the workspace/)
    expect(existsSync(victim)).toBe(true)
  })

  test('read-only refuses and names the mode', async () => {
    const { workspace } = await sandbox()
    const file = join(workspace, 'a.txt')
    await writeFile(file, 'x')
    await expect(rig(workspace, 'read-only').run('delete', { path: 'a.txt' })).rejects.toThrow(/file access denied under read-only mode/)
    expect(existsSync(file)).toBe(true)
  })

  test('danger-full-access delegates, including outside the workspace', async () => {
    const { workspace, outside } = await sandbox()
    const victim = join(outside, 'v.txt')
    await writeFile(victim, 'x')
    await rig(workspace, 'danger-full-access').run('delete', { path: victim })
    expect(existsSync(victim)).toBe(false)
  })
})

describe('delete semantics', () => {
  test('a non-empty directory needs recursive: true', async () => {
    const { workspace } = await sandbox()
    await mkdir(join(workspace, 'dir'))
    await writeFile(join(workspace, 'dir', 'inner.txt'), 'x')
    await expect(rig(workspace, 'workspace-write').run('delete', { path: 'dir' })).rejects.toThrow(/recursive: true/)
    expect(existsSync(join(workspace, 'dir', 'inner.txt'))).toBe(true)
  })

  test('recursive: true takes the whole tree', async () => {
    const { workspace } = await sandbox()
    await mkdir(join(workspace, 'dir'))
    await writeFile(join(workspace, 'dir', 'inner.txt'), 'x')
    const result = (await rig(workspace, 'workspace-write').run('delete', { path: 'dir', recursive: true })) as { kind: string }
    expect(result.kind).toBe('directory')
    expect(existsSync(join(workspace, 'dir'))).toBe(false)
  })

  test('a missing target reports not-found rather than succeeding silently', async () => {
    const { workspace } = await sandbox()
    await expect(rig(workspace, 'workspace-write').run('delete', { path: 'nope.txt' })).rejects.toThrow(/no such file/)
  })

  test('a blank path is rejected before any filesystem work', async () => {
    const { workspace } = await sandbox()
    await expect(rig(workspace, 'workspace-write').run('delete', { path: '   ' })).rejects.toThrow(/non-empty path/)
  })
})

describe('move semantics', () => {
  test('renames inside the workspace', async () => {
    const { workspace } = await sandbox()
    await writeFile(join(workspace, 'old.txt'), 'payload')
    const result = (await rig(workspace, 'workspace-write').run('move', { source: 'old.txt', destination: 'new.txt' })) as { from: string; to: string }
    expect(result.to.endsWith('new.txt')).toBe(true)
    expect(existsSync(join(workspace, 'old.txt'))).toBe(false)
    expect(existsSync(join(workspace, 'new.txt'))).toBe(true)
  })

  test('fences BOTH ends: an outside destination is refused and the source survives', async () => {
    const { workspace, outside } = await sandbox()
    await writeFile(join(workspace, 'old.txt'), 'payload')
    await expect(
      rig(workspace, 'workspace-write').run('move', { source: 'old.txt', destination: join(outside, 'stolen.txt') }),
    ).rejects.toThrow(/outside the workspace/)
    expect(existsSync(join(workspace, 'old.txt'))).toBe(true)
    expect(existsSync(join(outside, 'stolen.txt'))).toBe(false)
  })

  test('fences BOTH ends: an outside source is refused', async () => {
    const { workspace, outside } = await sandbox()
    await writeFile(join(outside, 'theirs.txt'), 'payload')
    await expect(
      rig(workspace, 'workspace-write').run('move', { source: join(outside, 'theirs.txt'), destination: 'mine.txt' }),
    ).rejects.toThrow(/outside the workspace/)
    expect(existsSync(join(outside, 'theirs.txt'))).toBe(true)
  })

  test('refuses the workspace root as either end', async () => {
    const { workspace } = await sandbox()
    await writeFile(join(workspace, 'a.txt'), 'x')
    await expect(rig(workspace, 'workspace-write').run('move', { source: '.', destination: 'x' })).rejects.toThrow(/workspace root itself/)
    await expect(rig(workspace, 'workspace-write').run('move', { source: 'a.txt', destination: '.' })).rejects.toThrow(/workspace root itself/)
  })
})
