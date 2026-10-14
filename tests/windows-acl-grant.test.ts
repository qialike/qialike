/**
 * The two Windows fixes merged from the field copy (`~/test/qialike`).
 *
 * Neither one can be exercised on this host: the junction fix is a WINDOWS build
 * path (`symlinkSync(…, 'dir')` needs SeCreateSymbolicLinkPrivilege), and the
 * grant prewarm returns immediately off win32. So the guards here are in three
 * layers, chosen so that each covers what the layer above cannot:
 *
 *  ① the ANCHORS, against the real harness source — `windows-acl-grant.mjs` is
 *     fail-loud, and this is the check that says so before a build discovers it;
 *  ② the PATCH ITSELF, through the module's own injected read/write hooks, so the
 *     seven edits are pinned as text (idempotency and the throw included);
 *  ③ the LAUNCHER wiring, as source guards — that the farm links through
 *     `linkDirectory`, that the helper picks a junction on win32, and that the
 *     grant patch is registered AFTER the runner-entry patch its anchor depends on.
 *
 * Run with `bun test tests/windows-acl-grant.test.ts`.
 *
 * @module qialike/windows-acl-grant-test
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { patchWindowsAclGrant, windowsAclGrantEdits } from '../apps/tui-bin/harness-patches/windows-acl-grant.mjs'
import {
  aclGrantArgv,
  canonicalWorkspaceRoot,
  embeddedRunnerReady,
  ensureAclGrant,
  prewarmAclGrant,
} from '../packages/qialike-app/src/windows-acl-grant.ts'

const REPO = join(import.meta.dir, '..')
const BUILD = readFileSync(join(REPO, 'apps', 'tui-bin', 'build.mjs'), 'utf8')

/**
 * The harness's compiled `dsh-sandbox-local`, the file the patch edits.
 *
 * Resolved the way `build.mjs` resolves the harness, so the guard reads the same
 * tree a build would. Absent (a clone without the sibling checkout) skips rather
 * than fails: this guard exists to catch a harness revision moving the anchors,
 * and it cannot speak about a tree that is not there.
 */
const HARNESS_LIB = join(
  process.env.DSH_HARNESS ?? join(REPO, '..', 'deepseek-harness'),
  'packages', 'sandbox', 'sandbox-local', 'lib', 'index.js',
)

const marker = (source: string, start: string, end: string): string =>
  source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)))

describe('the ACL grant patch anchors', () => {
  test.skipIf(!existsSync(HARNESS_LIB))('every pristine-harness anchor matches exactly once', () => {
    // The fail-loud contract: if a harness revision moves one of these, the build
    // throws. This says which one, before the build has to.
    const source = readFileSync(HARNESS_LIB, 'utf8')
    // The gate import hangs off qialike's own runner-flag import (inserted by
    // `patchWindowsAclRunnerEntry`), so it is not pristine — checked separately.
    const pristine = windowsAclGrantEdits().filter((edit) => edit.name !== 'gate import')
    expect(pristine.length, 'the pristine-harness edits').toBeGreaterThan(5)
    for (const edit of pristine) {
      expect(source.split(edit.anchor).length - 1, `${edit.name} anchor`).toBe(1)
    }
  })

  test('the gate import anchors on the import the runner-entry patch inserts', () => {
    // Ordering, not text: `build.mjs` inserts this line, and the gate import is
    // anchored on it so that it is present exactly when that patch has run.
    // The build spells that line as two concatenated literals, so match the halves.
    const gate = windowsAclGrantEdits().find((edit) => edit.name === 'gate import')
    expect(gate?.anchor).toBe(
      "import { WINDOWS_ACL_RUNNER_FLAG as QIALIKE_WINDOWS_ACL_RUNNER_FLAG }"
      + ' from "@qialike/qialike-app/src/windows-acl-mode.ts";\n',
    )
    expect(BUILD, 'build.mjs inserts that import')
      .toContain("'import { WINDOWS_ACL_RUNNER_FLAG as QIALIKE_WINDOWS_ACL_RUNNER_FLAG }'")
    expect(BUILD).toContain("' from \"@qialike/qialike-app/src/windows-acl-mode.ts\";\\n'")
  })
})

describe('applying the patch', () => {
  /** A stand-in for the vendored file: carries every anchor, in order. */
  const fixture = (): string => windowsAclGrantEdits().map((edit) => edit.anchor).join('')

  const apply = (source: string): { written: string; result: string[] } => {
    let written = source
    const result = patchWindowsAclGrant({
      root: '/nonexistent',
      file: 'fixture.js',
      readFile: () => written,
      writeFile: (_file: string, text: string) => { written = text },
      log: () => {},
    })
    return { written, result }
  }

  test('it rewrites all seven sites in one pass', () => {
    const { written, result } = apply(fixture())
    expect(result).toEqual(['fixture.js'])
    for (const edit of windowsAclGrantEdits()) {
      expect(written, `${edit.name} applied`).toContain(edit.text)
      expect(written, `${edit.name} marker`).toContain(edit.marker)
      // The gate-import edit INSERTS a line after its anchor, so its anchor is a
      // prefix of its own text and legitimately survives; every other edit
      // replaces its anchor outright.
      if (!edit.text.startsWith(edit.anchor)) {
        expect(written, `${edit.name} anchor consumed`).not.toContain(edit.anchor)
      }
    }
    // The authority stays: the harness's own `grant.add` must still run after the
    // await, or a child that never ran would leave the workspace ungranted.
    // Both indices are asserted present first — `indexOf` answers -1 for a
    // MISSING gate, and -1 satisfies a naive "before" comparison, so the ordering
    // check alone would pass with the gate deleted outright.
    const awaited = written.indexOf('await QIALIKE_ENSURE_ACL_GRANT(workspaceRoot, this.windowsAclRunnerInvocation());')
    const grants = written.indexOf('grant.add(workspaceRoot, true);')
    expect(awaited, 'the awaited gate is in the output').toBeGreaterThan(-1)
    expect(grants, 'and so is the grant it precedes').toBeGreaterThan(-1)
    expect(awaited, 'the await comes first').toBeLessThan(grants)
    // The gate must also keep its own import, or the call names nothing.
    expect(written).toContain('import { ensureAclGrant as QIALIKE_ENSURE_ACL_GRANT }')
  })

  test('a second run is a no-op, so a rebuild cannot double-apply', () => {
    const once = apply(fixture()).written
    const twice = apply(once)
    expect(twice.result, 'nothing written the second time').toEqual([])
    expect(twice.written).toBe(once)
  })

  test('a moved anchor throws rather than shipping a half-patched file', () => {
    // The revision this patch guards against: the harness drops the `async` the
    // gate needs. Break the ANCHOR (the fixture is built from anchors), and the
    // failure must name both the edit and the module to re-check.
    const broken = fixture().replace('\trunnerArgv(runner, policy) {\n', '\trunnerArgv(runner, policy, extra) {\n')
    expect(broken, 'the fixture really was broken').not.toBe(fixture())
    expect(() => apply(broken)).toThrow(/async runnerArgv anchor not found exactly once/)
    expect(() => apply(broken)).toThrow(/windows-acl-grant\.mjs/)
  })

  test('nothing is written when nothing changed', () => {
    let writes = 0
    patchWindowsAclGrant({
      root: '/nonexistent',
      file: 'fixture.js',
      readFile: () => fixture(),
      writeFile: () => { writes += 1 },
      log: () => {},
    })
    // `apply` above writes once because edits applied; here the same input means
    // one write — the guard is that an ALREADY-patched file writes none.
    expect(writes).toBe(1)
    writes = 0
    const patched = apply(fixture()).written
    patchWindowsAclGrant({
      root: '/nonexistent',
      file: 'fixture.js',
      readFile: () => patched,
      writeFile: () => { writes += 1 },
      log: () => {},
    })
    expect(writes, 'an already-patched file is not rewritten').toBe(0)
  })
})

describe('the prewarm call', () => {
  test('the argv is a grant-only run of the embedded runner', () => {
    const argv = aclGrantArgv(['C:\\qialike.exe', '--windows-acl-runner'], 'C:\\work')
    expect(argv.slice(0, 2)).toEqual(['C:\\qialike.exe', '--windows-acl-runner'])
    expect(argv).toContain('--workspace')
    expect(argv[argv.indexOf('--workspace') + 1]).toBe('C:\\work')
    expect(argv[argv.indexOf('--mode') + 1]).toBe('workspace-write')
    // The cheapest command the harness itself pairs with the runner for its win32
    // probe: no output, no dependency on the workspace. The ACEs are applied
    // before the spawn, so this command failing still prewarms the tree.
    expect(argv.slice(-5)).toEqual(['--', 'cmd', '/c', 'exit', '0'])
  })

  test('an unresolvable root keeps its spelling rather than inventing an identity', () => {
    // The write SID derives from the canonical root: a path that cannot be
    // resolved must not be silently replaced with something else, or the prewarm
    // would apply an ACE for an identity the confined command does not carry.
    const missing = join(REPO, 'no-such-directory-9f3a')
    expect(existsSync(missing), 'the fixture path really is absent').toBe(false)
    expect(canonicalWorkspaceRoot(missing)).toBe(missing)
  })

  test('a resolvable root canonicalizes through its links', () => {
    // A symlink must resolve to its target, because that is what the enforcement
    // layer hashes when it derives the write SID. Skipped where a plain user
    // cannot create a symlink (Windows without Developer Mode — the very
    // constraint the junction fix is about).
    test.skipIf(process.platform === 'win32')
    const dir = mkdtempSync(join(tmpdir(), 'acl-grant-canon-'))
    try {
      const real = join(dir, 'real')
      const link = join(dir, 'link')
      mkdirSync(real)
      symlinkSync(real, link, 'dir')
      expect(canonicalWorkspaceRoot(link)).toBe(realpathSync.native(real))
      expect(canonicalWorkspaceRoot(link), 'the link itself is not the answer').not.toBe(link)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('the running interpreter is not its own ACL runner', () => {
    // A source launch runs under bun/node, where the embedded argv would name the
    // interpreter rather than qialike — so the launcher prewarm must decline. The
    // on-demand gate receives the real invocation from the harness and is
    // unaffected, which is why this is only a head start.
    const answered = embeddedRunnerReady()
    if (process.platform !== 'win32') {
      expect(answered, 'off Windows the prewarm never runs at all').toBe(false)
    } else {
      // Whatever the host, the answer is exactly "is execPath a qialike binary".
      expect(answered).toBe(/^qialike(\.exe)?$/i.test(basename(process.execPath)))
    }
  })
})

describe('the launcher wiring', () => {
  test('every farm link goes through linkDirectory, and only it calls symlinkSync', () => {
    // The fix is only as good as its coverage: one `symlinkSync(…, 'dir')` left
    // behind is the EPERM that made an elevated shell mandatory.
    // Count CALL SITES only — the helper's own doc comment quotes the call it
    // replaces, and that mention is not a link.
    const calls = BUILD.split('\n')
      .filter((line) => /symlinkSync\(/.test(line) && !/^\s*(\*|\/\/)/.test(line))
    expect(calls, 'exactly one symlinkSync call — inside linkDirectory').toHaveLength(1)
    const helper = marker(BUILD, 'function linkDirectory(', '\n}\n')
    expect(helper, 'and that one is the helper').toContain('symlinkSync(')
    // And every link site routes through it.
    const sites = BUILD.split('\n')
      .filter((line) => /linkDirectory\(/.test(line) && !/^\s*(\*|\/\/)/.test(line))
    expect(sites.length, 'the helper plus its call sites').toBeGreaterThan(5)
    expect(BUILD, 'no direct dir-symlink site survived').not.toContain("symlinkSync(dir, target, 'dir')")
  })

  test('linkDirectory picks a junction on Windows and a symlink elsewhere', () => {
    const helper = marker(BUILD, 'function linkDirectory(', '\n}\n')
    expect(helper).toContain("process.platform === 'win32' ? 'junction' : 'dir'")
    // POSIX must keep `dir`: a junction is a Windows reparse point, and asking
    // for one elsewhere is not the same link.
    expect(helper, 'junction is Windows-only').toMatch(/'win32'\s*\?\s*'junction'/)
  })

  test('the grant patch is registered AFTER the runner-entry patch it anchors on', () => {
    // Its gate import hangs off the import `patchWindowsAclRunnerEntry` inserts,
    // so the order is a correctness requirement, not a preference.
    const runnerEntry = BUILD.indexOf('\n  patchWindowsAclRunnerEntry()')
    const grant = BUILD.indexOf('\n  patchWindowsAclGrant({')
    expect(runnerEntry, 'the runner-entry call site').toBeGreaterThan(-1)
    expect(grant, 'the grant call site').toBeGreaterThan(-1)
    expect(grant, 'grant after runner entry').toBeGreaterThan(runnerEntry)
    expect(BUILD, 'and the module is imported').toContain("from './harness-patches/windows-acl-grant.mjs'")
  })

  test('the boot prewarm is gated on the one mode that grants anything', () => {
    // `read-only` and `danger-full-access` grant nothing, so prewarming them would
    // mutate the ACL of a tree the session never confines.
    const bin = readFileSync(join(REPO, 'apps', 'tui-bin', 'src', 'bin.ts'), 'utf8')
    expect(bin).toContain('prewarmAclGrant(process.cwd())')
    expect(bin).toContain("prewarmPolicy?.resolve().mode === 'workspace-write'")
    const gate = bin.indexOf("prewarmPolicy?.resolve().mode === 'workspace-write'")
    expect(gate, 'the prewarm sits inside its gate').toBeLessThan(bin.indexOf('prewarmAclGrant(process.cwd())'))
  })
})

describe.skipIf(process.platform === 'win32')('the prewarm off Windows', () => {
  test('both entry points return before spawning anything', async () => {
    // The POSIX contract: Linux and macOS keep their rungs byte for byte, and no
    // child is ever spawned for a path that has no ACLs to grant.
    await expect(ensureAclGrant('C:\\work')).resolves.toBeUndefined()
    expect(() => { prewarmAclGrant('C:\\work') }).not.toThrow()
  })
})
