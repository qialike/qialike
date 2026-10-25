/**
 * `--model`: a model name, or a provider **and** a model.
 *
 * The reported problem: the flag was documented as `provider/name` from the day
 * it shipped, but the implementation kept the saved provider and passed the whole
 * argument as the model id — so `--model qialike-bee/deepseek-v4.1-flash` asked
 * the *previous* provider for a model literally called
 * `qialike-bee/deepseek-v4.1-flash`. Nothing said why; the request just failed.
 * `--model deepseek-v4-flash` (no slash) kept working, which is why it survived.
 *
 * The subtlety these cases pin: model ids contain slashes. The China gateways
 * serve `deepseek/deepseek-v4-flash-202605`, OpenRouter serves `openrouter/auto`.
 * Splitting on the first `/` unconditionally would turn a real id into a provider
 * lookup and break it. The rule is therefore "the prefix is a provider only when
 * it names a route this build serves".
 *
 * Run with `bun test tests/model-override.test.ts`.
 *
 * @module qialike/model-override-test
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveModelOverride, tuiCommand } from '../packages/qialike-app/src/startup.ts'
import { PROVIDER_TEMPLATES, QIALIKE_BEE_ROUTE } from '../packages/qialike-app/src/llm.ts'
import foreignGateways from '../packages/qialike-app/src/foreign-gateway-templates.json' with { type: 'json' }

const APP = join(import.meta.dir, '..', 'packages', 'qialike-app', 'src')
const read = (file: string): string => readFileSync(join(APP, file), 'utf8')

/** The persisted selection every case falls back to. */
const SAVED = { provider: 'deepseek-official', model: 'deepseek-flash' } as const

/**
 * Routes this build serves, as the app assembles them: the core catalogue plus
 * the gateway groups that register through `tuiLlmTemplates` at mount time.
 * A static `PROVIDER_TEMPLATES`-only set would call OpenRouter unknown.
 */
const served = new Set<string>([
  'deepseek-official',
  ...PROVIDER_TEMPLATES.map((template) => template.route),
  ...(foreignGateways as readonly { route: string }[]).map((row) => row.route),
])
const known = (route: string): boolean => served.has(route)

describe('resolveModelOverride', () => {
  test('no flag keeps the persisted selection', () => {
    expect(resolveModelOverride(undefined, known, SAVED)).toEqual(SAVED)
    expect(resolveModelOverride('', known, SAVED)).toEqual(SAVED)
  })

  test('a bare model name keeps the provider', () => {
    expect(resolveModelOverride('deepseek-v4-flash', known, SAVED))
      .toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-flash' })
  })

  test('a known route prefix switches BOTH provider and model', () => {
    // The bug this file exists for: before the fix this returned
    // `{ provider: 'deepseek-official', model: 'qialike-bee/…' }`.
    expect(resolveModelOverride('qialike-bee/deepseek-v4.1-flash', known, SAVED))
      .toEqual({ provider: 'qialike-bee', model: 'deepseek-v4.1-flash' })
    expect(resolveModelOverride('alibaba-cn/qwen-max', known, SAVED))
      .toEqual({ provider: 'alibaba-cn', model: 'qwen-max' })
  })

  test('the Bee route is spelled the way the catalogue spells it', () => {
    expect(QIALIKE_BEE_ROUTE).toBe('qialike-bee')
    expect(known('qialike-bee')).toBe(true)
    // The 0.11.3 spelling is gone, so it is no longer a provider prefix.
    expect(known('qialike')).toBe(false)
  })

  test('a model id that contains a slash keeps its provider', () => {
    // `deepseek/deepseek-v4-flash-202605` is a real id on the China gateways.
    // No route is called `deepseek`, so the whole string must stay a model id.
    expect(resolveModelOverride('deepseek/deepseek-v4-flash-202605', known, SAVED))
      .toEqual({ provider: 'deepseek-official', model: 'deepseek/deepseek-v4-flash-202605' })
    expect(resolveModelOverride('meta-llama/Llama-3.3-70B-Instruct', known, SAVED))
      .toEqual({ provider: 'deepseek-official', model: 'meta-llama/Llama-3.3-70B-Instruct' })
  })

  test('an unknown prefix is not an error — it is just a model id', () => {
    // Rejecting it would break every id we cannot enumerate up front.
    expect(resolveModelOverride('nope/x', known, SAVED))
      .toEqual({ provider: 'deepseek-official', model: 'nope/x' })
  })

  test('a trailing slash is not a provider pick — there would be no model', () => {
    expect(resolveModelOverride('qialike-bee/', known, SAVED))
      .toEqual({ provider: 'deepseek-official', model: 'qialike-bee/' })
  })

  test('a leading slash is not a provider pick — there would be no route', () => {
    expect(resolveModelOverride('/deepseek-v4-flash', known, SAVED))
      .toEqual({ provider: 'deepseek-official', model: '/deepseek-v4-flash' })
  })

  test('only the FIRST slash splits, so a nested id survives', () => {
    // A route whose models are themselves namespaced: provider `alibaba-cn`,
    // model `deepseek/deepseek-v4-flash-202605`. The remaining slashes must stay
    // in the model part.
    expect(resolveModelOverride('alibaba-cn/deepseek/deepseek-v4-flash-202605', known, SAVED))
      .toEqual({ provider: 'alibaba-cn', model: 'deepseek/deepseek-v4-flash-202605' })
  })

  test('a plugin-registered gateway counts as a provider', () => {
    // OpenRouter is not in `provider-templates.json` — its row arrives from the
    // foreign-gateway group at mount time. A static route set would miss it and
    // read `--model openrouter/x` as a model id, so the wiring reads the live
    // registry (asserted in the source guard below).
    expect(known('openrouter')).toBe(true)
    expect(resolveModelOverride('openrouter/anthropic/claude-sonnet-5', known, SAVED))
      .toEqual({ provider: 'openrouter', model: 'anthropic/claude-sonnet-5' })
  })
})

describe('the flag is wired to the resolver, not to a bare assignment', () => {
  test('index.tsx routes --model through resolveModelOverride', () => {
    const source = read('index.tsx')
    // The regression shape: `{ provider: selection.provider, model: config.model }`
    // applied the model on the OLD provider no matter what was written.
    expect(source).not.toContain('model: config.model')
    expect(source).toContain('resolveModelOverride(')
    // …and the route set is the live registry, so plugin-registered gateways
    // (OpenRouter, OpenCode, the China group) are providers too.
    expect(source).toContain("ctx.get('tuiLlmTemplates')")
    expect(source).toContain('hiddenRoutes()')
  })

  test('the help text still promises what the code now does', () => {
    const help = tuiCommand().helpInformation()
    expect(help).toContain('provider/name picks a provider too')
    // …and the example names the real route, not the retired one.
    expect(help).toContain('qialike-bee/deepseek-v4.1-flash')
  })
})
