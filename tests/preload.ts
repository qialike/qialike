/**
 * Unit-suite preload (see `bunfig.toml`): pin the terminal colour depth to
 * 24-bit so tests assert the AUTHORED palette, not a 256-colour quantization of
 * it. Without this the suite's result would depend on the developer's `TERM` /
 * `COLORTERM` (`packages/qialike-app/src/color-depth.ts` reads them).
 *
 * The quantization itself is tested directly (`tests/color-depth.test.ts`) by
 * calling `quantizePalette(palette, 2)` and `colorLevel({...})` with explicit
 * values, so pinning here costs no coverage.
 *
 * It also points the bare `koffi` specifier at the bundled shim
 * (`apps/tui-bin/stub/koffi.js`) for the whole suite — see
 * {@link installKoffiShim}, and `tests/windows-acl.test.ts` for what depends on
 * it.
 *
 * @module qialike/tests-preload
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TESTS = dirname(fileURLToPath(import.meta.url))

/**
 * Install the shim at `<root>/node_modules/koffi`, which is exactly where the
 * single-file build puts it (`installKoffiShim` in `apps/tui-bin/build.mjs`).
 *
 * A `Bun.plugin` `onResolve` hook is NOT an option: Bun routes a bare specifier
 * through the package resolver without consulting the hook, so an override there
 * is silently ignored. `tests/windows-acl.test.ts` imports the harness's Win32
 * modules to prove the ACL rung works against the shim, and without this they
 * would load whatever `node_modules/koffi` happens to be — a build artifact that
 * may be the no-op stub.
 */
function installKoffiShim(): void {
  const target = join(TESTS, '..', 'node_modules', 'koffi')
  try {
    mkdirSync(target, { recursive: true })
    writeFileSync(
      join(target, 'package.json'),
      JSON.stringify({ name: 'koffi', type: 'module', main: 'index.js' }, null, 2),
    )
    writeFileSync(join(target, 'index.js'), readFileSync(join(TESTS, '..', 'apps', 'tui-bin', 'stub', 'koffi.js'), 'utf8'))
  } catch (error) {
    // A read-only checkout cannot take the shim, so the Win32 module imports this
    // suite makes would silently reach the native koffi instead. Say so plainly.
    throw new Error(
      `qialike tests: cannot install the koffi shim at ${target} (${error instanceof Error ? error.message : String(error)})`,
    )
  }
}

installKoffiShim()

process.env.QIALIKE_COLOR = '24bit'
