/**
 * Smoke test: run the compiled single-file binary and assert that the full
 * dsh-base + dsh-tui-app composition boots and the TUI command parses.
 *
 * This is the REAL-composition guard the package rules require for a
 * product-visible plugin: it does not hand-build a `ctx.plugin(...)`; it boots
 * the actual tree through the Loader inside the packaged binary. Interactive
 * token streaming needs a TTY + a provider key, so the keyless assertion stops
 * at the booted command surface (`--help`).
 *
 * @module dsh-tui/smoke
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const bin = join(ROOT, 'dist/dsh-tui')

function run() {
  if (!existsSync(bin)) {
    throw new Error(`missing ${bin}; run \`pnpm run build\` first`)
  }
  const result = spawnSync(bin, ['--help'], { encoding: 'utf8', timeout: 30_000 })
  if (result.status !== 0) {
    throw new Error(`dsh-tui --help exited ${String(result.status)}:\n${result.stderr || result.stdout}`)
  }
  const output = `${result.stdout}\n${result.stderr}`
  if (!output.includes('Usage: dsh --profile tui')) {
    throw new Error(`unexpected output:\n${output}`)
  }
  console.log('smoke: dsh-tui composition boots and parses the TUI command')
}

run()
