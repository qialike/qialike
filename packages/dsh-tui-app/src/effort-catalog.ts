/**
 * Effort catalog: a bundled, offline snapshot of "which reasoning-effort
 * values each model exposes", modeled on the models.dev catalog
 * (`reasoning_options.type === 'effort'`, `values`, where `null` means "no
 * thinking" and becomes the `none` level) plus the canonical effort
 * vocabulary it validates against.
 *
 * dsh-tui applies the catalog ONLY as a fallback enrichment: a model whose
 * profile already declares `reasoningEfforts` keeps its static list (DeepSeek
 * official is static), and a route must opt in with
 * `effortWire: 'reasoning-effort'` before catalog values can ride on its
 * requests — the wire is a single OpenAI-compatible `reasoning_effort`, so a
 * catalog value is only meaningful when the endpoint genuinely accepts that
 * field (some clients instead translate per provider-SDK family; dsh-tui has one
 * wire, so the gate is the route declaration, not an npm table).
 *
 * @module @yourname/dsh-tui-app/effort-catalog
 */

import type { ReasoningEffortOption, TuiProviderProfile } from './llm.ts'
import effortCatalogData from './effort-catalog.json' with { type: 'json' }

/** Canonical effort ids the catalog may contribute (the `ReasoningEfforts`
 *  schema). Values outside this vocabulary are dropped —
 *  adapter-owned extras (e.g. DeepSeek's `off`) still work when a model
 *  declares them statically. */
export const EFFORT_VOCABULARY: readonly string[] = [
  'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
]

/** Display names for the canonical vocabulary (catalog-derived levels). */
const EFFORT_NAMES: Readonly<Record<string, string>> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'X-High',
  max: 'Max',
}

/** One-line descriptions for the canonical vocabulary, shown by the Effort
 *  picker under catalog-derived levels (DeepSeek's static levels carry their
 *  own copy from `REASONING_EFFORTS`). */
const EFFORT_DESCRIPTIONS: Readonly<Record<string, string>> = {
  none: 'Use for simple tasks that do not need reasoning.',
  minimal: 'Minimal reasoning for straightforward tasks.',
  low: 'Prefer for routine or latency-sensitive tasks.',
  medium: 'A middle ground for everyday tasks.',
  high: 'The default balance for most tasks.',
  xhigh: 'Stronger reasoning for complex or quality-sensitive tasks.',
  max: 'Reserve for the hardest quality-first tasks.',
}

/** Build one catalog-derived level option (`none` = no thinking — the
 *  `null → none` variant). */
function catalogOption(id: string): ReasoningEffortOption {
  return {
    id,
    name: EFFORT_NAMES[id] ?? id,
    ...(EFFORT_DESCRIPTIONS[id] === undefined ? {} : { description: EFFORT_DESCRIPTIONS[id] }),
    ...(id === 'none' ? { disablesThinking: true } : {}),
  }
}

/** One model's declared effort values from the snapshot. */
export interface EffortCatalogModel {
  /** `reasoning_options` effort values: `null` = no thinking (`none`). */
  effort?: readonly (string | null)[]
}

/** The bundled snapshot document (models.dev-style subset). */
export interface EffortCatalogFile {
  /** Format version (bump on incompatible shape changes). */
  schema: number
  /** When this snapshot was curated (informational). */
  generatedAt: string
  /** Human note on provenance; never parsed. */
  note?: string
  /** Provider-id (models.dev spelling) → its models. */
  providers: Readonly<Record<string, { models: Readonly<Record<string, EffortCatalogModel>> }>>
}

/**
 * Bundled offline snapshot of per-model effort values, loaded from the data
 * file `effort-catalog.json` (models.dev `reasoning_options.effort` style:
 * `null` = no thinking). Validated at load — a malformed shipped file fails
 * boot loudly. Seed content covers the built-in DeepSeek official models
 * (values verified against the live API); entries are added per verified
 * route/family instead of importing the whole third-party catalog wholesale.
 */
export const EFFORT_CATALOG: EffortCatalogFile = validateEffortCatalog(effortCatalogData)

/** Structural validation for the bundled `effort-catalog.json` document (our
 *  own shipped data: provider → model → `effort` array of vocabulary strings
 *  or `null`; anything else fails loud with the offending key). */
export function validateEffortCatalog(data: unknown): EffortCatalogFile {
  const bad = (where: string, reason: string): never => {
    throw new Error(`effort-catalog.json ${where}: ${reason}`)
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) bad('', 'expected an object')
  const doc = data as Record<string, unknown>
  if (typeof doc.schema !== 'number') bad('', 'schema (number) is required')
  const providers = doc.providers
  if (providers === null || typeof providers !== 'object' || Array.isArray(providers)) bad('', 'providers must be an object')
  for (const [provider, providerEntry] of Object.entries(providers as Record<string, unknown>)) {
    const models = (providerEntry as { models?: unknown } | null)?.models
    if (providerEntry === null || typeof providerEntry !== 'object'
      || models === null || typeof models !== 'object' || Array.isArray(models)) {
      bad(`provider "${provider}"`, 'needs a models object')
    }
    for (const [model, modelEntry] of Object.entries(models as Record<string, unknown>)) {
      if (modelEntry === null || typeof modelEntry !== 'object') bad(`provider "${provider}" model "${model}"`, 'must be an object')
      const effort = (modelEntry as { effort?: unknown }).effort
      if (effort === undefined) continue
      if (!Array.isArray(effort)) bad(`provider "${provider}" model "${model}"`, 'effort must be an array')
      for (const value of effort as unknown[]) {
        if (value !== null && typeof value !== 'string') {
          bad(`provider "${provider}" model "${model}"`, 'effort values must be strings or null')
        }
        if (typeof value === 'string' && !EFFORT_VOCABULARY.includes(value)) {
          bad(`provider "${provider}" model "${model}"`, `effort "${value}" is outside the vocabulary`)
        }
      }
    }
  }
  return doc as unknown as EffortCatalogFile
}

/** Default models.dev provider-id guess per dsh-tui route (overridable per
 *  profile with `catalogProvider`). */
const ROUTE_CATALOG_PROVIDERS: Readonly<Record<string, string>> = {
  'deepseek-official': 'deepseek',
}

/** The catalog provider + optional model key for one route/profile. */
function catalogKey(route: string, profile: TuiProviderProfile | undefined): { provider: string; model?: string } {
  return {
    provider: profile?.catalogProvider ?? ROUTE_CATALOG_PROVIDERS[route] ?? '',
    model: profile?.catalogModel,
  }
}

/** Resolve the catalog's effort levels for one route/model, or undefined when
 *  the snapshot has no matching entry (or all values fall outside the
 *  vocabulary). Does NOT consult static declarations — that is the caller's
 *  precedence decision. The optional `catalog` argument lets tests inject a
 *  synthetic snapshot; it defaults to the bundled file. */
export function catalogEfforts(
  route: string,
  profile: TuiProviderProfile | undefined,
  model: string,
  catalog: EffortCatalogFile = EFFORT_CATALOG,
): readonly ReasoningEffortOption[] | undefined {
  const { provider, model: catalogModel } = catalogKey(route, profile)
  if (provider === '') return undefined
  const entry = catalog.providers[provider]?.models[catalogModel ?? model]
  const values = entry?.effort
  if (values === undefined || values.length === 0) return undefined
  const seen = new Set<string>()
  const out: ReasoningEffortOption[] = []
  for (const value of values) {
    const id = value === null ? 'none' : value
    if (!EFFORT_VOCABULARY.includes(id)) continue // adapter-owned extras must be declared statically
    if (seen.has(id)) continue
    seen.add(id)
    out.push(catalogOption(id))
  }
  return out.length === 0 ? undefined : out
}

/**
 * The effective effort levels for one route/model: the profile's static
 * declaration wins; otherwise, when the route opts into the reasoning-effort
 * wire (`effortWire: 'reasoning-effort'`), the bundled catalog supplies the
 * levels; otherwise none. Single source shared by the picker metadata, the
 * adapter's model info, and request serialization, so every surface agrees.
 */
export function effortsFor(
  route: string,
  profile: TuiProviderProfile | undefined,
  model: string,
): readonly ReasoningEffortOption[] {
  const staticLevels = profile?.models?.find((entry) => entry.id === model)?.reasoningEfforts
  if (staticLevels !== undefined && staticLevels.length > 0) return staticLevels
  if (profile?.effortWire !== 'reasoning-effort') return []
  return catalogEfforts(route, profile, model) ?? []
}
