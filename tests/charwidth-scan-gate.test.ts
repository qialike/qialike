/**
 * The char-width calibration must not do work before the terminal has proven it
 * answers CPR (`session/optimization-plan.md` §8.7).
 *
 * The frame writer calls `globalThis.__dshCharScan` for a frame as soon as the
 * hook exists, and `scan()` walks every character of every line of that frame
 * (the giant session's first frame is ~680k code points). Registering the hook
 * (and raising `supported`) BEFORE the fingerprint let that scan run on a
 * terminal that never answers `ESC[6n` — measured in GNOME Terminal/VTE: the main
 * loop blocked for 1470 ms right after the first frame appeared, for a
 * calibration that then disabled itself anyway.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const src = readFileSync(
  join(import.meta.dir, '..', 'packages', 'dsh-tui-app', 'src', 'charwidth.ts'),
  'utf8',
)

describe('char-width calibration is gated on CPR support', () => {
  const initBody = src.slice(src.indexOf('export function initCharWidthCalibration'))
  const fingerprintBody = src.slice(
    src.indexOf('async function fingerprint()'),
    src.indexOf('export function initCharWidthCalibration'),
  )

  test('the scan hook is registered only after the fingerprint succeeded', () => {
    const probe = initBody.indexOf('await fingerprint()')
    const register = initBody.indexOf('GLOBAL.__dshCharScan = ')
    expect(probe).toBeGreaterThan(-1)
    expect(register).toBeGreaterThan(-1)
    expect(register).toBeGreaterThan(probe)
  })

  test('nothing enables calibration in the boot path itself', () => {
    // The raise lives in `fingerprint()`, i.e. only after the terminal answered.
    expect(initBody).not.toContain('supported = true')
    const raise = fingerprintBody.indexOf('supported = true')
    expect(raise).toBeGreaterThan(-1)
    expect(raise).toBeGreaterThan(fingerprintBody.indexOf('if (!ok) return false'))
  })

  test('scan() still refuses to run while calibration is unsupported', () => {
    const body = src.slice(src.indexOf('function scan(lines: readonly string[]): void'))
    expect(body.slice(0, 200)).toContain('if (!supported) return')
  })
})
