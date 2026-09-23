/**
 * When qialike is allowed to replace itself, and what it should do instead.
 *
 * The policy is split from the IO on purpose: everything here is a pure function
 * of its inputs (plus one thin settings accessor), so the gate matrix is testable
 * without a network, a filesystem or a Cordis tree.
 *
 * The shape follows opencode's `cli/upgrade.ts`: only a **patch** release is
 * installed silently, anything that moves the minor or major version is merely
 * announced. Three gates are qialike's own, and each exists because its situation
 * differs from opencode's:
 *
 *  - `BUILD_MODE === 'dev'` — opencode leans on its install-method probe to keep
 *    a checkout build from self-updating (`execPath` outside the install dir →
 *    `unknown`). That fallback does NOT cover qialike: this project's installer
 *    puts the binary in `~/.dsh/bin`, so a locally built dev binary that was
 *    installed there looks exactly like a released one and would be silently
 *    replaced by the published version.
 *  - `platform === 'windows'` — never install, whatever the release type. A
 *    running `.exe` cannot be replaced (the `mv` that saves a running ELF on
 *    POSIX does not work there) and the installer is bash, which Windows does not
 *    ship, so the only honest action is to announce the release and let the user
 *    replace the file. This is a property of the platform, not a preference: the
 *    `patch`-is-silent rule above simply has no implementation there.
 *  - `method === 'unknown'` as an explicit skip once we get past the notify
 *    branch — there is nothing to self-install over. Note it comes AFTER the
 *    platform gate, so a hand-placed Windows copy is still announced: the user
 *    who downloaded the binary by hand is exactly the one who must download the
 *    next one by hand.
 *
 * @module @qialike/qialike-app/upgrade-policy
 */

import { readSection } from './config.ts'
import { BUILD_MODE } from './build-mode.ts'
import type { BuildMode } from './version-footer.ts'

/**
 * `auto` mirrors opencode's three-state switch: `true` (install patch releases),
 * `false` (never even check) and `"notify"` (check, announce, never install).
 * It lives in `qialike.json` (`readSection('update')`) since 0.1.7 removed the
 * harness's runtime settings namespaces.
 */

/** The `qialike-update.auto` values. */
export type AutoMode = boolean | 'notify'

/** How a newer release relates to the running one. */
export type ReleaseType = 'patch' | 'minor' | 'major'

/** Whether this installation is one the updater may replace. */
export type InstallMethod = 'curl' | 'unknown'

/**
 * The two platform families the policy distinguishes.
 *
 * `windows` cannot replace a running executable, so no release is ever installed
 * there; everything else is treated as POSIX, where the installer's `mv` works.
 */
export type PlatformKind = 'windows' | 'unix'

/** Map a Node platform onto the two families the policy cares about. */
export function platformKind(platform: NodeJS.Platform = process.platform): PlatformKind {
  return platform === 'win32' ? 'windows' : 'unix'
}

/** What the updater should do about one observed pair of versions. */
export type UpdateDecision =
  | { kind: 'skip'; reason: 'disabled' | 'dev-build' | 'unmanaged-install' }
  | { kind: 'up-to-date' }
  | { kind: 'notify'; version: string }
  | { kind: 'install'; version: string }

/** Everything the decision depends on, resolved by the caller. */
export interface PolicyInput {
  /** The version this binary was built as. */
  installed: string
  /** The newest published release tag. */
  latest: string
  /** The `qialike-update.auto` setting. */
  auto: AutoMode
  /** The baked build channel. */
  buildMode: BuildMode
  /** Whether this install is the updater's to manage. */
  method: InstallMethod
  /** The platform family this binary runs on. Windows is announce-only. */
  platform: PlatformKind
  /** `QIALIKE_DISABLE_AUTOUPDATE` was set. */
  disabled: boolean
  /** `QIALIKE_ALWAYS_NOTIFY_UPDATE` was set. */
  alwaysNotify: boolean
}

/** Major/minor/patch of a version, tolerating a `v` prefix, a `-suffix` and junk. */
function versionParts(version: string): [number, number, number] {
  const match = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(version.trim())
  // An unparseable version reads as 0.0.0, which makes any real release look like a
  // move away from it — i.e. "announce, do not install" for the minor/major cases
  // below. Failing towards the quiet branch is the safe direction for a value we
  // could not understand.
  if (match === null) return [0, 0, 0]
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)]
}

/** Major/minor of a version. */
function majorMinor(version: string): { major: number; minor: number } {
  const [major, minor] = versionParts(version)
  return { major, minor }
}

/**
 * Compare two versions: negative when `a` is older than `b`, 0 when equal.
 *
 * Needed because the release SOURCES can disagree. A mirror (gitcode) lags the
 * primary (GitHub), so when the primary is unreachable the newest tag read from the
 * fallback can be OLDER than what is installed. `getReleaseType` compares only
 * major and minor, so 0.6.0 against an installed 0.6.1 classifies as a patch — and
 * the updater would have quietly installed a downgrade.
 */
export function compareVersions(a: string, b: string): number {
  const left = versionParts(a)
  const right = versionParts(b)
  for (let i = 0; i < 3; i += 1) {
    const difference = (left[i] as number) - (right[i] as number)
    if (difference !== 0) return difference
  }
  return 0
}

/**
 * Classify a release the way opencode does: compare major, then minor, and treat
 * everything else (including a bare pre-release suffix) as a patch.
 *
 * No `semver` dependency: `packages/qialike-app` does not depend on it (it is a
 * root devDependency), and adding one to the bundle for two comparisons is not
 * worth the wiring.
 */
export function getReleaseType(current: string, latest: string): ReleaseType {
  const from = majorMinor(current)
  const to = majorMinor(latest)
  if (to.major > from.major) return 'major'
  if (to.minor > from.minor) return 'minor'
  return 'patch'
}

/**
 * Decide what to do, in the order the gates are meant to be read.
 *
 * Ordering matters and is deliberate:
 *  - the two hard stops come first (an explicit off switch, then a dev build);
 *  - `alwaysNotify` is honoured before anything else can silence it, because the
 *    user asked for it by name;
 *  - an already-current version short-circuits before classification;
 *  - the notify branch is checked BEFORE the install gates (as in opencode), so an
 *    install the updater cannot manage is still *announced* when the release is not
 *    a patch — silence there would hide a minor or major upgrade from exactly the
 *    users who must act on it manually;
 *  - Windows is then announced for ANY newer release, patch included, because
 *    "install a patch silently" has no implementation on a platform where the
 *    running `.exe` cannot be replaced;
 *  - only then does an unmanaged install fall through to a skip.
 */
export function decideUpdate(input: PolicyInput): UpdateDecision {
  // Both ways of saying "off" are checked first: the settings switch and the
  // environment kill switch.
  if (input.auto === false || input.disabled) return { kind: 'skip', reason: 'disabled' }
  if (input.buildMode === 'dev') return { kind: 'skip', reason: 'dev-build' }
  if (input.alwaysNotify) return { kind: 'notify', version: input.latest }
  if (input.installed === input.latest) return { kind: 'up-to-date' }
  // A LAGGING SOURCE also lands here, and must not be acted on: when the primary
  // release host is unreachable the newest tag comes from a mirror that may not
  // have caught up, so "newest" can be OLDER than what is installed. Installing it
  // would be a silent downgrade — and because the mirror's tag would then match
  // nothing on the primary, the next check would bounce the user back up and down
  // again. Treat "not newer" as nothing to do.
  if (compareVersions(input.latest, input.installed) < 0) return { kind: 'up-to-date' }

  const release = getReleaseType(input.installed, input.latest)
  if (input.auto === 'notify' || release !== 'patch') return { kind: 'notify', version: input.latest }
  // Windows never installs: the user must fetch the release themselves, so a patch
  // is news there rather than something to do quietly. Checked before the method
  // gate so a hand-placed copy is announced too.
  if (input.platform === 'windows') return { kind: 'notify', version: input.latest }

  if (input.method === 'unknown') return { kind: 'skip', reason: 'unmanaged-install' }
  return { kind: 'install', version: input.latest }
}

/** The truthy spellings the rest of the app accepts for a boolean env var. */
const TRUTHY = /^(1|true|yes|on)$/i

/** The two environment overrides, read once at the edge. */
export function readEnvPolicy(env: NodeJS.ProcessEnv = process.env): { disabled: boolean; alwaysNotify: boolean } {
  return {
    disabled: TRUTHY.test(env.QIALIKE_DISABLE_AUTOUPDATE ?? ''),
    alwaysNotify: TRUTHY.test(env.QIALIKE_ALWAYS_NOTIFY_UPDATE ?? ''),
  }
}

/** The build channel, read from the baked constant — not from the environment. */
export function buildMode(): BuildMode {
  return BUILD_MODE
}

/**
 * The configured `auto` value, defaulting to `true` (install patch releases).
 *
 * An unregistered or malformed section falls back to the default rather than
 * throwing: a bad settings file must never keep the app from booting, and must
 * never silently turn updates into "off" either — the explicit `false` is the
 * only way to stop checking.
 */
export function readUpdateSettings(): AutoMode {
  const node = readSection('update')
  if (node !== null && typeof node === 'object' && 'auto' in node) {
    const auto = (node as { auto?: unknown }).auto
    if (auto === true || auto === false || auto === 'notify') return auto
  }
  return true
}
