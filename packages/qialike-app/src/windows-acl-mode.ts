/**
 * The reserved flag of qialike's embedded Windows ACL runner.
 *
 * The harness's `dsh-sandbox-local` confines PowerShell by spawning a runner
 * process. In a single-file binary it cannot locate that runner by specifier, so
 * the build points the win32 rung at qialike itself and this flag selects the
 * embedded copy (see `apps/tui-bin/build.mjs` and `windows-acl-shim.ts`).
 *
 * It lives in the app package because that is the one module surface BOTH the
 * launcher entry (`apps/tui-bin/src/main.ts`) and the build-injected patch of the
 * bundled harness package can import by name.
 *
 * @module @yourname/qialike-app/windows-acl-mode
 */

/** The reserved first argument that runs the embedded ACL runner instead of the TUI. */
export const WINDOWS_ACL_RUNNER_FLAG = '--windows-acl-runner'

/**
 * Whether this argv belongs to the embedded Windows ACL runner rather than the
 * TUI. Checked by first argument only, and before the TUI owns the command line:
 * the runner's own flags (`--temp`, `--mode`) are not TUI options, so commander
 * would reject them.
 * @param args - `process.argv.slice(2)`.
 * @returns whether `args[0]` is the reserved ACL-runner flag.
 */
export function isWindowsAclRunnerArgv(args: readonly string[]): boolean {
  return args[0] === WINDOWS_ACL_RUNNER_FLAG
}
