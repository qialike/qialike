/**
 * Which qialike site this machine should be pointed at.
 *
 * WHY THIS EXISTS. The hero's caption line (`Ver: … . URL: …`) and the installer
 * URL used by `/upgrade` were both a baked `https://qialike.com`. qialike runs two
 * independent deployments — the international site and the mainland one
 * (`qialike.cn`: its own console, its own key store, its own model catalogue) — and
 * a mainland user is better served by the one that is not a border away. Nothing in
 * the shipped binary distinguishes the two: both domains serve the SAME artifact
 * (`install` is byte-identical, the release assets are the same size), so the
 * decision has to be made on the machine, at run time.
 *
 * WHAT "IN CHINA" MEANS HERE. Not IP geolocation — that would need a network round
 * trip on the startup path, which this app keeps free of I/O (measured: ~470 ms to
 * the hero, unchanged by any provider configuration). Two offline signals instead,
 * both standard for terminal software:
 *
 *   ② the TERRITORY of the POSIX locale (`zh_CN.UTF-8` → `CN`). This is how git,
 *      vim, gcc and apt decide their language: `LC_ALL` > `LC_MESSAGES` > `LANG`,
 *      value `language_TERRITORY.codeset`.
 *   ③ the time zone (`Asia/Shanghai` …). Locale encodes a PREFERENCE; the zone
 *      encodes where the machine actually is, which is the question being asked.
 *      Windows has no `LANG`, so for a mainland Windows box this is the only signal.
 *
 * Either one landing on China is enough: a mainland Linux/macOS machine satisfies
 * both, and a mainland Windows machine satisfies only ③.
 *
 * A BUN GOTCHA, MEASURED. `Intl.DateTimeFormat().resolvedOptions().locale` reports
 * `en-US` no matter what `LANG`/`LC_ALL` say in this runtime (verified with
 * `LANG=zh_CN.UTF-8` and with `LC_ALL=zh_CN.UTF-8`), so the locale has to be parsed
 * out of the environment by hand — `Intl` is only usable for the TIME ZONE, which it
 * does honour (and derive from `/etc/localtime` when `TZ` is unset).
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
 * Time zones that mean mainland China.
 *
 * `Asia/Shanghai` is the one a modern install reports; the others are the historical
 * aliases still found in `/etc/timezone` and in old images. Hong Kong, Macau and
 * Taipei are deliberately absent: they are separate regions with their own
 * connectivity, and `.com` is the right default for them.
 */
export const CHINA_TIME_ZONES: readonly string[] = [
  'Asia/Shanghai',
  'Asia/Chongqing',
  'Asia/Harbin',
  'Asia/Urumqi',
  'PRC',
]

/**
 * The territory subtag of a POSIX locale, upper-cased.
 *
 * Accepts both spellings seen in the wild: `zh_CN.UTF-8` (POSIX) and `zh-CN` (BCP 47).
 * @param locale - the raw environment value, e.g. `zh_CN.UTF-8`.
 * @returns `CN`, `US`, … or `undefined` for `C`, `POSIX`, an empty value or anything
 *   without a territory.
 */
export function localeTerritory(locale: string | undefined): string | undefined {
  if (locale === undefined) return undefined
  const match = /^[a-z]{2,3}[_-]([A-Za-z]{2})(?:[.@]|$)/.exec(locale.trim())
  return match?.[1]?.toUpperCase()
}

/** The platform's IANA time zone, or `undefined` when the runtime cannot say. */
export function systemTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined
  } catch {
    return undefined
  }
}

/**
 * Decide which site to point at.
 *
 * Precedence: explicit override → locale territory → time zone → international.
 * @param env - environment to read (`QIALIKE_SITE`, `LC_ALL`, `LC_MESSAGES`, `LANG`).
 * @param timeZone - the zone to judge; defaults to the platform's.
 * @returns the site base URL, with no trailing slash.
 */
export function resolveSiteUrl(
  env: NodeJS.ProcessEnv = process.env,
  timeZone: string | undefined = systemTimeZone(),
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
  // POSIX precedence: `LC_ALL` beats `LC_MESSAGES` beats `LANG`, and the first one that
  // is SET decides — the others are not consulted at all. (Taking the first variable
  // that happens to say `CN` would let a leftover `LANG=zh_CN` override an explicit
  // `LC_ALL=en_US.UTF-8`, which is the opposite of what every `ls` and `git` does.)
  for (const name of ['LC_ALL', 'LC_MESSAGES', 'LANG']) {
    const raw = env[name]
    if (raw === undefined || raw.trim() === '') continue
    if (localeTerritory(raw) === 'CN') return SITE_URL_CN
    break
  }
  if (timeZone !== undefined && CHINA_TIME_ZONES.includes(timeZone)) return SITE_URL_CN
  return SITE_URL_COM
}

/** Memoised {@link resolveSiteUrl} for the render path: the answer cannot change
 *  during a run, and the hero asks on every frame. */
let resolved: string | undefined
export function siteUrl(): string {
  resolved ??= resolveSiteUrl()
  return resolved
}
