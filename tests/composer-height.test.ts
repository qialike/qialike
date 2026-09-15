/**
 * Direct assertions for the composer's saturation bound
 * (`composerHeightSaturated`, `packages/dsh-tui-app/src/panels/conversation.tsx`).
 *
 * `composerHeight` itself needs the live module store, so the branch that makes
 * a large draft cheap is pinned here as a pure function: it is the whole reason
 * a multi-megabyte draft no longer pays a per-line `wrap-ansi` pass per render.
 *
 * Run with `bun test tests/composer-height.test.ts`.
 *
 * @module dsh-tui/composer-height-test
 */
import { describe, expect, test } from 'bun:test'
import { composerHeightSaturated } from '../packages/dsh-tui-app/src/panels/conversation.tsx'

describe('the height bound saturates exactly when the clamp binds', () => {
  // min=3, cap=20 (a docked card on an 28-row terminal): the exact height is
  // min + rows - 1, so the bound may return early from rows >= 18.
  test('returns the cap once the bound reaches it, undefined below', () => {
    expect(composerHeightSaturated(17 * 100, 100, 3, 20)).toBeUndefined() // 17 rows -> 19
    expect(composerHeightSaturated(18 * 100, 100, 3, 20)).toBe(20)       // 18 rows -> 20
    expect(composerHeightSaturated(19 * 100, 100, 3, 20)).toBe(20)
    expect(composerHeightSaturated(5_000_000, 100, 3, 20)).toBe(20)      // 1 MB single line
  })

  test('a draft that fits is never truncated by the bound', () => {
    expect(composerHeightSaturated(0, 100, 3, 20)).toBeUndefined()
    expect(composerHeightSaturated(100, 100, 3, 20)).toBeUndefined()
    expect(composerHeightSaturated(1_700, 100, 3, 20)).toBeUndefined()
  })

  test('degenerate widths cannot divide by zero or wrap backwards', () => {
    expect(composerHeightSaturated(10, 0, 1, 5)).toBe(5)   // usable floors at 1
    expect(composerHeightSaturated(-5, 100, 1, 5)).toBeUndefined()
  })

  test('it is monotone in cells (never un-saturates as a draft grows)', () => {
    let seenSat = false
    for (const cells of [0, 100, 900, 1_800, 1_801, 5_000, 50_000]) {
      const out = composerHeightSaturated(cells, 100, 3, 20)
      if (out !== undefined) seenSat = true
      else expect(seenSat, `un-saturated after saturating at ${cells}`).toBe(false)
    }
  })
})
