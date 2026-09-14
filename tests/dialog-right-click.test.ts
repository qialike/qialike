/**
 * Inside a dialog, a right-click is inert — only Esc (and Ctrl+C) leave.
 *
 * History, because this one came BACK as a "regression" report: right-click = Esc
 * was added to `/theme` on 2026-09-09 at the user's request and then extended to
 * every popup (`/sessions`, `/models`, `/export`, `/help`). The later "sub-dialog"
 * work only stopped the right-click RELEASE from being read as a left click (it
 * selected/expanded the row under the cursor). So nothing was ever disabled — the
 * user's new call (2026-09-14) is that the exit mapping itself must go, because a
 * stray right-click is also the terminal's own paste/context gesture and it threw
 * an open popup (or a half-typed API key) away.
 *
 * The rule now lives in ONE place — the dialog gate in `handleKey` — so the
 * guards below are: the gate exists with the right condition and sits after the
 * conversation escape hatch, no dialog handler acts on the press any more, and no
 * footer advertises it.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const APP = join(import.meta.dir, '..', 'packages', 'dsh-tui-app', 'src')
const read = (file: string): string => readFileSync(join(APP, file), 'utf8')
const sources = readdirSync(APP, { withFileTypes: true })
  .filter((e) => e.isFile() && /\.tsx?$/u.test(e.name))
  .map((e) => e.name)
const panelsDir = join(APP, 'panels')
const panelSources = readdirSync(panelsDir).filter((n) => /\.tsx?$/u.test(n)).map((n) => join('panels', n))
const all = [...sources, ...panelSources]

describe('a right-click is inert inside dialogs', () => {
  test('① the press is consumed for every non-conversation panel, before dispatch', () => {
    const index = read('index.tsx')
    expect(index).toContain("if (store.panel !== 'conversation' && k.mouseRightPress !== undefined) return")
    const gate = index.indexOf("if (store.panel !== 'conversation' && k.mouseRightPress !== undefined) return")
    const dispatch = index.indexOf('def?.handleKey?.(k, store)')
    expect(gate).toBeGreaterThan(0)
    expect(dispatch).toBeGreaterThan(gate)
    // …and after the compaction cancel, which is the CONVERSATION surface's escape
    // hatch (not a dialog) and must keep working.
    const compaction = index.indexOf('store.cancelCompaction()')
    expect(compaction).toBeGreaterThan(0)
    expect(gate).toBeGreaterThan(compaction)
  })

  test('② no dialog handler acts on the press any more', () => {
    // `stdin.ts` decodes it (so it can be told apart from a left click and its
    // release swallowed) and `index.tsx` owns the gate + the compaction cancel;
    // every dialog is out of the business.
    for (const file of all) {
      if (file === 'stdin.ts' || file === 'index.tsx') continue
      expect(read(file), `${file} must not handle mouseRightPress`).not.toContain('mouseRightPress')
    }
  })

  test('③ no footer tells the user that a right-click closes the dialog', () => {
    // Hints are the `<Text dimColor>` lines; comments may (and do) explain the
    // history, so this checks the painted text only.
    for (const file of all) {
      for (const [i, line] of read(file).split('\n').entries()) {
        if (line.includes('dimColor') && /right-click/i.test(line)) {
          expect(`${file}:${i + 1}`, 'a footer hint still advertises right-click').toBe('no right-click in hints')
        }
      }
    }
  })

  test('④ the picker keeps the two-step Esc the right-click used to mirror', () => {
    const picker = read('theme-picker.tsx')
    expect(picker).toContain("if (state.filter !== '') { state.filter = ''; state.index = 0; preview() }")
    expect(picker).toContain('cancel()')
    expect(picker).not.toContain('mouseRightPress')
  })
})
