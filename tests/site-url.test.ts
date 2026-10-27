/**
 * Which site a machine is pointed at.
 *
 * WHY THIS EXISTS. The hero caption (`Ver: … . URL: …`) and the `/upgrade` installer
 * URL were both a baked `https://qialike.com`. qialike runs two independent
 * deployments — `.com` and `.cn`, separate consoles, key stores and catalogues — and
 * both domains serve the SAME binary (`install` is byte-identical, the release assets
 * match in size), so nothing in the artifact can tell them apart. The choice has to be
 * made from the machine's own signals.
 *
 * The rule has to stay OFFLINE: the startup path is measured at ~470 ms to the hero
 * and does no I/O, so IP geolocation is out by construction. That leaves the two
 * signals terminal software has always used — the POSIX locale's territory and the
 * time zone — plus an explicit override.
 *
 * The cases below are the machines this actually runs on. Note the one that is NOT a
 * bug: a Singapore machine (`en_US` + `Asia/Singapore`) gets `.com`, which is correct.
 *
 * Run with `bun test tests/site-url.test.ts`.
 *
 * @module qialike/site-url-test
 */

import { describe, expect, test } from 'bun:test'
import {
  CHINA_TIME_ZONES,
  localeTerritory,
  resolveSiteUrl,
  SITE_ENV,
  SITE_URL_CN,
  SITE_URL_COM,
  siteUrl,
  systemTimeZone,
} from '../packages/qialike-app/src/site-url.ts'
import { HERO_ART_MIN_WIDTH } from '../packages/qialike-app/src/hero-layout.ts'
import { heroVersionCaption } from '../packages/qialike-app/src/version-footer.ts'
import { installUrl } from '../packages/qialike-app/src/self-update.ts'

/** Resolve with a clean environment, so the host's own locale cannot leak in. */
const at = (env: NodeJS.ProcessEnv, tz: string | undefined): string =>
  resolveSiteUrl(env as NodeJS.ProcessEnv, tz)

describe('the locale territory', () => {
  test('reads the territory out of both spellings', () => {
    expect(localeTerritory('zh_CN.UTF-8')).toBe('CN')
    expect(localeTerritory('zh-CN')).toBe('CN')
    expect(localeTerritory('en_US.UTF-8')).toBe('US')
    expect(localeTerritory('zh_TW.UTF-8')).toBe('TW')
    expect(localeTerritory('zh_CN')).toBe('CN')
    expect(localeTerritory('zh_CN@variant')).toBe('CN')
  })

  test('a locale without a territory is not a region', () => {
    // `C` and `POSIX` are what an unconfigured container reports; treating either as
    // "somewhere in China" would be a guess, which this rule never makes.
    expect(localeTerritory('C')).toBeUndefined()
    expect(localeTerritory('POSIX')).toBeUndefined()
    expect(localeTerritory('')).toBeUndefined()
    expect(localeTerritory(undefined)).toBeUndefined()
  })
})

describe('deciding the site', () => {
  test('a mainland machine (zh_CN + Asia/Shanghai) gets .cn', () => {
    expect(at({ LANG: 'zh_CN.UTF-8' }, 'Asia/Shanghai')).toBe(SITE_URL_CN)
  })

  test('a mainland Windows machine (no LANG at all) still gets .cn, from the zone', () => {
    // This is why the zone layer exists: Windows has no `LANG`, so locale-only
    // detection would send the largest mainland population to the international site.
    expect(at({}, 'Asia/Shanghai')).toBe(SITE_URL_CN)
  })

  test('a Singapore machine gets .com — measured, not hypothetical', () => {
    // The reference host: egress 188.253.120.99 (SG), `LANG=en_US.UTF-8`,
    // `/etc/timezone` = Asia/Singapore. `.com` is the CORRECT answer here.
    expect(at({ LANG: 'en_US.UTF-8' }, 'Asia/Singapore')).toBe(SITE_URL_COM)
  })

  test('Hong Kong and Taipei stay on .com', () => {
    expect(at({ LANG: 'zh_HK.UTF-8' }, 'Asia/Hong_Kong')).toBe(SITE_URL_COM)
    expect(at({ LANG: 'zh_TW.UTF-8' }, 'Asia/Taipei')).toBe(SITE_URL_COM)
  })

  test('an English-preferring machine in China gets .cn (the zone is the tiebreak)', () => {
    expect(at({ LANG: 'en_US.UTF-8' }, 'Asia/Shanghai')).toBe(SITE_URL_CN)
  })

  test('the POSIX precedence holds: LC_ALL beats LC_MESSAGES beats LANG', () => {
    // A machine whose `LANG` is Chinese but whose `LC_ALL` pins the C locale is not a
    // Chinese session — `LC_ALL` wins, exactly as git and vim read it.
    expect(at({ LC_ALL: 'en_US.UTF-8', LANG: 'zh_CN.UTF-8' }, 'UTC')).toBe(SITE_URL_COM)
    expect(at({ LC_MESSAGES: 'zh_CN.UTF-8', LANG: 'en_US.UTF-8' }, 'UTC')).toBe(SITE_URL_CN)
    expect(at({ LC_ALL: 'zh_CN.UTF-8' }, 'UTC')).toBe(SITE_URL_CN)
  })

  test('an empty variable is skipped rather than treated as a hit', () => {
    expect(at({ LC_ALL: '', LANG: 'zh_CN.UTF-8' }, 'UTC')).toBe(SITE_URL_CN)
  })

  test('with no signals at all the international site is the default', () => {
    expect(at({}, undefined)).toBe(SITE_URL_COM)
    expect(at({}, 'Europe/Berlin')).toBe(SITE_URL_COM)
  })

  test('the zone list covers the mainland aliases and nothing else', () => {
    for (const zone of CHINA_TIME_ZONES) {
      expect(at({}, zone), zone).toBe(SITE_URL_CN)
    }
    // `.cn` is the mainland deployment; asking for a separate region's site would be
    // wrong for the same reason Hong Kong is not on it above.
    expect(CHINA_TIME_ZONES).not.toContain('Asia/Hong_Kong')
    expect(CHINA_TIME_ZONES).not.toContain('Asia/Taipei')
  })
})

describe('the explicit override', () => {
  test('QIALIKE_SITE wins over every signal', () => {
    expect(at({ [SITE_ENV]: 'cn' }, 'Europe/Berlin')).toBe(SITE_URL_CN)
    expect(at({ [SITE_ENV]: 'com', LANG: 'zh_CN.UTF-8' }, 'Asia/Shanghai')).toBe(SITE_URL_COM)
    expect(at({ [SITE_ENV]: 'global', LANG: 'zh_CN.UTF-8' }, 'Asia/Shanghai')).toBe(SITE_URL_COM)
    expect(at({ [SITE_ENV]: 'CN' }, 'UTC'), 'case-insensitive').toBe(SITE_URL_CN)
  })

  test('a full URL is taken verbatim, minus a trailing slash', () => {
    expect(at({ [SITE_ENV]: 'https://staging.example' }, 'Asia/Shanghai')).toBe('https://staging.example')
    expect(at({ [SITE_ENV]: 'https://staging.example/' }, 'Asia/Shanghai')).toBe('https://staging.example')
  })

  test('an unrecognised value falls through to detection instead of pinning a site', () => {
    // A typo must not silently pin the international site on a mainland machine.
    expect(at({ [SITE_ENV]: 'cnn', LANG: 'zh_CN.UTF-8' }, 'Asia/Shanghai')).toBe(SITE_URL_CN)
  })
})

describe('the two surfaces that use it', () => {
  test('the memoised accessor agrees with the resolver on this host', () => {
    // Whatever this machine is, both paths must give the same answer — a hero showing
    // one site while `/upgrade` fetches from the other would be the actual bug.
    expect(siteUrl()).toBe(resolveSiteUrl())
  })

  test('/upgrade follows the same site, and QIALIKE_INSTALL_URL still overrides it', () => {
    expect(installUrl({} as NodeJS.ProcessEnv)).toBe(`${resolveSiteUrl({} as NodeJS.ProcessEnv)}/install`)
    expect(installUrl({ QIALIKE_INSTALL_URL: 'https://mirror.example/install' })).toBe(
      'https://mirror.example/install',
    )
  })

  test('the platform really reports a zone (the signal the rule leans on)', () => {
    // If this ever goes undefined the zone layer silently stops contributing, and only
    // mainland Windows machines would notice — so it is asserted, not assumed.
    expect(systemTimeZone()).toBeString()
  })
})

describe('the site no longer reaches the hero', () => {
  test('the caption is version-only, and the url parameter is how it comes back', () => {
    // User call, 2026-10-27: the hero names no site while the rule above is being
    // settled. The parameter stays, so re-enabling it is one argument — and if it
    // does come back it must still fit under the brand mark (the mark's floor is the
    // tightest width the caption is ever asked to fit).
    expect(heroVersionCaption('0.11.5', 'beta')).toBe('Ver: 0.11.5 beta')
    for (const url of [SITE_URL_COM, SITE_URL_CN]) {
      const line = heroVersionCaption('0.11.5', 'beta', url)
      expect(line.length, `${url} must stay ASCII so its width is its length`)
        .toBeLessThanOrEqual(HERO_ART_MIN_WIDTH)
    }
  })
})
