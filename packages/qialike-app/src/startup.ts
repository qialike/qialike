/**
 * The long-lived terminal app's command-line provider: it parses the
 * `--workspace`, `--resume`, and `--model` flags plus `--help`, then publishes
 * {@link TUI_STARTUP_SERVICE}. The runtime is an ordinary consumer whose lazy
 * config waits for that service.
 * @module @qialike/qialike-app/startup
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

/** A resolved provider + model pair. */
export interface ModelOverrideTarget {
  readonly provider: string
  readonly model: string
}

/**
 * Resolve `--model` against the persisted selection.
 *
 * WHAT WAS BROKEN. The flag has always been documented as `provider/name`, but
 * the implementation passed the whole string as the model id and kept the saved
 * provider — so `--model qialike-bee/deepseek-v4.1-flash` asked the *other*
 * provider for a model literally called `qialike-bee/deepseek-v4.1-flash`, which
 * fails at request time with nothing in the UI saying why. `deepseek-v4-flash`
 * (no slash) kept working, which is why nobody noticed.
 *
 * WHY THE PREFIX IS NOT SIMPLY SPLIT AT THE FIRST `/`. Model ids legitimately
 * contain slashes — the China gateways serve `deepseek/deepseek-v4-flash-202605`
 * and OpenRouter serves `openrouter/auto` — so splitting blindly would turn a
 * real model id into a provider lookup. The prefix is consumed as a provider
 * **only when it names a route this build can serve**; otherwise the whole
 * argument stays a model id on the persisted provider, which is exactly the old
 * behaviour for every id that contains a slash.
 *
 * An unknown prefix is therefore not an error: `--model foo/bar` with no `foo`
 * route means "the model called `foo/bar`", and the request fails the same way
 * it always did. Rejecting it would break ids we cannot enumerate.
 * @param override - the raw `--model` value, or undefined when the flag is absent.
 * @param knownRoute - whether a route key is one this build serves.
 * @param persisted - the provider/model the session would otherwise use.
 * @returns the provider and model the session should start on.
 */
export function resolveModelOverride(
  override: string | undefined,
  knownRoute: (route: string) => boolean,
  persisted: ModelOverrideTarget,
): ModelOverrideTarget {
  if (override === undefined || override === '') return persisted
  const slash = override.indexOf('/')
  if (slash > 0) {
    const provider = override.slice(0, slash)
    const model = override.slice(slash + 1)
    if (model !== '' && knownRoute(provider)) return { provider, model }
  }
  return { provider: persisted.provider, model: override }
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
    .option('--model <model>', 'provider/name picks a provider too, e.g. qialike-bee/deepseek-v4.1-flash; a bare name keeps the current provider')
    .option('--dump-config', 'print the composed profile layers (embedded + user) and exit')
    .option('--no-project-overlay', "ignore the repository's .dsh/tui.cordis.patch.yml for this run")
    .addHelpText('after', `
Examples:
  qialike                     start a NEW session and show the hero screen (never auto-resumes)
  qialike resume              continue the newest session with content here, straight into the conversation view
  qialike --resume <id>       open one specific persisted session
  qialike --workspace ~/proj  operate in ~/proj (its own sessions / New Session placeholder)
  qialike --model qialike-bee/deepseek-v4.1-flash
                              start on Bee's model, switching provider as needed
  # opt back into auto-resume on every launch: resume_last: true in ~/.dsh/qialike.json (or QIALIKE_RESUME_LAST=1)
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
    // (a typo like `qialike resme` must not look like "no argument").
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
