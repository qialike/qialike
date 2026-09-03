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
  resolveDefaultEffort,
  effectiveProfile,
  TUI_LLM_NS,
  type ReasoningEffortOption,
  type TuiProviderProfile,
  type TuiProviderTemplate,
} from './llm.ts'
import { effortsFor } from './effort-catalog.ts'

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
  /** Reasoning-effort levels the model supports (when any): selecting the
   *  model then steps through an Effort dialog before the choice saves.
   *  Absent = the model does not expose an effort knob. */
  efforts?: readonly ReasoningEffortOption[]
  /** The effort preselected when no saved effort matches (route default). */
  defaultEffort?: string
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
  listAll(): Promise<{ provider: string; name: string; configured: boolean; needsBaseURL: boolean }[]>
  /** Register a custom pi-ai provider (settings + credential), hot-reloaded. */
  addProvider(input: AddProviderInput): Promise<{ ok: true } | { ok: false; error: string }>
  /** Whether one provider's credential reference is configured (env or the store). */
  keyConfigured(provider: string): Promise<boolean>
  /** Store the API key for one provider's credential reference (registering a dormant catalog route on first use). */
  setKey(provider: string, key: string): Promise<{ ok: true } | { ok: false; error: string }>
  /** Remove the API key for one provider (hide/deactivate): deletes the stored
   *  credential; an environment-supplied key cannot be removed here, which the
   *  caller is told via `envKey`. */
  removeKey(provider: string): Promise<{ ok: true; envKey: boolean } | { ok: false; error: string }>
}

/** The dsh-tui-llm settings namespace (the self-hosted adapter's provider dict). */
// (TUI_LLM_NS imported from ./llm.ts)

/** Route id pattern for hand-declared providers (lowercase kebab-case). */
const ROUTE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

/** Effort metadata for one route/model on the picker: effective levels (static
 *  declaration, else the bundled catalog when the route opts in via
 *  `effortWire`) + resolved default — the same source the adapter enforces. */
function effortAnnotation(route: string, profile: TuiProviderProfile | undefined, modelId: string): { efforts?: readonly ReasoningEffortOption[]; defaultEffort?: string } {
  const efforts = effortsFor(route, profile, modelId)
  if (efforts.length === 0) return {}
  return { efforts, defaultEffort: resolveDefaultEffort(profile, efforts) ?? efforts[0]!.id }
}

/** Annotate one profile model entry with its picker fields + effort metadata. */
function modelOption(route: string, entry: { id: string; name?: string }, profile: TuiProviderProfile | undefined): ModelsModelOption {
  return {
    id: entry.id,
    name: entry.name ?? entry.id,
    ...effortAnnotation(route, profile, entry.id),
  }
}

/** The picker option list for one provider route, from its effective profile
 *  (built-in DeepSeek, a settings override, or a template) — the same source
 *  the adapter uses, so effort metadata matches what requests will enforce. */
function optionsFor(
  route: string,
  section: Record<string, TuiProviderProfile> | undefined,
  templates: readonly TuiProviderTemplate[],
): readonly ModelsModelOption[] {
  const profile = effectiveProfile(route, section, templates)
  return (profile?.models ?? []).map((model) => modelOption(route, model, profile))
}

/** One provider template offered by the add-provider form's dropdown. */
export interface ProviderTemplate {
  /** Route key. */
  id: string
  /** Display name. */
  name: string
  /** Default endpoint pre-filled into the form. */
  baseURL: string
  /** Model ids pre-filled into the form (custom form for deployment-configured providers). */
  models?: readonly { id: string }[]
}

/** Map raw catalog templates (core + plugin-registered) to dropdown entries. */
function mapTemplates(templates: readonly TuiProviderTemplate[]): readonly ProviderTemplate[] {
  return templates.map((template) => ({
    id: template.route,
    name: template.name,
    baseURL: template.baseURL,
    ...(template.models !== undefined ? { models: template.models } : {}),
  }))
}

/** The deepseek route's credential reference (the TUI's runtime key). */
const DEEPSEEK_KEY_REF = 'DEEPSEEK_API_KEY'

/** The credential reference name a provider profile resolves keys through.
 *  A template route with no settings profile yet (activated by an env/credential
 *  key alone) must resolve through the TEMPLATE's `apiKeyEnv` — e.g. the
 *  OpenCode Zen routes share `OPENCODE_ZEN_API_KEY` — not a route-derived name,
 *  or a shared gateway key would look "not configured" for the sibling routes. */
function keyRefOf(
  provider: string,
  section: Record<string, TuiProviderProfile> | undefined,
  templates: readonly TuiProviderTemplate[],
): string {
  if (provider === 'deepseek-official') return DEEPSEEK_KEY_REF
  const profile = section?.[provider]
  if (profile?.apiKeyEnv !== undefined) return profile.apiKeyEnv
  const template = templates.find((t) => t.route === provider)
  if (template?.apiKeyEnv !== undefined) return template.apiKeyEnv
  return `${provider.toUpperCase().replace(/-/g, '_')}_API_KEY`
}

export function apply(ctx: Context): void {
  /** The llm capability service, read through strict `ctx.get` (never injected). */
  const llm = () => ctx.get('llm') as {
    listProviders(): { id: string; name: string }[]
    listConfigurableProviders(): { provider: string; displayName: string; declared: boolean }[]
    listModels(provider: string): Promise<readonly { id: string; name: string }[]>
  } | undefined
  const settings = () => ctx.get('settings') as { get(ns: unknown): unknown; update(ns: unknown, patch: unknown): Promise<void> } | undefined
  /** The merged template directory (core + plugin-registered), read live. */
  const templates = (): readonly TuiProviderTemplate[] =>
    (ctx.get('tuiLlmTemplates') as { list(): readonly TuiProviderTemplate[] } | undefined)?.list() ?? []
  /** The add-provider dropdown entries derived from the merged directory. */
  const providerTemplates = (): readonly ProviderTemplate[] => mapTemplates(templates())
  /** The dsh-tui-llm providers dict as configured (`{ <route>: profile }`). */
  const piProviders = (): Record<string, TuiProviderProfile> | undefined =>
    (settings()?.get(TUI_LLM_NS) as { providers?: Record<string, TuiProviderProfile> } | undefined)?.providers
  const service: TuiModelsService = {
    listProviders() {
      // The configurable-provider directory: the self-hosted adapter's
      // built-in templates plus every route the settings section declares
      // (the tui-llm adapter registers it on mount). A template route without
      // a settings entry is known but not yet activated — it has no models
      // list until a profile activates it. Routes unloaded by a disabled
      // plugin (hiddenRoutes) are excluded entirely.
      const hidden = (ctx.get('tuiLlmTemplates') as { hiddenRoutes(): readonly string[] } | undefined)?.hiddenRoutes() ?? []
      const isHidden = (route: string): boolean => hidden.includes(route)
      const configurable = llm()?.listConfigurableProviders() ?? []
      const registered = llm()?.listProviders() ?? []
      const providers = new Map<string, ModelsProviderOption>()
      const declare = (provider: string, name: string, models: readonly ModelsModelOption[]): void => {
        providers.set(provider, { provider, name, models })
      }
      for (const entry of configurable) {
        if (isHidden(entry.provider)) continue
        const profile = piProviders()?.[entry.provider]
        declare(entry.provider, profile?.displayName ?? entry.displayName,
          optionsFor(entry.provider, piProviders(), templates()))
      }
      // Registered routes the directory does not know (e.g. the built-in
      // deepseek-official route) join with their own metadata.
      for (const info of registered) {
        if (isHidden(info.id)) continue
        if (providers.has(info.id)) continue
        const profile = piProviders()?.[info.id]
        declare(info.id, profile?.displayName ?? info.name,
          optionsFor(info.id, piProviders(), templates()))
      }
      return [...providers.values()]
    },
    async listConfigured() {
      const providers = this.listProviders()
      // Resolve every provider's key status and live model list IN PARALLEL:
      // the /models dialog opens as soon as this resolves, and serial awaits
      // (one key check + one gateway /models fetch per provider) made the
      // first open visibly slow.
      const settled = await Promise.all(providers.map(async (provider) => {
        if (!(await this.keyConfigured(provider.provider))) return undefined
        // Prefer the adapter's live view: tui-llm enumerates the gateway's real
        // /models catalog (filtered to the adapter's wire protocol) for
        // OpenAI-compatible routes and falls back to the static catalog; the
        // provider entry's settings models are the last resort. A route that is
        // not (yet) serviceable keeps its static models; the picker still lists
        // the provider and the next refresh re-enumerates.
        let models = provider.models
        try {
          const live = (await llm()?.listModels(provider.provider)) ?? []
          if (live.length > 0) {
            // Re-attach effort metadata to live ids by matching the effective
            // profile catalog (live enumeration carries ids/names only).
            const profile = effectiveProfile(provider.provider, piProviders(), templates())
            const byId = new Map((profile?.models ?? []).map((model) => [model.id, model]))
            models = live.map((m) => {
              const known = byId.get(m.id)
              return known === undefined
                ? { id: m.id, name: m.name, ...effortAnnotation(provider.provider, profile, m.id) }
                : { ...modelOption(provider.provider, known, profile), name: m.name }
            })
          }
        } catch {
          // keep `models` as-is
        }
        return { ...provider, models }
      }))
      return settled.filter((entry): entry is ModelsProviderOption => entry !== undefined)
    },
    async listAll() {
      const providers = this.listProviders()
      const out = await Promise.all(providers.map(async (provider) => {
        const template = templates().find((t) => t.route === provider.provider)
        return {
          provider: provider.provider,
          name: provider.name,
          configured: await this.keyConfigured(provider.provider),
          needsBaseURL: template?.needsBaseURL === true,
        }
      }))
      // The Add-provider list reads alphabetically by display name (route as
      // tie-break), so scanning stays predictable as the catalog grows.
      return out.sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
        || a.provider.localeCompare(b.provider))
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
      const refName = keyRefOf(provider, section?.providers, templates())
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
      const refName = keyRefOf(provider, piProviders(), templates())
      // A template route has no settings entry yet, so a key alone would never
      // register it. Activate it with the template's full profile (endpoint
      // and model catalog), then store the key.
      if (piProviders()?.[provider] === undefined && provider !== 'deepseek-official') {
        const template = templates().find((t) => t.route === provider)
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
                ...(template.excludeModelPrefixes !== undefined
                  ? { excludeModelPrefixes: template.excludeModelPrefixes }
                  : {}),
                ...(template.includeModelPrefixes !== undefined
                  ? { includeModelPrefixes: template.includeModelPrefixes }
                  : {}),
                ...(template.modelsApi !== undefined
                  ? { modelsApi: template.modelsApi }
                  : {}),
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
    async removeKey(provider) {
      const refName = keyRefOf(provider, piProviders(), templates())
      // An environment-supplied key cannot be removed from here; the hidden
      // set still keeps the provider off the /models list until a stored key
      // is set again through "Add provider". (The credential store rejects a
      // write/unset whose reference its read-only env source shadows.)
      const envKey = Boolean(process.env[refName]?.trim())
      const creds = ctx.get('credentials') as { unset?: (ref: unknown) => Promise<void> } | undefined
      if (creds?.unset !== undefined) {
        try {
          await creds.unset(credentialRef(refName))
        } catch (error) {
          return { ok: false, error: `credential remove failed: ${error instanceof Error ? error.message : String(error)}` }
        }
      }
      return { ok: true, envKey }
    },
  }
  ctx.provide(TUI_MODELS_SERVICE, service)
  // Warm the configured providers' gateway model caches in the background so
  // the FIRST /models dialog opens instantly (listConfigured fetches each
  // gateway's /models list on first open; with the caches pre-filled it only
  // reads memory). Best-effort: a slow/offline gateway is silently skipped.
  setTimeout(() => {
    void service.listConfigured().then(() => {}).catch(() => {})
  }, 500)
}
