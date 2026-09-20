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
// Bun appends `.exe` to `--compile --target bun` output on Windows, so the
// single-file target lands as `qialike.exe` there (the same rule the build's
// own `targetBinaryPath()` encodes for the named targets).
const bin = join(ROOT, 'dist', process.platform === 'win32' ? 'qialike.exe' : 'qialike')

function run() {
  if (!existsSync(bin)) {
    throw new Error(`missing ${bin}; run \`pnpm run build\` first`)
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
