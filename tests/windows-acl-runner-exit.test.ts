/**
 * The embedded Windows ACL runner must be allowed to finish.
 *
 * The harness's ACL runner calls its own `main()` at module scope, but that
 * `main` is ASYNC: it awaits `child.wait()` for the confined command and settles
 * `process.exitCode` only through its own `.then` afterwards. The launcher
 * therefore cannot wait a fixed number of turns and exit with what it sees —
 * measured with a minimal reproduction of the same module shape, that reported
 * **exit 0 with the command never run**: the harness classifies a runner failure
 * by exit 127 plus a `windows-acl-run:` line and a denial by its own signatures,
 * so exit 0 reads as a SUCCESSFUL shell command with empty output. A silent false
 * success on a security path.
 *
 * The fix is a contract, and this file pins it:
 *  - the shim returns a code ONLY for a launcher-level failure (`undefined`
 *    otherwise), never force-exits, and never waits a fixed turn;
 *  - its pessimistic default is the runner-failure code, so a runner that never
 *    settles still fails closed;
 *  - `main.ts` forces an exit only when that failure code came back.
 *
 * Run with `bun test tests/windows-acl-runner-exit.test.ts`.
 *
 * @module qialike/windows-acl-runner-exit-test
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const shim = readFileSync(join(process.cwd(), 'apps/tui-bin/src/windows-acl-shim.ts'), 'utf8')
const main = readFileSync(join(process.cwd(), 'apps/tui-bin/src/main.ts'), 'utf8')

describe('the ACL runner launcher never cuts its own child short', () => {
  test('the shim neither force-exits nor waits a fixed number of event-loop turns', () => {
    // `setImmediate` was the exact defect: one macrotask is not `await child.wait()`.
    expect(shim).not.toContain('setImmediate')
    // The shim settles `process.exitCode`; only the LAUNCHER's failures are forced.
    expect(shim).not.toContain('process.exit(')
    expect(shim).toContain('return undefined')
  })

  test('main.ts forces an exit only when the launcher itself failed', () => {
    expect(main).toContain('const failure = await runWindowsAclRunner()')
    expect(main).toContain('if (failure !== undefined) process.exit(failure)')
    expect(main).not.toContain('process.exit(await runWindowsAclRunner())')
  })

  test('the pessimistic default is the runner-failure code, not success', () => {
    // A runner that never settles must look like a broken runner, not a command
    // that succeeded silently.
    expect(shim).toContain('process.exitCode = RUNNER_FAILURE_EXIT')
    expect(shim).not.toContain('process.exitCode = 0')
  })
})
