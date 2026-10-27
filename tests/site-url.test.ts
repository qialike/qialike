/**
 * Which site the hero points at, from the SYSTEM LANGUAGE.
 *
 * WHY THIS EXISTS. qialike runs two independent deployments — `.com` international and
 * `.cn` mainland, separate consoles, key stores and catalogues — and both domains
 * serve the SAME binary, so nothing in the artifact distinguishes them. The hero
 * caption therefore picks one at run time, and the signal (user call, 2026-10-27) is
 * the system language: Simplified Chinese → `.cn`, everything else → `.com`.
 *
 * LANGUAGE, NOT LOCATION. An earlier attempt also consulted the time zone so that a
 * machine physically in China was caught whatever its interface language was. That
 * was withdrawn: a person running their system in English asked for English. The zone
 * is not consulted — there is no test for it here because there is no code for it.
 *
 * The cases below are the ones that actually decide the site on real machines,
 * including the Traditional-Chinese ones that must NOT get `.cn`.
 *
 * Run with `bun test tests/site-url.test.ts`.
 *
 * @module qialike/site-url-test
 */

import { describe, expect, test } from 'bun:test'
import {
  effectiveLocale,
  isSimplifiedChinese,
  localeParts,
  resolveSiteUrl,
  runtimeLocale,
  SITE_ENV,
  SITE_URL_CN,
  SITE_URL_COM,
  siteUrl,
  systemLanguageIsSimplifiedChinese,
} from '../packages/qialike-app/src/site-url.ts'
import { HERO_ART_MIN_WIDTH, HERO_CAPTION_URL } from '../packages/qialike-app/src/hero-layout.ts'
import { heroVersionCaption } from '../packages/qialike-app/src/version-footer.ts'
import { installUrl } from '../packages/qialike-app/src/self-update.ts'

/** Resolve with a clean environment and no `Intl` contribution, so the host's own
 *  locale cannot leak into a case. */
const at = (env: NodeJS.ProcessEnv): string => resolveSiteUrl(env as NodeJS.ProcessEnv, undefined)

describe('reading a locale', () => {
  test('both spellings normalise to the same parts', () => {
    expect(localeParts('zh_CN.UTF-8')).toEqual(['zh', 'cn'])
    expect(localeParts('zh-CN')).toEqual(['zh', 'cn'])
    expect(localeParts('zh-Hans-CN')).toEqual(['zh', 'hans', 'cn'])
    expect(localeParts('en_US.UTF-8')).toEqual(['en', 'us'])
    expect(localeParts('zh_CN@variant')).toEqual(['zh', 'cn'])
  })

  test('C and POSIX are "no locale", not a language', () => {
    // What an unconfigured container reports. Treating either as a language would be
    // a guess, which this rule never makes.
    expect(localeParts('C')).toEqual([])
    expect(localeParts('POSIX')).toEqual([])
    expect(localeParts('')).toEqual([])
    expect(localeParts(undefined)).toEqual([])
  })
})

describe('what counts as Simplified Chinese', () => {
  test('the mainland and the other Simplified regions', () => {
    expect(isSimplifiedChinese('zh_CN.UTF-8')).toBe(true)
    expect(isSimplifiedChinese('zh-CN')).toBe(true)
    // Singapore and Malaysia write Chinese in Simplified characters.
    expect(isSimplifiedChinese('zh_SG.UTF-8')).toBe(true)
    expect(isSimplifiedChinese('zh_MY')).toBe(true)
  })

  test('an explicit script subtag decides on its own', () => {
    expect(isSimplifiedChinese('zh-Hans')).toBe(true)
    expect(isSimplifiedChinese('zh-Hans-HK'), 'script beats region').toBe(true)
    expect(isSimplifiedChinese('zh-Hant-CN'), 'script beats region').toBe(false)
  })

  test('Traditional Chinese does not get the mainland site', () => {
    // These are the cases a naive `zh` prefix test would get wrong.
    expect(isSimplifiedChinese('zh_TW.UTF-8')).toBe(false)
    expect(isSimplifiedChinese('zh_HK')).toBe(false)
    expect(isSimplifiedChinese('zh_MO')).toBe(false)
    expect(isSimplifiedChinese('zh-Hant')).toBe(false)
  })

  test('a bare `zh` is Simplified — and that is a decision, not an accident', () => {
    // An unqualified `zh` is what a system means by "Chinese", and it practically
    // always means Simplified; `.cn` is the Simplified site.
    expect(isSimplifiedChinese('zh')).toBe(true)
  })

  test('everything else is not', () => {
    for (const locale of ['en_US.UTF-8', 'ja_JP.UTF-8', 'ko_KR', 'de-DE', 'fr_FR', 'C', 'POSIX']) {
      expect(isSimplifiedChinese(locale), locale).toBe(false)
    }
  })
})

describe('reading the environment', () => {
  test('POSIX precedence: LC_ALL beats LC_MESSAGES beats LANG', () => {
    expect(effectiveLocale({ LC_ALL: 'zh_CN.UTF-8', LANG: 'en_US.UTF-8' })).toBe('zh_CN.UTF-8')
    expect(effectiveLocale({ LC_MESSAGES: 'zh_CN.UTF-8', LANG: 'en_US.UTF-8' })).toBe('zh_CN.UTF-8')
    expect(effectiveLocale({ LANG: 'zh_CN.UTF-8' })).toBe('zh_CN.UTF-8')
    expect(effectiveLocale({})).toBeUndefined()
  })

  test('an empty variable is skipped, not treated as a language', () => {
    expect(effectiveLocale({ LC_ALL: '', LANG: 'zh_CN.UTF-8' })).toBe('zh_CN.UTF-8')
  })

  test('LANGUAGE is only consulted when no POSIX variable is set', () => {
    // `zh_CN:zh:en_US:en` — the first entry naming Chinese decides.
    expect(systemLanguageIsSimplifiedChinese({ LANGUAGE: 'zh_CN:en_US' }, undefined)).toBe(true)
    expect(systemLanguageIsSimplifiedChinese({ LANGUAGE: 'en_US:zh_CN' }, undefined)).toBe(false)
    // …but a POSIX variable outranks it, because that is the locale the process runs
    // under (`LANGUAGE` is a message-catalogue hint, nothing more).
    expect(systemLanguageIsSimplifiedChinese({ LANG: 'en_US.UTF-8', LANGUAGE: 'zh_CN' }, undefined))
      .toBe(false)
  })
})

describe('deciding the site', () => {
  test('a Simplified Chinese system gets .cn', () => {
    expect(at({ LANG: 'zh_CN.UTF-8' })).toBe(SITE_URL_CN)
  })

  test('an English system gets .com — measured on the reference host', () => {
    // This machine: `LANG=en_US.UTF-8`, `/etc/timezone` = Asia/Singapore, egress in
    // Singapore. `.com` is the CORRECT answer, and the zone is not consulted.
    expect(at({ LANG: 'en_US.UTF-8' })).toBe(SITE_URL_COM)
  })

  test('an English interface on a machine in China still gets .com', () => {
    // The whole point of dropping the time zone: the language is what the user chose.
    expect(at({ LANG: 'en_US.UTF-8', TZ: 'Asia/Shanghai' })).toBe(SITE_URL_COM)
  })

  test('Traditional Chinese systems get .com', () => {
    expect(at({ LANG: 'zh_TW.UTF-8' })).toBe(SITE_URL_COM)
    expect(at({ LANG: 'zh_HK.UTF-8' })).toBe(SITE_URL_COM)
  })

  test('no signal at all falls back to the international site', () => {
    expect(at({})).toBe(SITE_URL_COM)
  })
})

describe('the explicit override', () => {
  test('QIALIKE_SITE wins over the language', () => {
    expect(at({ [SITE_ENV]: 'cn', LANG: 'en_US.UTF-8' })).toBe(SITE_URL_CN)
    expect(at({ [SITE_ENV]: 'com', LANG: 'zh_CN.UTF-8' })).toBe(SITE_URL_COM)
    expect(at({ [SITE_ENV]: 'global', LANG: 'zh_CN.UTF-8' })).toBe(SITE_URL_COM)
    expect(at({ [SITE_ENV]: 'CN' }), 'case-insensitive').toBe(SITE_URL_CN)
  })

  test('a full URL is taken verbatim, minus a trailing slash', () => {
    expect(at({ [SITE_ENV]: 'https://staging.example' })).toBe('https://staging.example')
    expect(at({ [SITE_ENV]: 'https://staging.example/' })).toBe('https://staging.example')
  })

  test('a typo falls through to detection instead of pinning a site', () => {
    // `cnn` must not silently pin the international site on a Chinese machine.
    expect(at({ [SITE_ENV]: 'cnn', LANG: 'zh_CN.UTF-8' })).toBe(SITE_URL_CN)
  })
})

describe('the surfaces that use it', () => {
  test('the memoised accessor agrees with the resolver on this host', () => {
    // Whatever this machine is, both paths must give the same answer.
    expect(siteUrl()).toBe(resolveSiteUrl())
  })

  test('/upgrade does NOT follow the language, and that is deliberate', () => {
    // The two installers have DIVERGED: `.cn`'s carries a gitcode-only source list
    // (measured 2026-10-27, the md5s no longer match). Following the site would drop
    // GitHub from the upgrade path, so `/upgrade` stays on `.com` for everyone.
    const zh = installUrl({ LANG: 'zh_CN.UTF-8' } as NodeJS.ProcessEnv)
    const en = installUrl({ LANG: 'en_US.UTF-8' } as NodeJS.ProcessEnv)
    expect(zh).toBe(en)
    expect(zh).toBe('https://qialike.com/install')
  })

  test('the Intl bridge is harmless where it cannot work', () => {
    // Measured: on Linux this returns `en-US` whatever the environment says, so it
    // cannot manufacture a `.cn`. (On Windows it is the only possible source, since
    // there is no `LANG` — unverified, no Windows host available.)
    const runtime = runtimeLocale()
    if (runtime === 'en-US') expect(siteUrl()).toBe(at({ LANG: 'en_US.UTF-8' }))
  })
})

describe('the caption stays inside the brand mark', () => {
  test('both sites fit, and the exported constant is the wide one', () => {
    // The caption is centred UNDER the wordmark, so the mark's own floor is the
    // tightest width it is ever asked to fit.
    expect(HERO_CAPTION_URL).toBe(SITE_URL_COM)
    for (const url of [SITE_URL_COM, SITE_URL_CN]) {
      const line = heroVersionCaption('0.11.7', 'beta', url)
      expect(line.length, `${url} must stay ASCII so its width is its length`)
        .toBeLessThanOrEqual(HERO_ART_MIN_WIDTH)
    }
    // `.cn` is the shorter of the two, so a machine switched to it can never overflow
    // where `.com` did not.
    expect(SITE_URL_CN.length).toBeLessThan(SITE_URL_COM.length)
  })

  test('the caption carries the site again, and the version is always there', () => {
    const line = heroVersionCaption('0.11.7', 'beta', SITE_URL_CN)
    expect(line).toBe('Ver: 0.11.7 beta . URL: https://qialike.cn')
    expect(heroVersionCaption('0.11.7', 'beta')).toBe('Ver: 0.11.7 beta')
  })
})
