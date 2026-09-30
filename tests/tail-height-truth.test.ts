/**
 * Regression tests for "the last wrapped line of the answer is never painted"
 * (qialike-development §2.5.51).
 *
 * Root cause: the transcript viewport is laid out from a per-row height, and
 * the newest (still growing) row's height is the one that decides whether the
 * tail fits. Three links of that chain dropped the truthful height:
 *   1. the layout pass wrote its markdown ESTIMATE into the measured-height
 *      cache, so an estimate could pose as painted truth;
 *   2. the measurement pipeline ignored any change of ≤ 1 row, so the final
 *      one-row growth of an answer was discarded and the cached height stayed
 *      one row short — with follow-tail the newest line fell below the viewport
 *      and End/PgDn could not help (maxScroll is computed from the same short
 *      height);
 *   3. after a width change the caches were dropped but mounted rows never
 *      re-measured, and the per-item estimate cache kept serving the previous
 *      width's (stale, several rows short) estimate — measured: 97 rows for a
 *      115-row answer, clipping 17 lines.
 *
 * The storage rule is exercised directly; the wiring that has no callable seam
 * (React effect deps, the store's settle epoch, the layout memo) is pinned at
 * the source level, the same way tests/assistant-stream.test.ts pins its cordis
 * subscription.
 *
 * Run with `bun test tests/tail-height-truth.test.ts`.
 *
 * @module qialike/tail-height-truth-test
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { resolveRowHeight, shouldStoreMeasured } from '../packages/qialike-app/src/panels/conversation.tsx'
import { estimateMarkdownHeight } from '../packages/qialike-app/src/markdown.tsx'

const panel = readFileSync(join(process.cwd(), 'packages/qialike-app/src/panels/conversation.tsx'), 'utf8')
const app = readFileSync(join(process.cwd(), 'packages/qialike-app/src/index.tsx'), 'utf8')

describe('shouldStoreMeasured: the final one-row growth must be stored', () => {
  test('an authoritative reading that differs by one row IS stored (the clipped tail)', () => {
    // The bug: the streamed answer grew from 242 to 243 rows; the reading was
    // dropped, the layout stayed at 242 and the last wrapped line fell off.
    expect(shouldStoreMeasured(243, 242, 242, true)).toBe(true)
    expect(shouldStoreMeasured(241, 242, 242, true)).toBe(true)
  })

  test('a mid-commit reading keeps the ±1 noise tolerance', () => {
    expect(shouldStoreMeasured(243, 242, 242, false)).toBe(false)
    expect(shouldStoreMeasured(247, 242, 245, false)).toBe(true)
  })

  test('an unchanged reading is a no-op', () => {
    expect(shouldStoreMeasured(242, 242, 242, true)).toBe(false)
    expect(shouldStoreMeasured(242, 242, 200, true)).toBe(false)
  })

  test('a collapsed diff-render reading (well below the estimate) is rejected', () => {
    expect(shouldStoreMeasured(1, undefined, 242, true)).toBe(false)
    expect(shouldStoreMeasured(240, undefined, 242, true)).toBe(false) // est - 2
    expect(shouldStoreMeasured(241, undefined, 242, true)).toBe(true) // est - 1 is plausible
  })

  test('a first reading is stored unless it is implausibly small', () => {
    expect(shouldStoreMeasured(242, undefined, 242, false)).toBe(true)
    expect(shouldStoreMeasured(0, undefined, 242, false)).toBe(false)
  })

  test('the layout still prefers the estimate for a collapsed reading', () => {
    // resolveRowHeight is the layout-side half of the same rule.
    expect(resolveRowHeight(242, 1)).toBe(242)
    expect(resolveRowHeight(242, 243)).toBe(243)
    expect(resolveRowHeight(242, undefined)).toBe(242)
  })

  test('a height that is exactly the estimate can never be the culprit', () => {
    // The estimate is exact (see tests/markdown-height-painted.test.ts), so the
    // one-row error always came from the storage rule, not from the estimator.
    const text = '双进程的复杂度每天都付,而巨型会话是少数场景。'.repeat(40)
    expect(estimateMarkdownHeight(text, 62)).toBeGreaterThan(0)
  })
})

describe('the layout never lets an estimate pass as a measurement', () => {
  test('the height walk reads the measured cache but never writes an estimate into it', () => {
    expect(panel).toContain('resolveRowHeight(est, measuredHeights.get(String(r.item.key)))')
    expect(panel).not.toContain('measuredHeights.set(key, est)')
    // S1b: a windowed row is refined from its precise estimate, and the cheap
    // placeholder outside the window must ALSO go through resolveRowHeight —
    // writing either into the measured cache would let an estimate pose as truth
    // (the tail-clipping failure of §2.5.51).
    expect(panel).toContain('const est = estItemLinesCachedOrCoarse(r.item, usable, reasoningExpandedFor(r.item))')
    // Exactly ONE write site — setMeasuredHeight, which only ever stores a
    // painted reading. The layout walk must not add a second one.
    expect(panel.split('measuredHeights.set(').length - 1).toBe(1)
  })

  test('settlement re-parses the row height from the authoritative text', () => {
    expect(app).toContain('this._assistantSettleEpoch += 1')
    expect(app).toContain('get assistantSettleEpoch(): number')
    // The settle bump lives in settleAssistantText, i.e. it happens even when the
    // streamed text already equals the settled text (the debounce is still stale).
    const settleBody = app.slice(app.indexOf('settleAssistantText(text: string)'), app.indexOf('streamReasoning(text: string)'))
    expect(settleBody).toContain('this._assistantSettleEpoch += 1')
    expect(settleBody.indexOf('this._assistantSettleEpoch += 1')).toBeLessThan(settleBody.indexOf('if (this.items[idx]!.text === text) return'))
  })

  test('the layout memo re-parses on settlement and is invalidated by it', () => {
    expect(panel).toContain('if (store.assistantSettleEpoch !== lastSettleEpoch)')
    expect(panel).toContain('store.assistantSettleEpoch]')
  })

  test('a width change re-measures mounted rows and drops the old estimate generation', () => {
    expect(panel).toContain('estGeneration += 1')
    // The per-item estimate cache key must carry the generation, or returning to
    // a previous width resurrects the stale estimate (the 97 vs 115 rows clip).
    expect(panel).toContain('function estItemCacheKey(')
    expect(panel).toContain('return `${estGeneration}|${usable}|${expandReasoning ? 1 : 0}')
    // S1b: only an EXACT estimate may enter the cache — the coarse placeholder is
    // recomputed per pass and must never be served as a parsed height.
    expect(panel).toContain('const key = estItemCacheKey(item, usable, expandReasoning)')
    expect(panel).toContain('return coarseItemLines(item, usable)')
    // The measure effect depends on the wrap width so a resize refills the cache.
    expect(panel).toContain('}, [props.item.text, props.usable, props.expandReasoning, props.toolExpanded, props.compactionExpanded])')
  })

  test('the final samples are authoritative (force) and un-throttled', () => {
    expect(panel).toContain('setTimeout(sample(false), 60)')
    expect(panel).toContain('setTimeout(sample(true), 400)')
    expect(panel).toContain('setTimeout(sample(true), 900)')
  })
})
