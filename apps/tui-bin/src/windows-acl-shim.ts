/**
 * qialike — the Windows ACL runner shim.
 *
 * The DeepSeek Harness confines PowerShell through
 * `@deepseek-ai/dsh-sandbox-windows-acl/lib/runner.js`, which
 * `dsh-sandbox-local` spawns as a SECOND PROCESS and locates with
 * `import.meta.resolve('@deepseek-ai/dsh-sandbox-windows-acl/runner')`. A
 * `bun build --compile` single file cannot answer that call — Bun reports
 * `Cannot find package …` for any specifier there, even one the same binary
 * statically imports — so `confine()` threw before spawning anything and every
 * Windows shell call failed with a package-resolution error instead of running.
 *
 * This module is the replacement launcher: the build re-bundles the harness's
 * runner into a self-contained `.cjs` (koffi shim included) and points
 * `sandbox-local` at `[this executable, --windows-acl-runner]`. The shim's only
 * job is to materialize that bundle and load it IN THIS PROCESS. The runner owns
 * its whole command line afterwards — its `--workspace` / `--temp` / `--mode`
 * parsing, its `windows-acl-run:` failure dialect, and its exit-code mirroring —
 * so running it unchanged is what keeps that contract from drifting.
 *
 * @module @yourname/qialike/windows-acl-shim
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WINDOWS_ACL_RUNNER_FILE, WINDOWS_ACL_RUNNER_BASE64 } from './windows-acl-runner.generated.ts'
import { WINDOWS_ACL_RUNNER_FLAG } from '@yourname/qialike-app/src/windows-acl-mode.ts'

export { WINDOWS_ACL_RUNNER_FLAG }

/** Subdirectory of the OS temp dir holding the materialized runner. */
const RUNNER_DIR = 'qialike-windows-acl-runner'

/** The runner's exit code for every runner-level failure, per its own contract. */
const RUNNER_FAILURE_EXIT = 127

/**
 * Materialize the bundled runner and return its path.
 *
 * The file name carries the bundle's content hash, so a rebuilt binary lands a
 * new file instead of racing an older one, and the write is idempotent across
 * concurrent calls (last writer wins with identical bytes).
 * @returns the runner's absolute path.
 */
function materializeRunner(): string {
  const dir = join(tmpdir(), RUNNER_DIR)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, WINDOWS_ACL_RUNNER_FILE)
  if (!existsSync(file)) writeFileSync(file, Buffer.from(WINDOWS_ACL_RUNNER_BASE64, 'base64'), { mode: 0o600 })
  return file
}

/**
 * Run one Windows ACL runner invocation in this process.
 *
 * The bundle executes its own `main()` when loaded and settles
 * `process.exitCode`; this waits for the module graph and one event-loop turn so
 * that code is in place before the entry returns and exits with it.
 * @returns the exit code the launcher should settle with.
 */
export async function runWindowsAclRunner(): Promise<number> {
  let file: string
  try {
    file = materializeRunner()
  } catch (error) {
    process.stderr.write(`windows-acl-run: cannot materialize the embedded runner: ${
      error instanceof Error ? error.message : String(error)}\n`)
    return RUNNER_FAILURE_EXIT
  }
  process.exitCode = 0
  try {
    // The `.cjs` extension keeps the bundle CommonJS: it is a re-bundled copy of
    // the harness's own runner, not part of this module graph.
    require(file)
  } catch (error) {
    process.stderr.write(`windows-acl-run: ${error instanceof Error ? error.message : String(error)}\n`)
    return RUNNER_FAILURE_EXIT
  }
  await new Promise<void>((resolve) => { setImmediate(resolve) })
  return process.exitCode ?? 0
}
