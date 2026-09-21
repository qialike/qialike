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
 * policy (announce a minor/major, install a patch silently where installing is
 * possible at all, stay quiet when disabled or already current) and prints ONLY
 * the lines a user should see. The explicit form is the user asking by name, so it
 * does what it is told and reports failures with a non-zero exit.
 *
 * **What "a user should see" depends on the platform.** Where the updater can
 * replace this copy, the notice names the command that does it. Where it cannot —
 * Windows, where a running `.exe` cannot be overwritten and the installer's bash
 * does not exist, or a hand-placed binary outside `~/.dsh/bin` — the notice has to
 * carry the download links instead, or it is a dead end that tells the user to run
 * something that will refuse. `updateNotice()` is that fork, kept pure so both
 * shapes are pinned by tests without a network.
 *
 * @module @yourname/qialike/upgrade-command
 */

import { spawn } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
import {
  buildMode,
  compareVersions,
  decideUpdate,
  getReleaseType,
  platformKind,
  readEnvPolicy,
  readUpdateSettings,
  type InstallMethod,
} from '@yourname/qialike-app/src/upgrade-policy.ts'
import {
  downloadUrls,
  installMethod,
  latestVersion,
  releaseSources,
  upgrade,
} from '@yourname/qialike-app/src/self-update.ts'
import { parseUpdateReport } from '@yourname/qialike-app/src/update-hint.ts'

/** What `qialike upgrade --help` explains. */
export const UPGRADE_HELP = `qialike upgrade — replace the installed binary with a newer release

usage: qialike upgrade [version] [options]

    version            install exactly this version (v-prefix accepted)
    --check            report the installed and newest versions, install nothing
    --json             with --check or --auto: append ONE machine-readable report
                       line (installed / newest / relation / canSelfInstall /
                       downloads / decision), which is what the TUI renders as the
                       update dialog and what its startup check branches on
    --auto             apply the update policy and print only what a user should
                       see (used by the automatic check; not for humans)
    -h, --help         show this help

Windows has no automatic update: a running .exe cannot be replaced and the
installer is bash. On Windows this command only CHECKS and prints the download
links for github.com (primary) and gitcode.com (mirror) — replace the file by hand.
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
  /** The platform to decide for; defaults to the one this process runs on. */
  platform?: NodeJS.Platform
}

/**
 * Whether `qialike upgrade` can replace this copy at all.
 *
 * Two independent reasons it cannot: the platform (Windows) and the install
 * (a binary nobody's installer put in `~/.dsh/bin`). Both must be told to fetch the
 * release by hand — and the difference matters, so the notice is built from this
 * rather than from the decision kind alone.
 */
export function canSelfInstall(method: InstallMethod, platform: NodeJS.Platform = process.platform): boolean {
  return method === 'curl' && platformKind(platform) !== 'windows'
}

/**
 * What a person is told about one newer release.
 *
 * Two shapes for one reason: a copy the updater can replace is told to run the
 * command, and one it cannot is told where to download the file. Returning lines
 * (rather than printing) keeps this pure, so the text contract is testable without
 * a launcher, a network or a platform.
 */
export function updateNotice(input: {
  installed: string
  version: string
  canSelfInstall: boolean
  urls: readonly string[]
}): string[] {
  const lead = `qialike ${input.version} is available (you have ${input.installed})`
  if (input.canSelfInstall) return [`${lead} — run 'qialike upgrade'`]
  return [`${lead} — download it and replace the file by hand:`, ...input.urls.map((url) => `  ${url}`)]
}

/**
 * How one version relates to the installed one, as the JSON reports spell it.
 *
 * The launcher does this arithmetic (and refuses to call a lagging mirror's older
 * tag an update), so a caller only ever renders the verdict.
 */
function relationOf(installed: string, version: string): 'up-to-date' | 'older' | 'patch' | 'minor' | 'major' {
  const comparison = compareVersions(version, installed)
  if (comparison === 0) return 'up-to-date'
  if (comparison < 0) return 'older'
  return getReleaseType(installed, version)
}

/** Parse the argument list into what the command acts on. */
function parse(argv: readonly string[]): { help: boolean; check: boolean; auto: boolean; json: boolean; version?: string; error?: string } {
  const flags = { help: false, check: false, auto: false, json: false, version: undefined as string | undefined, error: undefined as string | undefined }
  for (const arg of argv) {
    if (arg === '-h' || arg === '--help') flags.help = true
    else if (arg === '--check') flags.check = true
    else if (arg === '--auto') flags.auto = true
    else if (arg === '--json') flags.json = true
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
  // `--json` exists for the two forms a caller renders or branches on: the read-only
  // report and the policy run. Accepting it beside an install would make a mistyped
  // invocation look like it worked.
  if (flags.json && !flags.check && !flags.auto) {
    io.err("qialike: --json requires --check or --auto (try 'qialike upgrade --help')")
    return 1
  }

  const env = io.env ?? process.env
  const platform = io.platform ?? process.platform
  const method = installMethod()
  const policy = readEnvPolicy(env)

  if (flags.auto) {
    // The report a `--json` caller reads. `--auto` prints the human notice FIRST
    // (that is what a person sees) and this line last, so one run can serve both.
    const report = (
      decision: 'skip' | 'up-to-date' | 'unknown' | 'notify' | 'install',
      extra: { version?: string; reason?: string; ok?: boolean } = {},
    ): void => {
      if (!flags.json) return
      io.out(JSON.stringify({
        decision,
        installed: io.installed,
        newest: extra.version ?? null,
        relation: extra.version === undefined ? null : relationOf(io.installed, extra.version),
        canSelfInstall: canSelfInstall(method, platform),
        downloads: downloadUrls(extra.version, { sources: releaseSources(env) }),
        ...(extra.reason === undefined ? {} : { reason: extra.reason }),
        ...(extra.ok === undefined ? {} : { ok: extra.ok }),
      }))
    }
    // The policy's own gates first, so a disabled or dev build does nothing —
    // not even a network request.
    const auto = io.ctx === undefined ? true : readUpdateSettings(io.ctx)
    if (policy.disabled || auto === false) { report('skip', { reason: 'disabled' }); return 0 }
    if (buildMode() === 'dev') { report('skip', { reason: 'dev-build' }); return 0 }

    // The version is resolved BEFORE the install-method gate, and for a Windows
    // reason: the copies that most need this notice are the hand-placed ones the
    // installer never managed, and gating first made the check skip them without
    // ever asking the release host. Asking is harmless — `latestVersion` is a
    // HEAD-like read that downloads nothing — and it is the only way a Windows
    // user learns a newer release exists.
    const latest = latestVersion({ sources: releaseSources(env) })
    // No network, a rate-limited host or an unpublished platform all mean "we do
    // not know of a newer version" — say nothing rather than interrupting.
    if (latest === undefined) { report('unknown'); return 0 }

    const decision = decideUpdate({
      installed: io.installed,
      latest,
      auto,
      buildMode: buildMode(),
      method,
      platform: platformKind(platform),
      disabled: policy.disabled,
      alwaysNotify: policy.alwaysNotify,
    })

    if (decision.kind === 'skip') { report('skip', { reason: decision.reason }); return 0 }
    if (decision.kind === 'up-to-date') { report('up-to-date'); return 0 }
    if (decision.kind === 'notify') {
      for (const line of updateNotice({
        installed: io.installed,
        version: decision.version,
        // Says where to get it, rather than naming a command that would refuse:
        // both the platform and the install location can make `qialike upgrade`
        // impossible, and the notice is the only thing the user will see.
        canSelfInstall: canSelfInstall(method, platform),
        urls: downloadUrls(decision.version, { sources: releaseSources(env) }),
      })) io.out(line)
      report('notify', { version: decision.version })
      return 0
    }

    const result = upgrade(decision.version, { env, platform })
    if (result.ok) io.out(`updated to qialike ${result.version ?? decision.version} — restart to use it`)
    else io.out(`automatic update failed: ${result.error ?? 'unknown error'} — run 'qialike upgrade' to retry`)
    report('install', { version: decision.version, ok: result.ok })
    return 0
  }

  // `--check` is READ-ONLY, so it answers regardless of how this copy was
  // installed: "what is the newest release?" is a fair question from a checkout
  // build too. The self-replacement gate below does not apply to it.
  if (flags.check) {
    const target = flags.version ?? latestVersion({ sources: releaseSources(env) })
    // One JSON line, for a caller that RENDERS the answer (the TUI's /upgrade
    // dialog). It is printed even when the probe failed — `newest: null` plus the
    // releases pages — because "I could not check" and "you are up to date" are
    // different things to show a user, and the exit code alone cannot say which.
    if (flags.json) {
      io.out(JSON.stringify({
        decision: 'check',
        installed: io.installed,
        newest: target ?? null,
        relation: target === undefined ? null : relationOf(io.installed, target),
        canSelfInstall: canSelfInstall(method, platform),
        downloads: downloadUrls(target, { sources: releaseSources(env) }),
      }))
      return target === undefined ? 1 : 0
    }
    if (target === undefined) {
      io.err('qialike: could not determine the newest version (no network?) — pass one explicitly:')
      io.err('         qialike upgrade --check <version>')
      return 1
    }
    // Three cases, not two. A source that lags reports a tag OLDER than what is
    // installed, and calling that an "update available" would point the user at a
    // downgrade; naming it plainly is what makes the mirror's lag visible.
    const comparison = compareVersions(target, io.installed)
    const relation = comparison === 0
      ? 'up to date'
      : comparison < 0
        ? 'older than installed — the reachable release source has not caught up'
        : `${getReleaseType(io.installed, target)} update available`
    io.out(`installed  ${io.installed}`)
    io.out(`newest     ${target}  (${relation})`)
    // A report that ends at "update available" is a dead end for a copy that
    // cannot install one — the platform may forbid it or nobody's installer may
    // own this binary. Naming the download keeps the read-only answer actionable.
    if (comparison > 0 && !canSelfInstall(method, platform)) {
      const urls = downloadUrls(target, { sources: releaseSources(env) })
      for (const [index, url] of urls.entries()) io.out(`${index === 0 ? 'download  ' : '          '} ${url}`)
    }
    return 0
  }

  // Explicit install: the user asked by name, so the auto policy (including
  // `auto: false`) does not apply. What still applies is whether this binary is
  // one the installer can replace at all — and on Windows it never is, whatever
  // the install method says, so that gate comes first and points at the download
  // instead of at a bash one-liner the platform cannot run.
  if (platformKind(platform) === 'windows') {
    io.err('qialike: Windows has no automatic update — a running .exe cannot be replaced.')
    io.err('         Download the release and replace the file by hand:')
    const target = flags.version ?? latestVersion({ sources: releaseSources(env) })
    for (const url of downloadUrls(target, { sources: releaseSources(env) })) io.err(`           ${url}`)
    return 1
  }

  if (method === 'unknown') {
    io.err('qialike: this qialike is not an installer-managed copy, so it cannot replace itself.')
    io.err('         Reinstall it with:  curl -fsSL https://qialike.com/install | bash')
    return 1
  }

  const target = flags.version ?? latestVersion({ sources: releaseSources(env) })
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
  const result = upgrade(target, { env, platform })
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
  /** Relays one line of the child's notice to the user. */
  notify: (message: string) => void
  /**
   * Called instead of `notify` when a newer release is waiting on a platform that
   * cannot install it by itself — the TUI records it as its status-line hint.
   * Optional: a caller that only has a status line keeps the child's notice.
   */
  onUpdate?: (offer: { installed: string; version: string; urls: readonly string[] }) => void
  /** The platform the CHILD runs on; defaults to this process's. */
  platform?: NodeJS.Platform
  /** Delay before the check; opencode waits 1s so startup is never held back. */
  delayMs?: number
  env?: NodeJS.ProcessEnv
}

/**
 * Schedule one automatic check, by SPAWNING `upgrade --auto --json`.
 *
 * A child process, not an in-process call: the check may download and install,
 * and doing that here would block the TUI's event loop for the whole download.
 * The child also inherits the launcher privilege boundary instead of reaching
 * into `~/.dsh/bin` from inside the app tree.
 *
 * The child prints the human notice AND a machine-readable report line last, which
 * is what lets this relay keep the two platforms apart:
 *
 *  - Windows cannot replace a running `.exe` (and has no bash for the installer), so
 *    a newer release becomes the one-line HINT the TUI paints in its status line —
 *    `onUpdate` — instead of a transcript notice the user has to read and act on;
 *  - everywhere else the pre-existing behaviour is untouched: the child's own notice
 *    lines are relayed verbatim (a patch has already been installed by the time they
 *    are printed; a minor/major release is announced for the user to act on).
 *
 * That split is a requirement, not an optimisation: Linux/macOS have a complete,
 * verified auto-update path, and this Windows-specific handling must not touch it.
 *
 * Failures are swallowed (`error` and a missing executable included): a
 * background courtesy must never surface as a crash or a stray message. The
 * timer is `unref`'d so a short-lived process is not held open by it.
 */
export function scheduleAutoCheck(options: AutoCheckOptions): void {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  // Checked here as well as in the child, so a disabled check costs nothing at all
  // — no process, no network, nothing to observe. That is what makes the "no
  // background work" promise hold for a test harness that sets the variable.
  if (readEnvPolicy(env).disabled) return

  const timer = setTimeout(() => {
    const child = spawn(options.execPath ?? process.execPath, ['upgrade', '--auto', '--json'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      env,
    })

    let buffered = ''
    child.stdout?.on('data', (chunk: Buffer | string) => { buffered += String(chunk) })
    // A spawn failure (execPath gone) is not worth a message.
    child.on('error', () => { /* swallowed by design */ })
    child.on('exit', () => {
      const report = parseUpdateReport(buffered)
      const lines = buffered.split('\n').map((line) => line.trim()).filter((line) => line !== '')
      // The report is the last line; everything before it is the human notice.
      const notice = report === undefined ? lines : lines.slice(0, -1)

      if (
        options.onUpdate !== undefined
        && platformKind(platform) === 'windows'
        && report !== undefined
        && report.decision === 'notify'
        && report.newest !== null
      ) {
        options.onUpdate({ installed: report.installed, version: report.newest, urls: report.downloads })
        return
      }
      for (const line of notice) options.notify(line)
    })
  }, options.delayMs ?? 1000)

  // Node's Timeout has `unref`; the cast keeps this file usable in a test double.
  ;(timer as { unref?: () => void }).unref?.()
}
