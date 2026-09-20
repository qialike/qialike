/**
 * When qialike is allowed to replace itself, and what it should do instead.
 *
 * The policy is split from the IO on purpose: everything here is a pure function
 * of its inputs (plus one thin settings accessor), so the gate matrix is testable
 * without a network, a filesystem or a Cordis tree.
 *
 * The shape follows opencode's `cli/upgrade.ts`: only a **patch** release is
 * installed silently, anything that moves the minor or major version is merely
 * announced. Two gates are qialike's own, and both exist because its situation
 * differs from opencode's:
 *
 *  - `BUILD_MODE === 'dev'` — opencode leans on its install-method probe to keep
 *    a checkout build from self-updating (`execPath` outside the install dir →
 *    `unknown`). That fallback does NOT cover qialike: this project's installer
 *    puts the binary in `~/.dsh/bin`, so a locally built dev binary that was
 *    installed there looks exactly like a released one and would be silently
 *    replaced by the published version.
 *  - `method === 'unknown'` as an explicit skip once we get past the notify
 *    branch — there is nothing to self-install over.
 *
 * @module @yourname/qialike-app/upgrade-policy
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { BUILD_MODE } from './build-mode.ts'
import type { BuildMode } from './version-footer.ts'

/** The settings namespace holding the update switch. */
export const UPDATE_NS = 'qialike-update'

/**
 * `auto` mirrors opencode's three-state switch: `true` (install patch releases),
 * `false` (never even check) and `"notify"` (check, announce, never install).
 */
const UpdateSchema = z.object({ auto: z.union([z.boolean(), z.union(['notify'])]) })

/** The `qialike-update.auto` values. */
export type AutoMode = boolean | 'notify'

/** How a newer release relates to the running one. */
export type ReleaseType = 'patch' | 'minor' | 'major'

/** Whether this installation is one the updater may replace. */
export type InstallMethod = 'curl' | 'unknown'

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
 *  - the notify branch is checked BEFORE the install-method gate (as in
 *    opencode), so an install the updater cannot manage is still *announced*
 *    when the release is not a patch — silence there would hide a minor or major
 *    upgrade from exactly the users who must act on it manually.
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
 * Register the settings namespace.
 *
 * Called from the existing `tui-runtime` plugin rather than from a plugin of its
 * own: the updater is not a Cordis child plugin (it must also work outside the
 * tree), so this is one registration call, not a new row in `cordis.patch.yml`.
 */
export function registerUpdateSettings(ctx: Context): void {
  const settings = ctx.get('settings') as { register(ns: string, schema: unknown, options?: unknown): unknown } | undefined
  if (settings === undefined) return
  settings.register(UPDATE_NS, UpdateSchema as never, {})
}

/**
 * The configured `auto` value, defaulting to `true` (install patch releases).
 *
 * An unregistered or malformed section falls back to the default rather than
 * throwing: a bad settings file must never keep the app from booting, and must
 * never silently turn updates into "off" either — the explicit `false` is the
 * only way to stop checking.
 */
export function readUpdateSettings(ctx: Context): AutoMode {
  const settings = ctx.get('settings') as { get(ns: string): unknown } | undefined
  const node = settings?.get(UPDATE_NS)
  if (node !== null && typeof node === 'object' && 'auto' in node) {
    const auto = (node as { auto?: unknown }).auto
    if (auto === true || auto === false || auto === 'notify') return auto
  }
  return true
}
