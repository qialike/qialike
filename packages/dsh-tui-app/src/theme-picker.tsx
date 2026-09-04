/**
 * The `/theme` picker dialog — an opencode `DialogThemeList`-style colorscheme
 * browser (see `opencode/…/component/dialog-theme-list.tsx`):
 *
 *   - typing `/theme` (no arguments) opens a fullscreen dialog listing every
 *     scheme (built-in `dark`/`light` + user `~/.dsh/themes/*.json`), so no
 *     scheme name has to be typed;
 *   - ↑/↓ (and PgUp/PgDn/Home/End) move, typing filters the list, Enter
 *     applies + persists, Esc cancels;
 *   - like opencode, moving/filtering **previews live** (the scheme is applied
 *     to the shared `theme` object) and cancel restores the exact palette that
 *     was active when the dialog opened.
 *
 * All palette interaction goes through the `ThemePickerApi` supplied by the
 * theme plugin (no import cycle): the picker never persists or reads settings
 * itself.
 *
 * @module @yourname/dsh-tui-app/theme-picker
 */

import React from 'react'
import { Box, Text } from 'ink'
import type { Store } from './index.tsx'
import type { RawKey } from './stdin.ts'
import { theme, type ThemePalette } from './theme.ts'

/** What the theme plugin exposes to the picker (no import cycle). */
export interface ThemePickerApi {
  /** Sorted scheme names (built-ins + user files). */
  schemes(): string[]
  /** Whether a scheme comes from a user file (`~/.dsh/themes`). */
  isUserScheme(name: string): boolean
  /** Currently applied scheme name. */
  current(): string
  /** Live-apply a scheme for preview; never persists. */
  apply(name: string): void
  /** Persist a confirmed choice (settings). */
  persist(name: string): void
  /** Force a full repaint (theme-epoch bump). */
  rerender(): void
  /** Restore an exact palette snapshot after a cancel. */
  restore(palette: ThemePalette, name: string): void
}

interface ThemePickerState {
  open: boolean
  /** Palette active when the dialog opened (restored on Esc). */
  snapshot: ThemePalette | null
  /** Scheme name active when the dialog opened. */
  previous: string
  filter: string
  index: number
}

const state: ThemePickerState = { open: false, snapshot: null, previous: '', filter: '', index: 0 }

/** Case-insensitive substring filter over scheme names. */
export function filterSchemes(names: readonly string[], filter: string): string[] {
  const f = filter.trim().toLowerCase()
  return f === '' ? [...names] : names.filter((n) => n.toLowerCase().includes(f))
}

/** Wrap a list index (negative or beyond the end) into range. */
export function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0
  return ((index % length) + length) % length
}

/** Open the picker on the current scheme; snapshots the live palette. */
export function openThemePicker(store: Store, api: ThemePickerApi): void {
  const names = api.schemes()
  state.open = true
  state.snapshot = { ...theme }
  state.previous = api.current()
  state.filter = ''
  state.index = Math.max(0, names.indexOf(api.current()))
  store.setPanel('themes')
}

/** Consume one key while the picker is active; returns true when handled. */
export function themePickerKey(k: RawKey, store: Store, api: ThemePickerApi): boolean {
  if (!state.open) return false
  const close = (): void => { state.open = false; store.setPanel('conversation') }
  const cancel = (): void => {
    if (state.snapshot !== null) api.restore(state.snapshot, state.previous)
    state.snapshot = null
    close()
  }
  const preview = (): void => {
    const pick = filterSchemes(api.schemes(), state.filter)[state.index]
    if (pick !== undefined) api.apply(pick)
  }
  if (k.escape) {
    if (state.filter !== '') { state.filter = ''; state.index = 0; preview() }
    else cancel()
    return true
  }
  if (k.return) {
    const pick = filterSchemes(api.schemes(), state.filter)[state.index]
    if (pick !== undefined) {
      api.apply(pick)
      api.persist(pick)
      try { store.append('status', `colorscheme: ${pick}`, true) } catch { /* best-effort */ }
    }
    state.snapshot = null
    close()
    return true
  }
  if (k.backspace) {
    if (state.filter.length > 0) { state.filter = state.filter.slice(0, -1); state.index = 0; preview() }
    return true
  }
  const names = filterSchemes(api.schemes(), state.filter)
  if (k.upArrow || k.downArrow || k.wheelUp || k.wheelDown) {
    if (names.length > 0) {
      const dir = (k.downArrow || k.wheelDown) ? 1 : -1
      state.index = clampIndex(state.index + dir, names.length)
      preview()
    }
    return true
  }
  if (k.pageUp || k.pageDown || k.home || k.end) {
    if (names.length > 0) {
      if (k.home) state.index = 0
      else if (k.end) state.index = names.length - 1
      else {
        const step = Math.max(1, store.rows - 16)
        state.index = clampIndex(state.index + (k.pageDown ? step : -step), names.length)
      }
      preview()
    }
    return true
  }
  if (k.char !== undefined && k.char.length === 1 && !k.ctrl && !k.meta && k.char >= ' ') {
    state.filter += k.char
    state.index = 0
    preview()
    return true
  }
  return true
}

/** Render the fullscreen picker (mirrors the models/connect dialog layout). */
export function renderThemePicker(store: Store, api: ThemePickerApi): React.ReactNode {
  if (!state.open) return null
  const names = filterSchemes(api.schemes(), state.filter)
  const allNames = api.schemes()
  const listRows = Math.max(1, store.rows - 16)
  const total = names.length
  const selectedIndex = total > 0 ? Math.min(state.index, total - 1) : -1
  const top = total === 0 ? 0 : Math.max(0, Math.min(selectedIndex - Math.floor(listRows / 2), Math.max(0, total - listRows)))
  const visible = names.slice(top, top + listRows)
  const boxWidth = Math.min(72, Math.max(40, store.width - 10))
  return (
    <Box flexDirection="column" height={store.rows} alignItems="center" justifyContent="center">
      <Box position="absolute" width="100%" height={store.rows} flexDirection="column">
        <Text backgroundColor={theme.bg} wrap="wrap">{' '.repeat(Math.max(0, store.width * store.rows))}</Text>
      </Box>
      <Box width={boxWidth} borderStyle="round" borderColor={theme.border} flexDirection="column" paddingX={1} paddingY={1} gap={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold color={theme.accent}>Themes</Text>
          <Text dimColor>current: {api.current()}</Text>
        </Box>
        <Box flexDirection="row">
          <Text color={state.filter === '' ? theme.textMuted : theme.text}>⌕ {state.filter === '' ? 'type to filter' : state.filter}</Text>
        </Box>
        <Box flexDirection="column">
          {visible.map((name) => {
            const selected = name === names[selectedIndex]
            return (
              <Box key={name} flexDirection="row">
                <Text color={selected ? theme.accent : theme.text} inverse={selected}>
                  {selected ? '› ' : '  '}{name}
                </Text>
                {api.isUserScheme(name) ? <Text dimColor> · user</Text> : null}
              </Box>
            )
          })}
          {total === 0 && <Text dimColor>no themes match “{state.filter}”</Text>}
        </Box>
        <Box flexDirection="row">
          <Text dimColor>↑/↓ move · type to filter · Enter apply · Esc cancel — preview applies live ({allNames.length} schemes)</Text>
        </Box>
      </Box>
    </Box>
  )
}
