/**
 * Unit tests for the China gateway plugin (`tui-china-gateways`,
 * `packages/dsh-tui-app/src/china-gateways.ts` + its data file
 * `china-gateway-templates.json`): Qiniu / SiliconFlow templates register
 * through `tuiLlmTemplates`, unloaded wholesale by `dsh-tui-china-gateways.enabled: false`.
 *
 * Run with `bun test tests/china-gateways.test.ts`.
 *
 * @module dsh-tui/china-gateways-test
 */

import { describe, expect, test } from 'bun:test'
import { CHINA_GATEWAY_TEMPLATES, apply, name } from '../packages/dsh-tui-app/src/china-gateways.ts'

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

describe('tui-china-gateways plugin', () => {
  test('plugin identity and template routes', () => {
    expect(name).toBe('tui-china-gateways')
    expect(CHINA_GATEWAY_TEMPLATES.map((t) => t.route)).toEqual(['qiniu-ai', 'siliconflow', 'siliconflow-cn'])
    const qiniu = CHINA_GATEWAY_TEMPLATES.find((t) => t.route === 'qiniu-ai')
    expect(qiniu?.baseURL).toBe('https://api.qnaigc.com/v1')
    expect(qiniu?.models?.length).toBeGreaterThan(50)
  })

  test('every model entry carries id/name and positive limits', () => {
    for (const t of CHINA_GATEWAY_TEMPLATES) {
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
    expect(added.map((t) => t.route)).toEqual(['qiniu-ai', 'siliconflow', 'siliconflow-cn'])
  })

  test('explicit enabled: false unloads all gateways', () => {
    const { added, hidden } = runApply({ enabled: false })
    expect(added).toEqual([])
    expect(hidden).toEqual(['qiniu-ai', 'siliconflow', 'siliconflow-cn'])
  })
})
