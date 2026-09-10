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
