/**
 * `Ctrl+U` in a sub-dialog deletes the WHOLE line the user has typed.
 *
 * The composer and the question editor already bound Ctrl+U, but to the readline
 * meaning (delete to the line START). The dialog inputs are single-line — an API
 * key, a filter, a session title, a file name — where "delete the line" means
 * "clear the field", and they had NO binding at all (the user asked for it).
 *
 * Two halves: the wiring (each dialog routes Ctrl+U to its own clear action) and
 * the behaviour (driven here through the theme picker, whose key handler is pure
 * and takes fakes — the real-binary half lives in the `dialog-paste` scenario).
 *
 * Run with `bun test tests/dialog-clear-line.test.ts`.
 *
 * @module dsh-tui/dialog-clear-line-test
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { openThemePicker, themePickerKey } from '../packages/dsh-tui-app/src/theme-picker.tsx'

const APP = join(import.meta.dir, '..', 'packages', 'dsh-tui-app', 'src')
const read = (file: string): string => readFileSync(join(APP, file), 'utf8')

describe('Ctrl+U clears the whole line in dialog inputs', () => {
  test('every single-line dialog input routes Ctrl+U to its clear action', () => {
    const cases: [string, string][] = [
      ['panels/models.tsx', 'store.clearSecret()'],            // API key
      ['panels/models.tsx', 'store.providerFormClear()'],      // custom provider form
      ['panels/models.tsx', 'store.clearProviderListFilter()'],
      ['panels/models.tsx', 'store.clearModelFilter()'],
      ['panels/models.tsx', 'store.clearProviderFilter()'],
      ['sessions.tsx', 'store.sessionsRenameClear()'],
      ['sessions.tsx', 'store.clearSessionsFilter()'],
      ['export.tsx', 'store.exportNameClear()'],
    ]
    for (const [file, call] of cases) {
      const text = read(file)
      // A call may legitimately appear earlier behind ANOTHER key (the filters
      // reuse their clear action for Esc), so require at least one occurrence
      // that sits inside a ctrl+u branch.
      const ok = [...text.matchAll(new RegExp(call.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'gu'))].some((m) => {
        const before = text.slice(Math.max(0, (m.index ?? 0) - 500), m.index ?? 0)
        return before.includes("char === 'u'") && before.includes('ctrl')
      })
      expect(ok, `${call} must be bound to Ctrl+U in ${file}`).toBe(true)
    }
    expect(read('theme-picker.tsx')).toContain("k.ctrl && k.char === 'u'")
  })

  test('the theme filter really is cleared by Ctrl+U (and the picker stays open)', () => {
    const calls: string[] = []
    const applied: string[] = []
    const store = {
      calls,
      width: 120,
      rows: 40,
      setPanel: (p: string) => calls.push(`panel:${p}`),
      append: (_k: string, text: string) => calls.push(`append:${text}`),
      flashStatus: (text: string) => calls.push(`flash:${text}`),
    } as never
    const api = {
      schemes: () => ['dark', 'light', 'user-x'],
      isUserScheme: (name: string) => name === 'user-x',
      current: () => 'dark',
      apply: (name: string) => applied.push(name),
      persist: () => { /* noop */ },
      rerender: () => { /* noop */ },
      restore: () => { /* noop */ },
    } as never
    openThemePicker(store, api)
    themePickerKey({ char: 'x' } as never, store, api)          // filter 'x' → user-x
    expect(applied.at(-1)).toBe('user-x')
    themePickerKey({ char: 'u', ctrl: true } as never, store, api)
    // The filter is gone, so the preview falls back to the first scheme — and the
    // picker did NOT restore/close.
    expect(applied.at(-1)).toBe('dark')
    expect(calls).not.toContain('panel:conversation')
  })
})
