/**
 * Inside a dialog, a right-click NEVER closes it — and (since 2026-09-15) it is
 * not a blanket no-op either: a dialog with a text input uses it to PASTE from
 * the clipboard (`clipboard.ts`), because the terminal cannot run its own paste
 * while the TUI has mouse tracking on.
 *
 * History, because this one came BACK twice. Right-click = Esc was added to
 * `/theme` on 2026-09-09 at the user's request and then extended to every popup
 * (`/sessions`, `/models`, `/export`, `/help`); a stray right-click — which is
 * also the terminal's own paste/context gesture — threw an open popup (or a
 * half-typed API key) away, so on 2026-09-14 the exit mapping was removed and the
 * press became a complete no-op. The user then reported (2026-09-15) that the
 * no-op had gone too far: the API-key dialog must accept a right-click PASTE (and
 * so must the other sub-dialogs) — but still never exit on it.
 *
 * The rule lives in ONE place — the dialog branch in `handleKey` — so the guards
 * below are: that branch hands the press to the panel (which pastes) and returns,
 * the paired release stays swallowed, no dialog maps the press to an EXIT, and no
 * footer advertises a right-click exit.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const APP = join(import.meta.dir, '..', 'packages', 'qialike-app', 'src')
const read = (file: string): string => readFileSync(join(APP, file), 'utf8')
const sources = readdirSync(APP, { withFileTypes: true })
  .filter((e) => e.isFile() && /\.tsx?$/u.test(e.name))
  .map((e) => e.name)
const panelsDir = join(APP, 'panels')
const panelSources = readdirSync(panelsDir).filter((n) => /\.tsx?$/u.test(n)).map((n) => join('panels', n))
const all = [...sources, ...panelSources]

describe('a right-click is inert inside dialogs', () => {
  test('① the press reaches the dialog (to paste) and then STOPS — it can never fall through', () => {
    const index = read('index.tsx')
    const branch = index.indexOf("if (store.panel !== 'conversation' && k.mouseRightPress !== undefined)")
    expect(branch).toBeGreaterThan(0)
    const body = index.slice(branch, branch + 700)
    // The panel gets the press (a text input pastes with it)…
    expect(body).toContain('tui.panels.byId(store.panel)?.handleKey?.(k, store)')
    // …and the branch then RETURNS, so the press can neither close the dialog nor
    // reach the conversation surface (which uses it to cancel a compaction).
    expect(body).toMatch(/\n\s*return\b/u)
    expect(body).not.toContain("def?.handleKey?.(k, store)")
    // The paired release stays swallowed at the top of handleKey.
    expect(index).toContain('if (k.mouseRightRelease !== undefined) return')
    // The conversation-surface escape hatch (cancel a running compaction) is
    // before the dialog branch and untouched.
    const compaction = index.indexOf('store.cancelCompaction()')
    expect(compaction).toBeGreaterThan(0)
    expect(branch).toBeGreaterThan(compaction)
  })

  test('② a dialog may act on the press ONLY by pasting — never as an exit', () => {
    for (const file of all) {
      if (file === 'stdin.ts' || file === 'index.tsx' || file === 'clipboard.ts') continue
      const text = read(file)
      // The old exit mapping must be gone everywhere.
      expect(text, `${file} must not map the press to Esc`).not.toContain('escape || k.mouseRightPress')
      // A file that names the press must be feeding it to the paste helper (the
      // theme picker keeps its filter in local state, so it names both keys).
      if (text.includes('mouseRightPress')) {
        expect(text, `${file} may only use the press for pasting`).toContain('handleDialogPaste')
      }
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

  test('④ the picker keeps the two-step Esc (the press no longer mirrors it, it pastes)', () => {
    const picker = read('theme-picker.tsx')
    expect(picker).toContain("if (state.filter !== '') { state.filter = ''; state.index = 0; preview() }")
    expect(picker).toContain('cancel()')
    // The press is wired to the paste helper, not to the Esc path.
    const paste = picker.indexOf('handleDialogPaste')
    expect(paste).toBeGreaterThan(0)
    expect(picker.slice(paste - 200, paste)).not.toContain('cancel()')
  })
})
