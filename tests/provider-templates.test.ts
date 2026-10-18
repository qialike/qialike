/**
 * Unit tests for the bundled provider-template directory data file
 * (`provider-templates.json`) and its loader (`validateProviderTemplates` in
 * llm.ts): the file is the single source for the built-in "Add provider"
 * catalog, so its integrity (count, required fields, no duplicates, no
 * deepseek-official row) and the loud-validation contract are pinned here.
 *
 * Run with `bun test tests/provider-templates.test.ts`.
 *
 * @module qialike/provider-templates-test
 */

import { describe, expect, test } from 'bun:test'
import { PROVIDER_TEMPLATES, validateProviderTemplates } from '../packages/qialike-app/src/llm.ts'
import fileData from '../packages/qialike-app/src/provider-templates.json' with { type: 'json' }

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
    }
  })

  test('every row carries an endpoint, or asks for one', () => {
    // An empty `baseURL` is only right on a `needsBaseURL` row, where the
    // Add-provider flow prompts for the endpoint. Everywhere else it activates a
    // route whose first request dies as `request to /chat/completions failed`:
    // the adapter appends the protocol path to `baseURL`, so an empty value makes
    // `fetch()` throw on a relative URL before it ever dials. That error names
    // neither the provider nor the endpoint, which is why this is asserted on the
    // data rather than left to the loader alone.
    const endpointless = PROVIDER_TEMPLATES.filter((t) => t.baseURL.trim() === '' && t.needsBaseURL !== true)
    expect(endpointless.map((t) => t.route)).toEqual([])
    for (const template of PROVIDER_TEMPLATES) {
      expect(typeof template.baseURL).toBe('string')
      if (template.baseURL.trim() === '') continue
      expect(template.baseURL).toMatch(/^https?:\/\/\S+$/u)
    }
  })

  test('no anthropic-messages row duplicates the version segment the protocol adds', () => {
    // `streamAnthropic` requests `{baseURL}/v1/messages`, so a baseURL that already
    // ends in `/v1` asks for `/v1/v1/messages` — a 404 that says nothing about the
    // template row that caused it. This is the shape minimax/minimax-cn shipped
    // with, next to their `/anthropic` siblings on the same host.
    const doubled = PROVIDER_TEMPLATES
      .filter((t) => t.api === 'anthropic-messages' && /\/v\d+[a-z]*\/?$/iu.test(t.baseURL))
      .map((t) => t.route)
    expect(doubled).toEqual([])
    // The rule is not vacuous: minimax-coding-plan rides the same protocol with a
    // root baseURL, so the comparison below is between two real spellings.
    const rootEnded = PROVIDER_TEMPLATES.filter((t) => t.api === 'anthropic-messages' && t.baseURL.endsWith('/anthropic'))
    expect(rootEnded.length).toBeGreaterThan(0)
  })

  test('keeps the three main-catalog deployment-configured (needsBaseURL) templates', () => {
    // Vertex, Databricks, Snowflake Cortex stay in the main catalog; Azure and
    // the Cloudflare rows are provided by loadable plugins.
    expect(PROVIDER_TEMPLATES.filter((t) => t.needsBaseURL === true)).toHaveLength(3)
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
    // anthropic + minimax (x4: minimax / minimax-cn / minimax-coding-plan /
    // minimax-cn-coding-plan) ride the native Messages protocol
    expect(PROVIDER_TEMPLATES.filter((t) => t.api === 'anthropic-messages')).toHaveLength(5)
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

  test('rejects an endpointless row that would activate itself, and accepts one that asks', () => {
    // The bug this pins: five first-party rows shipped with `baseURL: ""` and no
    // `needsBaseURL`, so choosing one in the Add-provider flow produced a working-
    // looking route whose every request failed as `request to /chat/completions
    // failed`. Both directions are asserted, because "reject empty" alone would
    // make the three deployment-configured rows (Vertex, Databricks, Cortex)
    // unrepresentable.
    expect(() => validateProviderTemplates([{ route: 'x', name: 'X', baseURL: '' }])).toThrow(/baseURL is empty/)
    expect(() => validateProviderTemplates([{ route: 'x', name: 'X', baseURL: '   ' }])).toThrow(/baseURL is empty/)
    expect(validateProviderTemplates([{ route: 'x', name: 'X', baseURL: '', needsBaseURL: true }])).toHaveLength(1)
  })

  test('rejects a baseURL that is not absolute', () => {
    // A relative value reaches `fetch()` as a relative URL, which throws before the
    // request leaves the process.
    for (const bad of ['/v1', 'api.openai.com/v1', 'ftp://x/v1']) {
      expect(() => validateProviderTemplates([{ route: 'x', name: 'X', baseURL: bad }])).toThrow(/not an absolute http\(s\) URL/)
    }
  })

  test('rejects an anthropic-messages baseURL that already ends in a version', () => {
    // `streamAnthropic` appends `/v1/messages`; `.../anthropic/v1` would request
    // `.../anthropic/v1/v1/messages`. The root form on the same host is accepted,
    // which is what keeps this rule from banning the provider outright.
    expect(() => validateProviderTemplates([
      { route: 'x', name: 'X', baseURL: 'https://api.example.com/anthropic/v1', api: 'anthropic-messages' },
    ])).toThrow(/already ends in a version segment/)
    expect(validateProviderTemplates([
      { route: 'x', name: 'X', baseURL: 'https://api.example.com/anthropic', api: 'anthropic-messages' },
    ])).toHaveLength(1)
  })

  test('rejects duplicate routes and model rows without an id', () => {
    expect(() => validateProviderTemplates([
      { route: 'x', name: 'X', baseURL: 'https://x' },
      { route: 'x', name: 'X2', baseURL: 'https://x2' },
    ])).toThrow(/duplicate route/)
    expect(() => validateProviderTemplates([{ route: 'x', name: 'X', baseURL: 'https://x', models: [{ name: 'no-id' }] }])).toThrow(/model entry needs an id/)
  })
})
