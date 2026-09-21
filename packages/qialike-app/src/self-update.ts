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
 * **Windows is detect-only.** Two facts make in-place replacement impossible
 * there and neither is a policy choice: a running `.exe` cannot be overwritten
 * (the `mv` that saves a running ELF on POSIX does not work on Windows), and the
 * installer is bash, which the platform does not ship. `upgrade()` therefore
 * refuses on `win32`, and the notice carries download links instead — see
 * `downloadUrls()`. `nullDevice()` and `binaryName()` exist for the same reason:
 * both are spellings that differ on Windows, and each silently broke one half of
 * the chain (the probe and the install guard respectively).
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

/**
 * The name the binary has ON DISK for a platform.
 *
 * Windows cannot run a suffix-less executable, so the release archive carries
 * `qialike.exe` there (`scripts/install.d/20-platform.sh` derives the same name
 * from the archive member). Every place that builds a path to the installed
 * binary has to use this rather than `BIN`: the guard in `upgrade()` used `BIN`
 * and therefore reported "not installed at …\qialike" on a Windows machine where
 * the file was sitting right beside it as `qialike.exe`.
 */
export function binaryName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? `${BIN}.exe` : BIN
}

/**
 * The curl output path that discards a response body on this platform.
 *
 * NOT `/dev/null` everywhere. Measured on Windows 11 with the shipped
 * `C:\Windows\System32\curl.exe` (8.21.0), against the real release host:
 * `curl -fsS -o /dev/null -w '%{http_code} %{filename_effective}' …` answers
 * `302 /dev/null` — the request succeeds and the redirect is resolved — and then
 * exits **23**, because curl did NOT map the POSIX spelling onto the null device:
 * it tried to create the literal file `<drive>:\dev\null` and failed (`C:\dev` is
 * never created, on an administrator's account either). `-o NUL` prints
 * `302 NUL` and exits 0.
 *
 * That exit status is the whole problem: `latestFrom` only believes a tag when
 * curl exited 0, so on Windows the PRIMARY (GitHub) probe always threw its tag
 * away — measured end to end on the released 0.6.1 build, whose `--check` against
 * a GitHub-only source list answered "could not determine the newest version (no
 * network?)". It looked healthy only because the source list has a second entry:
 * the gitcode mirror's API call passes no `-o` at all, so the update was resolved
 * through the MIRROR. Requirement "GitHub first, mirror as the fallback" had
 * silently collapsed into "mirror only" on Windows.
 */
export function nullDevice(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'NUL' : '/dev/null'
}

/** The releases directory the installer also defaults to. */
export const DEFAULT_RELEASES_URL = 'https://github.com/qialike/qialike/releases'

/** Where the installer script is fetched from when upgrading. */
export const DEFAULT_INSTALL_URL = 'https://qialike.com/install'

/** How much of an asset a source is asked to deliver when it is being measured. */
export const MEASURE_BYTES = 262144

/** How long one source gets to deliver that sample, in seconds. */
export const MEASURE_TIMEOUT = '8'

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
  // download 55 MB. The output path is the platform's null device — see
  // `nullDevice()` for why the POSIX spelling silently killed this probe on Windows.
  const redirect = run('curl', ['-fsS', ...budget, '-o', nullDevice(), '-w', '%{redirect_url}', `${source.base}/latest/download/${asset}`])
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

/**
 * Where a person can fetch one release by hand, one URL per release source.
 *
 * Windows never installs an update itself (see the module note), so a notice to a
 * Windows user has to carry a LINK rather than a command — and it carries every
 * source, primary first, because the user who needs this most is the one behind a
 * blocked GitHub who must recognise the mirror as the way out.
 *
 * With no version to name (nothing resolved yet, or `upgrade` refusing offline)
 * or no asset for this platform, the releases page is the honest answer: it always
 * resolves, where a guessed asset name would 404.
 */
export function downloadUrls(
  version: string | undefined,
  options: { target?: string; sources?: readonly ReleaseSource[] } = {},
): string[] {
  const sources = options.sources ?? releaseSources()
  const target = options.target ?? detectTarget()
  const asset = target === undefined ? undefined : assetFor(target)
  if (version === undefined || asset === undefined) return sources.map((source) => source.base)
  return sources.map((source) => `${source.base}/download/${version}/${asset}`)
}

/**
 * How fast one source can actually deliver this release, in bytes per second, or
 * undefined when it cannot serve it at all.
 *
 * This is the same measurement the installer makes (`scripts/install.d/40-fetch.sh`),
 * and it exists here for a reason the installer cannot cover: the updater's choice of
 * host used to be whatever the DEPLOYED `/install` decided, so a deployed script
 * without the measurement — which is exactly what was live when this was written —
 * kept a throttled GitHub in the path. Measuring here makes the choice the updater's
 * own.
 *
 * Reachability is a different question from throughput: GitHub answers the small
 * `latest/download` redirect from `github.com` and serves the body from
 * `release-assets.githubusercontent.com`, so a GitHub whose asset CDN is throttled
 * passes every probe and then crawls.
 *
 * The exit status is deliberately ignored: the source that needs measuring most is the
 * one that hits `--max-time`, and curl still prints the speed it managed. Only "not a
 * single byte" (a dead host, or a mirror that has not caught up to this tag and 404s)
 * means "not a candidate".
 */
export function measureSpeed(
  source: ReleaseSource,
  version: string,
  options: { target?: string; run?: Runner } = {},
): number | undefined {
  const target = options.target ?? detectTarget()
  const asset = target === undefined ? undefined : assetFor(target)
  if (asset === undefined) return undefined

  const run = options.run ?? runShell
  const result = run('curl', [
    '-fsSL',
    '-r', `0-${MEASURE_BYTES - 1}`,
    '--connect-timeout', CONNECT_TIMEOUT,
    '--max-time', MEASURE_TIMEOUT,
    '-o', nullDevice(),
    '-w', '%{speed_download}',
    `${source.base}/download/${version}/${asset}`,
  ])
  const speed = Number.parseFloat(result.stdout.trim())
  if (!Number.isFinite(speed) || speed <= 0) return undefined
  return speed
}

/**
 * The fastest source that can serve this release, or undefined when none can.
 *
 * Ties keep the earlier source, so an inconclusive comparison leaves the configured
 * order exactly as it was.
 */
export function fastestSource(
  sources: readonly ReleaseSource[],
  version: string,
  options: { target?: string; run?: Runner } = {},
): ReleaseSource | undefined {
  if (sources.length < 2) return undefined

  let best: ReleaseSource | undefined
  let bestSpeed = 0
  for (const source of sources) {
    const speed = measureSpeed(source, version, options)
    if (speed === undefined) continue
    if (best === undefined || speed > bestSpeed) {
      best = source
      bestSpeed = speed
    }
  }
  return best
}

/**
 * The status the installer exits with when NO configured release source is reachable
 * — the fourth case of the source policy (`scripts/install.d/30-version.sh` decides
 * it, and `EXIT_NO_SOURCE` there carries the same number).
 *
 * It exists so this side can tell "the network is not there, nothing was written, the
 * installed copy still works" apart from "the install failed". The first is not worth
 * reporting to anyone or retrying; the second is.
 */
export const EXIT_NO_SOURCE = 3

/** What an update attempt that reached nobody reports. */
export const NO_SOURCE_ERROR = 'no release source is reachable — keeping the installed version'

/**
 * Did this source answer AT ALL?
 *
 * Any status counts — the question is whether the host replied, not whether it liked
 * the path — so a 404 from a live host is reachable while a refused or blackholed
 * connection is not. `-f` is deliberately absent (it would turn a 404 into a failure)
 * and `%{http_code}` is read instead, because curl prints `000` when no response
 * arrived: only that definite answer counts as unreachable. An empty or unparsable
 * answer means the probe itself said nothing, and guessing "down" there would stop an
 * update that might have worked.
 *
 * `-I` (HEAD), not a plain GET: the releases page is ~234 KB on GitHub (measured) and
 * only the answer is wanted. Measured on both hosts: HEAD answers `200` with
 * `size_download=0` in 0.23 s (GitHub) / 0.39 s (gitcode).
 */
export function sourceReachable(source: ReleaseSource, options: { run?: Runner } = {}): boolean {
  const run = options.run ?? runShell
  const result = run('curl', [
    '-sS',
    '-I',
    '-o', nullDevice(),
    '-w', '%{http_code}',
    '--connect-timeout', CONNECT_TIMEOUT,
    '--max-time', PROBE_TIMEOUT,
    source.base,
  ])
  return result.stdout.trim() !== '000'
}

/** What `routeUpgrade` decided about where an update would come from. */
export type SourceRoute =
  /** One source to hand the installer as `QIALIKE_INSTALL_BASE_URL`. */
  | { kind: 'pinned'; source: ReleaseSource }
  /** Some source is there, but nothing could be compared: let the installer decide. */
  | { kind: 'unpinned' }
  /** Nothing answered (case 4): no attempt is worth making. */
  | { kind: 'unreachable' }

/**
 * Where the update should come from — the source policy, applied by the updater.
 *
 * The four cases are the installer's (`scripts/install.d/30-version.sh`), applied in
 * the same order, and they are applied here as well because the updater used to leave
 * this entirely to the DEPLOYED `/install`: with no comparison of its own, a throttled
 * GitHub stayed in the automatic path whatever this repository said.
 *
 *   1. only the mirror answers -> pin the mirror
 *   2. only the primary answers -> pin the primary
 *   3. both answer -> sample both, pin the faster one
 *   4. neither answers -> unreachable, and nothing is spawned
 *
 * CONNECTIVITY FIRST, then throughput: a host that cannot be reached is not a
 * candidate for anything, and sampling it would only buy a connect timeout. The two
 * questions are different — a host can answer "what is your newest release" and then
 * crawl on the 55 MB body, which is why case 3 has to measure at all.
 *
 * `measure: false` is the documented `QIALIKE_INSTALL_MEASURE=0`: no comparison, so
 * the installer's own list decides — but the connectivity question is still asked,
 * because case 4 is about whether an attempt is worth making at all.
 */
export function routeUpgrade(
  sources: readonly ReleaseSource[],
  version: string,
  options: { measure?: boolean; target?: string; run?: Runner } = {},
): SourceRoute {
  const run = options.run ?? runShell
  const measure = options.measure ?? true

  const reachable = sources.filter((source) => sourceReachable(source, { run }))
  if (reachable.length === 0) return { kind: 'unreachable' }
  if (reachable.length === 1) return { kind: 'pinned', source: reachable[0] as ReleaseSource }

  // Two or more answered, so the body decides — unless the comparison was refused.
  if (measure) {
    const fastest = fastestSource(reachable, version, { target: options.target, run })
    if (fastest !== undefined) return { kind: 'pinned', source: fastest }
  }
  return { kind: 'unpinned' }
}

/** The version the installed binary reports, or undefined if it will not run. */
export function installedVersion(options: { dir?: string; run?: Runner; platform?: NodeJS.Platform } = {}): string | undefined {
  const dir = options.dir ?? installDir()
  const run = options.run ?? runShell
  const result = run(join(dir, binaryName(options.platform)), ['--version'])
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
  /**
   * Case 4 of the source policy: nobody answered, so NOTHING was attempted and the
   * installed copy is untouched. Callers branch on this instead of on `error` text —
   * an automatic check keeps the installed version and says nothing, while an explicit
   * `qialike upgrade` tells the user why there is nothing to install.
   */
  unreachable?: boolean
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
 *
 * Windows is refused outright, and before anything is spawned: there is no `mv`
 * that replaces a running `.exe`, and no bash to run the installer with. The
 * refusal names the manual route, which is the only one that exists there — see
 * `downloadUrls()` for the links the caller prints with it.
 */
export function upgrade(
  target: string,
  options: {
    installUrl?: string
    dir?: string
    lock?: string
    run?: Runner
    env?: NodeJS.ProcessEnv
    platform?: NodeJS.Platform
    /** Override the measurement decision (tests, and the env hatch it mirrors). */
    measure?: boolean
  } = {},
): UpgradeResult {
  const run = options.run ?? runShell
  const dir = options.dir ?? installDir()
  const platform = options.platform ?? process.platform
  // The lock sits beside the binary it guards, so an overridden install dir gets
  // its own lock rather than contending on the default home's.
  const lock = options.lock ?? join(dir, '.upgrade.lock')

  if (platform === 'win32') {
    return { ok: false, error: 'qialike does not replace a running .exe on Windows — update it by hand' }
  }
  // The platform's own name: a Windows build is `qialike.exe` on disk, and asking
  // for `qialike` there answered "not installed" about a file that was present.
  const binary = join(dir, binaryName(platform))
  if (!existsSync(binary)) {
    return { ok: false, error: `qialike is not installed at ${binary}` }
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

  const env = options.env ?? process.env
  // Which host to hand the installer, decided HERE rather than left to the deployed
  // script (`measureSpeed` explains why). Only for the built-in pair: an explicit
  // `QIALIKE_INSTALL_BASE_URL` or `QIALIKE_INSTALL_SOURCES` is the user's call, and
  // `QIALIKE_INSTALL_MEASURE=0` is the documented way to refuse the comparison.
  const explicit = env.QIALIKE_INSTALL_BASE_URL !== undefined || env.QIALIKE_INSTALL_SOURCES !== undefined
  const measure = options.measure ?? env.QIALIKE_INSTALL_MEASURE !== '0'
  const sources = releaseSources(env)
  let pinned: ReleaseSource | undefined
  if (!explicit) {
    const route = routeUpgrade(sources, target, { measure, run })
    // Case 4: with no reachable source there is nothing to try. Not spawning bash at
    // all is the point — the installer would reach the same conclusion, twice (once
    // per attempt), and report it as a failure of an attempt that was never possible.
    if (route.kind === 'unreachable') return { ok: false, unreachable: true, error: NO_SOURCE_ERROR }
    if (route.kind === 'pinned') pinned = route.source
  }

  // The winner goes in as `QIALIKE_INSTALL_BASE_URL`, which EVERY installer version
  // understands — including the ones deployed before the measurement existed. The
  // price is that a pinned host has no fallback, so a failed attempt is retried once
  // without the pin, and that retry gets the installer's own list (and its own
  // comparison, if it has one). Both attempts are inside the lock: another upgrade
  // must not slip between them.
  const result = withUpgradeLock(lock, () => {
    const attempt = (extra: NodeJS.ProcessEnv) =>
      run('bash', [], { input: script.stdout, env: { ...env, QIALIKE_VERSION: target, ...extra } })

    const first = pinned === undefined
      ? attempt({})
      : attempt({ QIALIKE_INSTALL_BASE_URL: pinned.base, QIALIKE_INSTALL_MEASURE: '0' })
    if (first.status === 0 || pinned === undefined) return first
    // The retry is worth making even when the pinned host answered case 4: the host may
    // have gone away between the measurement and the download, and the other source is
    // still there.
    return attempt({})
  })
  if (result === undefined) return { ok: false, error: 'another upgrade is already running' }
  // The installer decided case 4 for itself (a host died, or the pin pointed at a
  // network that is gone): report it as "keep the installed version", not as a failed
  // attempt — that is the same distinction, one layer down.
  if (result.status === EXIT_NO_SOURCE) return { ok: false, unreachable: true, error: NO_SOURCE_ERROR }
  if (result.status !== 0) {
    const detail = result.stderr.trim().split('\n').pop() ?? `exit ${result.status}`
    return { ok: false, error: `installer failed: ${detail}` }
  }

  return { ok: true, version: installedVersion({ dir, run, platform }) }
}
