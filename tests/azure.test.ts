/**
 * Unit tests for the Azure provider plugin (`tui-azure`,
 * `packages/qialike-app/src/azure.ts` + `azure-templates.json`): registers the
 * Azure deployment-configured template; `qialike-azure.enabled: false` unloads it.
 *
 * Run with `bun test tests/azure.test.ts`.
 *
 * @module qialike/azure-test
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AZURE_TEMPLATES, apply, name } from '../packages/qialike-app/src/azure.ts'

/**
 * The `enabled` switch lives in `qialike.json` since 0.1.7 (`readSection`), so a
 * case writes that file instead of faking the harness settings service.
 */
function runApply(section: unknown): { added: { route: string }[]; hidden: string[] } {
  const home = mkdtempSync(join(tmpdir(), 'qialike-azure-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  writeFileSync(join(home, 'qialike.json'), JSON.stringify({ azure: section }))
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

describe('tui-azure plugin', () => {
  test('registers the Azure deployment template', () => {
    expect(name).toBe('tui-azure')
    expect(AZURE_TEMPLATES.map((t) => t.route)).toEqual(['azure'])
    const azure = AZURE_TEMPLATES[0]
    expect(azure?.name).toBe('Azure')
    expect(azure?.apiKeyEnv).toBe('AZURE_API_KEY')
    expect(azure?.needsBaseURL).toBe(true)
    expect(azure?.models?.length).toBeGreaterThan(50)
  })

  test('every model entry carries id/name and positive limits', () => {
    for (const t of AZURE_TEMPLATES) {
      for (const m of t.models ?? []) {
        expect(typeof m.id).toBe('string')
        expect(m.id.length).toBeGreaterThan(0)
        expect(typeof m.name).toBe('string')
        if (m.contextWindow !== undefined) expect(m.contextWindow).toBeGreaterThan(0)
        if (m.maxTokens !== undefined) expect(m.maxTokens).toBeGreaterThan(0)
      }
    }
  })

  test('enabled by default adds Azure; explicit false unloads it', () => {
    expect(runApply(undefined).added.map((t) => t.route)).toEqual(['azure'])
    expect(runApply(undefined).hidden).toEqual([])
    const off = runApply({ enabled: false })
    expect(off.added).toEqual([])
    expect(off.hidden).toEqual(['azure'])
  })
})
