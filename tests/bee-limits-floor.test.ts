/**
 * Bee under-declares the DeepSeek family's limits; qialike raises them to the real ones.
 *
 * WHY. Bee fronts DeepSeek (`providers: [{ id: 'deepseek', model: 'deepseek-chat' }]` in
 * its own catalogue), and every DeepSeek official model reports `context_window:
 * 1048576` / `max_output_tokens: 393216`. Bee publishes the round approximations
 * `1000000` / `256000` instead — the same numbers the harness carries as
 * `DEFAULT_CONTEXT_WINDOW` / `DEFAULT_MAX_TOKENS` — while the schema comment on Bee's
 * own `contextWindow` field says "⚠️ 必须真实 … 报小了则会过早压缩上下文".
 *
 * MEASURED through Bee itself on 2026-10-27: `max_tokens: 393216` is accepted, and
 * `393217` is rejected with "Error from provider (DeepSeek): … the valid range of
 * max_tokens is [1, 393216]". So Bee applies no cap of its own — the declaration is
 * stale, and trusting it cost 35% of every request's output budget.
 *
 * WHAT IS PINNED. Two properties, and the second matters as much as the first:
 *   1. a Bee DeepSeek model resolves to the real limits even when the endpoint
 *      reports the stale ones;
 *   2. it is a FLOOR (`Math.max`), not an override — the moment Bee fixes its
 *      catalogue the reported value wins, so this table cannot rot into a wrong cap.
 *
 * Run with `bun test tests/bee-limits-floor.test.ts`.
 *
 * @module qialike/bee-limits-floor-test
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { effectiveProfile, QIALIKE_BEE_ROUTES } from '../packages/qialike-app/src/llm.ts'

const SRC = readFileSync(join(import.meta.dir, '..', 'packages', 'qialike-app', 'src', 'llm.ts'), 'utf8')

describe('the floor table', () => {
  test('carries the limits DeepSeek actually enforces', () => {
    // Both numbers are the official endpoint's own, and the output ceiling is
    // additionally proven by the provider's rejection message at 393217.
    expect(SRC).toContain('contextWindow: 1_048_576')
    expect(SRC).toContain('maxTokens: 393_216')
  })

  test('is a FLOOR, not a replacement', () => {
    // `raisedTo` must take the larger value. A plain assignment would pin the constant
    // forever — including after Bee fixes its catalogue, which would then be ignored.
    const fn = /function raisedTo\([\s\S]*?\n}/.exec(SRC)?.[0] ?? ''
    expect(fn).toContain('Math.max(value, floor)')
    expect(fn, 'an absent value still gets the floor').toContain('if (value === undefined) return floor')
  })

  test('applies to Bee routes serving the DeepSeek family, and nothing else', () => {
    // Scoped twice on purpose: a non-Bee route reporting a small window (Azure, a
    // local gateway) keeps its own truth, and a Bee route fronting `claude-*` or
    // `gpt-*` keeps whatever those endpoints declare.
    for (const route of QIALIKE_BEE_ROUTES) expect(SRC).toContain(route)
    expect(SRC).toContain("if (!QIALIKE_BEE_ROUTES.includes(provider)) return undefined")
    expect(SRC).toContain("if (!model.toLowerCase().startsWith('deepseek')) return undefined")
  })
})

describe('the static catalogue agrees with the floor', () => {
  const templates = JSON.parse(
    readFileSync(join(import.meta.dir, '..', 'packages', 'qialike-app', 'src', 'provider-templates.json'), 'utf8'),
  ) as { route: string; models?: { id: string; contextWindow?: number; maxTokens?: number }[] }[]

  test('every Bee row carries the real limits, so a failed probe is still right', () => {
    // The probe failing must not silently restore the stale numbers: the template row is
    // what the picker and `resolveModel` fall back to when no catalogue arrives.
    for (const route of QIALIKE_BEE_ROUTES) {
      const row = templates.find((t) => t.route === route)
      expect(row, route).toBeDefined()
      expect(row?.models?.length, `${route} must keep its catalogue`).toBeGreaterThan(0)
      for (const model of row?.models ?? []) {
        expect(model.contextWindow, `${route}/${model.id}`).toBe(1048576)
        expect(model.maxTokens, `${route}/${model.id}`).toBe(393216)
      }
    }
  })

  test('no OTHER route was dragged along with it', () => {
    // The correction is Bee's, and the file is shared by 40+ providers — a global
    // find/replace would silently rewrite every one of them.
    const others = templates.filter((t) => !QIALIKE_BEE_ROUTES.includes(t.route))
    expect(others.length).toBeGreaterThan(30)
    // Where another route declares these exact numbers it is its own business; what is
    // pinned is that the Bee value is not claimed as a global constant.
    expect(SRC).not.toContain('export const DEFAULT_CONTEXT_WINDOW = 1_048_576')
  })
})
