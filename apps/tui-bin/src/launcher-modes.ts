/**
 * The positional modes the LAUNCHER owns — resolved by `bin.ts` before the app
 * owns the command line, as opposed to `resume`, which the TUI command
 * definition parses like any other mode.
 *
 * They are positionals in argv (`qialike web …`), so the thin entry
 * (`main.ts`) must hand the whole line over BEFORE it validates the positional:
 *
 *  - {@link WEB_MODE} forwards the remaining arguments to the installed `dsh`
 *    CLI, so it takes options the TUI command definition does not declare
 *    (`--host`, `--no-open`) — parsing would reject those first.
 *  - {@link UNINSTALL_MODE} ignores the rest of the line by design and clears
 *    the harness home plus the shell-profile PATH line.
 *
 * This list is the single source of truth for both entry points because the two
 * used to drift: F5 (`v0.4.9-beta`) validated the positional against `resume`
 * alone and thereby rejected both launcher commands (`qialike web` read like a
 * typo). Keeping one list — and a regression assertion per mode in the pty
 * suite's `cli-errors` scenario — is what makes that failure mode impossible to
 * reintroduce silently.
 *
 * @module @yourname/qialike/launcher-modes
 */

/** Clears the harness home (`$DSH_HOME`) and the PATH line the install added. */
export const UNINSTALL_MODE = 'uninstall'
/** Hands over to the installed `dsh` CLI's web server. */
export const WEB_MODE = 'web'
/** Inspects / edits the overlay layers; never boots the TUI. */
export const PLUGIN_MODE = 'plugin'

/** Every launcher-owned positional mode, in the order `bin.ts` resolves them. */
export const LAUNCHER_MODES = [UNINSTALL_MODE, WEB_MODE, PLUGIN_MODE] as const

/** Whether `arg` is a launcher mode, i.e. its whole argv belongs to `bin.ts`. */
export function isLauncherMode(arg: string | undefined): arg is (typeof LAUNCHER_MODES)[number] {
  return arg !== undefined && (LAUNCHER_MODES as readonly string[]).includes(arg)
}

/**
 * The reserved arguments of the embedded **Landlock launcher**.
 *
 * These are not qialike commands: they are the CLI contract of
 * `@deepseek-ai/node-addon-system/landlock-run`, which the harness's
 * `dsh-sandbox-local` builds as `[launcherPath(), ...grantArgs, '--', argv]`.
 * Because the single-file binary cannot carry the real C launcher, qialike
 * serves as its own: `stub/landlock-run.js` points `launcherPath()` at this
 * executable, and `main.ts` re-enters `landlock-shim.ts` on exactly this shape.
 *
 * They are checked by first argument only, and before the TUI owns the command
 * line, because commander would otherwise reject them as unknown flags.
 */
export const LANDLOCK_LAUNCHER_FLAGS = ['--probe', '--ro', '--rw'] as const

/**
 * Whether this argv belongs to the embedded Landlock launcher rather than the
 * TUI. Reserved: qialike declares no command or option with these spellings.
 * @param args - `process.argv.slice(2)`.
 * @returns whether `args[0]` is a reserved launcher flag.
 */
export function isLandlockLauncherArgv(args: readonly string[]): boolean {
  return args[0] !== undefined && (LANDLOCK_LAUNCHER_FLAGS as readonly string[]).includes(args[0])
}
