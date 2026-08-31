/**
 * The /models capability plugin: provider enumeration and "Add provider"
 * writes against the harness seams — the LLM registry (`ctx.llm.listProviders`),
 * the `llm-pi-ai` settings namespace (the generic pi-ai adapter's provider
 * dict, hot-reloaded), and the credentials store. The terminal runtime
 * renders the /models dialog and consumes this service; nothing here touches
 * the UI store.
 *
 * @module @yourname/dsh-tui-app/models
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  TUI_LLM_NS,
  PROVIDER_TEMPLATES as TUI_TEMPLATES,
  type TuiProviderProfile,
} from './llm.ts'

/** Stable Cordis plugin name. */
export const name = 'tui-models'

/** Services required before provider enumeration / writes can run. */
export const inject = ['settings', 'credentials', 'llm']

/** Service provided by this plugin and injected by the TUI runtime. */
export const TUI_MODELS_SERVICE = 'tuiModels'

/** One model option in the /models picker. */
export interface ModelsModelOption {
  /** Model id sent to the provider. */
  id: string
  /** Display name. */
  name: string
}

/** One provider entry in the /models picker. */
export interface ModelsProviderOption {
  /** Registered provider route. */
  provider: string
  /** Human-readable provider name. */
  name: string
  /** Models this route serves (built-in catalog for deepseek, settings for pi-ai routes). */
  models: readonly ModelsModelOption[]
}

/** The "Add provider" form input. */
export interface AddProviderInput {
  /** Lowercase kebab-case route key, e.g. `my-gateway`. */
  route: string
  /** Human-readable name; defaults to the route. */
  displayName: string
  /** OpenAI-compatible base URL. */
  baseURL: string
  /** API key stored under a route-derived credential reference. */
  apiKey: string
  /** Model ids (comma-separated in the form). */
  models: readonly string[]
}

/** The models capability surface the terminal runtime consumes. */
export interface TuiModelsService {
  /** Every known provider route — the pi-ai catalog plus declared routes — with the models it serves. */
  listProviders(): ModelsProviderOption[]
  /** Providers whose credential is configured — the Models picker shows only these. */
  listConfigured(): Promise<ModelsProviderOption[]>
  /** Every known provider with whether its credential is configured — the Add provider list. */
  listAll(): Promise<{ provider: string; name: string; configured: boolean }[]>
  /** Register a custom pi-ai provider (settings + credential), hot-reloaded. */
  addProvider(input: AddProviderInput): Promise<{ ok: true } | { ok: false; error: string }>
  /** Whether one provider's credential reference is configured (env or the store). */
  keyConfigured(provider: string): Promise<boolean>
  /** Store the API key for one provider's credential reference (registering a dormant catalog route on first use). */
  setKey(provider: string, key: string): Promise<{ ok: true } | { ok: false; error: string }>
}

/** The dsh-tui-llm settings namespace (the self-hosted adapter's provider dict). */
// (TUI_LLM_NS imported from ./llm.ts)

/** Route id pattern for hand-declared providers (lowercase kebab-case). */
const ROUTE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

/** One provider template offered by the add-provider form's dropdown. */
export interface ProviderTemplate {
  /** Route key. */
  id: string
  /** Display name. */
  name: string
  /** Default endpoint pre-filled into the form. */
  baseURL: string
}

/**
 * The add-provider dropdown templates, derived from the self-hosted adapter's
 * built-in provider directory (OpenAI-compatible only).
 */
export const PROVIDER_TEMPLATES: readonly ProviderTemplate[] = TUI_TEMPLATES.map((template) => ({
  id: template.route,
  name: template.name,
  baseURL: template.baseURL,
}))

/** The deepseek route's credential reference (the TUI's runtime key). */
const DEEPSEEK_KEY_REF = 'DEEPSEEK_API_KEY'

/** The credential reference name a provider profile resolves keys through. */
function keyRefOf(provider: string, section: Record<string, TuiProviderProfile> | undefined): string {
  if (provider === 'deepseek-official') return DEEPSEEK_KEY_REF
  return section?.[provider]?.apiKeyEnv ?? `${provider.toUpperCase().replace(/-/g, '_')}_API_KEY`
}

export function apply(ctx: Context): void {
  /** The llm capability service, read through strict `ctx.get` (never injected). */
  const llm = () => ctx.get('llm') as {
    listProviders(): { id: string; name: string }[]
    listConfigurableProviders(): { provider: string; displayName: string; declared: boolean }[]
    listModels(provider: string): Promise<readonly { id: string; name: string }[]>
  } | undefined
  const settings = () => ctx.get('settings') as { get(ns: unknown): unknown; update(ns: unknown, patch: unknown): Promise<void> } | undefined
  /** The dsh-tui-llm providers dict as configured (`{ <route>: profile }`). */
  const piProviders = (): Record<string, TuiProviderProfile> | undefined =>
    (settings()?.get(TUI_LLM_NS) as { providers?: Record<string, TuiProviderProfile> } | undefined)?.providers
  const service: TuiModelsService = {
    listProviders() {
      // The configurable-provider directory: the self-hosted adapter's
      // built-in templates plus every route the settings section declares
      // (the tui-llm adapter registers it on mount). A template route without
      // a settings entry is known but not yet activated — it has no models
      // list until a profile activates it.
      const configurable = llm()?.listConfigurableProviders() ?? []
      const registered = llm()?.listProviders() ?? []
      const providers = new Map<string, ModelsProviderOption>()
      const declare = (provider: string, name: string, models: readonly ModelsModelOption[]): void => {
        providers.set(provider, { provider, name, models })
      }
      for (const entry of configurable) {
        const profile = piProviders()?.[entry.provider]
        const models = (profile?.models ?? []).map((m) => ({ id: m.id, name: m.name ?? m.id }))
        declare(entry.provider, profile?.displayName ?? entry.displayName, models)
      }
      // Registered routes the directory does not know (e.g. the built-in
      // deepseek-official route) join with their own metadata.
      for (const info of registered) {
        if (providers.has(info.id)) continue
        const profile = piProviders()?.[info.id]
        const models = (profile?.models ?? []).map((m) => ({ id: m.id, name: m.name ?? m.id }))
        declare(info.id, profile?.displayName ?? info.name, models)
      }
      return [...providers.values()]
    },
    async listConfigured() {
      const providers = this.listProviders()
      const out: ModelsProviderOption[] = []
      for (const provider of providers) {
        if (!(await this.keyConfigured(provider.provider))) continue
        // A catalog route activated by a key has no settings models entry; the
        // adapter serves the installed catalog, so enumerate through the llm
        // seam (which reads the same catalog) rather than leave it empty.
        let models = provider.models
        if (models.length === 0) {
          try {
            models = (await llm()?.listModels(provider.provider))?.map((m) => ({ id: m.id, name: m.name })) ?? []
          } catch {
            // Route not (yet) serviceable: keep the empty list; the picker
            // still lists the provider and the next refresh re-enumerates.
          }
        }
        out.push({ ...provider, models })
      }
      return out
    },
    async listAll() {
      const providers = this.listProviders()
      const out: { provider: string; name: string; configured: boolean }[] = []
      for (const provider of providers) {
        out.push({ provider: provider.provider, name: provider.name, configured: await this.keyConfigured(provider.provider) })
      }
      return out
    },
    async addProvider(input) {
      const route = input.route.trim()
      if (!ROUTE_PATTERN.test(route)) {
        return { ok: false, error: 'route must be lowercase kebab-case, e.g. my-gateway' }
      }
      const baseURL = input.baseURL.trim()
      if (baseURL === '') return { ok: false, error: 'base URL is required' }
      const models = input.models.map((m) => m.trim()).filter((m) => m !== '')
      if (models.length === 0) return { ok: false, error: 'at least one model id is required' }
      const apiKeyEnv = `${route.toUpperCase().replace(/-/g, '_')}_API_KEY`
      // The self-hosted adapter speaks one protocol (OpenAI-compatible), so
      // the profile needs no `api` field.
      const profile = {
        displayName: input.displayName.trim() === '' ? route : input.displayName.trim(),
        apiKeyEnv,
        baseURL,
        models: models.map((id) => ({ id })),
      }
      try {
        await (ctx.get('settings') as { update(ns: unknown, patch: unknown): Promise<void> })
          .update(TUI_LLM_NS, { providers: { [route]: profile } })
      } catch (error) {
        return { ok: false, error: `settings write failed: ${error instanceof Error ? error.message : String(error)}` }
      }
      const key = input.apiKey.trim()
      if (key !== '') {
        try {
          await (ctx.get('credentials') as { set(ref: unknown, value: string): Promise<void> })
            .set(credentialRef(apiKeyEnv), key)
        } catch (error) {
          return { ok: false, error: `credential write failed: ${error instanceof Error ? error.message : String(error)}` }
        }
      }
      return { ok: true }
    },
    async keyConfigured(provider) {
      const section = (ctx.get('settings') as { get(ns: unknown): unknown } | undefined)
        ?.get(TUI_LLM_NS) as { providers?: Record<string, TuiProviderProfile> } | undefined
      const refName = keyRefOf(provider, section?.providers)
      if (process.env[refName]?.trim()) return true
      const credentials = ctx.get('credentials') as { describe?: (ref: unknown) => Promise<{ configured: boolean }> } | undefined
      if (credentials?.describe === undefined) return false
      try {
        const info = await credentials.describe(credentialRef(refName))
        return Boolean(info?.configured)
      } catch {
        return false
      }
    },
    async setKey(provider, key) {
      const value = key.trim()
      if (value === '') return { ok: false, error: 'API key is empty' }
      const refName = keyRefOf(provider, piProviders())
      // A template route has no settings entry yet, so a key alone would never
      // register it. Activate it with the template's full profile (endpoint
      // and model catalog), then store the key.
      if (piProviders()?.[provider] === undefined && provider !== 'deepseek-official') {
        const template = TUI_TEMPLATES.find((t) => t.route === provider)
        if (template === undefined) {
          return { ok: false, error: `provider "${provider}" is not configured; add it through the custom-provider form first` }
        }
        try {
          await settings()?.update(TUI_LLM_NS, {
            providers: {
              [provider]: {
                displayName: template.name,
                baseURL: template.baseURL,
                apiKeyEnv: refName,
                models: template.models,
              },
            },
          })
        } catch (error) {
          return { ok: false, error: `settings write failed: ${error instanceof Error ? error.message : String(error)}` }
        }
      }
      try {
        await (ctx.get('credentials') as { set(ref: unknown, value: string): Promise<void> })
          .set(credentialRef(refName), value)
      } catch (error) {
        return { ok: false, error: `credential write failed: ${error instanceof Error ? error.message : String(error)}` }
      }
      return { ok: true }
    },
  }
  ctx.provide(TUI_MODELS_SERVICE, service)
}
