/**
 * The long-lived terminal app's command-line provider: it parses the
 * `--workspace`, `--resume`, and `--model` flags plus `--help`, then publishes
 * {@link TUI_STARTUP_SERVICE}. The runtime is an ordinary consumer whose lazy
 * config waits for that service.
 * @module @yourname/dsh-tui-app/startup
 */

import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'

/** Stable Cordis plugin name. */
export const name = 'tui-startup'

/** Services required before the invocation flags can be resolved. */
export const inject = ['cmdlineArgs']

/** Service provided by this plugin and injected by the TUI runtime. */
export const TUI_STARTUP_SERVICE = 'tuiStartup'

/** What the runtime row reads from {@link TUI_STARTUP_SERVICE}. */
export interface TuiStartupValues {
  /** Absolute workspace directory to exercise; defaults to `process.cwd()`. */
  workspace: string
  /** Persisted session id to resume, or `undefined` for a fresh session. */
  resume: string | undefined
  /** Optional model override (e.g. `deepseek-v4-flash`). */
  model: string | undefined
}

/**
 * This app's command.
 * @returns a fresh program, so one process can parse more than once (tests).
 */
function tuiCommand(): Command {
  return new Command()
    .name('dsh --profile tui')
    .description('Boot an interactive full-screen terminal surface over an agent session.')
    .helpOption('-h, --help', 'show this help')
    .option('--workspace <dir>', 'the directory the agent operates in (default: the invoking directory)')
    .option('--resume <sessionId>', 'resume a specific persisted session instead of auto-resuming')
    .option('--model <model>', 'a provider/name model override, e.g. deepseek-v4-flash')
    .addHelpText('after', `
Examples:
  dsh --profile tui                      continue the newest session in this directory (default), or start fresh when none exists
  dsh --profile tui --workspace ~/proj   continue the newest session in ~/proj
  dsh --profile tui --resume <sessionId> resume a specific persisted session
  # always start fresh: resume_last: false in ~/.dsh/dsh-tui.json, or DSH_TUI_RESUME_LAST=0
`)
}

/**
 * Parse and provide the TUI invocation as an ordinary Cordis service. On
 * `--help` nothing is provided, so no terminal is bound.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx: Context): void {
  const program = tuiCommand()
  program.action(() => {
    const options = program.opts<{ workspace?: string; resume?: string; model?: string }>()
    ctx.provide(TUI_STARTUP_SERVICE, {
      workspace: options.workspace ?? process.cwd(),
      resume: options.resume,
      model: options.model,
    } satisfies TuiStartupValues)
  })
  parseCmdline(ctx, program)
}
