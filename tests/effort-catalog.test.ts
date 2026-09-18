/**
 * Unit tests for the effort catalog (`effort-catalog.ts`): the canonical
 * vocabulary, the `null → none` no-thinking mapping, the precedence rules
 * (static declaration wins, `effortWire` gates catalog application), and the
 * route/profile lookup keying.
 *
 * Run with `bun test tests/effort-catalog.test.ts`.
 *
 * @module qialike/effort-catalog-test
 */

import { describe, expect, test } from 'bun:test'
import {
  EFFORT_CATALOG,
  EFFORT_VOCABULARY,
  catalogEfforts,
  effortsFor,
  validateEffortCatalog,
  type EffortCatalogFile,
} from '../packages/qialike-app/src/effort-catalog.ts'
import { REASONING_EFFORTS, effectiveProfile, modelReasoning, serializeRequestOpenAI, validateProviderTemplates } from '../packages/qialike-app/src/llm.ts'
import fileData from '../packages/qialike-app/src/effort-catalog.json' with { type: 'json' }

/** A synthetic snapshot shaped like the models.dev reasoning_options subset. */
const synthetic: EffortCatalogFile = {
  schema: 1,
  generatedAt: '2026-01-01',
  providers: {
    gw: {
      models: {
        'r1': { effort: [null, 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] },
        'r2': { effort: [null, 'low', 'max', 'ultra'] }, // 'ultra' is outside the vocabulary
        'r3': { effort: [] },
      },
    },
  },
}

describe('EFFORT_VOCABULARY', () => {
  test('covers the canonical effort set', () => {
    expect(EFFORT_VOCABULARY).toEqual(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  })
})

describe('catalogEfforts', () => {
  const profile = { displayName: 'GW', baseURL: 'https://gw.example/v1', catalogProvider: 'gw' } as never

  test('maps values in order; null becomes the none level', () => {
    const efforts = catalogEfforts('gw', profile, 'r1', synthetic)
    expect(efforts?.map((e) => e.id)).toEqual(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(efforts?.[0]).toMatchObject({ id: 'none', name: 'None', disablesThinking: true })
    expect(efforts?.[1]).toMatchObject({ id: 'minimal', name: 'Minimal' })
    expect(efforts?.[5]).toMatchObject({ id: 'xhigh', name: 'X-High' })
  })

  test('every catalog level carries a one-line description for the picker', () => {
    const efforts = catalogEfforts('gw', profile, 'r1', synthetic)!
    for (const level of efforts) {
      expect(typeof level.description).toBe('string')
      expect(level.description!.length).toBeGreaterThan(0)
    }
    expect(efforts.find((e) => e.id === 'none')?.description).toBe('Use for simple tasks that do not need reasoning.')
  })

  test('drops values outside the vocabulary', () => {
    const efforts = catalogEfforts('gw', profile, 'r2', synthetic)
    expect(efforts?.map((e) => e.id)).toEqual(['none', 'low', 'max'])
  })

  test('empty value list or unknown model yields undefined', () => {
    expect(catalogEfforts('gw', profile, 'r3', synthetic)).toBeUndefined()
    expect(catalogEfforts('gw', profile, 'nope', synthetic)).toBeUndefined()
  })

  test('route default map resolves deepseek-official without a profile', () => {
    const efforts = catalogEfforts('deepseek-official', undefined, 'deepseek-v4-flash')
    expect(efforts?.map((e) => e.id)).toEqual(['none', 'low', 'high', 'max'])
  })
})

describe('effortsFor precedence and gate', () => {
  test('static declaration wins over the catalog', () => {
    const profile = {
      displayName: 'DeepSeek',
      baseURL: 'https://api.deepseek.com',
      models: [
        { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', reasoningEfforts: REASONING_EFFORTS },
      ],
    }
    const efforts = effortsFor('deepseek-official', profile, 'deepseek-v4-flash')
    expect(efforts.map((e) => e.id)).toEqual(['off', 'low', 'high', 'max'])
  })

  test('catalog applies only when effortWire opts in', () => {
    const base = {
      displayName: 'DeepSeek',
      baseURL: 'https://api.deepseek.com',
      catalogProvider: 'deepseek',
      models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }], // no static efforts
    }
    // Without the gate: no levels.
    expect(effortsFor('mygw', base, 'deepseek-v4-flash')).toEqual([])
    // With the gate: the bundled catalog list (including the none no-thinking level).
    const opted = effortsFor('mygw', { ...base, effortWire: 'reasoning-effort' }, 'deepseek-v4-flash')
    expect(opted.map((e) => e.id)).toEqual(['none', 'low', 'high', 'max'])
    expect(opted.find((e) => e.id === 'none')?.disablesThinking).toBe(true)
  })

  test('catalog-only model advertises reasoning to the harness (adapter path)', () => {
    const profile = {
      displayName: 'DeepSeek',
      baseURL: 'https://api.deepseek.com',
      effortWire: 'reasoning-effort' as const,
      catalogProvider: 'deepseek',
      models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }], // no static efforts
    }
    const reasoning = modelReasoning(profile, 'deepseek-official', 'deepseek-v4-flash')
    expect(reasoning?.efforts.map((e) => e.id)).toEqual(['none', 'low', 'high', 'max'])
    // Default resolves through the declared levels: profile default absent →
    // `high` is present → high.
    expect(reasoning?.defaultEffort).toBe('high')
  })

  test('a model without any catalog entry stays effort-free even when gated', () => {
    const profile = {
      displayName: 'X',
      baseURL: 'https://x/v1',
      effortWire: 'reasoning-effort' as const,
      catalogProvider: 'gw',
      models: [{ id: 'unknown-model', name: 'X' }],
    }
    expect(effortsFor('x', profile, 'unknown-model')).toEqual([])
    expect(modelReasoning(profile, 'x', 'unknown-model')).toBeUndefined()
  })
})

test('bundled snapshot ships deepseek official values', () => {
  expect(EFFORT_CATALOG.providers.deepseek.models['deepseek-v4-flash']?.effort).toEqual([null, 'low', 'high', 'max'])
  // V4.1 (`deepseek-flash`) must be in the bundled snapshot too.
  expect(EFFORT_CATALOG.providers.deepseek.models['deepseek-flash']?.effort).toEqual([null, 'low', 'high', 'max'])
})

test('deepseek-official catalog leads with V4.1 and mirrors the harness row', () => {
  const profile = effectiveProfile('deepseek-official', undefined, [])
  const models = profile?.models ?? []
  // Order mirrors the harness (llm-deepseek) DEFAULT_MODELS: V4.1 first.
  expect(models[0]?.id).toBe('deepseek-flash')
  expect(models[0]?.name).toBe('DeepSeek-V41-Flash')
  // contextWindow mirrors the harness DEFAULT_CONTEXT_WINDOW (1_000_000) on every official row.
  expect(models.map((m) => m.contextWindow)).toEqual([1000000, 1000000, 1000000, 1000000])
  // V4.1 declares image input, so the attachment gate admits images for it.
  expect(models[0]?.inputModalities).toEqual(['text', 'image'])
  // The vision model carries the same declaration (it used to be missing, so the gate
  // rejected images for the one row whose name says vision).
  expect(models.find((m) => m.id === 'deepseek-v4-flash-vision-exp')?.inputModalities).toEqual(['text', 'image'])
  // The plain V4 text models stay text-only (no image declaration).
  expect(models.find((m) => m.id === 'deepseek-v4-flash')?.inputModalities).toBeUndefined()
  expect(models.find((m) => m.id === 'deepseek-v4-pro')?.inputModalities).toBeUndefined()
  // The V4 rows are kept (the harness still serves them).
  expect(models.map((m) => m.id)).toEqual([
    'deepseek-flash',
    'deepseek-v4-flash',
    'deepseek-v4-pro',
    'deepseek-v4-flash-vision-exp',
  ])
})

describe('validateEffortCatalog (effort-catalog.json)', () => {
  test('the bundled file passes and matches the loaded catalog', () => {
    expect(validateEffortCatalog(fileData)).toEqual(EFFORT_CATALOG)
    expect(EFFORT_CATALOG.providers.deepseek.models['deepseek-v4-flash']?.effort).toEqual([null, 'low', 'high', 'max'])
  })

  test('rejects non-object, missing schema, and malformed effort rows', () => {
    expect(() => validateEffortCatalog([])).toThrow(/expected an object/)
    expect(() => validateEffortCatalog({ providers: {} })).toThrow(/schema/)
    expect(() => validateEffortCatalog({ schema: 1, providers: {} })).not.toThrow()
    const badValue = { schema: 1, providers: { gw: { models: { m: { effort: ['high', 42] } } } } }
    expect(() => validateEffortCatalog(badValue)).toThrow(/strings or null/)
    const offVocab = { schema: 1, providers: { gw: { models: { m: { effort: ['ultra'] } } } } }
    expect(() => validateEffortCatalog(offVocab)).toThrow(/outside the vocabulary/)
  })
})

describe('data-file per-model effort end-to-end', () => {
  // A provider-templates.json-style row that declares its model's effort
  // levels (id + name + description + disablesThinking) in the data file.
  const row = {
    route: 'gw-e2e',
    name: 'GW E2E',
    baseURL: 'https://gw-e2e.example/v1',
    reasoningEffort: 'medium',
    models: [{
      id: 'm1',
      name: 'M1',
      reasoningEfforts: [
        { id: 'none', name: 'None', disablesThinking: true },
        { id: 'low', name: 'Low' },
        { id: 'medium', name: 'Medium', description: 'A middle ground for everyday tasks.' },
        { id: 'xhigh', name: 'X-High' },
      ],
    }],
  }

  test('a declared row validates and drives picker metadata + harness reasoning', () => {
    const [template] = validateProviderTemplates([row])
    const reasoning = modelReasoning(template, template.route, 'm1')
    expect(reasoning?.efforts.map((e) => e.id)).toEqual(['none', 'low', 'medium', 'xhigh'])
    expect(reasoning?.efforts.find((e) => e.id === 'medium')?.description).toBe('A middle ground for everyday tasks.')
    expect(reasoning?.efforts.find((e) => e.id === 'none')?.disablesThinking).toBe(true)
    // route default effort honored (medium), not a hardcoded high
    expect(reasoning?.defaultEffort).toBe('medium')
  })

  test('the same declared row drives the request wire (static beats the catalog, no effortWire needed)', async () => {
    const [template] = validateProviderTemplates([row])
    const medium = await serializeRequestOpenAI(undefined as never, { provider: template.route, model: 'm1', messages: [], reasoningEffort: 'medium' }, template, undefined)
    expect(medium.thinking).toEqual({ type: 'enabled' })
    expect(medium.reasoning_effort).toBe('medium')
    const none = await serializeRequestOpenAI(undefined as never, { provider: template.route, model: 'm1', messages: [], reasoningEffort: 'none' }, template, undefined)
    expect(none.thinking).toEqual({ type: 'disabled' })
    expect(none).not.toHaveProperty('reasoning_effort')
  })
})
