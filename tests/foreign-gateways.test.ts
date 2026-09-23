/**
 * Unit tests for the foreign gateway plugin (`tui-foreign-gateways`): the
 * aggregation gateways it registers through `tuiLlmTemplates`, and the
 * `qialike-foreign-gateways.enabled: false` wholesale unload.
 *
 * Run with `bun test tests/foreign-gateways.test.ts`.
 *
 * @module qialike/foreign-gateways-test
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FOREIGN_GATEWAY_TEMPLATES, apply, name } from '../packages/qialike-app/src/foreign-gateways.ts'

/**
 * The `enabled` switch lives in `qialike.json` since 0.1.7 (`readSection`), so a
 * case writes that file instead of faking the harness settings service.
 */
function runApply(section: unknown): { added: { route: string }[]; hidden: string[] } {
  const home = mkdtempSync(join(tmpdir(), 'qialike-foreign-gateways-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  writeFileSync(join(home, 'qialike.json'), JSON.stringify({ foreign_gateways: section }))
  const added: { route: string }[] = []
  const hidden: string[] = []
  try {
    const ctx = {
      get(id: string) {
        if (id === 'tuiLlmTemplates') {
          return {
            add: (templates: readonly { route: string }[]) => added.push(...templates),
            hideRoutes: (routes: readonly string[]) => hidden.push(...routes),
          }
        }
        return undefined
      },
    }
    apply(ctx as never)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
  return { added, hidden }
}

describe('tui-foreign-gateways plugin', () => {
  test('plugin identity and template routes', () => {
    expect(name).toBe('tui-foreign-gateways')
    const routes = FOREIGN_GATEWAY_TEMPLATES.map((t) => t.route)
    expect(routes).toContain('openrouter')
    expect(routes).toContain('vercel-ai-gateway')
    expect(routes).toContain('groq')
    expect(routes).toHaveLength(11)
    expect(FOREIGN_GATEWAY_TEMPLATES.filter((t) => t.needsBaseURL === true).map((t) => t.route).sort())
      .toEqual(['cloudflare-ai-gateway', 'cloudflare-workers-ai'])
  })

  test('every model entry carries id/name and positive limits', () => {
    for (const t of FOREIGN_GATEWAY_TEMPLATES) {
      for (const m of t.models ?? []) {
        expect(typeof m.id).toBe('string')
        expect(m.id.length).toBeGreaterThan(0)
        expect(typeof m.name).toBe('string')
        if (m.contextWindow !== undefined) expect(m.contextWindow).toBeGreaterThan(0)
        if (m.maxTokens !== undefined) expect(m.maxTokens).toBeGreaterThan(0)
      }
    }
  })

  test('enabled by default: adds all gateways and hides nothing', () => {
    const { added, hidden } = runApply(undefined)
    expect(hidden).toEqual([])
    expect(added.length).toBe(11)
  })

  test('explicit enabled: false unloads all gateways', () => {
    const { added, hidden } = runApply({ enabled: false })
    expect(added).toEqual([])
    expect(hidden.length).toBe(11)
  })
})
