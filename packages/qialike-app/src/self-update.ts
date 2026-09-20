/**
 * The IO half of the automatic update: which install this is, what the newest
 * release is, and how to hand the work to the installer.
 *
 * Deliberately stateless. The launcher bundle (`apps/tui-bin`, which imports this
 * through the `./src/*` export) and the app bundle (`lib/index.js`, which the
 * Cordis tree mounts) are built separately, so a module shared by both exists as
 * TWO instances in the binary. Nothing here may rely on module-level mutable
 * state — which is also why the concurrency guard is a file lock rather than a
 * flag: qialike runs as many processes, and two of them must not download and
 * install at once.
 *
 * The actual download and placement is not reimplemented here. `upgrade()` runs
 * the installer — the same script a fresh install uses — with `QIALIKE_VERSION`
 * pinning the target, mirroring opencode's `upgradeCurl`. The installer owns
 * platform naming, extraction and the `mv` that replaces a running binary.
 *
 * @module @yourname/qialike-app/self-update
 */

import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import type { InstallMethod } from './upgrade-policy.ts'

/** The installed executable's name. */
export const BIN = 'qialike'

/** The releases directory the installer also defaults to. */
export const DEFAULT_RELEASES_URL = 'https://github.com/qialike/qialike/releases'

/** Where the installer script is fetched from when upgrading. */
export const DEFAULT_INSTALL_URL = 'https://qialike.com/install'

/** The mirror used when the primary release host does not answer. */
export const MIRROR_RELEASES_URL = 'https://gitcode.com/qialike/qialike/releases'

/**
 * One place releases can be read from, and how to read its newest tag.
 *
 * Two resolution shapes exist, and they differ because the hosts differ:
 * GitHub answers `<base>/latest/download/<asset>` with a 302 whose Location carries
 * the tag — free of the API's 60/hour unauthenticated limit, so it is tried first
 * and is all GitHub needs. gitcode answers that same path with an HTML page
 * (verified: 200, `text/html`, no redirect), so its tag has to come from the v5
 * releases API instead, which does answer unauthenticated.
 */
export interface ReleaseSource {
  /** The releases directory: assets live at `<base>/download/<tag>/<asset>`. */
  base: string
  /** A URL answering JSON with `tag_name`, for a host with no `latest` redirect. */
  api?: string
}

/**
 * The primary release host, then the mirror.
 *
 * Order is the whole policy: the first source that can name the newest release wins,
 * so a user who can reach GitHub keeps getting GitHub's (always the freshest) tag,
 * and one who cannot falls through to the mirror. `scripts/install.d/00-common.sh`
 * carries the same list, and `tests/self-update.test.ts` fails if the two drift.
 */
/**
 * The releases API for a host with no `latest` redirect, derived from the base
 * rather than hardcoded per repository — `<host>/<owner>/<repo>/releases` becomes
 * `<host>/api/v5/repos/<owner>/<repo>/releases/latest`. Only gitcode is known to
 * need one, so only gitcode is asked; mirrors without an API keep working through
 * the redirect, which is why an unknown host is undefined rather than an error.
 */
export function sourceApiFor(base: string): string | undefined {
  const match = /^https:\/\/gitcode\.com\/(.+)\/releases$/.exec(base)
  if (match === null) return undefined
  return `https://gitcode.com/api/v5/repos/${match[1]}/releases/latest`
}

export const RELEASE_SOURCES: readonly ReleaseSource[] = [
  { base: DEFAULT_RELEASES_URL },
  { base: MIRROR_RELEASES_URL, api: sourceApiFor(MIRROR_RELEASES_URL) },
]

/** How long a source gets to prove it is reachable, in seconds. */
export const CONNECT_TIMEOUT = '4'

/**
 * How long the whole probe may take. Deliberately short: the point is to notice a
 * blackholed GitHub quickly enough that falling back to the mirror feels immediate,
 * rather than hanging the check for curl's default (and spawnSync's 120s cap).
 */
export const PROBE_TIMEOUT = '10'

/**
 * Split a source specification into sources.
 *
 * The format is `base` or `base|api`, comma-separated, matching the installer's
 * `QIALIKE_INSTALL_SOURCES` so a mirror list is written one way in both places. An
 * empty entry is ignored rather than becoming a nameless source.
 */
function parseSources(spec: string): ReleaseSource[] {
  const sources: ReleaseSource[] = []
  for (const entry of spec.split(',')) {
    const trimmed = entry.trim()
    if (trimmed === '') continue
    const [base, api] = trimmed.split('|')
    const normalized = (base ?? '').replace(/\/+$/, '')
    if (normalized === '') continue
    if (api === undefined || api === '') {
      const derived = sourceApiFor(normalized)
      sources.push(derived === undefined ? { base: normalized } : { base: normalized, api: derived })
      continue
    }
    sources.push({ base: normalized, api })
  }
  return sources
}

/**
 * The sources to try, in order.
 *
 * `QIALIKE_INSTALL_BASE_URL` still wins outright and yields exactly ONE source, so an
 * explicit host never has a fallback appended to it — that is what the installer's
 * fixture tests and a user's private mirror both rely on.
 */
export function releaseSources(env: NodeJS.ProcessEnv = process.env): ReleaseSource[] {
  if (env.QIALIKE_INSTALL_BASE_URL !== undefined && env.QIALIKE_INSTALL_BASE_URL !== '') {
    const base = env.QIALIKE_INSTALL_BASE_URL.replace(/\/+$/, '')
    const derived = sourceApiFor(base)
    return [derived === undefined ? { base } : { base, api: derived }]
  }
  const spec = env.QIALIKE_INSTALL_SOURCES
  if (spec !== undefined && spec.trim() !== '') return parseSources(spec)
  return [...RELEASE_SOURCES]
}

/** The tag out of a releases API answer, whatever JSON surrounds it. */
export function parseTagFromJson(body: string): string | undefined {
  return /"tag_name"\s*:\s*"([^"]+)"/.exec(body)?.[1]
}

/** How one source is asked for its newest tag. */
function latestFrom(source: ReleaseSource, asset: string, run: Runner): string | undefined {
  const budget = ['--connect-timeout', CONNECT_TIMEOUT, '--max-time', PROBE_TIMEOUT]
  // The redirect first, and without `-L`: this reads the recipe, it does not
  // download 55 MB.
  const redirect = run('curl', ['-fsS', ...budget, '-o', '/dev/null', '-w', '%{redirect_url}', `${source.base}/latest/download/${asset}`])
  if (redirect.status === 0) {
    const tag = parseTagFromRedirect(redirect.stdout)
    if (tag !== undefined) return tag
  }
  if (source.api === undefined) return undefined

  const answer = run('curl', ['-fsS', ...budget, source.api])
  if (answer.status !== 0) return undefined
  return parseTagFromJson(answer.stdout)
}

/**
 * The newest published tag, or undefined when no source can be reached.
 *
 * Undefined is not an error: no network, a rate-limited host or an unpublished
 * platform all mean "we do not know of a newer version", and the caller stays
 * quiet. The alternative — throwing — would surface a background check in the
 * middle of the user's session.
 */
export function latestVersion(
  options: { target?: string; sources?: readonly ReleaseSource[]; releases?: string; run?: Runner } = {},
): string | undefined {
  const target = options.target ?? detectTarget()
  if (target === undefined) return undefined
  const asset = assetFor(target)
  if (asset === undefined) return undefined

  const run = options.run ?? runShell
  const sources = options.sources ?? (options.releases !== undefined ? [{ base: options.releases }] : releaseSources())

  for (const source of sources) {
    const tag = latestFrom(source, asset, run)
    if (tag !== undefined) return tag
  }
  return undefined
}

/** The result of one child process, as much as this module needs. */
export interface RunResult {
  status: number | null
  stdout: string
  stderr: string
}

/** Injectable process runner, so tests never touch the network or bash. */
export type Runner = (cmd: string, args: readonly string[], options?: { input?: string; env?: NodeJS.ProcessEnv }) => RunResult

const runShell: Runner = (cmd, args, options) => {
  const result = spawnSync(cmd, args, {
    encoding: 'utf8',
    input: options?.input,
    env: options?.env,
    timeout: 120_000,
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/**
 * The directory the installer writes to.
 *
 * NOT derived from `$DSH_HOME`, for the same reason the installer hardcodes it:
 * `qialike uninstall` scans exactly `$HOME/.local/bin` and `$HOME/.dsh/bin`, so a
 * binary placed elsewhere could not be removed.
 */
export function installDir(home: string = homedir()): string {
  return join(home, '.dsh', 'bin')
}

/** Where the concurrency guard lives. */
export function lockPath(home: string = homedir()): string {
  return join(installDir(home), '.upgrade.lock')
}

/**
 * Whether this process is the kind of install the updater may replace.
 *
 * Path-based, like opencode's probe: a binary running from the install directory
 * was put there by the installer, so the installer is how it gets upgraded. A
 * checkout build (`apps/tui-bin`, `dist/qialike`, a `~/.local/bin` symlink) is
 * "unknown" and is never touched.
 */
export function installMethod(execPath: string = process.execPath, home: string = homedir()): InstallMethod {
  const dir = installDir(home)
  return execPath === join(dir, BIN) || execPath.startsWith(dir + sep) ? 'curl' : 'unknown'
}

/** `platform`/`arch` mapped to the release target naming, or undefined if unknown. */
export function detectTarget(platform: string = process.platform, arch: string = process.arch): string | undefined {
  const os = platform === 'linux' ? 'linux' : platform === 'darwin' ? 'darwin' : platform === 'win32' ? 'windows' : undefined
  const cpu = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : undefined
  if (os === undefined || cpu === undefined) return undefined
  return `${os}-${cpu}`
}

/**
 * The release asset for a target.
 *
 * This table MIRRORS `scripts/install.d/20-platform.sh`; `tests/self-update.test.ts`
 * executes the shell module and fails if the two ever disagree, because a silent
 * divergence here would surface as "could not resolve the latest version" — the
 * updater would simply stop seeing releases.
 */
export function assetFor(target: string): string | undefined {
  switch (target) {
    case 'linux-x64': return 'qialike-linux-x64.tar.gz'
    case 'linux-arm64': return 'qialike-linux-arm64.tar.gz'
    case 'darwin-x64':
    case 'darwin-arm64': return `qialike-${target}.zip`
    case 'windows-x64':
    case 'windows-arm64': return `qialike-${target}.zip`
    default: return undefined
  }
}

/**
 * The tag out of the redirect a releases server issues for `latest/download/…`.
 *
 * Reading the redirect rather than the GitHub API is what keeps the check free of
 * the 60-requests/hour unauthenticated limit.
 */
export function parseTagFromRedirect(url: string): string | undefined {
  return /\/download\/([^/]+)\/[^/]+$/.exec(url.trim())?.[1]
}

/** The installer endpoint to use. */
export function installUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.QIALIKE_INSTALL_URL ?? DEFAULT_INSTALL_URL
}

/** The version the installed binary reports, or undefined if it will not run. */
export function installedVersion(options: { dir?: string; run?: Runner } = {}): string | undefined {
  const dir = options.dir ?? installDir()
  const run = options.run ?? runShell
  const result = run(join(dir, BIN), ['--version'])
  if (result.status !== 0) return undefined
  const out = result.stdout.trim()
  return out === '' ? undefined : out.split(/\s+/).pop()
}

/** Whether an existing lock file belongs to a process that is gone. */
function isStaleLock(path: string): boolean {
  let pid: number
  try {
    pid = Number(readFileSync(path, 'utf8').trim())
  } catch {
    return true
  }
  if (!Number.isInteger(pid) || pid <= 0) return true
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    // ESRCH means no such process; EPERM means it exists but belongs to someone
    // else, which still counts as "held".
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

/**
 * Create the lock, stealing one whose owner died (a crashed upgrade must not
 * block every later one). Returns false when the lock is genuinely held.
 */
export function acquireLock(path: string): boolean {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, 'wx')
      writeFileSync(fd, String(process.pid))
      closeSync(fd)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return false
      if (attempt === 0 && isStaleLock(path)) {
        try { unlinkSync(path) } catch { /* raced with another process; fall through */ }
        continue
      }
      return false
    }
  }
  return false
}

/** Release the lock. Safe to call when it was never taken. */
export function releaseLock(path: string): void {
  try { unlinkSync(path) } catch { /* already gone */ }
}

/** Run `fn` under the lock, or return undefined when another upgrade holds it. */
export function withUpgradeLock<T>(path: string, fn: () => T): T | undefined {
  if (!acquireLock(path)) return undefined
  try {
    return fn()
  } finally {
    releaseLock(path)
  }
}

/** What `upgrade()` reports back. */
export interface UpgradeResult {
  ok: boolean
  /** The version the installed binary reports afterwards. */
  version?: string
  error?: string
}

/**
 * Install `target` by running the installer, exactly as a fresh install would.
 *
 * The script is fetched and piped to bash's stdin with `QIALIKE_VERSION` set, so
 * the installer resolves nothing itself and the version cannot drift from the one
 * the policy decided on. `--no-modify-path` is NOT passed: the PATH step is
 * idempotent (an already-configured profile is left alone), and suppressing it
 * would mean a broken PATH never gets repaired by an upgrade.
 *
 * The whole thing runs under the lock, so two qialike processes cannot install
 * over each other.
 */
export function upgrade(
  target: string,
  options: {
    installUrl?: string
    dir?: string
    lock?: string
    run?: Runner
    env?: NodeJS.ProcessEnv
  } = {},
): UpgradeResult {
  const run = options.run ?? runShell
  const dir = options.dir ?? installDir()
  // The lock sits beside the binary it guards, so an overridden install dir gets
  // its own lock rather than contending on the default home's.
  const lock = options.lock ?? join(dir, '.upgrade.lock')

  if (!existsSync(join(dir, BIN))) {
    return { ok: false, error: `qialike is not installed at ${join(dir, BIN)}` }
  }
  if (run('bash', ['--version']).status !== 0) {
    // The installer is bash: arrays, `[[ ]]` and process substitution are load
    // bearing, so POSIX sh cannot stand in for it.
    return { ok: false, error: 'bash is required to run the installer' }
  }

  const url = options.installUrl ?? installUrl(options.env)
  const script = run('curl', ['-fsSL', url])
  if (script.status !== 0 || script.stdout === '') {
    return { ok: false, error: `could not fetch the installer from ${url}` }
  }

  const result = withUpgradeLock(lock, () =>
    run('bash', [], { input: script.stdout, env: { ...(options.env ?? process.env), QIALIKE_VERSION: target } }),
  )
  if (result === undefined) return { ok: false, error: 'another upgrade is already running' }
  if (result.status !== 0) {
    const detail = result.stderr.trim().split('\n').pop() ?? `exit ${result.status}`
    return { ok: false, error: `installer failed: ${detail}` }
  }

  return { ok: true, version: installedVersion({ dir, run }) }
}
