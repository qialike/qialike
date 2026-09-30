/**
 * Unit tests for the stderr log mirror's sanitization (`sanitizeStderrChunk`).
 *
 * The mirror in `log.ts` appends every non-debug stderr line to
 * `~/.dsh/qialike.log` so real crashes are captured there. Terminal control
 * sequences written to stderr by cursor libraries (cli-cursor's `\x1b[?25l`
 * hide / `\x1b[?25h` show, Ink's frame caret parking) are NOT errors and must
 * not pollute the log — these tests pin that contract.
 *
 * Run with `bun test tests/log-mirror.test.ts`.
 *
 * @module qialike/log-mirror-test
 */

import { describe, expect, test } from 'bun:test'
import { sanitizeStderrChunk } from '../packages/qialike-app/src/log.ts'

const ESC = '\u001b'

describe('sanitizeStderrChunk', () => {
  test('pure cursor sequences are dropped (the ?25l/?25h noise)', () => {
    expect(sanitizeStderrChunk(`${ESC}[?25l`)).toBeNull()
    expect(sanitizeStderrChunk(`${ESC}[?25h`)).toBeNull()
    expect(sanitizeStderrChunk(`${ESC}[?25h${ESC}[18;3H`)).toBeNull() // frame suffix caret park
    expect(sanitizeStderrChunk(`${ESC}[?25l\n`)).toBeNull()
    expect(sanitizeStderrChunk(`${ESC}[?1049h`)).toBeNull() // alternate screen enter
  })

  test('colors and cursor moves are stripped from real messages', () => {
    expect(sanitizeStderrChunk(`${ESC}[31mERROR${ESC}[0m: boom`)).toBe('ERROR: boom')
    expect(sanitizeStderrChunk(`line1${ESC}[2Kline2`)).toBe('line1line2')
    expect(sanitizeStderrChunk(`${ESC}]52;c;dGVzdA==${ESC}\\msg`)).toBe('msg') // OSC
  })

  test('plain error text passes through unchanged (trailing whitespace trimmed)', () => {
    expect(sanitizeStderrChunk("<Box> can't be nested inside <Text>")).toBe("<Box> can't be nested inside <Text>")
    expect(sanitizeStderrChunk('oops\n')).toBe('oops')
  })

  test('empty / whitespace-only chunks are dropped', () => {
    expect(sanitizeStderrChunk('')).toBeNull()
    expect(sanitizeStderrChunk('   \n')).toBeNull()
  })
})
