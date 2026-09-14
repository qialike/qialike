/**
 * Source guards for the IN-PLACE transcript array (`Store.items`).
 *
 * Why this exists: every streamed delta used to copy the whole rows array
 * (`this.items = [...this.items, chunk]`, `[...slice(0, -1), merged]`) — O(n) per
 * chunk, i.e. O(n²) per answer, with two full copies alive at once. That copy
 * was part of the measured peak while loading a giant session (see
 * `research/ai-agent-code-loading-survey.md` §9).
 *
 * The fix is a trade with exactly two failure modes, both pinned here:
 *   ① a mutation that does not bump `Store.itemsRev` (the render never learns);
 *   ② a consumer that still keys a memo on the array identity (stable now, so
 *      the memo would freeze after the first frame).
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const INDEX = readFileSync(new URL('../packages/dsh-tui-app/src/index.tsx', import.meta.url), 'utf-8')
const PANEL = readFileSync(new URL('../packages/dsh-tui-app/src/panels/conversation.tsx', import.meta.url), 'utf-8')

const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1

describe('in-place transcript array', () => {
  test('① every write goes through one of the three rev-bumping writers', () => {
    // Exactly three writers may touch the array: one whole-array assignment,
    // one append, one indexed write — each inside its helper, each bumping the
    // revision. Any fourth write site (or any other mutating array method) is a
    // mutation the render path cannot see.
    expect(count(INDEX, 'this.items = '), 'whole-array writes').toBe(1)
    expect(count(INDEX, 'this.items.push('), 'appends').toBe(1)
    expect(INDEX.match(/this\.items\[[^\]]*\]\s*=/g)?.length ?? 0, 'indexed writes').toBe(1)
    expect(count(INDEX, 'this._itemsRev += 1'), 'revision bumps').toBe(3)
    for (const method of ['splice', 'sort', 'pop', 'shift', 'unshift', 'reverse', 'fill', 'copyWithin']) {
      expect(count(INDEX, `this.items.${method}(`), `this.items.${method}( must not appear`).toBe(0)
    }
  })

  test('② the revision is published, and the array still reads as a live view', () => {
    expect(INDEX, 'zero-initialised field').toContain('private _itemsRev = 0')
    expect(INDEX, 'public getter').toContain('get itemsRev(): number { return this._itemsRev }')
    expect(INDEX, 'getItems hands out the live array').toContain('getItems(): readonly TranscriptItem[] { return this.items }')
  })

  test('③ the panel row memo keys on the revision, never on array identity', () => {
    expect(PANEL, 'the panel reads the revision').toContain('store.itemsRev')
    expect(PANEL, 'the row memo depends on it').toContain('}, [itemsRev, steps])')
    expect(PANEL, 'and no longer on the (stable) array identity').not.toContain('}, [items, steps])')
  })
})
