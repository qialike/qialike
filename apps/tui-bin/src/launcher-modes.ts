/**
 * The positional modes the LAUNCHER owns — resolved by `bin.ts` before the app
 * owns the command line, as opposed to `resume`, which the TUI command
 * definition parses like any other mode.
 *
 * They are positionals in argv (`dsh-tui web …`), so the thin entry
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
 * alone and thereby rejected both launcher commands (`dsh-tui web` read like a
 * typo). Keeping one list — and a regression assertion per mode in the pty
 * suite's `cli-errors` scenario — is what makes that failure mode impossible to
 * reintroduce silently.
 *
 * @module @yourname/dsh-tui/launcher-modes
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
