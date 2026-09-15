/**
 * The composer height MIRROR: `pointer-region.composerStripRows` (the dock
 * pointer router, bundled separately) and `conversation.composerHeight` (the
 * panel that paints the card) must produce the same card height for the same
 * draft — a one-row disagreement misroutes the pointer region or clips the card.
 *
 * Since the arithmetic moved into `composer-metrics.ts`, this test pins both
 * ends against that one source AND asserts the O(1) saturation branch is what a
 * multi-megabyte draft takes (the exact row count is then irrelevant: the clamp
 * has already bound).
 *
 * Run with `bun test tests/composer-mirror.test.ts`.
 *
 * @module dsh-tui/composer-mirror-test
 */
import { describe, expect, test } from 'bun:test'
import stringWidth from 'string-width'
import wrapAnsi from 'wrap-ansi'
import { composerStripRows } from '../packages/dsh-tui-app/src/pointer-region.ts'
import {
  composerCap, composerHeightFor, composerHeightSaturated, composerUsableFor,
} from '../packages/dsh-tui-app/src/composer-metrics.ts'
import { COMPOSER_MIN_HEIGHT } from '../packages/dsh-tui-app/src/layout-budget.ts'

/** The exact wrapped-row count, the number the saturation bound must equal once
 *  it binds (and the thing a big draft must NOT pay for). */
function exactRows(input: string, usable: number): number {
  return input.split('\n').reduce(
    (sum, seg) => sum + (seg === '' ? 1 : wrapAnsi(seg, usable, { trim: false, hard: true }).split('\n').length),
    0,
  )
}

function mirroredHeight(input: string, rows: number, width: number, hasImage: boolean): number {
  const usable = composerUsableFor(width)
  const min = COMPOSER_MIN_HEIGHT
  const cap = composerCap(rows, min)
  const saturated = composerHeightSaturated(stringWidth(input), usable, min, cap)
  const wrapped = exactRows(input, usable)
  const expected = composerHeightFor(wrapped, min, cap)
  // The shared bound must agree with the exact count wherever it fires.
  if (saturated !== undefined) expect(saturated).toBe(expected)
  return expected
}

describe('composerStripRows mirrors composerHeightFor(exact rows, min, cap)', () => {
  const drafts = [
    '',
    'x',
    'hello world',
    'a\nb\n\nc',
    'a'.repeat(200),
    '世界世界世界世界世界',
    '🙂 '.repeat(60),
    Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n'),
  ]

  test('a batch of drafts × terminal heights × image chip', () => {
    for (const draft of drafts) {
      for (const rows of [18, 24, 40, 80]) {
        for (const width of [40, 100, 133]) {
          const messageRight = width
          for (const hasImage of [false, true]) {
            const strip = composerStripRows(width, rows, draft, hasImage, messageRight)
            if (strip === null) continue
            const expected = mirroredHeight(draft, rows, messageRight, hasImage)
            expect(strip.height - (hasImage ? 1 : 0)).toBe(expected)
          }
        }
      }
    }
  })

  test('a 1 MB draft takes the O(1) saturation branch in BOTH copies', () => {
    const single = 'a'.repeat(1024 * 1024)
    const multi = ('lorem ipsum dolor sit amet consectetur\n').repeat(32000)
    for (const draft of [single, multi]) {
      const usable = composerUsableFor(133)
      const min = COMPOSER_MIN_HEIGHT
      const cap = composerCap(24, min)
      // The bound binds → neither side has to count rows.
      expect(composerHeightSaturated(stringWidth(draft), usable, min, cap)).toBe(cap)
      const strip = composerStripRows(133, 24, draft, false, 133)
      expect(strip).not.toBeNull()
      expect(strip!.height).toBe(cap)
      expect(mirroredHeight(draft, 24, 133, false)).toBe(cap)
    }
  })
})
