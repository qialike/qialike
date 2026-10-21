/**
 * **QiaLike Bee** — qialike's own API route (`QIALIKE_BEE_ROUTE`, route
 * `qialike`, `https://qialike.com/bee/v1`) as the `/models` dialog presents it:
 *
 * 1. it cannot be removed — `Ctrl+D` / `Alt+D` refuses, the store's hide path
 *    ignores it, and a hand-written `hidden_providers` entry cannot hide it;
 * 2. selecting it while it has NO API key asks for one (the key dialog) instead
 *    of opening an empty model list; once the key is set, selecting it lists the
 *    whole of Bee's live `/bee/v1/models` catalogue, because the row routes
 *    every family to the wire protocol Bee documents for it (`modelsApi`:
 *    `claude-`/`qwen` → Messages, `gpt-` → Responses, `gemini-` → Google,
 *    everything else → chat/completions).
 *
 * Three layers are pinned here, in the order they can break: the shipped data
 * (the template row and its protocol map), the unfiltered live catalogue the
 * adapter shows for a multi-protocol route, and the store/wiring behaviour the
 * dialog reads.
 *
 * The static ids are the fallback for when Bee's `/models` cannot be reached —
 * the DeepSeek models the built-in `deepseek-official` route already declares
 * (plus the `deepseek-v4.1-flash` id Bee answers anonymously today).
 *
 * DSH_HOME points at a throwaway temp dir so the real `~/.dsh` is never touched.
 *
 * Run with `bun test tests/qialike-bee.test.ts`.
 *
 * @module qialike/qialike-bee-test
 */

import { afterAll, beforeEach, afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { filterDynamicModels, fetchDynamicModels, PROVIDER_TEMPLATES, QIALIKE_BEE_ROUTE, resolveModelApi } from '../packages/qialike-app/src/llm.ts'
import { Store, type ProviderModelsEntry } from '../packages/qialike-app/src/index.tsx'
import { BEE_ENV, DEFAULT_BEE_ENABLED, resolveBeeEnabled } from '../packages/qialike-app/src/config.ts'

const home = mkdtempSync(join(tmpdir(), 'qialike-bee-test-'))
process.env.DSH_HOME = home

afterAll(() => {
  rmSync(home, { recursive: true, force: true })
})

const APP = join(import.meta.dir, '..', 'packages', 'qialike-app', 'src')
const read = (file: string): string => readFileSync(join(APP, file), 'utf8')

/** The shipped Bee row (a template row like any other provider's). */
const bee = PROVIDER_TEMPLATES.find((template) => template.route === QIALIKE_BEE_ROUTE)

/** The dialog's first-level entry for Bee, as `listConfigured` hands it over. */
function beeEntry(configured: boolean): ProviderModelsEntry {
  return {
    provider: QIALIKE_BEE_ROUTE,
    name: 'QiaLike Bee',
    builtin: true,
    configured,
    models: (bee?.models ?? []).map((m) => ({
      provider: QIALIKE_BEE_ROUTE,
      model: m.id,
      label: m.name ?? m.id,
    })),
  }
}

function otherEntry(): ProviderModelsEntry {
  return {
    provider: 'moonshotai',
    name: 'Moonshot AI',
    configured: true,
    models: [{ provider: 'moonshotai', model: 'kimi-k3', label: 'Kimi K3' }],
  }
}

describe('the Bee template row', () => {
  test('is shipped under the qialike-owned route, endpoint and key reference', () => {
    expect(bee).toBeDefined()
    expect(QIALIKE_BEE_ROUTE).toBe('qialike')
    expect(bee?.name).toBe('QiaLike Bee')
    expect(bee?.baseURL).toBe('https://qialike.com/bee/v1')
    // The credential reference the published Bee docs use, so an exported
    // QIALIKE_API_KEY is picked up without touching settings or the store.
    expect(bee?.apiKeyEnv).toBe('QIALIKE_API_KEY')
    expect(bee?.api).toBe('openai-completions')
  })

  test('routes each family to the wire protocol and endpoint Bee documents', () => {
    // Bee serves four protocols under one key (`/docs/bee` → "Endpoints"):
    // GPT on Responses, Claude and Qwen on Messages, Gemini on Google, the
    // rest on chat/completions. The map is the whole feature: without it every
    // non-DeepSeek model would be posted to /chat/completions and fail.
    expect(bee?.modelsApi).toEqual({
      'claude-': { api: 'anthropic-messages', baseURL: 'https://qialike.com/bee' },
      qwen: { api: 'anthropic-messages', baseURL: 'https://qialike.com/bee' },
      'gpt-': { api: 'openai-responses' },
      'gemini-': { api: 'google-generative' },
    })
    // `anthropic-messages` appends `/v1/messages`, so that override must be
    // the root (template validation rejects a baseURL already ending in /v1);
    // the other protocols append to the route's own `/bee/v1` baseURL.
    expect(bee?.modelsApi?.['claude-']?.baseURL).toBe('https://qialike.com/bee')
    expect(bee?.baseURL).toBe('https://qialike.com/bee/v1')
  })

  test('resolveModelApi lands every documented model on its protocol', () => {
    const profile = bee as unknown as Parameters<typeof resolveModelApi>[0]
    const cases: Array<[string, { api?: string; baseURL?: string }]> = [
      ['gpt-5.6-sol', { api: 'openai-responses' }],
      ['gpt-5-codex', { api: 'openai-responses' }],
      ['claude-opus-4-8', { api: 'anthropic-messages', baseURL: 'https://qialike.com/bee' }],
      ['claude-haiku-4-5', { api: 'anthropic-messages', baseURL: 'https://qialike.com/bee' }],
      ['qwen3.7-max', { api: 'anthropic-messages', baseURL: 'https://qialike.com/bee' }],
      ['qwen3.5-plus', { api: 'anthropic-messages', baseURL: 'https://qialike.com/bee' }],
      ['gemini-3.5-flash', { api: 'google-generative' }],
      // Everything else keeps the route default: chat/completions, appended to
      // the route's own `/bee/v1` baseURL by the adapter.
      ['deepseek-v4.1-flash', {}],
      ['deepseek-v4-pro', {}],
      ['glm-5.2', {}],
      ['kimi-k2.6', {}],
      ['minimax-m3', {}],
      ['grok-4.5', {}],
      ['big-pickle', {}],
      ['mimo-v2.5-free', {}],
    ]
    for (const [model, expected] of cases) {
      expect(resolveModelApi(profile, model), model).toEqual(expected)
    }
  })

  test('the static fallback covers the deepseek family the live catalogue serves', () => {
    // Fallback only: Bee answers `/models` anonymously with a single id
    // (`deepseek-v4.1-flash` at the time of writing) and the full catalogue
    // once a key is set. These rows are what the picker shows when the probe
    // fails, so they must stay a real, deepseek-served subset.
    expect(bee?.includeModelPrefixes).toBeUndefined()
    expect(bee?.excludeModelPrefixes).toBeUndefined()
    const ids = (bee?.models ?? []).map((m) => m.id)
    expect(ids).toEqual(['deepseek-v4.1-flash', 'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-flash-free'])
    for (const model of bee?.models ?? []) {
      expect(model.contextWindow).toBe(1000000)
      expect(model.maxTokens).toBe(256000)
    }
  })

  test('the live probe reads {baseURL}/models and the catalogue stays unfiltered', async () => {
    // The families Bee's own docs list (`/docs/bee`): all of them are
    // routable now, so the picker must show all of them.
    const catalog = ['gpt-5.6-sol', 'claude-opus-4-8', 'gemini-3.5-flash', 'qwen3.7-max', 'glm-5.2', 'kimi-k2.6', 'grok-4.5', 'minimax-m3', 'deepseek-v4.1-flash', 'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-flash-free']
    const realFetch = globalThis.fetch
    const seen: string[] = []
    globalThis.fetch = (async (input: string | URL | Request) => {
      seen.push(String(input))
      return new Response(JSON.stringify({ object: 'list', data: catalog.map((id) => ({ id, object: 'model' })) }),
        { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    try {
      const live = await fetchDynamicModels(bee!.baseURL)
      expect(seen).toEqual(['https://qialike.com/bee/v1/models'])
      expect(live).toEqual(catalog)
      // The adapter's composition for a modelsApi route: identity, no include
      // or exclude list (a filter would hide families that DO have a wire).
      expect(filterDynamicModels(live!, undefined)).toEqual(catalog)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test('the adapter skips the catalogue filter exactly for a modelsApi route', () => {
    // Source guard for the branch the feature depends on: a multi-protocol
    // route keeps the whole live catalogue, an ordinary route applies its
    // include/exclude lists.
    const source = read('llm.ts')
    expect(source).toContain('const multiProtocol = template?.modelsApi !== undefined')
    expect(source).toContain('include: effective.includeModelPrefixes')
    expect(bee?.modelsApi).toBeDefined()
  })

  test('no other route claims to be qialike-owned', () => {
    expect(PROVIDER_TEMPLATES.filter((t) => t.route === QIALIKE_BEE_ROUTE)).toHaveLength(1)
  })
})

describe('Bee cannot be removed from /models', () => {
  test('Ctrl+D’s store path refuses to hide it, whatever is persisted', () => {
    const store = new Store()
    // A hand-written hidden_providers entry naming Bee (as an older/edited
    // config could carry) is dropped on seed…
    store.seedHiddenProviders([QIALIKE_BEE_ROUTE, 'moonshotai'])
    expect(store.isProviderHidden(QIALIKE_BEE_ROUTE)).toBe(false)
    expect(store.isProviderHidden('moonshotai')).toBe(true)
    expect(store.hiddenProviders).not.toContain(QIALIKE_BEE_ROUTE)
    // …and hiding it directly is a no-op, so the row survives the next open.
    store.hideProvider(QIALIKE_BEE_ROUTE)
    store.openModels([beeEntry(false), otherEntry()], 0)
    expect(store.providers.map((p) => p.provider)).toContain(QIALIKE_BEE_ROUTE)
  })

  test('the wiring refuses the deactivate before any credential is touched', () => {
    const source = read('index.tsx')
    // One gate for Ctrl+D and Alt+D (the panel calls store.deactivateProvider),
    // sitting ABOVE the removeKey call so the key is never deleted either.
    const wiring = source.slice(source.indexOf('store.deactivateProvider = (route'))
    expect(wiring.length).toBeGreaterThan(0)
    const guard = wiring.indexOf('PROTECTED_PROVIDER_ROUTES.has(route)')
    const removeKey = wiring.indexOf('const result = await service.removeKey(route)')
    expect(guard).toBeGreaterThan(-1)
    expect(removeKey).toBeGreaterThan(guard)
    expect(wiring).toContain('is qialike\'s own gateway — it cannot be removed')
    // …and the panel's first level is where Ctrl+D is dispatched.
    expect(read('panels/models.tsx')).toContain('store.deactivateProvider(entry.provider, entry.name)')
  })

  test('the protected set is derived from the route constant, not a literal', () => {
    const source = read('index.tsx')
    expect(source).toContain('new Set([QIALIKE_BEE_ROUTE])')
    // A config that still names it is rewritten, so the file stops carrying an
    // entry that the seed drops and that can never take effect.
    expect(source).toContain('storedHidden.some((route) => PROTECTED_PROVIDER_ROUTES.has(route))')
    // The custom-provider form cannot shadow the route either.
    expect(read('models.ts')).toContain('is reserved for qialike\'s own gateway')
  })
})

describe('selecting Bee: key first, models after', () => {
  test('with no key the dialog asks for one instead of opening a model list', () => {
    const source = read('panels/models.tsx')
    // The Enter branch for a keyless builtin entry opens the KEY dialog…
    expect(source).toContain('entry.builtin === true && entry.configured === false')
    const gate = source.indexOf('entry.builtin === true && entry.configured === false')
    const openKeys = source.indexOf('store.openKeyDialog(entry.provider, entry.name, false)')
    const openModels = source.indexOf('store.openProviderModels(entry, initial)')
    expect(openKeys).toBeGreaterThan(gate)
    // …and the model list is only reached by falling THROUGH that gate.
    expect(openModels).toBeGreaterThan(openKeys)
    // The row says so, rather than advertising models it cannot serve yet.
    expect(source).toContain("· API key required")
  })

  test('the keyless entry still carries its models, so the flag is what gates them', () => {
    // `listConfigured` lists Bee while keyless: `configured: false` + `builtin`
    // is the pair the dialog decides on, so dropping either flag would silently
    // turn Enter back into "open an empty list".
    const models = read('models.ts')
    expect(models).toContain('if (!configured && provider.builtin !== true) return undefined')
    expect(models).toContain('return { ...provider, models, configured }')
    // The flag is set once, where providers are declared.
    expect(models).toContain('provider === QIALIKE_BEE_ROUTE ? { builtin: true as const } : {}')
    // …and survives the two mappings into the dialog's entry shape.
    expect(read('index.tsx')).toContain('...(p.configured === undefined ? {} : { configured: p.configured })')
    expect(read('panels/models.tsx')).toContain('...(p.builtin === undefined ? {} : { builtin: p.builtin })')
  })

  test('a keyless Bee never becomes the "first provider" or the fallback model', () => {
    // Bee is always listed, so counting it as configured would both promote it
    // to the current model on another provider's first key and stop the
    // first-provider promotion from ever firing.
    const source = read('index.tsx')
    expect(source).toContain('noUserConfiguredProviders(await modelsService.listConfigured())')
    expect(source).toContain('p.configured !== false')
    // No key -> not a promotion candidate: the helper filters builtins out.
    const helper = source.slice(source.indexOf('function noUserConfiguredProviders'))
    expect(helper.slice(0, 400)).toContain('p.builtin !== true')
  })
})

/**
 * The `bee` switch (`qialike.json` `bee.enabled`, or `QIALIKE_BEE`).
 *
 * Bee ships OFF while the service is in internal testing (the gateway is live but
 * no one can sign up yet), so these cases lead with the default and then the two
 * ways to turn it back on. The environment variable deliberately does NOT persist
 * (unlike `QIALIKE_RESUME_LAST`): a one-off override must not silently re-enable
 * the route for every later launch.
 */
describe('the bee switch', () => {
  let home = ''
  const configFile = (): string => join(home, 'qialike.json')
  const writeConfig = (doc: unknown): void => { writeFileSync(configFile(), JSON.stringify(doc)) }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'qialike-bee-switch-'))
    process.env.DSH_HOME = home
    delete process.env[BEE_ENV]
  })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    delete process.env.DSH_HOME
    delete process.env[BEE_ENV]
  })

  test('OFF by default — the whole point of the switch', () => {
    expect(resolveBeeEnabled()).toBe(false)
    expect(DEFAULT_BEE_ENABLED).toBe(false)
  })

  test('config turns it on, and back off', () => {
    writeConfig({ bee: { enabled: true } })
    expect(resolveBeeEnabled()).toBe(true)
    writeConfig({ bee: { enabled: false } })
    expect(resolveBeeEnabled()).toBe(false)
  })

  test('the environment turns it on for one run', () => {
    process.env[BEE_ENV] = '1'
    expect(resolveBeeEnabled()).toBe(true)
  })

  test('the environment wins over the config, both ways', () => {
    writeConfig({ bee: { enabled: true } })
    process.env[BEE_ENV] = '0'
    expect(resolveBeeEnabled()).toBe(false)
    writeConfig({ bee: { enabled: false } })
    process.env[BEE_ENV] = 'true'
    expect(resolveBeeEnabled()).toBe(true)
  })

  test('the environment is NOT persisted — an override stays an override', () => {
    // The contrast with resolveResumeLast is the contract: that one writes the
    // env value back, this one must not.
    process.env[BEE_ENV] = '1'
    expect(resolveBeeEnabled()).toBe(true)
    delete process.env[BEE_ENV]
    expect(resolveBeeEnabled(), 'a later run must fall back to the default').toBe(false)
    expect(existsSync(configFile()) ? JSON.parse(readFileSync(configFile(), 'utf8')) : {}).toEqual({})
  })

  test('a malformed value falls through to the config rather than guessing', () => {
    writeConfig({ bee: { enabled: true } })
    process.env[BEE_ENV] = 'maybe'
    expect(resolveBeeEnabled()).toBe(true)
  })

  test('an empty value is not an override', () => {
    writeConfig({ bee: { enabled: true } })
    process.env[BEE_ENV] = '  '
    expect(resolveBeeEnabled()).toBe(true)
  })

  test('the switch is consulted where the route is offered, and where it is reserved', () => {
    // Source guards: the two places that must agree with the switch. A gate that
    // only hid the template row would leave `addProvider` refusing the name for
    // a route nothing offers.
    const llm = read('llm.ts')
    expect(llm, 'the hidden set is seeded from the switch').toContain('if (!resolveBeeEnabled()) hiddenRoutes.add(QIALIKE_BEE_ROUTE)')
    expect(read('models.ts')).toContain('if (resolveBeeEnabled() && route === QIALIKE_BEE_ROUTE)')
  })
})
