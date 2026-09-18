/**
 * The CPR glyph probe must never leave the HARDWARE CURSOR visible on the last
 * row.
 *
 * Reported on WSL and Ubuntu 24.04: typing `/` put a blinking cursor on the
 * status bar. Root cause: `measureOne` parks the cursor on the last row to read
 * its position report, but never hid it — and the command palette introduces
 * eight new ambiguous glyphs (the box + the hints' `—`/`…`), so a calibration
 * batch ran exactly while the composer caret was shown. The cursor it moved to
 * the last row stayed visible (measured on a pty that answers CPR: 5 of 14 boot
 * probes ran with a visible cursor parked on row 37).
 *
 * The probe now hides the cursor for the round trip and restores the app's own
 * state (through the frame suffix, which also parks the caret back at the
 * composer) instead of waiting for the next repaint.
 *
 * Run with `bun test tests/charwidth-probe-cursor.test.ts`.
 *
 * @module qialike/charwidth-probe-cursor-test
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { measureOne } from '../packages/qialike-app/src/charwidth.ts'

const writes: string[] = []
let handlers: Array<(chunk: unknown) => void> = []
const origWrite = process.stdout.write
const origOn = process.stdin.on
const origOff = process.stdin.off
const host = globalThis as { __dshTuiFrameSuffix?: () => string }

function install(cursorState: string | null): void {
  writes.length = 0
  handlers = []
  ;(process.stdout as unknown as { write: unknown }).write = (chunk: unknown) => {
    writes.push(String(chunk))
    return true
  }
  ;(process.stdin as unknown as { on: unknown }).on = (_event: string, fn: (chunk: unknown) => void) => {
    handlers.push(fn)
    return process.stdin
  }
  ;(process.stdin as unknown as { off: unknown }).off = () => process.stdin
  if (cursorState === null) delete host.__dshTuiFrameSuffix
  else host.__dshTuiFrameSuffix = () => cursorState
}

function restore(): void {
  ;(process.stdout as unknown as { write: unknown }).write = origWrite
  ;(process.stdin as unknown as { on: unknown }).on = origOn
  ;(process.stdin as unknown as { off: unknown }).off = origOff
  delete host.__dshTuiFrameSuffix
}

afterEach(restore)

describe('the CPR probe keeps the cursor off the screen', () => {
  test('hides it for the round trip and restores the app state after', async () => {
    install('\x1b[9;9H\x1b[?25h')
    const pending = measureOne(0x2014, 500) // — (the glyph the palette introduced)
    // The probe bytes: hide FIRST, then save/move/conceal/query/blank.
    expect(writes).toHaveLength(1)
    // (`process.stdout.rows` is whatever the test env reports: assert the shape.)
    expect(/^\x1b\[\?25l\x1b7\x1b\[\d+;1H\x1b\[8m/.test(writes[0]!)).toBe(true)
    expect(writes[0]).toContain('\x1b[8m\u2014\x1b[28m\x1b[6n')
    handlers[0]!('\x1b[24;3R') // terminal answers: the glyph advanced 2 cells
    await expect(pending).resolves.toBe(2)
    // Restore cursor position AND the app's own visibility/park in one write.
    expect(writes[1]).toBe('\x1b8\x1b[9;9H\x1b[?25h')
  })

  test('without the TUI hook it still restores the cursor (show fallback)', async () => {
    install(null)
    const pending = measureOne(0x2014, 500)
    handlers[0]!('\x1b[24;2R')
    await expect(pending).resolves.toBe(1)
    expect(writes[1]).toBe('\x1b8\x1b[?25h')
  })

  test('a terminal that never answers still restores after the timeout', async () => {
    install('\x1b[3;4H\x1b[?25l') // e.g. the palette is open: caret hidden
    const pending = measureOne(0x2014, 20)
    await expect(pending).resolves.toBeNull()
    expect(writes[1]).toBe('\x1b8\x1b[3;4H\x1b[?25l')
  })
})
