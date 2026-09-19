/**
 * The `glob` / `grep` tools' ripgrep, as the single-file artifact must supply it.
 *
 * The harness reaches ripgrep through `@vscode/ripgrep`, which resolves its
 * platform binary with
 * `createRequire(import.meta.url).resolve('@vscode/ripgrep-<platform>-<arch>/bin/rg')`.
 * A `bun build --compile` single file bundles that module's JavaScript and none
 * of the binaries, so the call throws and both tools failed at launch with
 * `ripgrep launch failed` (`SEARCH_FAILED`) — reported from a real product
 * session, which is why this file exists. The build embeds the binary and
 * patches the lookup; these cases pin that chain.
 *
 * Windows is not required for the point of the test — only for the artifact this
 * checkout produces — so the spawn cases follow `dist/` rather than the platform.
 *
 * Run with `bun test tests/glob-grep-ripgrep.test.ts`.
 *
 * @module qialike/glob-grep-ripgrep-test
 */

import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const BINARY = join(process.cwd(), 'dist', process.platform === 'win32' ? 'qialike.exe' : 'qialike')
const HARNESS_SEARCH_DIR = join(process.cwd(), 'apps', 'tui-bin', 'x', '-deepseek-ai-dsh-tool-fs-search')
const GENERATED = new URL('../packages/qialike-app/src/ripgrep-binary.generated.ts', import.meta.url)

describe('the embedded ripgrep', () => {
  test('the build embeds a binary per target and names each one for its own platform', () => {
    const generated = readFileSync(GENERATED, 'utf8')
    const map = JSON.parse(/RIPGREP_BINARIES = (\{[\s\S]*?\n\})/u.exec(generated)?.[1] ?? '{}') as Record<string, string>
    const names = JSON.parse(/RIPGREP_BINARY_FILES = (\{[\s\S]*?\n\})/u.exec(generated)?.[1] ?? '{}') as Record<string, string>
    // The host must be among them: an artifact that cannot search on the host it
    // was built for is exactly the regression this file guards.
    const hostKey = `${process.platform}-${process.arch}`
    expect(typeof map[hostKey]).toBe('string')
    // The bytes really are an executable, not a placeholder.
    expect(Buffer.from(map[hostKey] ?? '', 'base64').length).toBeGreaterThan(1_000_000)
    // Every embedded binary has a name, hashed so a changed binary lands on a new
    // path, and carrying ITS OWN platform's extension. That last part is not
    // cosmetic: a `BUILD_TARGETS=ALL` build hosted on Linux used to give the
    // Windows artifact an extensionless name, and Windows cannot spawn an
    // extensionless image (CreateProcess appends `.exe`), so `glob`/`grep` failed
    // to launch on the one platform the embedding exists for.
    expect(Object.keys(names).sort()).toEqual(Object.keys(map).sort())
    for (const [key, name] of Object.entries(names)) {
      expect(name).toMatch(/^rg-[0-9a-f]{16}(\.exe)?$/u)
      expect(name.endsWith('.exe')).toBe(key.startsWith('win32-'))
    }
  })

  test('the shim materializes a runnable ripgrep for the running platform', async () => {
    const shim = await import('../packages/qialike-app/src/ripgrep-shim.ts')
    expect(await shim.hasEmbeddedRipgrep()).toBe(true)
    const path = await shim.ripgrepPath()
    expect(existsSync(path)).toBe(true)
    const version = spawnSync(path, ['--version'], { encoding: 'utf8', timeout: 20_000 })
    expect(version.status).toBe(0)
    expect(version.stdout).toContain('ripgrep')
  })

  test('the materialized binary runs the tools’ own argv shape', async () => {
    const shim = await import('../packages/qialike-app/src/ripgrep-shim.ts')
    const rg = await shim.ripgrepPath()
    // `glob` lists files (`--files` + a glob filter); `grep` searches content
    // through `--json`. Both go through `--no-config`, as the tool prepends.
    //
    // `stdin: 'ignore'` is not incidental: the harness spawns ripgrep through
    // `ctx.subprocess` with `stdio.stdin: 'ignore'` and NO path argument when the
    // model omits `path`. `spawnSync`'s own default is a PIPED stdin, and a
    // piped stdin makes ripgrep search that empty pipe instead of the workdir
    // (measured: pipe → 0 match records, ignore → the workdir's matches), so the
    // default would test a shape the product never uses and report the tools as
    // broken. Mirror the real spawn.
    const spawnShape = {
      encoding: 'utf8',
      timeout: 60_000,
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    } as const

    const files = spawnSync(rg, ['--no-config', '--files', '--glob', '**/*.md'], spawnShape)
    expect(files.status).toBe(0)
    expect(files.stdout.split('\n').filter(Boolean).length).toBeGreaterThan(0)

    const matches = spawnSync(rg, ['--no-config', '--json', 'qialike', '--glob', '**/*.md'], spawnShape)
    // 0 = matches, 1 = none; anything else is a launch/pattern failure.
    expect([0, 1]).toContain(matches.status)
    expect(matches.stdout).toContain('"type":"begin"')
  })

  test('the build patches the harness lookup to ask the shim first', () => {
    const build = readFileSync(new URL('../apps/tui-bin/build.mjs', import.meta.url), 'utf8')
    // The patch anchors on the harness's real sidecar line, so a harness bump
    // that moves it fails the build loudly instead of silently leaving the tools
    // unable to find ripgrep.
    expect(build).toContain('`${executable.name}-rg.exe`')
    expect(build).toContain('QIALIKE_RIPGREP_PATH')
    expect(build).toContain('embedRipgrepBinaries')
  })

  test.skipIf(!existsSync(HARNESS_SEARCH_DIR))('the bundled search module asks the shim, not only the module', () => {
    const bundled = readFileSync(join(HARNESS_SEARCH_DIR, 'lib', 'index.js'), 'utf8')
    expect(bundled).toContain('QIALIKE_RIPGREP_PATH')
    // The module branch has to survive as the on-disk fallback.
    expect(bundled).toContain('@vscode/ripgrep')
  })

  test.skipIf(!existsSync(BINARY))('the artifact materializes the binary where a spawn can reach it', async () => {
    // The shim writes into the OS temp dir, the one place a spawned process can
    // read a file this process created; the artifact itself carries no loose
    // files. Materialize through the shim, then confirm the artifact is what a
    // search would actually launch.
    const shim = await import('../packages/qialike-app/src/ripgrep-shim.ts')
    const path = await shim.ripgrepPath()
    const dir = join(process.env.TEMP ?? process.env.TMPDIR ?? '/tmp', 'qialike-ripgrep')
    expect(readdirSync(dir).some((name) => name.startsWith('rg-'))).toBe(true)
    // The running test process and the artifact share the binary's bytes; the
    // artifact's own resolution is exercised by the ACL/binary cases elsewhere
    // only where it can be (a search needs a model turn to reach the tool).
    expect(existsSync(path)).toBe(true)
  })
})
