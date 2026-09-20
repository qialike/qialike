/**
 * `qialike upgrade` — the privileged half of automatic update.
 *
 * It lives in the launcher, not in a Cordis plugin, for the same reasons
 * `uninstall` does: it writes outside the workspace (`~/.dsh/bin`, and the PATH
 * line via the installer), it must work with no TUI at all, and `launcher-modes.ts`
 * is the single source of truth for modes resolved before the app owns argv.
 *
 * Two callers:
 *  - a person, running `qialike upgrade [version]` in a terminal;
 *  - the TUI, which SPAWNS this mode rather than calling it. That is deliberate:
 *    `upgrade()` shells out to the installer, which downloads tens of megabytes
 *    and then replaces the running binary — on the TUI's event loop that would
 *    freeze the interface for the whole download, so the work goes to a child
 *    process and only the resulting notice comes back.
 *
 * `--auto` is the internal form the TUI spawns: it applies the `qialike-update`
 * policy (announce a minor/major, install a patch silently, stay quiet when
 * disabled or already current) and prints ONLY the lines a user should see. The
 * explicit form is the user asking by name, so it does what it is told and
 * reports failures with a non-zero exit.
 *
 * @module @yourname/qialike/upgrade-command
 */

import { spawn } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
import {
  buildMode,
  decideUpdate,
  getReleaseType,
  readEnvPolicy,
  readUpdateSettings,
} from '@yourname/qialike-app/src/upgrade-policy.ts'
import {
  installMethod,
  latestVersion,
  upgrade,
} from '@yourname/qialike-app/src/self-update.ts'

/** What `qialike upgrade --help` explains. */
export const UPGRADE_HELP = `qialike upgrade — replace the installed binary with a newer release

usage: qialike upgrade [version] [options]

    version            install exactly this version (v-prefix accepted)
    --check            report the installed and newest versions, install nothing
    --auto             apply the update policy and print only what a user should
                       see (used by the automatic check; not for humans)
    -h, --help         show this help
`

/** Everything the command needs from its environment, injected for testability. */
export interface UpgradeIo {
  /** The version this binary reports. */
  installed: string
  out: (line: string) => void
  err: (line: string) => void
  /** The Cordis context, when one exists — only `--auto` needs its settings. */
  ctx?: Context
  env?: NodeJS.ProcessEnv
}

/** Parse the argument list into what the command acts on. */
function parse(argv: readonly string[]): { help: boolean; check: boolean; auto: boolean; version?: string; error?: string } {
  const flags = { help: false, check: false, auto: false, version: undefined as string | undefined, error: undefined as string | undefined }
  for (const arg of argv) {
    if (arg === '-h' || arg === '--help') flags.help = true
    else if (arg === '--check') flags.check = true
    else if (arg === '--auto') flags.auto = true
    else if (arg.startsWith('-')) return { ...flags, error: `unknown option '${arg}'` }
    else if (flags.version === undefined) flags.version = arg
    else return { ...flags, error: `unexpected extra argument '${arg}'` }
  }
  return flags
}

/**
 * Run the command. Returns the process exit code.
 *
 * `--auto` NEVER fails the caller: the automatic check runs in the background of
 * somebody's session, and a network blip must not surface as an error. It reports
 * what happened on stdout so the spawning TUI can relay it, and exits 0 either
 * way. The explicit form is the opposite — the user asked, so a refusal or a
 * failed download exits non-zero.
 */
export function runUpgrade(argv: readonly string[], io: UpgradeIo): number {
  const flags = parse(argv)

  if (flags.error !== undefined) {
    io.err(`qialike: ${flags.error} (try 'qialike upgrade --help')`)
    return 1
  }
  if (flags.help) {
    io.out(UPGRADE_HELP)
    return 0
  }

  const env = io.env ?? process.env
  const method = installMethod()
  const policy = readEnvPolicy(env)

  if (flags.auto) {
    // The policy's own gates first, so a disabled or dev build does nothing —
    // not even a network request.
    const auto = io.ctx === undefined ? true : readUpdateSettings(io.ctx)
    if (policy.disabled || auto === false || buildMode() === 'dev') return 0
    if (method === 'unknown') return 0

    const latest = latestVersion()
    // No network, a rate-limited host or an unpublished platform all mean "we do
    // not know of a newer version" — say nothing rather than interrupting.
    if (latest === undefined) return 0

    const decision = decideUpdate({
      installed: io.installed,
      latest,
      auto,
      buildMode: buildMode(),
      method,
      disabled: policy.disabled,
      alwaysNotify: policy.alwaysNotify,
    })

    if (decision.kind === 'skip' || decision.kind === 'up-to-date') return 0
    if (decision.kind === 'notify') {
      io.out(`qialike ${decision.version} is available (you have ${io.installed}) — run 'qialike upgrade'`)
      return 0
    }

    const result = upgrade(decision.version, { env })
    if (result.ok) io.out(`updated to qialike ${result.version ?? decision.version} — restart to use it`)
    else io.out(`automatic update failed: ${result.error ?? 'unknown error'} — run 'qialike upgrade' to retry`)
    return 0
  }

  // `--check` is READ-ONLY, so it answers regardless of how this copy was
  // installed: "what is the newest release?" is a fair question from a checkout
  // build too. The self-replacement gate below does not apply to it.
  if (flags.check) {
    const target = flags.version ?? latestVersion()
    if (target === undefined) {
      io.err('qialike: could not determine the newest version (no network?) — pass one explicitly:')
      io.err('         qialike upgrade --check <version>')
      return 1
    }
    const relation = target === io.installed ? 'up to date' : `${getReleaseType(io.installed, target)} update available`
    io.out(`installed  ${io.installed}`)
    io.out(`newest     ${target}  (${relation})`)
    return 0
  }

  // Explicit install: the user asked by name, so the auto policy (including
  // `auto: false`) does not apply. What still applies is whether this binary is
  // one the installer can replace at all.
  if (method === 'unknown') {
    io.err('qialike: this qialike is not an installer-managed copy, so it cannot replace itself.')
    io.err('         Reinstall it with:  curl -fsSL https://qialike.com/install | bash')
    return 1
  }

  const target = flags.version ?? latestVersion()
  if (target === undefined) {
    io.err('qialike: could not determine the newest version (no network?) — pass one explicitly:')
    io.err('         qialike upgrade <version>')
    return 1
  }

  if (target === io.installed) {
    io.out(`qialike ${io.installed} is already the newest version`)
    return 0
  }

  io.out(`upgrading qialike ${io.installed} -> ${target}`)
  const result = upgrade(target, { env })
  if (!result.ok) {
    io.err(`qialike: ${result.error ?? 'upgrade failed'}`)
    return 1
  }
  io.out(`updated to qialike ${result.version ?? target} — restart to use it`)
  return 0
}

/** How the automatic check is wired, injected so a test can drive it. */
export interface AutoCheckOptions {
  /** Spawned executable; defaults to this process's. */
  execPath?: string
  /** Relays one line of the child's report to the user. */
  notify: (message: string) => void
  /** Delay before the check; opencode waits 1s so startup is never held back. */
  delayMs?: number
  env?: NodeJS.ProcessEnv
}

/**
 * Schedule one automatic check, by SPAWNING `upgrade --auto`.
 *
 * A child process, not an in-process call: the check may download and install,
 * and doing that here would block the TUI's event loop for the whole download.
 * The child also inherits the launcher privilege boundary instead of reaching
 * into `~/.dsh/bin` from inside the app tree.
 *
 * Failures are swallowed (`error` and a missing executable included): a
 * background courtesy must never surface as a crash or a stray message. The
 * timer is `unref`'d so a short-lived process is not held open by it.
 */
export function scheduleAutoCheck(options: AutoCheckOptions): void {
  const env = options.env ?? process.env
  // Checked here as well as in the child, so a disabled check costs nothing at all
  // — no process, no network, nothing to observe. That is what makes the "no
  // background work" promise hold for a test harness that sets the variable.
  if (readEnvPolicy(env).disabled) return

  const timer = setTimeout(() => {
    const child = spawn(options.execPath ?? process.execPath, ['upgrade', '--auto'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      env,
    })

    let buffered = ''
    child.stdout?.on('data', (chunk: Buffer | string) => { buffered += String(chunk) })
    // A spawn failure (execPath gone) is not worth a message.
    child.on('error', () => { /* swallowed by design */ })
    child.on('exit', () => {
      for (const line of buffered.split('\n')) {
        const text = line.trim()
        if (text !== '') options.notify(text)
      }
    })
  }, options.delayMs ?? 1000)

  // Node's Timeout has `unref`; the cast keeps this file usable in a test double.
  ;(timer as { unref?: () => void }).unref?.()
}
