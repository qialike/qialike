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
 *
 * KNOWN LIMIT of a text guard: it can only see writes spelled in this file. A
 * mutation through the live alias (`const a = store.getItems(); a.push(x)`) is
 * invisible to it — that is why `getItems()` hands out `readonly TranscriptItem[]`
 * and why every consumer was audited by hand when the array went in-place.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const INDEX = readFileSync(new URL('../packages/dsh-tui-app/src/index.tsx', import.meta.url), 'utf-8')
const PANEL = readFileSync(new URL('../packages/dsh-tui-app/src/panels/conversation.tsx', import.meta.url), 'utf-8')

const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1
/** Occurrences of a /g pattern. `String.match` ignores `lastIndex`, so the
 *  patterns below are safe to reuse across calls. */
const hits = (re: RegExp, haystack: string): number => haystack.match(re)?.length ?? 0

/** An indexed or whole-length WRITE — any assignment OPERATOR, never a
 *  comparison. The operator group covers the compound forms (`+=`, `??=`, `||=`,
 *  `&&=`, `**=`, `<<=`, `>>=`, `>>>=`, `&=`, `|=`, `^=`, `%=`) as well as plain
 *  `=`; `(?!=)` rejects `==`/`===`, and `<`/`>`/`!` alone are not in the set, so
 *  `<=`, `>=` and `!=` stay comparisons. */
const IDX_WRITE = /this\.items\[[^\]]*\]\s*(?:[-+*/%&|^]|\*\*|<<|>>>?|&&|\|\||\?\?)?=(?!=)/g
const LEN_WRITE = /this\.items\.length\s*(?:[-+*/%&|^]|\*\*|<<|>>>?|&&|\|\||\?\?)?=(?!=)/g

describe('in-place transcript array', () => {
  test('① every write goes through one of the three rev-bumping writers', () => {
    // Exactly three writers may touch the array: one whole-array assignment,
    // one append, one indexed write — each inside its helper, each bumping the
    // revision. Any fourth write site (or any other mutating route) is a
    // mutation the render path cannot see.
    expect(count(INDEX, 'this.items = '), 'whole-array writes').toBe(1)
    expect(count(INDEX, 'this.items.push('), 'appends').toBe(1)
    expect(hits(IDX_WRITE, INDEX), 'indexed writes').toBe(1)
    expect(count(INDEX, 'this._itemsRev += 1'), 'revision bumps').toBe(3)
    for (const method of ['splice', 'sort', 'pop', 'shift', 'unshift', 'reverse', 'fill', 'copyWithin']) {
      expect(count(INDEX, `this.items.${method}(`), `this.items.${method}( must not appear`).toBe(0)
    }
    // Routes a `this.items[...]` pattern would miss.
    expect(hits(LEN_WRITE, INDEX), 'this.items.length = n must not appear').toBe(0)
    for (const route of ['delete this.items', 'Object.assign(this.items', 'Array.prototype.splice.call(this.items']) {
      expect(count(INDEX, route), `${route} must not appear`).toBe(0)
    }
  })

  test('①b the write patterns ignore comparisons (and still catch real writes)', () => {
    // The first cut of this guard used `\]\s*=` without the lookahead, so ANY
    // future element comparison (`=== undefined`, `!== last`) counted as a
    // write and turned the guard red spuriously.
    for (const cmp of [
      'if (this.items[i] === undefined) return',
      'if (this.items[i] !== last) return',
      'if (this.items[i] == x) return',
      'while (this.items.length === 0) {}',
      'if (this.items.length >= 1) return',
      'if (this.items.length <= 1) return',
    ]) {
      expect(hits(IDX_WRITE, cmp), `IDX_WRITE must not match: ${cmp}`).toBe(0)
      expect(hits(LEN_WRITE, cmp), `LEN_WRITE must not match: ${cmp}`).toBe(0)
    }
    expect(hits(IDX_WRITE, 'this.items[index] = item'), 'the real indexed write').toBe(1)
    expect(hits(IDX_WRITE, 'this.items[i] = { ...this.items[i], text }'), 'an element replace').toBe(1)
    expect(hits(LEN_WRITE, 'this.items.length = 0'), 'the real length write').toBe(1)
  })

  test('①c every compound assignment is caught too', () => {
    // A guard that only sees `=` is not a guard on a mutable array: `items[i] +=`
    // and `items.length -= 1` mutate in place and never bump the revision, so
    // the render freezes — exactly the failure this file exists to prevent.
    for (const op of ['+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '>>>=', '&=', '|=', '^=', '&&=', '||=', '??=']) {
      expect(hits(IDX_WRITE, `this.items[i] ${op} x`), `IDX_WRITE must match ${op}`).toBe(1)
      expect(hits(LEN_WRITE, `this.items.length ${op} 1`), `LEN_WRITE must match ${op}`).toBe(1)
    }
    for (const cmp of ['this.items[i] <= x', 'this.items[i] >= x', 'this.items[i] != x',
                       'this.items.length <= 1', 'this.items.length >= 1']) {
      expect(hits(IDX_WRITE, cmp), `IDX_WRITE must not match: ${cmp}`).toBe(0)
      expect(hits(LEN_WRITE, cmp), `LEN_WRITE must not match: ${cmp}`).toBe(0)
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
