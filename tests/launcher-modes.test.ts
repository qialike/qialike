/**
 * The launcher-owned positional modes, and the drift guard that keeps `bin.ts`
 * and the shared list in step.
 *
 * Context (v0.4.10-beta): F5 taught the thin entry to validate the positional
 * mode, but only `resume` was allowed, so `dsh-tui web` and `dsh-tui uninstall`
 * — both launcher-owned positionals handled in `bin.ts` — were rejected as
 * typos, and `web`'s own options (`--host`) were rejected by commander before
 * that. The fix hands the whole line over when `args[0]` is a launcher mode;
 * these tests pin the list, the ordering in `main.ts`, and the fact that no
 * launcher flag can be added to `bin.ts` without the list learning about it.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { LAUNCHER_MODES, UNINSTALL_MODE, WEB_MODE, isLauncherMode } from '../apps/tui-bin/src/launcher-modes.ts'

const binSource = readFileSync(new URL('../apps/tui-bin/src/bin.ts', import.meta.url), 'utf8')
const mainSource = readFileSync(new URL('../apps/tui-bin/src/main.ts', import.meta.url), 'utf8')

describe('launcher modes', () => {
  test('web and uninstall are launcher-owned positionals', () => {
    expect(isLauncherMode(WEB_MODE)).toBe(true)
    expect(isLauncherMode(UNINSTALL_MODE)).toBe(true)
    expect(LAUNCHER_MODES).toEqual([UNINSTALL_MODE, WEB_MODE])
  })

  test('resume, a typo and a missing argument are NOT launcher modes', () => {
    // `resume` is parsed by the TUI command definition, so it must keep going
    // through the positional check (which is what F5 was written for).
    expect(isLauncherMode('resume')).toBe(false)
    expect(isLauncherMode('frobnicate')).toBe(false)
    expect(isLauncherMode(undefined)).toBe(false)
  })

  test('bin.ts resolves exactly the shared list — every launcher flag is known to main.ts', () => {
    // The F5 failure mode: a positional handled in bin.ts but absent from the
    // list is silently rejected by main.ts before bin.ts ever sees it. String
    // comparisons are the only literals allowed here; the constants must be used.
    const literals = [...binSource.matchAll(/args\[0\] === '([^']+)'/g)].map((match) => match[1])
    expect(literals).toEqual([])
    const constants = [...binSource.matchAll(/args\[0\] === ([A-Z_]+)/g)].map((match) => match[1])
    expect(new Set(constants)).toEqual(new Set(['UNINSTALL_MODE', 'WEB_MODE']))
    expect(new Set(constants).size).toBe(LAUNCHER_MODES.length)
  })

  test('main.ts hands launcher modes over BEFORE it validates the positional', () => {
    // Order is the whole fix: the validation block parses with `tuiCommand()`,
    // which does not declare `web`'s options, so reaching it at all breaks
    // `dsh-tui web --host …` even after the mode itself is allowed.
    const handover = mainSource.indexOf('isLauncherMode(args[0])')
    const validation = mainSource.indexOf("mode !== 'resume'")
    expect(handover).toBeGreaterThan(-1)
    expect(validation).toBeGreaterThan(-1)
    expect(handover).toBeLessThan(validation)
  })
})
