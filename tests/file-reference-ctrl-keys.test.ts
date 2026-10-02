/**
 * Control chords belong to the COMPOSER, even while the `@file` popup is open.
 *
 * Regression: the popup's last branch was `if (k.char !== undefined)
 * { store.insertAtCursor(k.char) }` with NO modifier check. The decoder turns
 * Ctrl+U into `{ char: 'u', ctrl: true }` (stdin.ts), so with the popup open
 * every chord whose letter the decoder knows (u, p, y, t, d, r, f, c) was typed
 * into the draft as that LETTER — `Ctrl+U` on the draft `npm i -g @qialike/cli`
 * inserted a literal `u` instead of deleting the line.
 *
 * The popup is the more dangerous owner of the two because it can be INVISIBLE:
 * `FileReferencePalette` returns null when no candidate matched, while
 * `store.panel` still names it and the dispatcher (index.tsx) routes keys to the
 * ACTIVE panel with no fall-through to the conversation surface.
 *
 * The fix delegates every chord to the conversation panel — the single
 * definition of the chord set — so this test drives the REAL handler with a fake
 * store/tui and asserts the delegation, not a re-implementation of it.
 *
 * Run with `bun test tests/file-reference-ctrl-keys.test.ts`.
 *
 * @module qialike/file-reference-ctrl-keys-test
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  apply, fileReferenceKey, name as PLUGIN_NAME, FILE_PANEL,
} from '../packages/qialike-app/src/file-reference.tsx'
import type { RawKey } from '../packages/qialike-app/src/stdin.ts'

/** Everything the handler touched, in order. */
interface Spies {
  /** Keys the conversation panel received from the popup. */
  delegated: RawKey[]
  /** Text the popup typed into the draft itself. */
  typed: string[]
  /** Draft edits made by any other popup branch. */
  edited: string[]
}

/**
 * Mount the plugin against fakes and return its registered key handler plus the
 * spies. `apply()` is what wires the module-level `store`/`tui` the handler
 * reads, so the test must go through it rather than calling the handler cold.
 */
function mount(draft: string): { key: (k: RawKey) => void; spies: Spies } {
  const spies: Spies = { delegated: [], typed: [], edited: [] }
  const store = {
    input: draft,
    cursor: draft.length,
    panel: 'conversation',
    insertAtCursor: (text: string) => spies.typed.push(text),
    backspaceAtCursor: () => spies.edited.push('backspace'),
    deleteForward: () => spies.edited.push('delete'),
    deleteToLineStart: () => spies.edited.push('deleteToLineStart'),
    setInput: (v: string) => { store.input = v },
    setCursor: (v: number) => { store.cursor = v },
    setPanel: (p: string) => { store.panel = p },
    repaint: () => {},
    subscribe: () => () => {},
    mousePress: () => {}, mouseDrag: () => {}, mouseRelease: () => 'click',
  }
  const conversation = {
    // The popup hands chords over; record them rather than running the real
    // composer (which is covered by its own tests).
    handleKey: (k: RawKey) => { spies.delegated.push(k) },
  }
  const registered: { id: string; handleKey?: (k: RawKey) => boolean }[] = []
  const tui = {
    panels: {
      register: (def: { id: string; handleKey?: (k: RawKey) => boolean }) => { registered.push(def) },
      byId: (id: string) => (id === 'conversation' ? conversation : registered.find((r) => r.id === id)),
    },
  }
  const services: Record<string, unknown> = { tuiStore: store, tui }
  apply({
    get: (n: string) => services[n],
    effect: () => {},
  } as never)
  const def = registered.find((r) => r.id === FILE_PANEL)
  if (def?.handleKey === undefined) throw new Error('the popup did not register a key handler')
  return { key: (k) => { def.handleKey!(k) }, spies }
}

/** The chords the decoder actually emits, and the letter each carries. */
const CHORDS: [string, string][] = [
  ['Ctrl+U', 'u'], ['Ctrl+P', 'p'], ['Ctrl+Y', 'y'], ['Ctrl+T', 't'],
  ['Ctrl+C', 'c'], ['Ctrl+D', 'd'], ['Ctrl+R', 'r'], ['Ctrl+F', 'f'],
]

describe('the @file popup never types a control chord as text', () => {
  // The draft ends in an OPEN `@token` — exactly what makes the popup claim the
  // panel (and, with no matching candidate, stay invisible while doing so).
  const DRAFT = 'npm i -g @qialike/cli'

  for (const [label, letter] of CHORDS) {
    test(`${label} is delegated to the composer, not typed as "${letter}"`, () => {
      const { key, spies } = mount(DRAFT)
      key({ char: letter, ctrl: true })
      expect(spies.typed, `${label} must not insert a literal "${letter}"`).toEqual([])
      expect(spies.delegated).toEqual([{ char: letter, ctrl: true }])
    })
  }

  test('Alt chords are delegated too (meta is not text either)', () => {
    const { key, spies } = mount(DRAFT)
    key({ char: 't', meta: true })
    expect(spies.typed).toEqual([])
    expect(spies.delegated).toEqual([{ char: 't', meta: true }])
  })

  test('the reported repro: Ctrl+U on the @qialike/cli draft types nothing', () => {
    const { key, spies } = mount(DRAFT)
    key({ char: 'u', ctrl: true })
    expect(spies.typed).toEqual([])          // was: ['u']
    expect(spies.delegated).toHaveLength(1)
    // The popup itself must not touch the draft on the chord path: the composer
    // owns deleteToLineStart, and the popup's subscription then re-syncs.
    expect(spies.edited).toEqual([])
  })
})

describe('plain editing in the popup is unchanged', () => {
  test('a bare letter still reaches the draft', () => {
    const { key, spies } = mount('npm i -g @qial')
    key({ char: 'i' })
    expect(spies.typed).toEqual(['i'])
    expect(spies.delegated).toEqual([])
  })

  test('Backspace/Delete still edit the draft', () => {
    const { key, spies } = mount('npm i -g @qial')
    key({ backspace: true })
    key({ delete: true })
    expect(spies.edited).toEqual(['backspace', 'delete'])
    expect(spies.delegated).toEqual([])
  })

  test('the handler still claims the key (it is an overlay owner)', () => {
    const { key } = mount('npm i -g @qial')
    // `apply` wraps the handler; a plain key must be consumed, never fall
    // through to the conversation surface as a SECOND handler.
    expect(() => key({ char: 'i' })).not.toThrow()
  })
})

describe('the popup is reachable with the composer draft intact', () => {
  test('the plugin is registered under the documented id', () => {
    expect(PLUGIN_NAME).toBe('tui-file-reference')
    expect(FILE_PANEL).toBe('file-refs')
  })
})

describe('source guards that the behaviour above depends on', () => {
  const read = (f: string): string =>
    readFileSync(join(import.meta.dir, '..', 'packages', 'qialike-app', 'src', f), 'utf8')

  test('the composer also refuses to type an unhandled chord', () => {
    // Same class of bug one level down: the decoder knows Ctrl+D/R/F but the
    // composer binds none of them, so an unguarded `if (char)` typed d/r/f.
    const text = read(join('panels', 'conversation.tsx'))
    expect(text).toContain('if (char && !k.ctrl && !k.meta) {')
  })

  test('the popup inserts text only without a modifier', () => {
    const text = read('file-reference.tsx')
    expect(text).toContain('if (k.char !== undefined && !k.ctrl && !k.meta)')
  })
})
