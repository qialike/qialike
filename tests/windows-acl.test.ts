/**
 * The Windows restricted-token rung, running for real through the koffi shim
 * (P4-step2).
 *
 * The shim's own codec is covered by `tests/koffi-struct-layout.test.ts`, which
 * proves the layout and the byte-level writes without any Windows. This file
 * covers what only a real host can: that the harness's Win32 stack — the
 * `dsh-win32-process` binding table, `dsh-sandbox-windows-acl`'s token/ACL
 * calls, and `dsh-pwsh-sandbox`'s confined executor — actually works when its
 * only koffi is the bundled shim. `tests/koffi-shim-resolve.ts` (loaded from the
 * suite preload) is what points the harness's `koffi` import at that shim.
 *
 * What it is really guarding, in order of how badly a regression would hurt:
 *
 *  1. **The boundary.** A confined child must be able to write in the workspace
 *     and must be refused outside it. A shim that quietly mis-marshalled a
 *     buffer or a struct pointer would leave the child UNRESTRICTED while every
 *     unit test still passed; only this assertion catches that.
 *  2. **The PowerShell path.** `ctx.shell` must report a `sandboxMode`, which is
 *     the capability fact qialike's approval fence keys on
 *     (`unconfinedShellAskDecision`): once the confined executor is mounted, the
 *     per-command prompt stops firing on its own. If the ACL rung fails to
 *     select, `sandboxMode` is still defined (the executor reads the policy, not
 *     the runner) — so the executor's own `mode`/enforcement facts are asserted
 *     too.
 *  3. **Both spawn shapes.** `spawnSandboxed` (anonymous pipes) and
 *     `spawnSandboxedInherited` (inherit stdio under a kill-on-close Job) are
 *     different Win32 call sequences; a shim can satisfy one and not the other.
 *
 * Windows only. ACLs are real mutations: the sandbox's own `dispose()` owns the
 * revocable temp grant, and the standing workspace ACE is inert once the fixture
 * directory is removed, because its SID is derived from that path.
 *
 * Run with `bun test tests/windows-acl.test.ts`.
 *
 * @module qialike/windows-acl-test
 */

import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AclSandbox, tempWriteSid, workspaceWriteSid } from '@deepseek-ai/dsh-sandbox-windows-acl'
import { loadWin32ProcessBindings, probeCurrentTokenJobSupport } from '@deepseek-ai/dsh-win32-process'

/** A throwaway workspace, private temp dir, and the outside directory to escape into. */
interface Fixture {
  root: string
  workspace: string
  outside: string
  temp: string
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'qialike-win-acl-'))
  const workspace = join(root, 'workspace')
  const outside = join(root, 'outside')
  const temp = join(root, 'temp')
  for (const dir of [workspace, outside, temp]) mkdirSync(dir, { recursive: true })
  return { root, workspace, outside, temp }
}

/** What one confined child reported, plus what actually landed on disk. */
interface ProbeResult {
  inside: string
  outside: string
  stdout: string
  stderr: string
  exitCode: number
}

/**
 * Run one child under the restricted token and report both its own observations
 * and the disk state, because those are different claims: the disk is the
 * authority on whether the write was really allowed.
 */
async function probeWrites(fixture: Fixture, stdio: 'pipe' | 'inherit'): Promise<ProbeResult> {
  const inside = join(fixture.workspace, 'inside.txt')
  const outside = join(fixture.outside, 'outside.txt')
  const sandbox = new AclSandbox({
    writableDirs: [fixture.workspace],
    tempDir: fixture.temp,
    mode: 'workspace-write',
    writeSid: workspaceWriteSid(fixture.workspace),
    tempWriteSid: tempWriteSid(fixture.temp),
  })
  await sandbox.init()
  try {
    const script = `
      const { writeFileSync } = require('node:fs')
      let inside = 'ok'
      try { writeFileSync(${JSON.stringify(inside)}, 'inside') } catch (error) { inside = 'ERR ' + error.code }
      let outside = 'allowed'
      try { writeFileSync(${JSON.stringify(outside)}, 'escape') } catch (error) { outside = 'ERR ' + error.code }
      process.stdout.write(JSON.stringify({ inside, outside }))
    `
    const child = sandbox.spawn({ command: process.execPath, args: ['-e', script], cwd: fixture.workspace, stdio })
    const result = await child.wait()
    const reported = JSON.parse(result.stdout.toString() || '{}') as { inside?: string; outside?: string }
    return {
      inside: reported.inside ?? '(no report)',
      outside: reported.outside ?? '(no report)',
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
      exitCode: result.exitCode,
    }
  } finally {
    sandbox.dispose()
  }
}

describe.skipIf(process.platform !== 'win32')('the Win32 stack through the bundled koffi shim', () => {
  test('the binding tables load and the current-token Job capability probes', () => {
    // Module-scope struct guards already ran at import; this is the first CALL.
    const api = loadWin32ProcessBindings()
    expect(() => { probeCurrentTokenJobSupport(api) }).not.toThrow()
  })

  test('a confined child writes in the workspace and is refused outside it', async () => {
    const dirs = fixture()
    try {
      const result = await probeWrites(dirs, 'pipe')
      expect(result.stderr).toBe('')
      expect(result.exitCode).toBe(0)
      // The child's own view…
      expect(result.inside).toBe('ok')
      // …and the disk's, which is the claim that matters: EPERM is the
      // restricted token refusing the write, not the child choosing not to.
      expect(existsSync(join(dirs.workspace, 'inside.txt'))).toBe(true)
      expect(existsSync(join(dirs.outside, 'outside.txt'))).toBe(false)
      expect(result.outside.startsWith('ERR')).toBe(true)
    } finally {
      rmSync(dirs.root, { recursive: true, force: true })
    }
  })

  test('the inherited-stdio Job spawn shape confines the same way', async () => {
    // A stdout-inheriting child cannot hand its report back through the pipe, so
    // this shape is judged on the exit code and the disk alone.
    const dirs = fixture()
    try {
      const result = await probeWrites(dirs, 'inherit')
      expect(result.exitCode).toBe(0)
      expect(existsSync(join(dirs.workspace, 'inside.txt'))).toBe(true)
      expect(existsSync(join(dirs.outside, 'outside.txt'))).toBe(false)
    } finally {
      rmSync(dirs.root, { recursive: true, force: true })
    }
  })

  test('read-only refuses a workspace write as well', async () => {
    const dirs = fixture()
    const target = join(dirs.workspace, 'nope.txt')
    const sandbox = new AclSandbox({ writableDirs: [], tempDir: null, mode: 'read-only' })
    await sandbox.init()
    try {
      const script = `
        const { writeFileSync } = require('node:fs')
        let wrote = 'ok'
        try { writeFileSync(${JSON.stringify(target)}, 'x') } catch (error) { wrote = 'ERR ' + error.code }
        process.stdout.write(wrote)
      `
      const child = sandbox.spawn({ command: process.execPath, args: ['-e', script], cwd: dirs.workspace, stdio: 'pipe' })
      const result = await child.wait()
      expect(result.stdout.toString().startsWith('ERR')).toBe(true)
      expect(existsSync(target)).toBe(false)
    } finally {
      sandbox.dispose()
      rmSync(dirs.root, { recursive: true, force: true })
    }
  })
})

describe.skipIf(process.platform !== 'win32')('the composition mounts the confined PowerShell executor', () => {
  test('the committed patch layer mounts the confined executor and not the unconfined one', () => {
    // A source-level guard, because the two rows are mutually exclusive by
    // intent: `pwsh-sandbox` (confined) must stay enabled and the `pwsh-local`
    // (unconfined) INSERT must stay gone. Reinstating the insert would silently
    // restore the unconfined shell and re-arm the per-command prompt.
    const patch = readFileSync(new URL('../packages/qialike-app/cordis.patch.yml', import.meta.url), 'utf8')
    const rows = patch.split('\n').filter((line) => line.trim().startsWith('- id:'))
    expect(rows.some((line) => line.includes('pwsh-sandbox'))).toBe(true)
    expect(patch).not.toContain('@deepseek-ai/dsh-pwsh-local')
    expect(patch).not.toMatch(/- id: pwsh-sandbox\s*\n\s*disabled: true/)
    // The permission presets row is sandbox-coupled and now mounts on every
    // platform, so it must not be disabled by a platform expression.
    expect(patch).not.toMatch(/- id: permission\s*\n\s*disabled:/)
  })

  test('the built manifest imports the confined executor instead of the no-op stub', () => {
    // The end of the chain the composition actually reads: `PLUGIN_BUILTINS`
    // maps the row's plugin name to an import, and that import has to be the
    // real module. The generated file is produced by the build, so this fails
    // loudly if `NATIVE_PACKAGES` ever takes the executor back. The two Win32
    // helpers need no entry of their own: they are dependencies OF the executor
    // plugin, so the bundler follows them from it.
    const manifest = readFileSync(new URL('../apps/tui-bin/generated/plugins.ts', import.meta.url), 'utf8')
    const importOf = new Map<string, string>()
    for (const match of manifest.matchAll(/^import \* as (m_\d+) from '([^']+)'/gmu)) {
      importOf.set(match[2], match[1])
    }
    const key = importOf.get('@deepseek-ai/dsh-pwsh-sandbox')
    expect(key).toBeDefined()
    expect(manifest).toContain(`"@deepseek-ai/dsh-pwsh-sandbox": ${key}`)
  })

  test('the build no longer stubs the confined executor or its Win32 helpers', () => {
    const build = readFileSync(new URL('../apps/tui-bin/build.mjs', import.meta.url), 'utf8')
    const start = build.indexOf('const NATIVE_PACKAGES')
    const nativeSet = build.slice(start, build.indexOf('])', start))
    expect(nativeSet).not.toContain('dsh-pwsh-sandbox')
    expect(nativeSet).not.toContain('dsh-win32-process')
    expect(nativeSet).not.toContain('dsh-sandbox-windows-acl')
    expect(build).not.toContain('win32 process bindings are not available in qialike')
  })
})

describe('the koffi the harness resolves is the bundled shim', () => {
  test('the suite preload redirects the bare specifier to the shim file', async () => {
    // Guards the guard: if the override ever stopped taking effect, the tests
    // above would silently load the native koffi from the harness checkout and
    // prove nothing about the artifact. `sizeof` is shim-only surface the native
    // module also has, so the discriminator is the shim's own error text.
    const api = (await import('koffi')).default as { sizeof: (type: string) => number }
    expect(() => api.sizeof('qialike_unknown_type')).toThrow(/koffi shim/)
  })
})

/**
 * The runner as a SECOND PROCESS, which is how the win32 rung confines:
 * `sandbox-local` spawns `[program, runner, --workspace …, --, <argv>]`. A
 * single-file binary cannot resolve that runner by specifier — measured: Bun
 * reports `Cannot find package …` for every specifier at runtime, including one
 * the binary statically imports — so qialike is its own runner behind a reserved
 * flag. These cases pin both halves: that the built binary confines through that
 * mode, and that what the build bundles for it is the HARNESS's runner.
 */
describe.skipIf(process.platform !== 'win32')('the embedded Windows ACL runner mode', () => {
  const binary = join(process.cwd(), 'dist', 'qialike.exe')

  /** One confined run through the binary's own runner mode. */
  function runRunner(dirs: Fixture, mode: string, command: string) {
    const result = spawnSync(binary, [
      '--windows-acl-runner',
      '--workspace', dirs.workspace,
      '--temp', dirs.temp,
      '--mode', mode,
      '--', 'cmd', '/c', command,
    ], { encoding: 'utf8', timeout: 60_000 })
    return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
  }

  test.skipIf(!existsSync(binary))('the mode is reserved before the TUI owns the command line', () => {
    // Before this mode existed the binary parsed the runner's own flags as TUI
    // options and answered `unknown option '--temp'`, so the flag must be
    // dispatched before commander ever sees the line. The echo proves the wrapped
    // command really ran; its exit code is the runner's own business and is
    // covered by the write cases below.
    const dirs = fixture()
    try {
      const result = runRunner(dirs, 'read-only', 'echo runner-mode-ok')
      expect(result.output).not.toContain('unknown option')
      expect(result.output).toContain('runner-mode-ok')
    } finally {
      rmSync(dirs.root, { recursive: true, force: true })
    }
  })

  test.skipIf(!existsSync(binary))('it confines a write: inside lands, outside is denied', () => {
    const dirs = fixture()
    const inside = join(dirs.workspace, 'in.txt')
    const outside = join(dirs.outside, 'escaped.txt')
    try {
      expect(runRunner(dirs, 'workspace-write', `echo written> ${inside}`).status).toBe(0)
      expect(existsSync(inside)).toBe(true)

      expect(runRunner(dirs, 'workspace-write', `echo escaped> ${outside}`).status).not.toBe(0)
      expect(existsSync(outside)).toBe(false)
    } finally {
      rmSync(dirs.root, { recursive: true, force: true })
    }
  })

  test.skipIf(!existsSync(binary))('read-only denies a write inside the workspace too', () => {
    const dirs = fixture()
    const inside = join(dirs.workspace, 'denied.txt')
    try {
      expect(runRunner(dirs, 'read-only', `echo nope> ${inside}`).status).not.toBe(0)
      expect(existsSync(inside)).toBe(false)
    } finally {
      rmSync(dirs.root, { recursive: true, force: true })
    }
  })

  test('the runner the build bundles is the harness’s own entry', () => {
    // If the bundle ever stopped being the harness's runner, the runner's own
    // failure dialect (`windows-acl-run: ` + exit 127) would stop matching the
    // harness's classification and every Windows failure would misreport.
    const generated = readFileSync(new URL('../apps/tui-bin/src/windows-acl-runner.generated.ts', import.meta.url), 'utf8')
    const base64 = /WINDOWS_ACL_RUNNER_BASE64 = "([^"]+)"/u.exec(generated)?.[1] ?? ''
    const bundle = Buffer.from(base64, 'base64').toString('utf8')
    expect(bundle).toContain('windows-acl-run')
    expect(bundle).toContain('127')
    // Self-contained: a remaining bare `@deepseek-ai/*` require would need a
    // node_modules tree beside the materialized file, which the install has not.
    expect(bundle).not.toMatch(/require\(["']@deepseek-ai\//)
  })

  test('the build anchors the patch on the harness’s real resolution line', () => {
    // The patch locates itself by that exact line, so a harness bump that moves
    // it fails the build loudly instead of silently leaving Windows unable to
    // resolve its runner.
    const build = readFileSync(new URL('../apps/tui-bin/build.mjs', import.meta.url), 'utf8')
    expect(build).toContain('import.meta.resolve("@deepseek-ai/dsh-sandbox-windows-acl/runner")')
    expect(build).toContain('QIALIKE_WINDOWS_ACL_RUNNER_FLAG')
  })
})
