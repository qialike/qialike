/**
 * Which qialike site the hero caption points at, from the SYSTEM LANGUAGE.
 *
 * WHY THIS EXISTS. qialike runs two independent deployments — `qialike.com`
 * (international) and `qialike.cn` (mainland: its own console, key store and model
 * catalogue) — and both serve the SAME binary (the release assets match byte for
 * byte), so nothing in the artifact can tell the two apart. The hero's caption
 * therefore has to pick one at run time, and the signal (user call, 2026-10-27) is
 * the system language: Simplified Chinese gets `.cn`, everything else `.com`.
 *
 * LANGUAGE ONLY — NOT LOCATION. An earlier attempt also consulted the time zone, so
 * that "a machine in China" was caught regardless of interface language. That was
 * withdrawn: a person who runs their system in English asked for English, and the
 * language is the thing they actually chose. The zone is not consulted here.
 *
 * WHAT "SIMPLIFIED CHINESE" MEANS. A bare `zh` is treated as Simplified, because
 * that is what practically every system means by an unqualified `zh`, and
 * `qialike.cn` is the Simplified site. The explicit Traditional tags are excluded —
 * `zh_TW`, `zh_HK`, `zh_MO`, and any `zh-Hant` — since those readers are better
 * served by the international site.
 *
 * A BUN GOTCHA, MEASURED (2026-10-27). `Intl.DateTimeFormat().resolvedOptions()
 * .locale` reports `en-US` no matter what `LANG`/`LC_ALL` say, in both `bun run` and
 * a `bun build --compile` binary — so the locale has to be parsed out of the
 * environment by hand. `Intl` is consulted only as a LAST RESORT, as a possible
 * bridge to the platform API on Windows (which has no `LANG`); on Linux it can
 * never contribute, which makes it harmless there. That bridge is UNVERIFIED — no
 * Windows host was available to test it.
 *
 * @module @qialike/qialike-app/site-url
 */

/** The international site. */
export const SITE_URL_COM = 'https://qialike.com'

/** The mainland site — same product, separate deployment and separate credentials. */
export const SITE_URL_CN = 'https://qialike.cn'

/** Environment override, mirroring `QIALIKE_INSTALL_URL` / `QIALIKE_BEE`: one run,
 *  not persisted. Accepts `cn`, `com`/`global`/`intl`, or a full `https://…` base. */
export const SITE_ENV = 'QIALIKE_SITE'

/**
 * Regions whose Chinese is written in Simplified characters.
 *
 * Singapore and Malaysia use Simplified, which is why they belong here and not with
 * the Traditional set. `tw` / `hk` / `mo` are deliberately absent: they are
 * Traditional, so the international site is the better default for them.
 */
const SIMPLIFIED_REGIONS: readonly string[] = ['cn', 'sg', 'my']

/**
 * The tags that mean Traditional Chinese. Listed rather than inferred so an
 * unfamiliar region does not silently fall into one bucket or the other.
 */
const TRADITIONAL_REGIONS: readonly string[] = ['tw', 'hk', 'mo']

/**
 * Normalise a POSIX or BCP 47 locale to lower-case, hyphen-separated parts.
 * @param locale - e.g. `zh_CN.UTF-8`, `zh-Hans-CN`, `en_US`.
 * @returns the tag parts, e.g. `['zh', 'cn']`; empty for `C`/`POSIX`/blank.
 */
export function localeParts(locale: string | undefined): string[] {
  if (locale === undefined) return []
  // POSIX is `language_TERRITORY.codeset@modifier`; BCP 47 uses hyphens throughout.
  // Strip the codeset and the modifier first, then normalise the separator.
  const tag = (locale.trim().toLowerCase().split('.')[0] ?? '').split('@')[0]?.replace(/_/g, '-') ?? ''
  if (tag === '' || tag === 'c' || tag === 'posix') return []
  return tag.split('-').filter((part) => part !== '')
}

/**
 * Whether a locale means Simplified Chinese.
 *
 * The SCRIPT subtag wins when present (`zh-Hans` / `zh-Hant`), then the REGION
 * (`zh_CN`, `zh_SG`, `zh_TW`…), and a bare `zh` counts as Simplified.
 * @param locale - a POSIX (`zh_CN.UTF-8`) or BCP 47 (`zh-CN`) locale.
 * @returns `true` for Simplified Chinese, `false` for anything else.
 */
export function isSimplifiedChinese(locale: string | undefined): boolean {
  const parts = localeParts(locale)
  if (parts[0] !== 'zh') return false
  const script = parts.find((part) => part === 'hans' || part === 'hant')
  if (script !== undefined) return script === 'hans'
  const region = parts.slice(1).find((part) => /^[a-z]{2}$/.test(part))
  if (region === undefined) return true
  if (TRADITIONAL_REGIONS.includes(region)) return false
  return SIMPLIFIED_REGIONS.includes(region)
}

/** The locale the process actually runs under, per POSIX precedence.
 *
 * `LC_ALL` beats `LC_MESSAGES` beats `LANG`, and the first one that is SET decides —
 * the others are not consulted. (Taking the first variable that merely happens to be
 * Chinese would let a leftover `LANG=zh_CN` override an explicit
 * `LC_ALL=en_US.UTF-8`, which is the opposite of what `ls` and `git` do.)
 * @param env - environment to read.
 * @returns the effective locale string, or `undefined` when none is set.
 */
export function effectiveLocale(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const name of ['LC_ALL', 'LC_MESSAGES', 'LANG']) {
    const raw = env[name]
    if (raw === undefined || raw.trim() === '') continue
    return raw
  }
  return undefined
}

/**
 * The platform locale, asked of `Intl` — the possible Windows bridge.
 *
 * Only reached when no POSIX variable is set, which is the normal state on Windows.
 * Measured to return `en-US` unconditionally on Linux (both under `bun run` and in a
 * compiled binary), so it cannot produce a false `.cn` there.
 * @returns the runtime's locale, or `undefined` when it cannot say.
 */
export function runtimeLocale(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || undefined
  } catch {
    return undefined
  }
}

/**
 * Whether this machine's system language is Simplified Chinese.
 *
 * Order: the POSIX locale, then `LANGUAGE` (a colon-separated GNU preference list,
 * consulted only when no POSIX variable is set), then `Intl`.
 * @param env - environment to read.
 * @param intlLocale - the runtime's locale; defaults to {@link runtimeLocale}.
 * @returns `true` when the interface language is Simplified Chinese.
 */
export function systemLanguageIsSimplifiedChinese(
  env: NodeJS.ProcessEnv = process.env,
  intlLocale: string | undefined = runtimeLocale(),
): boolean {
  const posix = effectiveLocale(env)
  if (posix !== undefined) return isSimplifiedChinese(posix)
  const list = env.LANGUAGE
  if (list !== undefined && list.trim() !== '') {
    // `zh_CN:zh:en_US:en` is a DESCENDING preference list — the FIRST entry is the
    // language the user would get, so it alone decides. Scanning the whole list would
    // call `en_US:zh_CN` Chinese just because Chinese appears somewhere in the
    // fallbacks, which is the opposite of what the list means.
    const preferred = list.split(':').find((entry) => entry.trim() !== '')
    return isSimplifiedChinese(preferred)
  }
  return isSimplifiedChinese(intlLocale)
}

/**
 * Decide which site to point at.
 *
 * Precedence: explicit override → system language → international.
 * @param env - environment to read (`QIALIKE_SITE`, `LC_ALL`, `LC_MESSAGES`, `LANG`,
 *   `LANGUAGE`).
 * @param intlLocale - the runtime's locale; defaults to {@link runtimeLocale}.
 * @returns the site base URL, with no trailing slash.
 */
export function resolveSiteUrl(
  env: NodeJS.ProcessEnv = process.env,
  intlLocale: string | undefined = runtimeLocale(),
): string {
  const explicit = (env[SITE_ENV] ?? '').trim()
  if (explicit !== '') {
    // A full URL is taken as-is: the override's whole point is to not be second-guessed.
    if (/^https?:\/\//i.test(explicit)) return explicit.replace(/\/+$/, '')
    const key = explicit.toLowerCase()
    if (key === 'cn') return SITE_URL_CN
    if (key === 'com' || key === 'global' || key === 'intl') return SITE_URL_COM
    // Unrecognised: fall through to detection rather than silently pinning a site.
  }
  return systemLanguageIsSimplifiedChinese(env, intlLocale) ? SITE_URL_CN : SITE_URL_COM
}

/** Memoised {@link resolveSiteUrl} for the render path: the answer cannot change
 *  during a run, and the hero asks on every frame. */
let resolved: string | undefined
export function siteUrl(): string {
  resolved ??= resolveSiteUrl()
  return resolved
}
