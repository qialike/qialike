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
  /** Positional `resume`: continue the newest session with content in this
   *  directory and open straight into the conversation view (docked). Without
   *  it the launch never auto-resumes: it opens/reuses an unused New Session
   *  placeholder and shows the hero screen (web parity). */
  resumeNewest: boolean
  /** Optional model override (e.g. `deepseek-v4-flash`). */
  model: string | undefined
}

/**
 * Resolve the optional positional mode into the auto-resume choice.
 * @param mode - the positional argument, or undefined when absent.
 * @returns true for `resume` (continue the newest content session).
 * @throws on any other value: a typo must fail loud, not start fresh silently.
 */
export function parseResumeMode(mode: string | undefined): boolean {
  if (mode === undefined) return false
  if (mode === 'resume') return true
  throw new Error(`unknown argument "${mode}" — did you mean "resume"? (see --help)`)
}

/**
 * This app's command. Exported so the single-file launcher's thin entry
 * (apps/tui-bin/src/main.ts) can render the same width-aware `--help` text
 * before the ~111-module plugin graph loads; the help bytes must not drift
 * between the fast path and the full boot.
 * @returns a fresh program, so one process can parse more than once (tests).
 */
export function tuiCommand(): Command {
  return new Command()
    .name('dsh --profile tui')
    .description('Boot an interactive full-screen terminal surface over an agent session.')
    .helpOption('-h, --help', 'show this help')
    .argument('[mode]', "optional positional mode: 'resume' continues the newest session in this directory")
    .option('--workspace <dir>', 'the directory the agent operates in (default: the invoking directory)')
    .option('--resume <sessionId>', 'resume a specific persisted session (opens the conversation view directly)')
    .option('--model <model>', 'a provider/name model override, e.g. deepseek-v4-flash')
    .option('--dump-config', 'print the composed profile layers (embedded + user) and exit')
    .addHelpText('after', `
Examples:
  dsh-tui                     start a NEW session and show the hero screen (never auto-resumes)
  dsh-tui resume              continue the newest session with content here, straight into the conversation view
  dsh-tui --resume <id>       open one specific persisted session
  dsh-tui --workspace ~/proj  operate in ~/proj (its own sessions / New Session placeholder)
  # opt back into auto-resume on every launch: resume_last: true in ~/.dsh/dsh-tui.json (or DSH_TUI_RESUME_LAST=1)
`)
}

/**
 * Parse and provide the TUI invocation as an ordinary Cordis service. On
 * `--help` nothing is provided, so no terminal is bound.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx: Context): void {
  const program = tuiCommand()
  program.action((mode?: string) => {
    // Fail loud on an unknown positional instead of silently starting fresh
    // (a typo like `dsh-tui resme` must not look like "no argument").
    const resumeNewest = parseResumeMode(mode)
    const options = program.opts<{
      workspace?: string
      resume?: string
      model?: string
    }>()
    ctx.provide(TUI_STARTUP_SERVICE, {
      workspace: options.workspace ?? process.cwd(),
      resume: options.resume,
      resumeNewest,
      model: options.model,
    } satisfies TuiStartupValues)
  })
  parseCmdline(ctx, program)
}
