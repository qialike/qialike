/**
 * Source guards for the "terminal too small ⇒ no input" gate.
 *
 * The bug this locks down (external review, HIGH): at rows < 14 the panel paints
 * the one-row notice INSTEAD of the conversation surface, but `handleKey` kept
 * routing by `store.panel` — so the invisible approval dock still received keys
 * and `settle(store.approvalChoice)` ran on Enter, whose default is "Allow once"
 * (`panels/approval.tsx`). A blind Enter therefore approved a permission prompt
 * nobody could see. On the hero the same gap let a blind Enter submit a real
 * (paid) turn and `/export` write files from an invisible draft.
 *
 * The fix has three moving parts, each guarded here:
 *   ① the store publishes a notify-free `surfaceTooSmall` flag;
 *   ② the conversation panel sets it from the SAME predicate it paints with;
 *   ③ `handleKey` consults it BEFORE dispatching to any panel, keeps exactly one
 *      escape hatch (Ctrl+C → quit), and only gates the conversation surface —
 *      fullscreen dialogs are visible at any height and keep their keys.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const INDEX = readFileSync(new URL('../packages/qialike-app/src/index.tsx', import.meta.url), 'utf-8')
const PANEL = readFileSync(new URL('../packages/qialike-app/src/panels/conversation.tsx', import.meta.url), 'utf-8')

describe('terminal-too-small input gate', () => {
  test('① the store owns a notify-free suppression flag', () => {
    const field = INDEX.indexOf('private _surfaceTooSmall = false')
    const getter = INDEX.indexOf('get surfaceTooSmall(): boolean')
    const setter = INDEX.indexOf('setSurfaceTooSmall(value: boolean): void {')
    expect(field, 'the flag exists').toBeGreaterThan(-1)
    expect(getter, 'readable by the dispatch').toBeGreaterThan(-1)
    expect(setter, 'writable by the panel').toBeGreaterThan(-1)
    // Notify-free: a notify() here would re-enter the render that set it.
    const body = INDEX.slice(setter, INDEX.indexOf('}', setter))
    expect(body, 'the setter must not notify').not.toContain('this.notify()')
  })

  test('② the panel publishes the same predicate it paints with', () => {
    const call = PANEL.indexOf('store.setSurfaceTooSmall(')
    expect(call, 'the panel publishes the flag during render').toBeGreaterThan(-1)
    const line = PANEL.slice(call, PANEL.indexOf('\n', call))
    // Hero: the hero budget's own verdict; docked: the docked minimum. Both are
    // the exact conditions the render branches on, so the gate can never
    // disagree with what is on screen.
    expect(line).toContain('heroB?.fits === false')
    expect(line).toContain('!dockedFits(store.rows)')
  })

  test('③ handleKey gates BEFORE any panel sees the key — with NO escape hatch', () => {
    const gate = INDEX.indexOf('if (onConversationSurface && store.surfaceTooSmall) {')
    const dispatch = INDEX.indexOf('def?.handleKey?.(k, store)')
    expect(gate, 'the gate exists').toBeGreaterThan(-1)
    expect(dispatch, 'the dispatch exists').toBeGreaterThan(-1)
    expect(gate, 'the gate must sit before the dispatch').toBeLessThan(dispatch)
    // The gate's OWN body (up to its closing brace), not everything up to the
    // dispatch — `const def = …` sits in between and would defeat endsWith.
    const gateClose = INDEX.indexOf('\n  }\n', gate)
    expect(gateClose, 'the gate closes').toBeGreaterThan(gate)
    const body = INDEX.slice(gate, gateClose)
    // NO escape hatch (user decision, 2026-09-13): quitting does not remove the
    // cause — a re-launch at the same height shows the same notice — so every key
    // is dropped and the notice says "make the terminal taller". Ctrl+C must NOT
    // be special-cased, and the old `requestQuit` hook must be gone entirely.
    expect(body, 'no Ctrl+C special case').not.toContain("(k.char ?? '') === 'c'")
    expect(body, 'no quit hook in the gate').not.toContain('requestQuit')
    expect(INDEX, 'the requestQuit hook is removed').not.toContain('requestQuit')
    expect(body.trimEnd().endsWith('return'), 'the gate drops everything with a bare return').toBe(true)
    // Fullscreen dialogs stay live: only the conversation surface (and the
    // overlay docks it embeds) may be gated.
    expect(INDEX.slice(gate - 400, gate)).toContain("activePanel.mode !== 'fullscreen'")
    expect(INDEX.slice(gate - 400, gate)).toContain("store.panel === 'conversation'")
  })

  test('④ the notice band is the PAINTED notice height on both surfaces', () => {
    // Same drift class as the gate itself: the hero branch of `composerBand`
    // hardcoded `height: 1` while its notice had been split into two rows (the
    // docked branch had been updated). Both branches must derive the height from
    // the very builder the render maps over, never from a literal.
    // Scoped to `composerBand` itself: matching the first `if (!b.fits) return`
    // anywhere in the panel let an unrelated guard in another function shadow the
    // band this test is about.
    const bandAt = PANEL.indexOf('function composerBand(')
    expect(bandAt, 'composerBand exists').toBeGreaterThan(-1)
    const BAND = PANEL.slice(bandAt, PANEL.indexOf('\nexport function ', bandAt + 1))
    const line = (needle: string): string => {
      const at = BAND.indexOf(needle)
      expect(at, `${needle} exists in composerBand`).toBeGreaterThan(-1)
      return BAND.slice(at, BAND.indexOf('\n', at))
    }
    const heroBand = line('if (!b.fits) return')
    const dockedBand = line('if (!dockedFits(rows)) return')
    expect(heroBand, 'hero band height = hero notice rows').toContain('heroTooSmallLines(COMPOSER_MIN_HEIGHT).length')
    expect(heroBand, 'no hardcoded hero band height').not.toContain('height: 1')
    expect(dockedBand, 'docked band height = docked notice rows').toContain('tooSmallNoticeLines(DOCKED_MIN_ROWS).length')
    expect(dockedBand, 'no hardcoded docked band height').not.toContain('height: 2')
    // …and the paint at both call sites uses exactly those two builders.
    expect(PANEL, 'hero paint').toContain('{heroTooSmallLines(COMPOSER_MIN_HEIGHT).map(')
    expect(PANEL, 'docked paint').toContain('{tooSmallNoticeLines(DOCKED_MIN_ROWS).map(')
  })
})

/**
 * Source guards for the command palette's FILTER/draft sync.
 *
 * The bug this locks down (reported as "paste, then the cursor blinks outside the
 * input box"): `store.commandFilter` is separate state from `store.input`, and only
 * the TYPED-edit paths kept it in step. The paste path inserted the text and left
 * the filter alone, so pasting `/model` painted the full 15-command list while
 * typing the same six characters narrowed it to one, and because the caret is
 * parked on the palette's own rows while that box covers the input row
 * (`installFrameSuffix`), the hardware cursor sat on a command entry instead of the
 * draft. Measured on the packaged binary, same probe: paste left 15 entries with the
 * composer text hidden behind them and the cursor on `/exit`; typing left 1 entry
 * with the cursor on the draft. After the fix both leave 1 entry and the cursor on
 * the draft row.
 *
 * The guard is about structure, not strings: EVERY path that edits the draft must
 * call the one helper, so "a path forgot to sync" cannot return one path at a time.
 * That is exactly how it arrived — paste was added later than typing.
 */
describe('the command palette filter follows every draft edit', () => {
  /** The body of `conversationKey`, the composer's key/paste handler. */
  const handler = (): string => {
    const start = PANEL.indexOf('function conversationKey(')
    expect(start, 'conversationKey exists').toBeGreaterThan(-1)
    const end = PANEL.indexOf('\n/** The main conversation surface', start)
    return PANEL.slice(start, end === -1 ? undefined : end)
  }

  test('one helper owns the sync, and it handles both directions', () => {
    const start = PANEL.indexOf('function syncCommandFilter(): void {')
    expect(start, 'the shared helper exists').toBeGreaterThan(-1)
    const body = PANEL.slice(start, PANEL.indexOf('\n}', start))
    // Entering the palette: the filter is the draft minus the leading slash.
    expect(body).toContain("input.startsWith('/')")
    expect(body).toContain('input.slice(1)')
    // Leaving it: a draft that is no longer a command must CLEAR the filter, or a
    // stale non-empty filter narrows the list the next time the user types '/'.
    expect(body, 'must clear when the draft stops being a command').toContain("setCommandFilter('')")
  })

  test('the paste path syncs too (this is the regression)', () => {
    const body = handler()
    const paste = body.indexOf('if (k.paste !== undefined) {')
    expect(paste, 'the paste branch exists').toBeGreaterThan(-1)
    const branch = body.slice(paste, body.indexOf('\n  }', paste))
    expect(branch, 'the paste branch inserts the text').toContain('insertAtCursor(k.paste)')
    expect(branch, 'and must bring the filter with it').toContain('syncCommandFilter()')
  })

  test('no edit path writes the filter by hand any more', () => {
    const body = handler()
    // Backspace, delete and typing each used to spell the sync out inline; a new
    // path copying that spelling is how the paste route was missed.
    expect(body).not.toContain('setCommandFilter(store.input)')
    expect(body).not.toContain('setCommandFilter(store.input.slice(1))')
    for (const edit of ['backspaceAtCursor()', 'deleteForward()', 'insertAtCursor(char)']) {
      const at = body.indexOf(edit)
      expect(at, `${edit} is still an edit path`).toBeGreaterThan(-1)
      const after = body.slice(at, at + 200)
      expect(after, `${edit} must sync the filter`).toContain('syncCommandFilter()')
    }
  })
})
