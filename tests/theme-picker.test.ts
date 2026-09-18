/**
 * Unit tests for the `/theme` picker dialog (`theme-picker.tsx`): open on
 * current scheme, live preview on move/type, Enter applies + persists + closes,
 * Esc clears the filter first then cancels (restoring the opening snapshot).
 *
 * Run with `bun test tests/theme-picker.test.ts`.
 *
 * @module qialike/theme-picker-test
 */

import { describe, expect, test } from 'bun:test'
import {
  clampIndex, filterSchemes, openThemePicker, themePickerKey, type ThemePickerApi,
} from '../packages/qialike-app/src/theme-picker.tsx'
import type { Store } from '../packages/qialike-app/src/index.tsx'

function fakeStore(): Store & { calls: string[] } {
  const calls: string[] = []
  const store = {
    calls,
    width: 120,
    rows: 40,
    setPanel: (p: string) => calls.push(`panel:${p}`),
    append: (_kind: string, text: string) => calls.push(`append:${text}`),
    // The paste path flashes what it did (the real Store has this too).
    flashStatus: (text: string) => calls.push(`flash:${text}`),
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

  test('a right-click PASTES into the filter and never cancels (user call 2026-09-15)', () => {
    // Right-click meant Esc until 2026-09-14; it then became a complete no-op, and
    // the user asked for the useful half back: paste, but never exit. The
    // deterministic half is a bracketed paste (the same insertion path a
    // right-click feeds); the right-click itself is asserted only for "does not
    // cancel", because its clipboard read is environment-dependent (and unit-tested
    // with an injected reader in tests/clipboard.test.ts).
    const store = fakeStore()
    const api = fakeApi()
    openThemePicker(store, api)
    themePickerKey(key({ paste: 'light' }), store, api) // as if pasted from the clipboard
    expect(api.applied.at(-1)).toBe('light') // the pasted filter previewed that scheme
    const applied = api.applied.length
    // A PLAIN right-click pastes nothing (user call 2026-09-15: too easy to hit by
    // accident) — and it still never cancels the picker.
    themePickerKey(key({ mouseRightPress: { row: 5, col: 10 } }), store, api)
    expect(api.restored).toHaveLength(0) // never cancelled
    expect(store.calls).not.toContain('panel:conversation') // still open
    expect(api.applied.length).toBe(applied) // and nothing was pasted
    expect(store.calls.some((c) => c.startsWith('flash:'))).toBe(false)
    // SHIFT+right-click is the paste gesture: it either pasted or said why not
    // (the clipboard read is environment-dependent; tests/clipboard.test.ts pins
    // the exact behaviour with an injected reader).
    themePickerKey(key({ mouseRightPress: { row: 5, col: 10 }, shift: true }), store, api)
    expect(api.restored).toHaveLength(0)
    expect(store.calls.some((c) => c.startsWith('flash:pasted ') || c.startsWith('flash:clipboard'))).toBe(true)
    // Esc is unchanged: it clears the filter first, then cancels.
    themePickerKey(key({ escape: true }), store, api)
    expect(store.calls).not.toContain('panel:conversation') // step one: filter cleared
    themePickerKey(key({ escape: true }), store, api)
    expect(api.restored.length).toBe(1) // step two: restores + closes
    expect(store.calls).toContain('panel:conversation')
  })
})
