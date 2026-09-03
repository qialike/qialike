/**
 * Unit tests for the foreign gateway plugin (`tui-foreign-gateways`): the
 * aggregation gateways it registers through `tuiLlmTemplates`, and the
 * `dsh-tui-foreign-gateways.enabled: false` wholesale unload.
 *
 * Run with `bun test tests/foreign-gateways.test.ts`.
 *
 * @module dsh-tui/foreign-gateways-test
 */

import { describe, expect, test } from 'bun:test'
import { FOREIGN_GATEWAY_TEMPLATES, apply, name } from '../packages/dsh-tui-app/src/foreign-gateways.ts'

function runApply(settingsValue: unknown): { added: { route: string }[]; hidden: string[] } {
  const added: { route: string }[] = []
  const hidden: string[] = []
  const ctx = {
    get(id: string) {
      if (id === 'settings') return { register: () => ({ get: () => settingsValue }) }
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
