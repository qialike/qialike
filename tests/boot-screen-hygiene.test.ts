/**
 * Boot-screen hygiene: nothing may print raw text on the terminal before the
 * first Ink frame.
 *
 * Why this file exists: the alternate screen is entered before the app mounts,
 * so any write to stdout/stderr in that window lands on it and is then erased by
 * Ink's first frame — which the user sees as a flash of stray text over the
 * screen they asked for. Three sources did exactly that (all reported by the
 * user as "闪了一下屏" / "should start on the hero"):
 *
 *   1. the lifecycle breadcrumb `dsh-tui started` was mirrored to stderr;
 *   2. the stderr CAPTURE wrapper echoed every captured chunk back to stderr;
 *   3. `charwidth`'s "terminal does not answer CPR" diagnostic went to stderr;
 *   4. the `dsh-tui <version> — starting…` splash was drawn immediately.
 *
 * The invariant is a policy at three call sites, which unit tests cannot reach
 * (they would have to boot the SEA binary on a pty), so it is pinned at the
 * source level — the same approach as the prompt gate and the hero blank bit.
 *
 * Run with `bun test tests/boot-screen-hygiene.test.ts`.
 *
 * @module dsh-tui/boot-screen-hygiene-test
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const app = (relative: string): string =>
  readFileSync(new URL(`../packages/dsh-tui-app/src/${relative}`, import.meta.url), 'utf8')
const bin = readFileSync(new URL('../apps/tui-bin/src/bin.ts', import.meta.url), 'utf8')

describe('boot log lines stay in the log file', () => {
  test('the start breadcrumb is not mirrored to stderr', () => {
    const log = app('log.ts')
    expect(log).toContain("writeLine('dsh-tui started', false)")
    expect(log).not.toContain("writeLine('dsh-tui started')")
  })

  test('the stderr capture does not echo what it captured back to stderr', () => {
    const log = app('log.ts')
    expect(log).toContain('writeLine(`[stderr] ${clean}`, false)')
  })

  test('the charwidth CPR diagnostic goes to the log, not the screen', () => {
    const charwidth = app('charwidth.ts')
    expect(charwidth).toContain("logErrorFileOnly('charwidth'")
    expect(charwidth).not.toContain("process.stderr.write('[charwidth]")
  })
})

describe('the alternate screen is entered WITH the first frame that has content', () => {
  const build = readFileSync(new URL('../apps/tui-bin/build.mjs', import.meta.url), 'utf8')

  test('the interactive launch does not enter it at boot', () => {
    // Entering it early left the screen blank from t≈0 until Ink painted (~0.6 s).
    expect(bin).toContain("const interactiveLaunch = !wantsHelp && process.stdout.isTTY === true")
    expect(bin).toContain("if (!interactiveLaunch) process.stdout.write('\\x1b[?1049h')")
  })

  test('the frame writer enters it with the first frame, and holds back empty ones', () => {
    // Empty first frames must not be painted either: on the normal screen they
    // would wipe the user's shell, and in the alternate screen they would be the
    // blank flash.
    expect(build).toContain('const __dshEnterAlt = () => {')
    expect(build).toContain('const __dshFrameHasText = (lines) => {')
    expect(build).toContain('if (writeFullScreenFrame._alt !== true && !__dshFrameHasText(lines)) return;')
    expect(build).toContain('if (writeFullScreenFrame._alt !== true && !__dshFrameHasText(pending)) return;')
  })

  test('help and version keep their pre-mount entry (byte contract)', () => {
    const main = readFileSync(new URL('../apps/tui-bin/src/main.ts', import.meta.url), 'utf8')
    expect(main).toContain("process.stdout.write('\\x1b[?1049h')")
  })
})

describe('the CPR probe is invisible and non-destructive', () => {
  test('the glyph is concealed, and no line is erased', () => {
    const charwidth = app('charwidth.ts')
    expect(charwidth).toContain('\\x1b[8m${glyph}\\x1b[28m\\x1b[6n')
    // The old probe + finish erased the whole bottom row (`2K`) — on the normal
    // screen that ate a line of the user's shell.
    expect(charwidth).not.toContain('\\x1b[2K${glyph}')
    expect(charwidth).toContain('try { process.stdout.write(`\\x1b8`) }')
  })
})

describe('the splash is a slow-boot indicator, not a first-frame placeholder', () => {
  test('it is deferred and cancelled by the first flushed frame', () => {
    expect(bin).toContain('const SPLASH_DELAY_MS')
    expect(bin).toContain('__dshTuiLastFlushAt')
    expect(bin).toContain('if (flushed !== undefined) return')
    expect(bin).toContain('splash.unref?.()')
  })

  test('its delay is overridable, with a force value for the positive control', () => {
    // A 0 ms delay cannot prove the draw path is alive: the timer waits for the
    // thread to yield, by which time Ink has usually flushed its first frame.
    expect(bin).toContain('DSH_TUI_SPLASH_MS')
    expect(bin).toContain('if (SPLASH_DELAY_MS < 0)')
  })

  test('the splash still draws inside the tty-only branch', () => {
    const block = bin.slice(bin.indexOf('const wantsHelp = '), bin.indexOf('let appMounted = false'))
    expect(block).toContain('process.stdout.isTTY === true')
    expect(block).toContain('drawSplash()')
  })
})
