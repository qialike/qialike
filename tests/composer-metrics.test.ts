/**
 * The shared composer arithmetic (`packages/qialike-app/src/composer-metrics.ts`)
 * — the numbers the conversation panel and the dock pointer mirror must agree on.
 *
 * Run with `bun test tests/composer-metrics.test.ts`.
 *
 * @module qialike/composer-metrics-test
 */
import { describe, expect, test } from 'bun:test'
import {
  composerCap, composerHeightFor, composerHeightSaturated, composerUsableFor,
} from '../packages/qialike-app/src/composer-metrics.ts'

describe('the shared arithmetic', () => {
  test('usable width floors at 10 and subtracts the card chrome', () => {
    expect(composerUsableFor(133)).toBe(129)
    expect(composerUsableFor(13)).toBe(10)
    expect(composerUsableFor(1)).toBe(10)
  })

  test('the cap is rows − 8 but never below min', () => {
    expect(composerCap(37, 3)).toBe(29)
    expect(composerCap(10, 3)).toBe(3)
    expect(composerCap(0, 3)).toBe(3)
  })

  test('the exact height clamps at the cap', () => {
    expect(composerHeightFor(1, 3, 20)).toBe(3)
    expect(composerHeightFor(18, 3, 20)).toBe(20)
    expect(composerHeightFor(500, 3, 20)).toBe(20)
  })

  test('saturation fires exactly when the bound reaches the cap', () => {
    expect(composerHeightSaturated(17 * 100, 100, 3, 20)).toBeUndefined()
    expect(composerHeightSaturated(18 * 100, 100, 3, 20)).toBe(20)
    expect(composerHeightSaturated(5_000_000, 100, 3, 20)).toBe(20)
    // Degenerate width cannot divide by zero; 0 cells stays exact.
    expect(composerHeightSaturated(0, 0, 3, 20)).toBeUndefined()
    expect(composerHeightSaturated(10, 0, 3, 5)).toBe(5)
  })
})
