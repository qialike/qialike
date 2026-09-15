/**
 * Dialog paste: the clipboard reader, the sanitiser, and the one path every
 * dialog input uses for a bracketed paste and for a right-click paste.
 *
 * The reported bug: the API-key dialog's own hint said "paste a single-line key"
 * but the handler only accepted `char`, so a terminal paste (which arrives as
 * `k.paste`, because the TUI enables bracketed paste) was dropped — and a
 * right-click did nothing at all (it had been made a blanket no-op inside
 * dialogs). Both now insert into the focused input and neither closes the dialog.
 *
 * Run with `bun test tests/clipboard.test.ts`.
 *
 * @module dsh-tui/clipboard-test
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  PASTE_MAX_CHARS,
  clipboardReadCommands,
  handleDialogPaste,
  pastedText,
  readClipboardText,
} from '../packages/dsh-tui-app/src/clipboard.ts'

const APP = join(import.meta.dir, '..', 'packages', 'dsh-tui-app', 'src')
const read = (file: string): string => readFileSync(join(APP, file), 'utf8')

describe('pastedText: sanitising one paste', () => {
  test('drops escape/control bytes but keeps real text', () => {
    // A clipboard is attacker-controllable: an ESC would reach the terminal.
    expect(pastedText('sk-\u001b[31mabc\u0007', true)).toBe('sk-[31mabc')
    expect(pastedText('ok\u009b32m', true)).toBe('ok32m')
    expect(pastedText('keep\ttabs and spaces', true)).toBe('keep tabs and spaces')
  })

  test('single-line fields fold newlines/tabs and trim; multi-line keeps them', () => {
    expect(pastedText('  sk-abc\r\ndef \n', true)).toBe('sk-abc def')
    expect(pastedText('line1\r\nline2\n', false)).toBe('line1\nline2\n')
    expect(pastedText('a\rb', false)).toBe('a\nb')
  })

  test('caps the length', () => {
    expect(pastedText('x'.repeat(50), false, 10)).toHaveLength(10)
    expect(pastedText('x'.repeat(PASTE_MAX_CHARS + 100), false)).toHaveLength(PASTE_MAX_CHARS)
    expect(pastedText('x', false, 0)).toBe('')
  })
})

describe('readClipboardText: which commands, and what failure says', () => {
  test('picks the platform tools in order', () => {
    expect(clipboardReadCommands('linux').map((c) => c.cmd)).toEqual(['wl-paste', 'xclip', 'xsel'])
    expect(clipboardReadCommands('darwin').map((c) => c.cmd)).toEqual(['pbpaste'])
    expect(clipboardReadCommands('win32')[0]!.cmd).toBe('powershell.exe')
  })

  test('falls through a missing tool to the next one', () => {
    const ran: string[] = []
    const result = readClipboardText('linux', ((cmd: string) => {
      ran.push(cmd)
      if (cmd === 'wl-paste') return { error: new Error('ENOENT'), status: null, stdout: '' }
      if (cmd === 'xclip') return { error: undefined, status: 1, stdout: '' }
      return { error: undefined, status: 0, stdout: 'sk-from-xsel\n' }
    }) as never)
    expect(ran).toEqual(['wl-paste', 'xclip', 'xsel'])
    expect(result).toEqual({ ok: true, text: 'sk-from-xsel\n', reason: '' })
  })

  test('reports the last reason when nothing worked', () => {
    const result = readClipboardText('linux', ((cmd: string) => ({
      error: new Error(`${cmd} missing`), status: null, stdout: '',
    })) as never)
    expect(result.ok).toBe(false)
    expect(result.text).toBe('')
    expect(result.reason).toContain('xsel missing')
  })
})

describe('handleDialogPaste: bracketed paste and right-click', () => {
  const host = (): { flashes: string[]; flashStatus(text: string): void } => {
    const flashes: string[] = []
    return { flashes, flashStatus: (text: string) => { flashes.push(text) } }
  }

  test('a bracketed paste inserts (sanitised) without flashing', () => {
    const h = host()
    const typed: string[] = []
    const handled = handleDialogPaste({ paste: 'sk-\u001b[31mkey\n' }, h, (t) => typed.push(t), { singleLine: true })
    expect(handled).toBe(true)
    expect(typed).toEqual(['sk-[31mkey'])
    expect(h.flashes).toEqual([])
  })

  test('a right-click reads the clipboard, inserts, and says how much', () => {
    const h = host()
    const typed: string[] = []
    const handled = handleDialogPaste({ mouseRightPress: { row: 5, col: 5 } }, h, (t) => typed.push(t), {
      singleLine: true,
      read: () => ({ ok: true, text: 'sk-abc\r\n', reason: '' }),
    })
    expect(handled).toBe(true)
    expect(typed).toEqual(['sk-abc'])
    expect(h.flashes).toEqual(['pasted 6 chars'])
  })

  test('an unavailable or empty clipboard flashes instead of inserting', () => {
    const h = host()
    const typed: string[] = []
    handleDialogPaste({ mouseRightPress: { row: 5, col: 5 } }, h, (t) => typed.push(t), {
      read: () => ({ ok: false, text: '', reason: 'xclip: exit 1' }),
    })
    expect(typed).toEqual([])
    expect(h.flashes[0]).toContain('clipboard unavailable')
    expect(h.flashes[0]).toContain('xclip: exit 1')

    // Whitespace that a SINGLE-LINE field folds away counts as empty...
    const h2 = host()
    handleDialogPaste({ mouseRightPress: { row: 5, col: 5 } }, h2, (t) => typed.push(t), {
      singleLine: true,
      read: () => ({ ok: true, text: '\n', reason: '' }),
    })
    expect(typed).toEqual([])
    expect(h2.flashes).toEqual(['clipboard is empty'])

    // ...but a newline IS content for a multi-line field (the question editor).
    const h3 = host()
    handleDialogPaste({ mouseRightPress: { row: 5, col: 5 } }, h3, (t) => typed.push(t), {
      read: () => ({ ok: true, text: '\n', reason: '' }),
    })
    expect(typed).toEqual(['\n'])
    expect(h3.flashes).toEqual(['pasted 1 char'])
  })

  test('anything else is not a paste', () => {
    const h = host()
    expect(handleDialogPaste({}, h, () => { /* noop */ })).toBe(false)
    expect(h.flashes).toEqual([])
  })
})

describe('wiring: every dialog input shares the path, and none exits on right-click', () => {
  test('the text-input dialogs call handleDialogPaste', () => {
    for (const file of [
      'panels/models.tsx',
      'panels/question.tsx',
      'sessions.tsx',
      'export.tsx',
      'theme-picker.tsx',
    ]) {
      expect(read(file), `${file} must handle paste`).toContain('handleDialogPaste')
    }
  })

  test('the caret/secret inputs each keep their own insertion action', () => {
    const models = read('panels/models.tsx')
    expect(models).toContain('store.pushSecret(text)')          // API-key field
    expect(models).toContain('store.providerFormType(text)')     // custom provider form
    expect(models).toContain('store.modelFilterType(text)')
    expect(read('sessions.tsx')).toContain('store.sessionsRenameType(text)')
    expect(read('panels/question.tsx')).toContain('store.questionType(text)')
  })

  test('no dialog exits on a right-click any more, and the gate dispatches it', () => {
    for (const file of ['panels/models.tsx', 'panels/question.tsx', 'sessions.tsx', 'export.tsx', 'theme-picker.tsx', 'index.tsx']) {
      expect(read(file), `${file} must not map a right-click to Esc`).not.toContain('escape || k.mouseRightPress')
    }
    const index = read('index.tsx')
    // The dialog branch hands the press to the panel (which may paste) and then
    // returns: it can neither close a dialog nor reach the conversation surface.
    const branch = index.indexOf("if (store.panel !== 'conversation' && k.mouseRightPress !== undefined)")
    expect(branch).toBeGreaterThan(0)
    expect(index.slice(branch, branch + 600)).toContain("tui.panels.byId(store.panel)?.handleKey?.(k, store)")
  })
})
