/**
 * Unit tests for the `/theme` picker dialog (`theme-picker.tsx`): open on
 * current scheme, live preview on move/type, Enter applies + persists + closes,
 * Esc clears the filter first then cancels (restoring the opening snapshot).
 *
 * Run with `bun test tests/theme-picker.test.ts`.
 *
 * @module dsh-tui/theme-picker-test
 */

import { describe, expect, test } from 'bun:test'
import {
  clampIndex, filterSchemes, openThemePicker, themePickerKey, type ThemePickerApi,
} from '../packages/dsh-tui-app/src/theme-picker.tsx'
import type { Store } from '../packages/dsh-tui-app/src/index.tsx'

function fakeStore(): Store & { calls: string[] } {
  const calls: string[] = []
  const store = {
    calls,
    width: 120,
    rows: 40,
    setPanel: (p: string) => calls.push(`panel:${p}`),
    append: (_kind: string, text: string) => calls.push(`append:${text}`),
  }
  return store as never as Store & { calls: string[] }
}

function fakeApi(): ThemePickerApi & {
  applied: string[]; persisted: string[]; restored: { palette: unknown; name: string }[]; rerenders: number
} {
  const applied: string[] = []
  const persisted: string[] = []
  const restored: { palette: unknown; name: string }[] = []
  const rerenders: number[] = []
  return {
    applied, persisted, restored, rerenders,
    schemes: () => ['dark', 'light', 'user-x'],
    isUserScheme: (n) => n === 'user-x',
    current: () => 'dark',
    apply: (n) => applied.push(n),
    persist: (n) => persisted.push(n),
    rerender: () => rerenders.push(1),
    restore: (palette, name) => restored.push({ palette, name }),
  }
}

const key = (k: object) => k as never

describe('filter helpers', () => {
  test('filterSchemes matches case-insensitive substrings; empty filter keeps all', () => {
    expect(filterSchemes(['dark', 'light', 'user-x'], '')).toEqual(['dark', 'light', 'user-x'])
    expect(filterSchemes(['dark', 'light', 'user-x'], 'li')).toEqual(['light'])
    expect(filterSchemes(['dark', 'light', 'user-x'], 'L')).toEqual(['light'])
    expect(filterSchemes(['dark', 'light', 'user-x'], 'zz')).toEqual([])
  })

  test('clampIndex wraps both directions', () => {
    expect(clampIndex(0, 3)).toBe(0)
    expect(clampIndex(3, 3)).toBe(0)
    expect(clampIndex(-1, 3)).toBe(2)
    expect(clampIndex(0, 0)).toBe(0)
  })
})

describe('theme picker dialog', () => {
  test('bare open snaps the current scheme and switches to the themes panel', () => {
    const store = fakeStore()
    const api = fakeApi()
    openThemePicker(store, api)
    expect(store.calls).toContain('panel:themes')
    expect(api.current()).toBe('dark')
  })

  test('down arrow previews the next scheme (live, not persisted)', () => {
    const store = fakeStore()
    const api = fakeApi()
    openThemePicker(store, api)
    themePickerKey(key({ downArrow: true }), store, api)
    expect(api.applied).toEqual(['light'])
    expect(api.persisted).toEqual([])
  })

  test('typing filters and previews the first match', () => {
    const store = fakeStore()
    const api = fakeApi()
    openThemePicker(store, api)
    themePickerKey(key({ char: 'l' }), store, api)
    themePickerKey(key({ char: 'i' }), store, api) // filter 'li' → light
    expect(api.applied.at(-1)).toBe('light')
    // Clear the filter (Esc stays open), then a new filter reaches user-x.
    themePickerKey(key({ escape: true }), store, api)
    themePickerKey(key({ char: 'u' }), store, api)
    expect(api.applied.at(-1)).toBe('user-x')
  })

  test('Enter applies, persists, reports and closes', () => {
    const store = fakeStore()
    const api = fakeApi()
    openThemePicker(store, api)
    themePickerKey(key({ downArrow: true }), store, api)
    themePickerKey(key({ return: true }), store, api)
    expect(api.applied.at(-1)).toBe('light')
    expect(api.persisted).toEqual(['light'])
    expect(store.calls).toContain('panel:conversation')
    expect(store.calls.some((c) => c.startsWith('append:colorscheme: light'))).toBe(true)
  })

  test('Esc clears a typed filter first; a second Esc cancels and restores the snapshot', () => {
    const store = fakeStore()
    const api = fakeApi()
    openThemePicker(store, api)
    themePickerKey(key({ char: 'l' }), store, api) // filter 'l', preview light
    expect(api.applied.at(-1)).toBe('light')
    // First Esc: clear filter (still open; preview back to first scheme)
    const handled = themePickerKey(key({ escape: true }), store, api)
    expect(handled).toBe(true)
    expect(store.calls.filter((c) => c === 'panel:conversation')).toHaveLength(0)
    expect(api.applied.at(-1)).toBe('dark')
    // Second Esc: cancel — restore the opening palette + scheme, close
    themePickerKey(key({ escape: true }), store, api)
    expect(api.restored.length).toBe(1)
    expect(api.restored[0]!.name).toBe('dark')
    expect(store.calls).toContain('panel:conversation')
  })

  test('backspace shortens the filter', () => {
    const store = fakeStore()
    const api = fakeApi()
    openThemePicker(store, api)
    themePickerKey(key({ char: 'u' }), store, api) // filter 'u' → user-x
    themePickerKey(key({ char: 's' }), store, api) // 'us' → user-x
    expect(api.applied.at(-1)).toBe('user-x')
    themePickerKey(key({ backspace: true }), store, api) // 'u' → user-x again
    expect(api.applied.at(-1)).toBe('user-x')
  })

  test('right-click does NOTHING in the picker (user call 2026-09-14)', () => {
    // Right-click used to mean Esc here (and in every popup, 2026-09-09). A stray
    // right-click — also the terminal's own paste/context gesture — then threw the
    // picker away, so the dialog now ignores it entirely; only Esc (and Ctrl+C)
    // leave. `handleKey` consumes the press for every dialog panel, and this
    // asserts the handler ITSELF does not act on it either.
    const store = fakeStore()
    const api = fakeApi()
    openThemePicker(store, api)
    themePickerKey(key({ char: 'l' }), store, api) // filter 'l' → preview light
    const before = api.applied.length
    for (const _ of [0, 1]) themePickerKey(key({ mouseRightPress: { row: 5, col: 10 } }), store, api)
    expect(api.applied.length).toBe(before) // no preview change, no filter clear
    expect(api.restored).toHaveLength(0) // never cancelled
    expect(store.calls).not.toContain('panel:conversation') // still open
    // Esc is unchanged: it clears the filter first, then cancels.
    themePickerKey(key({ escape: true }), store, api)
    expect(store.calls).not.toContain('panel:conversation') // step one: filter cleared
    themePickerKey(key({ escape: true }), store, api)
    expect(api.restored.length).toBe(1) // step two: restores + closes
    expect(store.calls).toContain('panel:conversation')
  })
})
