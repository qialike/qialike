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

const INDEX = readFileSync(new URL('../packages/dsh-tui-app/src/index.tsx', import.meta.url), 'utf-8')
const PANEL = readFileSync(new URL('../packages/dsh-tui-app/src/panels/conversation.tsx', import.meta.url), 'utf-8')

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

  test('③ handleKey gates BEFORE any panel sees the key', () => {
    const gate = INDEX.indexOf('if (onConversationSurface && store.surfaceTooSmall) {')
    const dispatch = INDEX.indexOf('def?.handleKey?.(k, store)')
    expect(gate, 'the gate exists').toBeGreaterThan(-1)
    expect(dispatch, 'the dispatch exists').toBeGreaterThan(-1)
    expect(gate, 'the gate must sit before the dispatch').toBeLessThan(dispatch)
    const body = INDEX.slice(gate, dispatch)
    // The one escape hatch, and it must actually quit (`/exit` needs typing,
    // which is exactly what the gate removed).
    expect(body, 'Ctrl+C is the escape hatch').toContain("(k.char ?? '') === 'c'")
    expect(body, 'and it quits').toContain('requestQuit?.()')
    expect(body, 'the hook is wired to the launcher exit').toBeTruthy()
    expect(INDEX, 'requestQuit is assigned where io is in scope').toContain('requestQuit = () => { requestExit(io, 0) }')
    // Fullscreen dialogs stay live: only the conversation surface (and the
    // overlay docks it embeds) may be gated.
    expect(INDEX.slice(gate - 400, gate)).toContain("activePanel.mode !== 'fullscreen'")
    expect(INDEX.slice(gate - 400, gate)).toContain("store.panel === 'conversation'")
  })
})
