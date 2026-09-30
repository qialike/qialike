/**
 * Smoke test: run the compiled single-file binary and assert that the full
 * dsh-base + qialike-app composition boots and the TUI command parses.
 *
 * This is the REAL-composition guard the package rules require for a
 * product-visible plugin: it does not hand-build a `ctx.plugin(...)`; it boots
 * the actual tree through the Loader inside the packaged binary. Interactive
 * token streaming needs a TTY + a provider key, so the keyless assertion stops
 * at the booted command surface (`--help`).
 *
 * @module qialike/smoke
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** The build's host target directory name (`dist/<os>-<arch>/`). */
function hostTarget() {
  const os = process.platform === 'linux'
    ? 'linux'
    : process.platform === 'darwin'
      ? 'darwin'
      : process.platform === 'win32'
        ? 'windows'
        : 'unknown'
  const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : 'unknown'
  return `${os}-${arch}`
}

/**
 * The binary under test, resolved the way the release scripts resolve it:
 * `$QIALIKE_BIN` first, then `dist/qialike[.exe]` (a `--single` build), then
 * `dist/<os>-<arch>/qialike[.exe]`.
 *
 * The last one is not a nicety: the default `BUILD_TARGETS=ALL` build writes the
 * host binary into `dist/<os>-<arch>/` and **never** creates `dist/qialike`, so a
 * hardcoded `dist/qialike` (what this file used to do) failed every release build
 * with "missing …/dist/qialike" while the binary was sitting right next to it.
 * Bun also appends `.exe` to `--compile --target bun` output on Windows, the same
 * rule the build's own `targetBinaryPath()` encodes for the named targets.
 */
function resolveBin() {
  if (process.env.QIALIKE_BIN) return process.env.QIALIKE_BIN
  const exe = process.platform === 'win32' ? 'qialike.exe' : 'qialike'
  const single = join(ROOT, 'dist', exe)
  if (existsSync(single)) return single
  return join(ROOT, 'dist', hostTarget(), exe)
}

const bin = resolveBin()

function run() {
  if (!existsSync(bin)) {
    throw new Error(`missing ${bin}; build it first: bash scripts/release/build-qialike.sh <version>`)
  }
  // No background work: the smoke test must not have the binary reach out for an
  // update check, let alone replace itself mid-test.
  const result = spawnSync(bin, ['--help'], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, QIALIKE_DISABLE_AUTOUPDATE: '1' },
  })
  if (result.status !== 0) {
    throw new Error(`qialike --help exited ${String(result.status)}:\n${result.stderr || result.stdout}`)
  }
  const output = `${result.stdout}\n${result.stderr}`
  if (!output.includes('Usage: dsh --profile tui')) {
    throw new Error(`unexpected output:\n${output}`)
  }
  console.log('smoke: qialike composition boots and parses the TUI command')
}

run()
