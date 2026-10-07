/**
 * **QiaLike Bee** — qialike's own API route (`QIALIKE_BEE_ROUTE`, route
 * `qialike`, `https://qialike.com/bee/v1`) as the `/models` dialog presents it:
 *
 * 1. it cannot be removed — `Ctrl+D` / `Alt+D` refuses, the store's hide path
 *    ignores it, and a hand-written `hidden_providers` entry cannot hide it;
 * 2. selecting it while it has NO API key asks for one (the key dialog) instead
 *    of opening an empty model list; once the key is set, selecting it lists the
 *    models qialike serves — the `deepseek-*` family, which is all Bee exposes to
 *    this route for now (`includeModelPrefixes: ["deepseek-"]`).
 *
 * Three layers are pinned here, in the order they can break: the shipped data
 * (the template row), the model filter the adapter applies to Bee's live
 * `/bee/v1/models` catalog, and the store/wiring behaviour the dialog reads.
 *
 * The three static ids and their limits mirror the DeepSeek models the built-in
 * `deepseek-official` route already declares — same upstream models, and the
 * row is only the fallback for when Bee's `/models` cannot be reached.
 *
 * DSH_HOME points at a throwaway temp dir so the real `~/.dsh` is never touched.
 *
 * Run with `bun test tests/qialike-bee.test.ts`.
 *
 * @module qialike/qialike-bee-test
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { filterDynamicModels, fetchDynamicModels, PROVIDER_TEMPLATES, QIALIKE_BEE_ROUTE } from '../packages/qialike-app/src/llm.ts'
import { Store, type ProviderModelsEntry } from '../packages/qialike-app/src/index.tsx'

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

  test('serves only the deepseek family — the shipped filter and the fallback list agree', () => {
    expect(bee?.includeModelPrefixes).toEqual(['deepseek-'])
    const ids = (bee?.models ?? []).map((m) => m.id)
    expect(ids).toEqual(['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-flash-free'])
    for (const id of ids) expect(id.startsWith('deepseek-')).toBe(true)
    // A model with no declared limit would silently ride the provider's own
    // default; the DeepSeek rows keep their explicit ceiling.
    for (const model of bee?.models ?? []) {
      expect(model.contextWindow).toBe(1000000)
      expect(model.maxTokens).toBe(256000)
    }
  })

  test('the filter keeps deepseek ids out of Bee’s full live catalog and drops the rest', () => {
    // What https://qialike.com/bee/v1/models answers with (Bee fronts GPT /
    // Claude / Gemini / GLM / Kimi / … as well).
    const live = ['gpt-5.6-sol', 'claude-opus-4-8', 'glm-5.2', 'kimi-k2.6', 'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-flash-free', 'minimax-m3']
    expect(filterDynamicModels(live, { include: bee?.includeModelPrefixes }))
      .toEqual(['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-flash-free'])
  })

  test('the live probe reads {baseURL}/models and the template filter narrows it', async () => {
    // The ids Bee's own docs list (`/docs/bee` in the site repo), minus the
    // protocol families this adapter cannot speak — a catalogue with no
    // deepseek- entry would leave the route empty, so the stub has both.
    const catalog = ['gpt-5.6-sol', 'claude-opus-4-8', 'gemini-3.5-flash', 'qwen3.7-max', 'glm-5.2', 'kimi-k2.6', 'grok-4.5', 'minimax-m3', 'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-flash-free']
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
      // …the adapter's own composition for a non-multi-protocol route.
      expect(filterDynamicModels(live!, { include: bee?.includeModelPrefixes }))
        .toEqual(['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-flash-free'])
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test('the adapter is what applies that filter, off the effective profile', () => {
    // Source guard for the one line that makes the row's filter real: a
    // multi-protocol route (modelsApi) skips it, ordinary routes do not — Bee
    // is an ordinary single-protocol route.
    const source = read('llm.ts')
    expect(source).toContain('include: effective.includeModelPrefixes')
    expect(bee?.modelsApi).toBeUndefined()
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
