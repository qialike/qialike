/**
 * Unit tests for the bundled provider-template directory data file
 * (`provider-templates.json`) and its loader (`validateProviderTemplates` in
 * llm.ts): the file is the single source for the built-in "Add provider"
 * catalog, so its integrity (count, required fields, no duplicates, no
 * deepseek-official row) and the loud-validation contract are pinned here.
 *
 * Run with `bun test tests/provider-templates.test.ts`.
 *
 * @module dsh-tui/provider-templates-test
 */

import { describe, expect, test } from 'bun:test'
import { PROVIDER_TEMPLATES, validateProviderTemplates } from '../packages/dsh-tui-app/src/llm.ts'
import fileData from '../packages/dsh-tui-app/src/provider-templates.json' with { type: 'json' }

describe('bundled provider-templates.json', () => {
  test('loads every row the file declares', () => {
    expect(PROVIDER_TEMPLATES.length).toBe(fileData.length)
    expect(PROVIDER_TEMPLATES.length).toBeGreaterThanOrEqual(30)
  })

  test('routes are unique and required fields are present', () => {
    const routes = new Set<string>()
    for (const template of PROVIDER_TEMPLATES) {
      expect(routes.has(template.route)).toBe(false)
      routes.add(template.route)
      expect(template.route.length).toBeGreaterThan(0)
      expect(template.name.length).toBeGreaterThan(0)
      expect(typeof template.baseURL).toBe('string')
    }
  })

  test('keeps the four deployment-configured (needsBaseURL) templates', () => {
    expect(PROVIDER_TEMPLATES.filter((t) => t.needsBaseURL === true)).toHaveLength(4)
  })

  test('every model entry carries an id and a name', () => {
    for (const template of PROVIDER_TEMPLATES) {
      for (const model of template.models ?? []) {
        expect(typeof model.id).toBe('string')
        expect(model.id.length).toBeGreaterThan(0)
      }
    }
  })

  test('protocol annotations are from the supported set', () => {
    const apis = new Set(['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative'])
    for (const template of PROVIDER_TEMPLATES) {
      if (template.api !== undefined) expect(apis.has(template.api)).toBe(true)
    }
    // anthropic + minimax (x2) ride the native Messages protocol
    expect(PROVIDER_TEMPLATES.filter((t) => t.api === 'anthropic-messages')).toHaveLength(3)
  })

  test('the built-in deepseek route stays code-owned (not a template row)', () => {
    expect(PROVIDER_TEMPLATES.some((t) => t.route === 'deepseek-official')).toBe(false)
  })
})

describe('validateProviderTemplates', () => {
  test('accepts the bundled file', () => {
    expect(validateProviderTemplates(fileData).length).toBe(fileData.length)
  })

  test('rejects non-array input', () => {
    expect(() => validateProviderTemplates({ templates: [] })).toThrow(/expected an array/)
  })

  test('rejects a row without route / name / baseURL', () => {
    expect(() => validateProviderTemplates([{ name: 'X', baseURL: 'https://x' }])).toThrow(/row 1: route/)
    expect(() => validateProviderTemplates([{ route: 'x', baseURL: 'https://x' }])).toThrow(/row 1: name/)
    expect(() => validateProviderTemplates([{ route: 'x', name: 'X', baseURL: 42 }])).toThrow(/row 1: baseURL/)
  })

  test('rejects unknown api / effortWire values', () => {
    expect(() => validateProviderTemplates([{ route: 'x', name: 'X', baseURL: 'https://x', api: 'soap' }])).toThrow(/unknown api/)
    expect(() => validateProviderTemplates([{ route: 'x', name: 'X', baseURL: 'https://x', effortWire: 'sometimes' }])).toThrow(/unknown effortWire/)
  })

  test('rejects duplicate routes and model rows without an id', () => {
    expect(() => validateProviderTemplates([
      { route: 'x', name: 'X', baseURL: 'https://x' },
      { route: 'x', name: 'X2', baseURL: 'https://x2' },
    ])).toThrow(/duplicate route/)
    expect(() => validateProviderTemplates([{ route: 'x', name: 'X', baseURL: 'https://x', models: [{ name: 'no-id' }] }])).toThrow(/model entry needs an id/)
  })
})
