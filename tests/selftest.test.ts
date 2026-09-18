/**
 * Unit tests for the self-test plugin (`tui-selftest`): the in-process check
 * battery must pass against the real registries, and fail loudly when a
 * required registry piece is missing.
 *
 * Run with `bun test tests/selftest.test.ts`.
 *
 * @module qialike/selftest-test
 */

import { describe, expect, test } from 'bun:test'
import { clampIndex, filterSchemes } from '../packages/qialike-app/src/theme-picker.tsx'
import { syncChecks, formatReport, findRepo } from '../packages/qialike-app/src/selftest.ts'
import type { CheckResult } from '../packages/qialike-app/src/selftest.ts'

function fakeDeps(overrides?: {
  commands?: string[]
  panels?: string[]
}): { commands: { list(): { name: string }[] }; panels: { byId(id: string): unknown } } {
  const commands = overrides?.commands ?? ['help', 'think', 'compact', 'clear', 'exit', 'models', 'sessions', 'export', 'new', 'goal', 'plan', 'theme', 'selftest']
  const panels = overrides?.panels ?? ['conversation', 'approval', 'question', 'connect', 'sessions', 'export', 'help', 'themes']
  return {
    commands: { list: () => commands.map((name) => ({ name })) },
    panels: { byId: (id) => (panels.includes(id) ? { id } : undefined) },
  }
}

describe('selftest in-process checks', () => {
  test('a phase-pending command is reported, not called missing (read-only /compact)', () => {
    // Read-only: `/compact` is registered only after the attach. It used to make
    // the whole battery report 7/8 with `missing: compact` (measured on a real
    // terminal) — a self-test crying wolf about the documented phase split.
    const deps = fakeDeps({ commands: ['help', 'think', 'clear', 'exit', 'models', 'sessions', 'export', 'new', 'goal', 'plan', 'theme', 'selftest'] })
    const readonly = syncChecks({ ...deps, pendingCommands: ['compact'] })
    const registry = readonly.find((c) => c.name === 'command registry')
    expect(registry?.ok).toBe(true)
    expect(registry?.detail).toContain('not yet registered: compact')
    // ...but without the phase hint the same registry still fails.
    expect(syncChecks(deps).find((c) => c.name === 'command registry')?.ok).toBe(false)
    // ...and a command missing for any OTHER reason still fails.
    const broken = fakeDeps({ commands: ['think', 'compact', 'clear', 'exit', 'models', 'sessions', 'export', 'new', 'goal', 'plan', 'theme', 'selftest'] })
    expect(syncChecks({ ...broken, pendingCommands: ['compact'] }).find((c) => c.name === 'command registry')?.ok).toBe(false)
  })

  test('full battery passes against real registries', () => {
    const checks = syncChecks(fakeDeps())
    const failed = checks.filter((c) => !c.ok)
    expect(failed, formatReport(checks)).toEqual([])
    expect(checks.length).toBeGreaterThanOrEqual(8)
    // The battery names its domains (so a check silently disappearing is caught).
    const names = checks.map((c) => c.name).join('\n')
    expect(names).toContain('colorscheme registry')
    expect(names).toContain('stdin decoder')
    expect(names).toContain('provider templates')
    expect(names).toContain('panel registry')
    expect(names).toContain('command registry')
  })

  test('missing panels/commands fail their checks (no crash)', () => {
    const checks = syncChecks(fakeDeps({ commands: ['help'], panels: ['conversation'] }))
    const byName = new Map(checks.map((c) => [c.name, c]))
    expect(byName.get('panel registry')?.ok).toBe(false)
    expect(byName.get('command registry')?.ok).toBe(false)
    expect(byName.get('colorscheme registry')?.ok).toBe(true) // registry checks still pass
  })

  test('report summarizes pass/fail counts', () => {
    const all: CheckResult[] = [{ name: 'a', ok: true }, { name: 'b', ok: false, detail: 'boom' }]
    const report = formatReport(all)
    expect(report).toContain('1/2 passed')
    expect(report).toContain('✓ a')
    expect(report).toContain('✗ b — boom')
  })
})

describe('selftest repo detection', () => {
  test('finds this checkout from its own directory', () => {
    const repo = findRepo()
    // In the test runner cwd is the repo root; the real-root package.json name matches.
    expect(repo).toBeDefined()
  })
})

describe('selftest helpers stay in sync with the picker', () => {
  test('filter/clamp helpers behave as the battery asserts', () => {
    expect(filterSchemes(['dark', 'light', 'user-x'], 'li')).toEqual(['light'])
    expect(clampIndex(-1, 3)).toBe(2)
    expect(clampIndex(3, 3)).toBe(0)
  })
})
