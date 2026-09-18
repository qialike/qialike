/**
 * The self-hosted LLM provider layer (`tui-llm`): an OpenAI-compatible
 * multi-provider adapter that replaces the pi-ai twin (`dsh-llm-pi-ai`) in the
 * TUI composition. It owns its own provider directory (built-in templates plus
 * routes declared in the `qialike-llm:` settings section), speaks one wire
 * protocol — OpenAI `chat/completions` — and registers through the same llm
 * seams the harness adapters use (`registerAdapter` +
 * `registerConfigurableProviders`), so the agent loop, the Models dialog, and
 * the session log need no changes.
 *
 * No third-party LLM SDK: requests are direct `fetch` + SSE, in the style of
 * `dsh-llm-deepseek`. Scope is deliberately OpenAI-compatible only, text-only
 * models, no response replay metadata.
 *
 * @module @yourname/qialike-app/llm
 */

import { Context } from '@deepseek-ai/cordis'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import { registerWithLegacy } from './legacy-names.ts'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { logErrorFileOnly } from './log.ts'
import { effortsFor } from './effort-catalog.ts'
import providerTemplatesData from './provider-templates.json' with { type: 'json' }
import {
  LlmAdapter,
  LlmError,
  ToolCallId,
  ReasoningEffortId,
  attributionHeaders,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  isContextWindowExceededError,
  type GenerateOptions,
  type StreamChunk,
  type LlmConfigurableProvider,
  type LlmModelInfo,
  type LlmResolvedModelInfo,
  type Message,
  type TokenUsage,
  type FinishReason,
} from '@deepseek-ai/dsh-llm'

/** Stable Cordis plugin name. */
export const name = 'tui-llm'

/** Services required before adapter registration can run. */
export const inject = ['settings', 'credentials', 'llm']

/** The `qialike-llm:` settings namespace holding user provider profiles. */
export const TUI_LLM_NS = 'qialike-llm'

/** Pre-rename namespace: read as a `base` fallback, never written. */
export const TUI_LLM_LEGACY_NS = 'dsh-tui-llm'

/** One provider route profile as configured under `qialike-llm.providers`. */
export interface TuiProviderProfile {
  /** Selector label; defaults to the route key. */
  displayName?: string
  /** Wire protocol the endpoint speaks; defaults to OpenAI-compatible. */
  api?: 'openai-completions' | 'openai-responses' | 'anthropic-messages' | 'google-generative'
  /** Endpoint root; `/chat/completions` (OpenAI) or `/v1/messages` (Anthropic) is appended. */
  baseURL: string
  /** Credential reference the API key resolves through (env or the credentials store). */
  apiKeyEnv?: string
  /** Which output-cap field the endpoint reads; OpenAI-compatible only, defaults to `max_tokens`. */
  maxTokensField?: 'max_tokens' | 'max_completion_tokens'
  /**
   * Model id prefixes to drop from the gateway's live `/models` catalog
   * (OpenAI-compatible routes only). Gateways like OpenCode Zen serve several
   * wire protocols under one key (chat/completions, messages, responses), and
   * `/models` does not say which — this adapter only speaks chat/completions,
   * so profiles exclude the families routed to the other protocols.
   */
  excludeModelPrefixes?: readonly string[]
  /**
   * Model id prefixes to keep from the gateway's live `/models` catalog;
   * when set, everything else is dropped (whitelist, applied before the
   * exclude list). Used by split gateways where one route speaks a single
   * protocol family (e.g. `opencode-zen-gpt` keeps only gpt-/grok-/muse-).
   */
  includeModelPrefixes?: readonly string[]
  /**
   * Per-model-family wire overrides for a multi-protocol gateway, keyed by
   * model id prefix. OpenCode Zen serves four protocols under one API key —
   * chat/completions (default), messages (claude-/qwen), responses
   * (gpt-/grok-/muse-) and Google (gemini-) — so the picker can show all
   * models while the adapter routes each family to its endpoint/protocol at
   * stream time. `api`/`baseURL` override the route's defaults when the model
   * id starts with the prefix.
   */
  modelsApi?: Readonly<Record<string, { api?: TuiProviderProfile['api']; baseURL?: string }>>
  /** Model catalog this route serves. */
  models?: readonly TuiModelProfile[]
  /**
   * Route default reasoning effort, materialized for the route's
   * effort-capable models when a request carries none. The id must be one of
   * the model's declared efforts; when unset the default resolves to `high`
   * when declared, else the model's first declared level.
   */
  reasoningEffort?: string
  /**
   * Opt-in for catalog-supplied effort levels. When a model on this route has
   * no static `reasoningEfforts` declaration, the bundled effort catalog
   * (`effort-catalog.ts`) may supply its levels — but ONLY with this flag,
   * because the request then sends `reasoning_effort: <id>` verbatim and the
   * endpoint must genuinely accept that field (DeepSeek official does; most
   * OpenAI-compatible gateways are unverified and stay off).
   */
  effortWire?: 'reasoning-effort'
  /** models.dev provider-id used to look the route up in the effort catalog
   *  (defaults through an internal route→provider map). */
  catalogProvider?: string
  /** models.dev model-id override for the effort-catalog lookup (defaults to
   *  the qialike model id). */
  catalogModel?: string
}

/** One model entry in a provider profile. */
export interface TuiModelProfile {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  /** Request modalities this model accepts; absent means text-only. */
  inputModalities?: readonly ('text' | 'image')[]
  /**
   * Reasoning-effort levels this model supports (adapter-owned ids + selector
   * copy). A model without this field never sends effort parameters and its
   * picker entry saves directly without the Effort step; a model WITH it is
   * advertised to the harness (validation + default materialization) and its
   * requests carry `thinking`/`reasoning_effort` per the chosen level.
   */
  reasoningEfforts?: readonly ReasoningEffortOption[]
}

/** One selectable reasoning-effort level (adapter-owned id + selector copy). */
export interface ReasoningEffortOption {
  /** Opaque stable value sent to the provider (e.g. `reasoning_effort`). */
  id: string
  /** Human-readable name for selectors and diagnostics. */
  name: string
  /** Optional user-facing distinction from otherwise similar efforts. */
  description?: string
  /**
   * When true this level switches the provider's thinking OFF entirely (the
   * request sends `thinking: {type: 'disabled'}` and no `reasoning_effort`).
   * Defaults to true for the conventional id `off`; providers whose
   * no-thinking level has another id (e.g. `none`, `disabled`) mark it here,
   * and a provider that really accepts `reasoning_effort: off` can set false.
   */
  disablesThinking?: boolean
}

/**
 * Reasoning-effort levels of the DeepSeek official models, in display order.
 * Other providers/models declare their own lists (ids + names + optional
 * `disablesThinking`) — every surface (picker, cycling, wiring) is driven by
 * those declarations, never by a fixed DeepSeek set.
 */
export const REASONING_EFFORTS: readonly ReasoningEffortOption[] = [
  { id: 'off', name: 'Off', description: 'Use for simple tasks that do not need reasoning.' },
  { id: 'low', name: 'Low', description: 'Prefer for routine or latency-sensitive tasks.' },
  { id: 'high', name: 'High', description: 'The default balance for most tasks.' },
  { id: 'max', name: 'Max', description: 'Reserve for the hardest quality-first tasks.' },
]

/**
 * Resolve a route's default reasoning effort from its declared levels: the
 * profile default when it is declared, else `high` when declared, else the
 * model's first declared level. Never returns an id the model does not list.
 */
export function resolveDefaultEffort(
  profile: TuiProviderProfile | undefined,
  declared: readonly ReasoningEffortOption[],
): string | undefined {
  const preferred = profile?.reasoningEffort
  if (preferred !== undefined && declared.some((effort) => effort.id === preferred)) return preferred
  if (declared.some((effort) => effort.id === 'high')) return 'high'
  return declared[0]?.id
}

/** Human-readable name for one reasoning-effort id (catalog name or the raw id). */
export function reasoningEffortName(id: string): string {
  return REASONING_EFFORTS.find((effort) => effort.id === id)?.name ?? id
}

/** A built-in provider template offered by the Add-provider directory. */
export interface TuiProviderTemplate extends TuiProviderProfile {
  /** Route key the template activates. */
  route: string
  /** Human-readable provider name. */
  name: string
  /** The endpoint is deployment-specific (Azure/Cloudflare/Vertex…): the key
   *  dialog cannot activate it alone — the user must supply a base URL via the
   *  custom-provider form, which is opened pre-filled from this template. */
  needsBaseURL?: boolean
}

/**
 * Built-in OpenAI-compatible provider templates. Each carries the endpoint and
 * a small current-model catalog, so activating one (setting its key) yields a
 * working route immediately. The directory shows these beside the configured
 * routes, exactly like the catalog the pi-ai twin used to provide.
 */
/**
 * The built-in provider template directory (wire profiles for the
 * Add-provider flow) is defined in the bundled data file
 * `provider-templates.json` (one row per provider, schema-versioned); the
 * file is validated and exposed as `PROVIDER_TEMPLATES` below (after the zod
 * schemas it validates against).
 */

/** The TUI's own provider: `deepseek-official` runs out of the box. */
// `maxTokens` is the PER-REQUEST output ceiling requested from the provider;
// reasoning tokens count against it. The catalog asks for the same generous
// cap the harness's own deepseek adapter defaults to (256000,
// DEFAULT_MAX_TOKENS) instead of the historical 8192: with high reasoning
// effort a single planning chain burns through 8192 before emitting body
// text, which ends the turn as a max-tokens truncation (see the turn/end
// max-tokens hint). DeepSeek's endpoint accepts the larger cap (verified over
// many real runs — zero truncations at 256000 vs 50 at 8192), so the higher
// ceiling makes output truncation effectively unreachable.
const DEEPSEEK_OFFICIAL: TuiProviderProfile = {
  displayName: 'DeepSeek',
  baseURL: 'https://api.deepseek.com',
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  models: [
    // `deepseek-flash` is DeepSeek's V4.1 Flash weights and is first in the harness
    // (llm-deepseek) DEFAULT_MODELS order; it declares image input, so the TUI-side
    // attachment gate admits images for it. `deepseek-v4-flash-vision-exp` carries the
    // same declaration as the harness row (without it the gate rejected images for a
    // model whose whole point is vision). `contextWindow` mirrors the harness's
    // DEFAULT_CONTEXT_WINDOW (1_000_000) — all four official rows are kept in sync with it.
    { id: 'deepseek-flash', name: 'DeepSeek-V41-Flash', contextWindow: 1000000, maxTokens: 256000, inputModalities: ['text', 'image'], reasoningEfforts: REASONING_EFFORTS },
    { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', contextWindow: 1000000, maxTokens: 256000, reasoningEfforts: REASONING_EFFORTS },
    { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', contextWindow: 1000000, maxTokens: 256000, reasoningEfforts: REASONING_EFFORTS },
    { id: 'deepseek-v4-flash-vision-exp', name: 'DeepSeek V4 Flash Vision Exp', contextWindow: 1000000, maxTokens: 256000, inputModalities: ['text', 'image'], reasoningEfforts: REASONING_EFFORTS },
  ],
}

/** Route key of the built-in DeepSeek provider. */
export const DEEPSEEK_OFFICIAL_ROUTE = 'deepseek-official'

/** The `qialike-llm` settings section shape. */
interface TuiLlmSection {
  providers?: Record<string, TuiProviderProfile>
}

const TuiModelSchema = z.object({
  id: z.string().required(),
  name: z.string(),
  contextWindow: z.number(),
  maxTokens: z.number(),
  inputModalities: z.array(z.union(['text', 'image'])),
  reasoningEfforts: z.array(z.object({
    id: z.string().required(),
    name: z.string().required(),
    description: z.string(),
    disablesThinking: z.boolean(),
  })),
})

const TuiProviderSchema = z.object({
  displayName: z.string(),
  api: z.union(['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative']),
  baseURL: z.string().required(),
  apiKeyEnv: z.string(),
  maxTokensField: z.union(['max_tokens', 'max_completion_tokens']),
  excludeModelPrefixes: z.array(z.string()),
  includeModelPrefixes: z.array(z.string()),
  modelsApi: z.dict(z.object({
    api: z.union(['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative']),
    baseURL: z.string(),
  })),
  models: z.array(TuiModelSchema),
  reasoningEffort: z.string(),
  effortWire: z.union(['reasoning-effort']),
  catalogProvider: z.string(),
  catalogModel: z.string(),
})

const TuiLlmSchema = z.object({
  providers: z.dict(TuiProviderSchema),
})

/** Structural validation for the bundled `provider-templates.json` rows (the
 *  file is our own shipped data, so a malformed row must fail loud with a row
 *  number — never silently produce a broken route). Optional fields follow the
 *  `TuiProviderTemplate` shape; unknown keys are tolerated for forward
 *  compatibility. */
export function validateProviderTemplates(data: unknown): TuiProviderTemplate[] {
  if (!Array.isArray(data)) {
    throw new Error('provider-templates.json: expected an array of template rows')
  }
  const apis = new Set(['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative'])
  const effortWires = new Set(['reasoning-effort'])
  const fail = (index: number, reason: string): never => {
    throw new Error(`provider-templates.json row ${index + 1}: ${reason}`)
  }
  const needString = (value: unknown, index: number, what: string): string => {
    if (typeof value !== 'string' || value === '') {
      throw new Error(`provider-templates.json row ${index + 1}: ${what} (string) is required`)
    }
    return value
  }
  const seen = new Set<string>()
  const out: TuiProviderTemplate[] = []
  data.forEach((row, index) => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) fail(index, 'not an object')
    const entry = row as Record<string, unknown>
    const route = needString(entry.route, index, 'route')
    if (seen.has(route)) fail(index, `duplicate route "${route}"`)
    seen.add(route)
    needString(entry.name, index, 'name')
    const baseURL = entry.baseURL
    if (typeof baseURL !== 'string') fail(index, 'baseURL must be a string')
    const api = entry.api
    if (api !== undefined && !apis.has(api as string)) fail(index, `unknown api "${String(api)}"`)
    const effortWire = entry.effortWire
    if (effortWire !== undefined && !effortWires.has(effortWire as string)) fail(index, `unknown effortWire "${String(effortWire)}"`)
    const needsBaseURL = entry.needsBaseURL
    if (needsBaseURL !== undefined && typeof needsBaseURL !== 'boolean') fail(index, 'needsBaseURL must be a boolean')
    const models = entry.models
    if (models !== undefined) {
      if (!Array.isArray(models)) fail(index, 'models must be an array')
      for (const model of models as unknown[]) {
        if (model === null || typeof model !== 'object' || typeof (model as { id?: unknown }).id !== 'string') {
          fail(index, 'each model entry needs an id (string)')
        }
        const reasoningEfforts = (model as { reasoningEfforts?: unknown }).reasoningEfforts
        if (reasoningEfforts !== undefined) {
          if (!Array.isArray(reasoningEfforts)) fail(index, 'model reasoningEfforts must be an array')
          for (const level of reasoningEfforts as unknown[]) {
            const entry_ = level as { id?: unknown; name?: unknown; description?: unknown; disablesThinking?: unknown } | null
            if (entry_ === null || typeof level !== 'object') fail(index, 'a reasoningEffort entry must be an object')
            if (typeof entry_?.id !== 'string' || entry_?.id === '') fail(index, 'a reasoningEffort entry needs id (string)')
            if (typeof entry_?.name !== 'string' || entry_?.name === '') fail(index, 'a reasoningEffort entry needs name (string)')
            if (entry_?.description !== undefined && typeof entry_?.description !== 'string') fail(index, 'a reasoningEffort description must be a string')
            if (entry_?.disablesThinking !== undefined && typeof entry_?.disablesThinking !== 'boolean') fail(index, 'a reasoningEffort disablesThinking must be a boolean')
          }
        }
      }
    }
    out.push(entry as unknown as TuiProviderTemplate)
  })
  return out
}

/**
 * The built-in provider template directory, loaded from the bundled data file
 * `provider-templates.json` (one wire-profile row per provider; see that file
 * for the schema). Validated at load — a malformed shipped file fails boot
 * loudly. Plugin templates join through `tuiLlmTemplates.add` and
 * settings-declared routes ride the configurable-provider axis.
 */
export const PROVIDER_TEMPLATES: readonly TuiProviderTemplate[] = validateProviderTemplates(providerTemplatesData)

/**
 * Resolve the effective provider map: the built-in `deepseek-official` route
 * first, then every route the settings section declares (user additions and
 * overrides win, so an `deepseek-official` section entry replaces the default).
 * @param section - the resolved settings section.
 * @returns provider profiles keyed by route, default first.
 */
function effectiveProviders(section: TuiLlmSection): Map<string, TuiProviderProfile> {
  const map = new Map<string, TuiProviderProfile>([[DEEPSEEK_OFFICIAL_ROUTE, DEEPSEEK_OFFICIAL]])
  for (const [route, profile] of Object.entries(section.providers ?? {})) {
    map.set(route, profile)
  }
  return map
}

/** One registered provider's models, for `listModels`/`resolveModel`. */
function providerModels(profile: TuiProviderProfile | undefined): readonly TuiModelProfile[] {
  return profile?.models ?? []
}

/** The reasoning metadata advertised to the harness for one effort-capable
 *  route/model: its effective levels (static declaration, else the bundled
 *  effort catalog when the route opts in via `effortWire`) plus the route
 *  default effort (resolved through the declared levels — profile default,
 *  else `high`, else the first level), mirroring the harness llm-deepseek
 *  adapter. Absent when the model has no levels. */
export function modelReasoning(
  profile: TuiProviderProfile | undefined,
  route: string,
  model: string,
): { efforts: readonly ReasoningEffortOption[]; defaultEffort: string } | undefined {
  const efforts = effortsFor(route, profile, model)
  if (efforts.length === 0) return undefined
  const defaultEffort = resolveDefaultEffort(profile, efforts) ?? efforts[0]!.id
  return { efforts, defaultEffort }
}

/** Resolve one route's effective profile exactly as the adapter does: the
 *  built-in DeepSeek route first, then a settings-provided override, then a
 *  template route. Exported so the /models capability annotates the picker
 *  with the same effort metadata the adapter will enforce. */
export function effectiveProfile(
  route: string,
  section: Record<string, TuiProviderProfile> | undefined,
  templates: readonly TuiProviderTemplate[],
): TuiProviderProfile | undefined {
  if (route === DEEPSEEK_OFFICIAL_ROUTE) return section?.[route] ?? DEEPSEEK_OFFICIAL
  return section?.[route] ?? templates.find((template) => template.route === route)
}

/** How long a gateway-fetched `/models` catalog is trusted before re-fetching. */
const DYNAMIC_MODELS_TTL = 5 * 60_000

/** Timeout for the gateway `/models` probe; a slow gateway degrades to the static catalog. */
const DYNAMIC_MODELS_TIMEOUT = 4_000

/** Cached gateway model-id lists, keyed by the endpoint root (shared across routes). */
const dynamicModelsCache = new Map<string, { at: number; ids: readonly string[] }>()

/**
 * Probe an OpenAI-compatible gateway's live model catalog (`GET {baseURL}/models`,
 * the standard OpenAI list endpoint — OpenCode Zen/Go, OpenRouter, DeepSeek …
 * all serve it; some gateways expose it without auth, e.g. Zen). Returns the
 * model ids, or `undefined` when the endpoint is missing/unauthorized/slow, so
 * callers fall back to the static profile catalog. Results are cached per
 * endpoint root with a TTL; a stale cache miss re-fetches.
 */
export async function fetchDynamicModels(baseURL: string): Promise<readonly string[] | undefined> {
  const root = baseURL.replace(/\/+$/, '')
  const hit = dynamicModelsCache.get(root)
  if (hit !== undefined && Date.now() - hit.at < DYNAMIC_MODELS_TTL) return hit.ids
  try {
    const response = await fetch(`${root}/models`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(DYNAMIC_MODELS_TIMEOUT),
    })
    if (!response.ok) return undefined
    const body = (await response.json()) as { data?: readonly { id?: unknown }[] } | undefined
    const ids = (body?.data ?? []).map((entry) => String(entry?.id ?? '')).filter((id) => id !== '')
    if (ids.length === 0) return undefined
    dynamicModelsCache.set(root, { at: Date.now(), ids })
    return ids
  } catch {
    return undefined
  }
}

/** Resolve the per-model wire override (protocol + endpoint) for one model id
 *  against a route's `modelsApi` prefix map. Returns `{}` when the route has
 *  no map or no prefix matches — the route's defaults apply. */
export function resolveModelApi(
  profile: TuiProviderProfile,
  model: string,
): { api?: TuiProviderProfile['api']; baseURL?: string } {
  const map = profile.modelsApi
  if (map === undefined) return {}
  for (const [prefix, override] of Object.entries(map)) {
    if (model.startsWith(prefix)) return override
  }
  return {}
}

/** Drop model families that ride wire protocols this adapter does not speak.
 *  `include` is a whitelist (keep only matching ids, applied first); `exclude`
 *  then removes any remaining unwanted families. */
export function filterDynamicModels(
  ids: readonly string[],
  filters: { include?: readonly string[] | undefined; exclude?: readonly string[] | undefined } | undefined,
): readonly string[] {
  if (filters === undefined) return ids
  let out = ids
  if (filters.include !== undefined && filters.include.length > 0) {
    out = out.filter((id) => filters.include!.some((prefix) => id.startsWith(prefix)))
  }
  if (filters.exclude !== undefined && filters.exclude.length > 0) {
    out = out.filter((id) => !filters.exclude!.some((prefix) => id.startsWith(prefix)))
  }
  return out
}

/** Resolve the API key for one route through the credentials seam, then env. */
async function resolveApiKey(
  ctx: Context,
  route: string,
  envName: string | undefined,
): Promise<string> {
  const refName = envName ?? `${route.toUpperCase().replace(/-/g, '_')}_API_KEY`
  const credentials = ctx.get('credentials') as { resolve?: (ref: unknown) => Promise<{ value?: string } | undefined> } | undefined
  if (credentials?.resolve !== undefined) {
    try {
      const hit = await credentials.resolve(credentialRef(refName))
      if (hit?.value !== undefined && hit.value.length > 0) return hit.value
    } catch {
      // Fall through to the environment; a store failure is not the route's fault.
    }
  }
  const fromEnv = process.env[refName]?.trim()
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  throw new LlmError(
    `no credential for provider route "${route}"; its profile resolves ${refName}, which is not set`
    + ' — store it through the Models dialog or export it',
    'MISSING_CREDENTIAL',
  )
}

/** OpenAI wire message. */
type WireMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | readonly (WireTextPart | WireImagePart)[]
  tool_call_id?: string
  tool_calls?: readonly {
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }[]
}

/** OpenAI text content part. */
interface WireTextPart { type: 'text'; text: string }

/** OpenAI image content part (`data:` URL carries the base64 bytes). */
interface WireImagePart { type: 'image_url'; image_url: { url: string } }

/** Anthropic wire message. */
interface AnthropicWireMessage {
  role: 'user' | 'assistant'
  content: readonly (AnthropicTextBlock | AnthropicImageBlock | AnthropicToolUseBlock | AnthropicToolResultBlock)[]
}

interface AnthropicTextBlock { type: 'text'; text: string }
interface AnthropicImageBlock { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
interface AnthropicToolUseBlock { type: 'tool_use'; id: string; name: string; input: unknown }
interface AnthropicToolResultBlock { type: 'tool_result'; tool_use_id: string; content: string }

/** Request-image projection for attached images (fixed conservative budget). */
const IMAGE_REQUEST_POLICY = { maxPixels: 1024 * 1024, maxBytes: 2 * 1024 * 1024 }

/** Whether any message in a request carries an image block. */
function hasImages(messages: readonly Message[]): boolean {
  return messages.some((message) => message.content.some((block) => block.type === 'image'))
}

/**
 * Encode one durable image reference to a provider-ready base64 payload through
 * the attachment service (`ctx.attachments`, mounted by the base composition).
 * @returns the media type and base64 payload, or `undefined` when the
 *   attachment service is unavailable (the request then fails on admission).
 */
async function encodeImage(
  ctx: Context,
  ref: Extract<Message['content'][number], { type: 'image' }>['attachment'],
  signal: AbortSignal | undefined,
): Promise<{ mediaType: string; data: string } | undefined> {
  const attachments = ctx.get('attachments') as {
    readImageRequest(ref: unknown, policy: unknown, signal?: AbortSignal): Promise<{
      mediaType: string
      data: Uint8Array
    }>
  } | undefined
  if (attachments === undefined) return undefined
  const request = await attachments.readImageRequest(ref, IMAGE_REQUEST_POLICY, signal)
  return { mediaType: request.mediaType, data: Buffer.from(request.data).toString('base64') }
}

/** One SSE `data:` payload from a chat/completions stream. */
interface WireChunk {
  choices?: readonly {
    delta?: {
      content?: string | null
      reasoning_content?: string | null
      tool_calls?: readonly {
        index?: number
        id?: string | null
        function?: { name?: string | null; arguments?: string | null }
      }[]
    }
    finish_reason?: string | null
  }[]
  usage?: {
    prompt_tokens?: number | null
    completion_tokens?: number | null
    prompt_tokens_details?: { cached_tokens?: number } | null
    completion_tokens_details?: { reasoning_tokens?: number } | null
  } | null
  /** Provider error delivered as an SSE payload (HTTP 200 but stream aborted). */
  error?: { message?: string; code?: string; type?: string }
}

/** Flatten a message's text blocks; non-text blocks are ignored (text-only scope). */
function flattenText(content: readonly Message['content'][number][]): string {
  const text: string[] = []
  for (const block of content) {
    if (block.type === 'text') text.push(block.text)
  }
  return text.join('')
}

/** Serialize one assistant message (text + tool calls); never null content. */
function serializeAssistant(message: Message): WireMessage {
  const text = flattenText(message.content)
  const toolCalls = message.content
    .filter((block): block is Extract<Message['content'][number], { type: 'tool-call' }> => block.type === 'tool-call')
    .map((block) => ({
      id: block.id,
      type: 'function' as const,
      function: { name: block.name, arguments: block.arguments },
    }))
  return {
    role: 'assistant',
    content: text,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  }
}

/**
 * Serialize the conversation for OpenAI-compatible endpoints. Harness tool
 * results ride user-role messages; OpenAI wants them as standalone
 * `{role:'tool'}` entries, so each expands to its own wire message. User text
 * and images become content parts when any image is present.
 * @param ctx - the context resolving the attachment service for image blocks.
 * @param messages - the harness conversation in order.
 * @param system - the system prompt, prepended when present.
 * @param signal - cancellation for image reads.
 * @returns the wire messages, order preserved.
 */
export async function serializeMessagesOpenAI(
  ctx: Context,
  messages: readonly Message[],
  system: string | undefined,
  signal: AbortSignal | undefined,
): Promise<WireMessage[]> {
  const wire: WireMessage[] = []
  if (system !== undefined && system !== '') wire.push({ role: 'system', content: system })
  for (const message of messages) {
    if (message.role === 'system') {
      wire.push({ role: 'system', content: flattenText(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      wire.push(serializeAssistant(message))
      continue
    }
    const toolResults = message.content.filter((block) => block.type === 'tool-result')
    const parts = await userContentParts(ctx, message, signal)
    if (parts.length > 0 || toolResults.length === 0) {
      wire.push({
        role: 'user',
        content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts,
      })
    }
    for (const result of toolResults) {
      wire.push({
        role: 'tool',
        tool_call_id: result.toolCallId,
        content: flattenText(result.content) || '(no output)',
      })
    }
  }
  return wire
}

/** One user message's text/image content parts (OpenAI). */
async function userContentParts(
  ctx: Context,
  message: Message,
  signal: AbortSignal | undefined,
): Promise<readonly (WireTextPart | WireImagePart)[]> {
  const parts: (WireTextPart | WireImagePart)[] = []
  for (const block of message.content) {
    if (block.type === 'text') {
      if (block.text !== '') parts.push({ type: 'text', text: block.text })
    } else if (block.type === 'image') {
      const encoded = await encodeImage(ctx, block.attachment, signal)
      if (encoded === undefined) {
        throw new LlmError('image input requires the attachment service', 'UNSUPPORTED_CONTENT')
      }
      parts.push({ type: 'image_url', image_url: { url: `data:${encoded.mediaType};base64,${encoded.data}` } })
    }
  }
  return parts
}

/**
 * Serialize the conversation for the Anthropic Messages API: the system prompt
 * is a top-level field, tool calls and tool results are content blocks, and
 * images are base64 source blocks.
 * @param ctx - the context resolving the attachment service for image blocks.
 * @param messages - the harness conversation in order.
 * @param system - the system prompt.
 * @param signal - cancellation for image reads.
 * @returns the top-level system text (when any) and the wire messages.
 */
export async function serializeMessagesAnthropic(
  ctx: Context,
  messages: readonly Message[],
  system: string | undefined,
  signal: AbortSignal | undefined,
): Promise<{ systemText: string | undefined; messages: AnthropicWireMessage[] }> {
  const systemParts: string[] = []
  if (system !== undefined && system !== '') systemParts.push(system)
  const wire: AnthropicWireMessage[] = []
  for (const message of messages) {
    if (message.role === 'system') {
      const text = flattenText(message.content)
      if (text !== '') systemParts.push(text)
      continue
    }
    if (message.role === 'assistant') {
      const text = flattenText(message.content)
      const toolUses: AnthropicToolUseBlock[] = []
      for (const block of message.content) {
        if (block.type !== 'tool-call') continue
        let input: unknown = {}
        try { input = JSON.parse(block.arguments) as unknown } catch { /* malformed args: send {} */ }
        toolUses.push({ type: 'tool_use', id: block.id, name: block.name, input })
      }
      const content: AnthropicWireMessage['content'] = [
        ...(text !== '' ? [{ type: 'text' as const, text }] : []),
        ...toolUses,
      ]
      wire.push({ role: 'assistant', content })
      continue
    }
    // user role: text/images plus expanded tool results.
    const toolResults = message.content.filter((block) => block.type === 'tool-result')
    const content: (AnthropicTextBlock | AnthropicImageBlock)[] = []
    for (const block of message.content) {
      if (block.type === 'text') {
        if (block.text !== '') content.push({ type: 'text', text: block.text })
      } else if (block.type === 'image') {
        const encoded = await encodeImage(ctx, block.attachment, signal)
        if (encoded === undefined) {
          throw new LlmError('image input requires the attachment service', 'UNSUPPORTED_CONTENT')
        }
        content.push({ type: 'image', source: { type: 'base64', media_type: encoded.mediaType, data: encoded.data } })
      }
    }
    if (content.length > 0 || toolResults.length === 0) {
      wire.push({ role: 'user', content })
    }
    for (const result of toolResults) {
      wire.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: result.toolCallId,
          content: flattenText(result.content) || '(no output)',
        }],
      })
    }
  }
  return { systemText: systemParts.length > 0 ? systemParts.join('\n\n') : undefined, messages: wire }
}

/** Map one adapter reasoning effort to its provider wire fields, driven by the
 * model's own declaration (the provider's level set may be anything — e.g.
 * DeepSeek Off/Low/High/Max, another gateway low/medium/high/xhigh/max):
 * - the level marked `disablesThinking` (or the conventional id `off`)
 *   switches thinking off entirely (`thinking: {type: 'disabled'}`, no
 *   `reasoning_effort` value);
 * - every other level enables thinking and sends its own id verbatim as
 *   `reasoning_effort` (the id is the provider-advertised wire value).
 */
function reasoningEffortWire(entry: ReasoningEffortOption | undefined, effort: string): { thinking: { type: 'enabled' | 'disabled' }; reasoning_effort?: string } {
  if (entry?.disablesThinking === true || (entry?.disablesThinking === undefined && effort === 'off')) {
    return { thinking: { type: 'disabled' } }
  }
  return { thinking: { type: 'enabled' }, reasoning_effort: effort }
}

/** Assemble the OpenAI chat/completions request body. Optional fields are omitted, never null. */
export async function serializeRequestOpenAI(
  ctx: Context,
  options: GenerateOptions,
  profile: TuiProviderProfile,
  signal: AbortSignal | undefined,
): Promise<Record<string, unknown>> {
  const tools = options.tools?.map((tool) => ({
    type: 'function' as const,
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }))
  // Effort-capable models carry their reasoning level on the wire: the harness
  // materializes the route default before streaming, so
  // `options.reasoningEffort` is normally set; a direct caller without one
  // falls back to the resolved route default. A model that declares no efforts
  // never receives effort fields.
  const declared = effortsFor(options.provider, profile, options.model)
  const effort = options.reasoningEffort === undefined
    ? (declared.length > 0 ? resolveDefaultEffort(profile, declared) : undefined)
    : options.reasoningEffort
  if (effort !== undefined && declared.length === 0) {
    throw new LlmError(
      `model "${options.model}" does not support reasoning effort "${effort}"`,
      'UNSUPPORTED_REASONING_EFFORT',
    )
  }
  const effortEntry = effort === undefined ? undefined : declared.find((candidate) => candidate.id === effort)
  return {
    model: options.model,
    messages: await serializeMessagesOpenAI(ctx, options.messages, options.system, signal),
    stream: true,
    stream_options: { include_usage: true },
    ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.maxTokens === undefined ? {} : { [profile.maxTokensField ?? 'max_tokens']: options.maxTokens }),
    ...(options.stop !== undefined ? { stop: options.stop } : {}),
    ...(effort === undefined ? {} : reasoningEffortWire(effortEntry, effort)),
  }
}

/** Assemble the Anthropic Messages request body (`max_tokens` is mandatory). */
function serializeRequestAnthropic(
  options: GenerateOptions,
  systemText: string | undefined,
  messages: readonly AnthropicWireMessage[],
  maxTokens: number,
): Record<string, unknown> {
  const tools = options.tools?.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }))
  return {
    model: options.model,
    max_tokens: maxTokens,
    ...(systemText !== undefined ? { system: systemText } : {}),
    messages,
    stream: true,
    ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.stop !== undefined && options.stop.length > 0 ? { stop_sequences: options.stop } : {}),
  }
}

/** Assemble the OpenAI Responses request body (input array + tools + stream).
 *  The Responses wire format differs from chat/completions: a flat `input`
 *  item array (role + content parts), `tools` as bare {type,name,description,
 *  parameters}, and `max_output_tokens`. */
export async function serializeRequestResponses(
  ctx: Context,
  options: GenerateOptions,
  signal: AbortSignal | undefined,
): Promise<Record<string, unknown>> {
  const wire = await serializeMessagesOpenAI(ctx, options.messages, options.system, signal)
  const input: Record<string, unknown>[] = []
  for (const message of wire) {
    if (message.role === 'system') {
      input.push({ role: 'system', content: [{ type: 'input_text', text: stringifyContent(message.content) }] })
    } else if (message.role === 'user') {
      input.push({ role: 'user', content: userContentToResponses(message.content) })
    } else if (message.role === 'assistant') {
      const content: Record<string, unknown>[] = []
      const text = stringifyContent(message.content)
      if (text !== '') content.push({ type: 'output_text', text })
      for (const call of message.tool_calls ?? []) {
        content.push({
          type: 'function_call',
          call_id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        })
      }
      input.push({ role: 'assistant', content })
    } else if (message.role === 'tool') {
      input.push({
        role: 'user',
        content: [{
          type: 'function_call_output',
          call_id: message.tool_call_id,
          output: stringifyContent(message.content) || '(no output)',
        }],
      })
    }
  }
  const tools = options.tools?.map((tool) => ({
    type: 'function' as const,
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }))
  return {
    model: options.model,
    input,
    stream: true,
    ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.maxTokens === undefined ? {} : { max_output_tokens: options.maxTokens }),
    ...(options.stop !== undefined && options.stop.length > 0 ? { stop: options.stop } : {}),
  }
}

/** Flatten a wire message's content to its text (parts may include images). */
function stringifyContent(content: WireMessage['content']): string {
  if (typeof content === 'string') return content
  return content.filter((part) => part.type === 'text').map((part) => (part as WireTextPart).text).join('')
}

/** Map wire user content (text/image parts) to Responses input parts. */
function userContentToResponses(content: WireMessage['content']): Record<string, unknown>[] {
  const parts = typeof content === 'string' ? [{ type: 'text' as const, text: content }] : content
  return parts.map((part) => {
    if (part.type === 'text') return { type: 'input_text', text: part.text }
    return { type: 'input_image', image_url: part.image_url.url }
  })
}

/** One Google Generative Language wire part. */
interface GooglePart {
  text?: string
  inlineData?: { mimeType: string; data: string }
  functionCall?: { name: string; args: unknown }
  functionResponse?: { name: string; response: unknown }
}

/** One Google Generative Language content item (roles are `user`/`model`). */
interface GoogleContent {
  role: 'user' | 'model'
  parts: GooglePart[]
}

/**
 * Serialize the conversation for the Google Generative Language API: the
 * system prompt becomes the top-level `systemInstruction`, assistant tool
 * calls become `functionCall` parts, and tool results `functionResponse`
 * parts (name keyed by the harness tool-call id).
 * @param ctx - the context resolving the attachment service for image blocks.
 * @param messages - the harness conversation in order.
 * @param system - the system prompt.
 * @param signal - cancellation for image reads.
 * @returns the top-level system instruction (when any) and the content items.
 */
export async function serializeMessagesGoogle(
  ctx: Context,
  messages: readonly Message[],
  system: string | undefined,
  signal: AbortSignal | undefined,
): Promise<{ systemInstruction: string | undefined; contents: GoogleContent[] }> {
  const systemParts: string[] = []
  if (system !== undefined && system !== '') systemParts.push(system)
  const contents: GoogleContent[] = []
  for (const message of messages) {
    if (message.role === 'system') {
      const text = flattenText(message.content)
      if (text !== '') systemParts.push(text)
      continue
    }
    const parts: GooglePart[] = []
    for (const block of message.content) {
      if (block.type === 'text') {
        if (block.text !== '') parts.push({ text: block.text })
      } else if (block.type === 'image') {
        const encoded = await encodeImage(ctx, block.attachment, signal)
        if (encoded === undefined) {
          throw new LlmError('image input requires the attachment service', 'UNSUPPORTED_CONTENT')
        }
        parts.push({ inlineData: { mimeType: encoded.mediaType, data: encoded.data } })
      } else if (block.type === 'tool-call') {
        let args: unknown = {}
        try { args = JSON.parse(block.arguments) as unknown } catch { /* malformed args: send {} */ }
        parts.push({ functionCall: { name: block.name, args } })
      } else if (block.type === 'tool-result') {
        const text = flattenText(block.content)
        let response: unknown = {}
        try { response = JSON.parse(text || '{}') as unknown } catch { response = text }
        parts.push({ functionResponse: { name: block.toolCallId, response } })
      }
    }
    if (parts.length > 0) contents.push({ role: message.role === 'assistant' ? 'model' : 'user', parts })
  }
  return { systemInstruction: systemParts.length > 0 ? systemParts.join('\n\n') : undefined, contents }
}

/** Assemble the Google Generative Language request body. */
function serializeRequestGoogle(
  options: GenerateOptions,
  systemInstruction: string | undefined,
  contents: readonly GoogleContent[],
): Record<string, unknown> {
  const tools = options.tools !== undefined && options.tools.length > 0
    ? [{ functionDeclarations: options.tools.map((tool) => ({
        name: tool.name,
        ...(tool.description !== undefined ? { description: tool.description } : {}),
        ...(tool.parameters !== undefined ? { parameters: tool.parameters } : {}),
      })) }]
    : undefined
  return {
    contents,
    ...(systemInstruction !== undefined ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
    ...(tools !== undefined ? { tools } : {}),
    generationConfig: {
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.maxTokens !== undefined ? { maxOutputTokens: options.maxTokens } : {}),
      ...(options.stop !== undefined && options.stop.length > 0 ? { stopSequences: options.stop } : {}),
    },
  }
}

/** One SSE `data:` payload from the Anthropic Messages stream. */
interface AnthropicSseEvent {
  type: string
  index?: number
  content_block?: { type?: string; id?: string; name?: string }
  delta?: { type?: string; text?: string; partial_json?: string; thinking?: string; stop_reason?: string }
  usage?: { input_tokens?: number; output_tokens?: number }
  error?: { type?: string; message?: string }
  message?: { usage?: { input_tokens?: number; output_tokens?: number } }
}

/** Map an Anthropic `stop_reason` to the harness vocabulary. */
function mapAnthropicFinish(reason: string): FinishReason {
  switch (reason) {
    case 'tool_use':
      return { kind: 'tool-calls' }
    case 'max_tokens':
      return { kind: 'max-tokens' }
    default:
      return { kind: 'stop' }
  }
}

/**
 * Translate Anthropic Messages SSE events into harness `StreamChunk`s. Block
 * indexes are the provider's own `content_block` indexes; text/thinking/tool
 * blocks map to text/reasoning/tool-call chunks, and `usage`/`finish` are
 * emitted once at the stream end.
 */
async function* translateAnthropic(source: AsyncIterable<AnthropicSseEvent>): AsyncIterable<StreamChunk> {
  const open = new Map<number, { type: 'text' | 'reasoning' | 'tool-call'; id?: string; name?: string; arguments?: string; text?: string }>()
  let pendingUsage: TokenUsage | undefined
  let finish: FinishReason = { kind: 'stop' }
  for await (const event of source) {
    switch (event.type) {
      case 'message_start': {
        const usage = event.message?.usage
        if (usage?.input_tokens !== undefined) {
          pendingUsage = { inputTokens: usage.input_tokens, outputTokens: 0 }
        }
        break
      }
      case 'content_block_start': {
        const block = event.content_block
        if (block === undefined || event.index === undefined) break
        if (block.type === 'text') {
          open.set(event.index, { type: 'text' })
          yield { type: 'block-start', index: event.index, blockType: 'text' }
        } else if (block.type === 'thinking') {
          open.set(event.index, { type: 'reasoning' })
          yield { type: 'block-start', index: event.index, blockType: 'reasoning' }
        } else if (block.type === 'tool_use') {
          const entry = { type: 'tool-call' as const, id: block.id, name: block.name, arguments: '' }
          open.set(event.index, entry)
          yield {
            type: 'tool-call-delta',
            index: event.index,
            id: ToolCallId(block.id ?? ''),
            ...(block.name !== undefined ? { name: block.name } : {}),
            argumentsDelta: '',
          }
        }
        break
      }
      case 'content_block_delta': {
        if (event.index === undefined || event.delta === undefined) break
        const delta = event.delta
        if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text !== '') {
          if (!open.has(event.index)) {
            open.set(event.index, { type: 'text', text: '' })
            yield { type: 'block-start', index: event.index, blockType: 'text' }
          }
          const entry = open.get(event.index)!
          entry.text = (entry.text ?? '') + delta.text
          yield { type: 'text-delta', index: event.index, text: delta.text }
        } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking !== '') {
          if (!open.has(event.index)) {
            open.set(event.index, { type: 'reasoning', text: '' })
            yield { type: 'block-start', index: event.index, blockType: 'reasoning' }
          }
          const entry = open.get(event.index)!
          entry.text = (entry.text ?? '') + delta.thinking
          yield { type: 'reasoning-delta', index: event.index, text: delta.thinking }
        } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          const entry = open.get(event.index)
          if (entry !== undefined) entry.arguments = (entry.arguments ?? '') + delta.partial_json
          yield {
            type: 'tool-call-delta',
            index: event.index,
            id: ToolCallId(entry?.id ?? ''),
            ...(entry?.name !== undefined ? { name: entry.name } : {}),
            argumentsDelta: delta.partial_json,
          }
        }
        break
      }
      case 'content_block_stop': {
        if (event.index === undefined) break
        const entry = open.get(event.index)
        if (entry === undefined) break
        if (entry.type === 'text') {
          yield { type: 'block-end', index: event.index, block: { type: 'text', text: entry.text ?? '' } }
        } else if (entry.type === 'reasoning') {
          yield { type: 'block-end', index: event.index, block: { type: 'reasoning', text: entry.text ?? '' } }
        } else {
          yield {
            type: 'block-end',
            index: event.index,
            block: { type: 'tool-call', id: ToolCallId(entry.id ?? ''), name: entry.name ?? '', arguments: entry.arguments ?? '' },
          }
        }
        break
      }
      case 'message_delta': {
        if (event.delta?.stop_reason !== undefined && event.delta.stop_reason !== '') {
          finish = mapAnthropicFinish(event.delta.stop_reason)
        }
        if (event.usage?.output_tokens !== undefined) {
          pendingUsage = {
            ...(pendingUsage ?? { inputTokens: 0, outputTokens: 0 }),
            outputTokens: event.usage.output_tokens,
          }
        }
        break
      }
      case 'error': {
        const detail = event.error?.message ?? event.error?.type ?? 'anthropic stream error'
        throw new LlmError(detail, 'PROVIDER_ERROR')
      }
      default:
        // Other events (ping, message_stop) carry no content.
        break
    }
  }
  if (pendingUsage !== undefined) yield { type: 'usage', usage: pendingUsage }
  yield { type: 'finish', reason: finish }
}

/** Map the wire `finish_reason` to the harness vocabulary. */
function mapFinishReason(reason: string | undefined): FinishReason {
  switch (reason) {
    case 'tool_calls':
    case 'function_call':
      return { kind: 'tool-calls' }
    case 'length':
      return { kind: 'max-tokens' }
    default:
      return { kind: 'stop' }
  }
}

/** Map wire usage; DeepSeek-style `prompt_tokens` includes cache hits, so subtract them. */
function mapUsage(usage: NonNullable<WireChunk['usage']>): TokenUsage {
  const cacheRead = usage.prompt_tokens_details?.cached_tokens
  const reasoning = usage.completion_tokens_details?.reasoning_tokens
  const prompt = usage.prompt_tokens ?? 0
  const completion = usage.completion_tokens ?? 0
  return {
    inputTokens: prompt - (cacheRead ?? 0),
    outputTokens: completion,
    totalTokens: prompt + completion,
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
  }
}

/** Parse an SSE body into wire chunks. */
async function* parseSse<T>(body: ReadableStream<Uint8Array>): AsyncIterable<T> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const data = trimmed.slice(5).trim()
        if (data === '[DONE]') return
        try {
          yield JSON.parse(data) as T
        } catch {
          // A malformed SSE payload is not a request failure; skip the line.
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * Translate wire chunks into harness `StreamChunk`s. Block indexes: text 0,
 * reasoning 1, tool calls 2+. `block-end`/`usage`/`finish` are deferred to the
 * stream end so no chunk ever follows `finish`.
 */
async function* translate(source: AsyncIterable<WireChunk>): AsyncIterable<StreamChunk> {
  const open = new Map<number, { type: 'text' | 'reasoning' | 'tool-call'; id?: string; name?: string; arguments?: string; text?: string }>()
  let nextToolIndex = 2
  let pendingUsage: TokenUsage | undefined
  let finish: FinishReason = { kind: 'stop' }
  for await (const chunk of source) {
    if (chunk.error !== undefined) {
      const detail = chunk.error.message ?? chunk.error.type ?? 'provider stream error'
      throw new LlmError(detail, typeof chunk.error.code === 'string' && chunk.error.code !== ''
        ? chunk.error.code
        : 'PROVIDER_ERROR')
    }
    const choice = chunk.choices?.[0]
    if (choice === undefined) {
      if (chunk.usage != null) pendingUsage = mapUsage(chunk.usage)
      continue
    }
    const delta = choice.delta ?? {}
    // Providers emit `content: null` / `reasoning_content: null` on empty
    // deltas; only a real string may open or extend a block.
    if (typeof delta.content === 'string' && delta.content !== '') {
      if (!open.has(0)) {
        open.set(0, { type: 'text', text: '' })
        yield { type: 'block-start', index: 0, blockType: 'text' }
      }
      const entry = open.get(0)!
      entry.text = (entry.text ?? '') + delta.content
      yield { type: 'text-delta', index: 0, text: delta.content }
    }
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '') {
      if (!open.has(1)) {
        open.set(1, { type: 'reasoning', text: '' })
        yield { type: 'block-start', index: 1, blockType: 'reasoning' }
      }
      const entry = open.get(1)!
      entry.text = (entry.text ?? '') + delta.reasoning_content
      yield { type: 'reasoning-delta', index: 1, text: delta.reasoning_content }
    }
    for (const part of delta.tool_calls ?? []) {
      const index = part.index !== undefined ? part.index + 2 : nextToolIndex
      const id = typeof part.id === 'string' && part.id !== '' ? ToolCallId(part.id) : undefined
      const deltaArguments = typeof part.function?.arguments === 'string' ? part.function.arguments : ''
      const deltaName = typeof part.function?.name === 'string' ? part.function.name : undefined
      const entryId = typeof part.id === 'string' ? part.id : undefined
      let entry = open.get(index)
      if (entry === undefined) {
        entry = { type: 'tool-call', id: entryId, name: deltaName, arguments: deltaArguments }
        open.set(index, entry)
        // The assembler keys tool arguments to a tool-call BLOCK: without the
        // block-start marker the deltas have no block to land on.
        yield { type: 'block-start', index, blockType: 'tool-call' }
        yield {
          type: 'tool-call-delta',
          index,
          id: id ?? ToolCallId(''),
          ...(deltaName !== undefined ? { name: deltaName } : {}),
          argumentsDelta: deltaArguments,
        }
      } else {
        entry.arguments = (entry.arguments ?? '') + deltaArguments
        yield {
          type: 'tool-call-delta',
          index,
          id: id ?? ToolCallId(entry.id ?? ''),
          ...(deltaName !== undefined ? { name: deltaName } : {}),
          argumentsDelta: deltaArguments,
        }
      }
      if (index >= nextToolIndex) nextToolIndex = index + 1
    }
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      finish = mapFinishReason(choice.finish_reason)
    }
    if (chunk.usage != null) pendingUsage = mapUsage(chunk.usage)
  }
  for (const [index, entry] of open) {
    if (entry.type === 'text') yield { type: 'block-end', index, block: { type: 'text', text: entry.text ?? '' } }
    else if (entry.type === 'reasoning') yield { type: 'block-end', index, block: { type: 'reasoning', text: entry.text ?? '' } }
    else yield { type: 'block-end', index, block: { type: 'tool-call', id: ToolCallId(entry.id ?? ''), name: entry.name ?? '', arguments: entry.arguments ?? '' } }
  }
  if (pendingUsage !== undefined) yield { type: 'usage', usage: pendingUsage }
  yield { type: 'finish', reason: finish }
}

/** One SSE `data:` payload from an OpenAI Responses stream. */
interface ResponsesSseEvent {
  type: string
  delta?: string | null
  output_index?: number
  item?: { type?: string; id?: string; call_id?: string; name?: string }
  response?: {
    status?: string
    output?: readonly { type?: string; call_id?: string; name?: string; arguments?: string }[]
    usage?: {
      input_tokens?: number | null
      output_tokens?: number | null
      input_tokens_details?: { cached_tokens?: number } | null
      output_tokens_details?: { reasoning_tokens?: number } | null
    } | null
  }
  error?: { message?: string; code?: string; type?: string }
}

/**
 * Translate OpenAI Responses SSE events into harness `StreamChunk`s. Block
 * indexes follow the chat/completions convention (text 0, reasoning 1, tool
 * calls 2+, keyed by the event's `output_index`). Function-call items open on
 * `response.output_item.added`; argument deltas accumulate until
 * `response.completed` carries the final output + usage.
 */
export async function* translateResponses(source: AsyncIterable<ResponsesSseEvent>): AsyncIterable<StreamChunk> {
  const open = new Map<number, { type: 'text' | 'reasoning' | 'tool-call'; id?: string; name?: string; arguments?: string; text?: string }>()
  let nextToolIndex = 2
  let pendingUsage: TokenUsage | undefined
  let finish: FinishReason = { kind: 'stop' }
  for await (const event of source) {
    if (event.error !== undefined) {
      const detail = event.error.message ?? event.error.type ?? 'responses stream error'
      throw new LlmError(detail, typeof event.error.code === 'string' && event.error.code !== '' ? event.error.code : 'PROVIDER_ERROR')
    }
    switch (event.type) {
      case 'response.output_item.added': {
        const item = event.item
        if (item?.type === 'function_call') {
          const index = event.output_index !== undefined ? event.output_index + 2 : nextToolIndex
          if (index >= nextToolIndex) nextToolIndex = index + 1
          const entry = { type: 'tool-call' as const, id: item.call_id, name: item.name, arguments: '' }
          open.set(index, entry)
          yield { type: 'block-start', index, blockType: 'tool-call' }
          yield {
            type: 'tool-call-delta',
            index,
            id: ToolCallId(item.call_id ?? ''),
            ...(item.name !== undefined ? { name: item.name } : {}),
            argumentsDelta: '',
          }
        }
        break
      }
      case 'response.output_text.delta': {
        const text = event.delta ?? ''
        if (text === '') break
        if (!open.has(0)) {
          open.set(0, { type: 'text', text: '' })
          yield { type: 'block-start', index: 0, blockType: 'text' }
        }
        const entry = open.get(0)!
        entry.text = (entry.text ?? '') + text
        yield { type: 'text-delta', index: 0, text }
        break
      }
      case 'response.reasoning_text.delta':
      case 'response.reasoning_summary_text.delta': {
        const text = event.delta ?? ''
        if (text === '') break
        if (!open.has(1)) {
          open.set(1, { type: 'reasoning', text: '' })
          yield { type: 'block-start', index: 1, blockType: 'reasoning' }
        }
        const entry = open.get(1)!
        entry.text = (entry.text ?? '') + text
        yield { type: 'reasoning-delta', index: 1, text }
        break
      }
      case 'response.function_call_arguments.delta': {
        const delta = event.delta ?? ''
        if (delta === '') break
        const index = event.output_index !== undefined ? event.output_index + 2 : nextToolIndex
        let entry = open.get(index)
        if (entry === undefined) {
          entry = { type: 'tool-call', id: undefined, name: undefined, arguments: delta }
          open.set(index, entry)
          yield { type: 'block-start', index, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index, id: ToolCallId(''), argumentsDelta: delta }
        } else {
          entry.arguments = (entry.arguments ?? '') + delta
          yield {
            type: 'tool-call-delta',
            index,
            id: ToolCallId(entry.id ?? ''),
            ...(entry.name !== undefined ? { name: entry.name } : {}),
            argumentsDelta: delta,
          }
        }
        break
      }
      case 'response.completed': {
        const usage = event.response?.usage
        if (usage != null) {
          const cacheRead = usage.input_tokens_details?.cached_tokens
          const reasoning = usage.output_tokens_details?.reasoning_tokens
          const input = usage.input_tokens ?? 0
          const output = usage.output_tokens ?? 0
          pendingUsage = {
            inputTokens: input - (cacheRead ?? 0),
            outputTokens: output,
            totalTokens: input + output,
            ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
            ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
          }
        }
        const output = event.response?.output ?? []
        if (output.some((item) => item.type === 'function_call')) finish = { kind: 'tool-calls' }
        else if (event.response?.status === 'incomplete') finish = { kind: 'max-tokens' }
        else finish = { kind: 'stop' }
        break
      }
      default:
        // response.created / in_progress / output_text.done / function_call_arguments.done
        // carry no content.
        break
    }
  }
  for (const [index, entry] of open) {
    if (entry.type === 'text') yield { type: 'block-end', index, block: { type: 'text', text: entry.text ?? '' } }
    else if (entry.type === 'reasoning') yield { type: 'block-end', index, block: { type: 'reasoning', text: entry.text ?? '' } }
    else yield { type: 'block-end', index, block: { type: 'tool-call', id: ToolCallId(entry.id ?? ''), name: entry.name ?? '', arguments: entry.arguments ?? '' } }
  }
  if (pendingUsage !== undefined) yield { type: 'usage', usage: pendingUsage }
  yield { type: 'finish', reason: finish }
}

/** One SSE `data:` payload from a Google `streamGenerateContent` stream. */
interface GoogleSseEvent {
  candidates?: readonly {
    content?: { parts?: readonly ({ text?: string } | { functionCall?: { name?: string; args?: unknown } })[] }
    finishReason?: string
  }[]
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    cachedContentTokenCount?: number
    totalTokenCount?: number
  }
  error?: { message?: string; code?: number; status?: string }
}

/** Map a Google `finishReason` to the harness vocabulary. */
function mapGoogleFinish(reason: string | undefined): FinishReason {
  switch (reason) {
    case 'MAX_TOKENS':
      return { kind: 'max-tokens' }
    case 'TOOL_CALL':
      return { kind: 'tool-calls' }
    default:
      // STOP / SAFETY / RECITATION / BLOCKLIST / PROHIBITED_CONTENT all end the turn.
      return { kind: 'stop' }
  }
}

/**
 * Translate Google `streamGenerateContent` SSE frames into harness
 * `StreamChunk`s. Text parts stream into block 0; `functionCall` parts open a
 * tool-call block per call (Google delivers the full arguments object in one
 * frame; a synthetic `fc-N` id stands in for the missing call id). Usage and
 * finish are emitted once at the stream end.
 */
export async function* translateGoogle(source: AsyncIterable<GoogleSseEvent>): AsyncIterable<StreamChunk> {
  const open = new Map<number, { type: 'text' | 'reasoning' | 'tool-call'; id?: string; name?: string; arguments?: string; text?: string }>()
  let nextToolIndex = 2
  let synthetic = 0
  let pendingUsage: TokenUsage | undefined
  let finish: FinishReason = { kind: 'stop' }
  for await (const event of source) {
    if (event.error !== undefined) {
      throw new LlmError(event.error.message ?? event.error.status ?? 'google stream error', 'PROVIDER_ERROR')
    }
    const usage = event.usageMetadata
    if (usage !== undefined) {
      const input = usage.promptTokenCount ?? 0
      const output = usage.candidatesTokenCount ?? 0
      pendingUsage = {
        inputTokens: input,
        outputTokens: output,
        totalTokens: usage.totalTokenCount ?? (input + output),
        ...(usage.cachedContentTokenCount !== undefined && usage.cachedContentTokenCount > 0
          ? { cacheReadTokens: usage.cachedContentTokenCount }
          : {}),
      }
    }
    const candidate = event.candidates?.[0]
    if (candidate === undefined) continue
    for (const part of candidate.content?.parts ?? []) {
      if ('text' in part && typeof part.text === 'string' && part.text !== '') {
        if (!open.has(0)) {
          open.set(0, { type: 'text', text: '' })
          yield { type: 'block-start', index: 0, blockType: 'text' }
        }
        const entry = open.get(0)!
        entry.text = (entry.text ?? '') + part.text
        yield { type: 'text-delta', index: 0, text: part.text }
      } else if ('functionCall' in part && part.functionCall !== undefined) {
        const index = nextToolIndex++
        const id = `fc-${synthetic++}`
        const argumentsText = JSON.stringify(part.functionCall.args ?? {})
        open.set(index, { type: 'tool-call', id, name: part.functionCall.name, arguments: argumentsText })
        yield { type: 'block-start', index, blockType: 'tool-call' }
        yield {
          type: 'tool-call-delta',
          index,
          id: ToolCallId(id),
          ...(part.functionCall.name !== undefined ? { name: part.functionCall.name } : {}),
          argumentsDelta: argumentsText,
        }
      }
    }
    if (candidate.finishReason !== undefined && candidate.finishReason !== '') {
      finish = mapGoogleFinish(candidate.finishReason)
    }
  }
  for (const [index, entry] of open) {
    if (entry.type === 'text') yield { type: 'block-end', index, block: { type: 'text', text: entry.text ?? '' } }
    else if (entry.type === 'reasoning') yield { type: 'block-end', index, block: { type: 'reasoning', text: entry.text ?? '' } }
    else yield { type: 'block-end', index, block: { type: 'tool-call', id: ToolCallId(entry.id ?? ''), name: entry.name ?? '', arguments: entry.arguments ?? '' } }
  }
  if (pendingUsage !== undefined) yield { type: 'usage', usage: pendingUsage }
  yield { type: 'finish', reason: finish }
}

/** The adapter: one OpenAI-compatible route set, registered under `ctx.llm`. */
class TuiLlmAdapter extends LlmAdapter {
  constructor(
    private readonly ctx: Context,
    private readonly resolve: () => Map<string, TuiProviderProfile>,
  ) {
    super()
  }

  override providerInfo(provider: string): { id: string; name: string } {
    const profile = this.resolve().get(provider)
    return { id: provider, name: profile?.displayName ?? provider }
  }

  /** The merged template directory (core + plugin-registered), read live so a
   *  sibling plugin's additions apply without a restart. */
  private templates(): readonly TuiProviderTemplate[] {
    return (this.ctx.get('tuiLlmTemplates') as { list(): readonly TuiProviderTemplate[] } | undefined)?.list() ?? []
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const profile = this.resolve().get(provider)
    // A template route activated by env key alone (no settings profile yet)
    // still serves models: fall back to the template's endpoint and catalog.
    // Likewise a hand-written profile with no `models` list (Anthropic routes
    // have no /models endpoint to probe) degrades to the template's catalog.
    const template = this.templates().find((t) => t.route === provider)
    const effective = profile ?? template
    const catalog = effective?.models !== undefined && effective.models.length > 0 ? effective : template
    const staticModels = providerModels(catalog).map((model) => ({
      provider,
      id: model.id,
      name: model.name ?? model.id,
      ...(model.inputModalities !== undefined ? { inputModalities: model.inputModalities } : {}),
    }))
    // Live catalog first: OpenAI-compatible gateways enumerate their real model
    // list via GET {baseURL}/models (OpenCode Zen/Go serve 60+/30+ models while
    // the template carries a small sample). Anthropic-protocol routes stay on
    // the static catalog. Failures (no /models endpoint, auth, timeout) degrade
    // to the static catalog without surfacing.
    if (effective !== undefined && (effective.api ?? 'openai-completions') !== 'anthropic-messages') {
      const dynamic = await fetchDynamicModels(effective.baseURL)
      if (dynamic !== undefined) {
        // A modelsApi route is multi-protocol: every family routes to a wire
        // protocol at stream time, so the live catalog is NOT filtered (a
        // stale profile may still carry include/exclude lists from an older
        // template — the template's modelsApi semantics win).
        const multiProtocol = template?.modelsApi !== undefined
        const ids = multiProtocol
          ? dynamic
          : filterDynamicModels(dynamic, {
              include: effective.includeModelPrefixes,
              exclude: effective.excludeModelPrefixes,
            })
        if (ids.length > 0) {
          const byId = new Map(staticModels.map((m) => [m.id, m]))
          return ids.map((id) => {
            const known = byId.get(id)
            return {
              provider,
              id,
              name: known?.name ?? id,
              ...(known?.inputModalities !== undefined ? { inputModalities: known.inputModalities } : {}),
            }
          })
        }
      }
    }
    return staticModels
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const profile = this.resolve().get(provider)
    const template = this.templates().find((t) => t.route === provider)
    const effective = profile ?? template
    const entry = providerModels(effective).find((candidate) => candidate.id === model)
    // Effort-capable models advertise their levels + route default to the
    // harness, which then validates explicit efforts and materializes the
    // default into every request before this adapter streams it.
    const reasoning = modelReasoning(effective, provider, model)
    return {
      provider,
      id: model,
      name: entry?.name ?? model,
      ...(entry?.contextWindow !== undefined ? { context: { contextWindow: entry.contextWindow } } : {}),
      ...(entry?.maxTokens !== undefined ? { defaultMaxTokens: entry.maxTokens } : {}),
      ...(entry?.inputModalities !== undefined ? { inputModalities: entry.inputModalities } : {}),
      ...(reasoning === undefined ? {} : {
        reasoning: {
          efforts: reasoning.efforts.map((effort) => ({
            id: ReasoningEffortId(effort.id),
            name: effort.name,
            ...(effort.description === undefined ? {} : { description: effort.description }),
          })),
          defaultEffort: ReasoningEffortId(reasoning.defaultEffort),
        },
      }),
    }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    try {
      // One resolution per stream call: profile and key freeze here and hold for
      // this whole request, so an in-flight stream never observes a change.
      // A template route without a settings profile (activated by env/credential
      // key alone) resolves through its template — same endpoint, auth env, and
      // protocol the directory advertised.
      const profile = this.resolve().get(options.provider)
        ?? this.templates().find((t) => t.route === options.provider)
      if (profile === undefined) {
        throw new LlmError(`provider route "${options.provider}" is not configured`, 'UNKNOWN_PROVIDER')
      }
      // A multi-protocol gateway (modelsApi) routes each model family to its
      // own wire protocol + endpoint at stream time; everything else uses the
      // route's defaults. The wire profile freezes here for this request.
      const modelApi = resolveModelApi(profile, options.model)
      const wireProfile = modelApi.api !== undefined || modelApi.baseURL !== undefined
        ? { ...profile, api: modelApi.api ?? profile.api, baseURL: modelApi.baseURL ?? profile.baseURL }
        : profile
      const apiKey = await resolveApiKey(this.ctx, options.provider, profile.apiKeyEnv)
      // Image input is a per-model capability: refuse it before any wire request.
      if (hasImages(options.messages)) {
        const entry = profile.models?.find((model) => model.id === options.model)
        if (entry?.inputModalities?.includes('image') !== true) {
          throw new LlmError(
            `model "${options.model}" does not accept image input`,
            'UNSUPPORTED_CONTENT',
          )
        }
      }
      const wire = wireProfile.api === 'anthropic-messages'
        ? this.streamAnthropic(options, wireProfile, apiKey)
        : wireProfile.api === 'openai-responses'
          ? this.streamResponses(options, wireProfile, apiKey)
          : wireProfile.api === 'google-generative'
            ? this.streamGoogle(options, wireProfile, apiKey)
            : this.streamOpenAI(options, wireProfile, apiKey)
      // Manual `/compact` summaries are ordinary LLM requests on the session's
      // own route, tagged `purpose: 'compaction'` by the harness. Counting
      // their streamed output is what lets the TUI show real progress for the
      // one long phase of a compaction; every other request passes through
      // untouched (`tapCompaction` is not even constructed).
      if (options.purpose === 'compaction') yield* this.tapCompaction(options, wire)
      else yield* wire
    } catch (error) {
      // Agent loops treat a stream failure as a terminal outcome and can stay
      // silent about it; surface the failure in the log AND on the status line
      // so a "no response" is never a black box. The log write is file-only:
      // the stderr mirror would print the line onto the terminal at the input
      // row, which the UI status line already covers.
      try { logErrorFileOnly('llm', error) } catch { /* best-effort */ }
      try {
        const store = this.ctx.get('tuiStore') as
          | { append?(kind: string, text: string, dim?: boolean): void; appendRunError?(text: string): void }
          | undefined
        const message = error instanceof Error ? error.message : String(error)
        // A request the USER aborted (Esc on a compaction, Ctrl+C on a turn) is
        // not a run failure: the raw fetch error ("The operation was aborted.")
        // would land as a red turn-error row for something the reader just
        // asked for. Keep it in the log, keep it off the transcript.
        if (options.signal?.aborted === true) {
          // logged above; nothing to show
        } else if (store?.appendRunError !== undefined) {
          // Web turn-error parity: an error-colored run-failure row.
          store.appendRunError(message)
        } else {
          store?.append?.('status', `llm error: ${message}`, false)
        }
      } catch { /* best-effort */ }
      throw error
    }
  }

  /** Forward one compaction-summary stream while reporting its growing output.
   *
   *  The status bar wants "how much summary has been written", not a fake
   *  percentage: text deltas are accumulated and turned into an ESTIMATED token
   *  count with the harness's own meter (throttled — the estimator is a
   *  heuristic and re-running it per delta would be busywork), and a provider
   *  `usage` chunk, when one arrives, replaces the estimate with the real
   *  number. `options.maxTokens` (the harness's summarization budget) becomes
   *  the honest denominator.
   *  @param options - the summarization request (carries `purpose`/`maxTokens`).
   *  @param wire - the underlying wire stream.
   *  @returns the same chunks, unmodified. */
  private async *tapCompaction(
    options: GenerateOptions,
    wire: AsyncIterable<StreamChunk>,
  ): AsyncIterable<StreamChunk> {
    let text = ''
    let lastEstimateAt = 0
    let reported = 0
    const report = (tokens: number, estimated: boolean): void => {
      try {
        const store = this.ctx.get('tuiStore') as
          | { noteCompactionTokens?(tokens: number, estimated: boolean, budget?: number): void }
          | undefined
        store?.noteCompactionTokens?.(tokens, estimated, options.maxTokens)
      } catch { /* best-effort: progress is never worth failing a request */ }
    }
    for await (const chunk of wire) {
      if (chunk.type === 'text-delta') {
        text += chunk.text
        const now = Date.now()
        if (now - lastEstimateAt >= 400) {
          lastEstimateAt = now
          const estimated = this.estimateTokens(text)
          if (estimated !== undefined && estimated > reported) {
            reported = estimated
            report(estimated, true)
          }
        }
      } else if (chunk.type === 'usage') {
        const out = chunk.usage.outputTokens
        if (typeof out === 'number' && out > reported) {
          reported = out
          report(out, false)
        }
      }
      yield chunk
    }
  }

  /** Estimated output tokens for streamed text, via the harness's own meter
   *  (undefined when the service is absent — a partially-booted context). */
  private estimateTokens(text: string): number | undefined {
    try {
      const meter = this.ctx.get('tokenMeter') as
        | { estimateMessage?(message: Message): number }
        | undefined
      return meter?.estimateMessage?.({
        role: 'assistant',
        content: [{ type: 'text', text }],
      } as Message)
    } catch {
      return undefined
    }
  }

  /** Google Generative Language request: `POST {baseURL}/models/{model}:streamGenerateContent?alt=sse`
   *  with `x-goog-api-key` auth (the OpenCode Zen Gemini endpoint uses exactly
   *  this Google wire shape — verified: `:generateContent` + `x-goog-api-key`
   *  are recognized). */
  private async *streamGoogle(
    options: GenerateOptions,
    profile: TuiProviderProfile,
    apiKey: string,
  ): AsyncIterable<StreamChunk> {
    const { systemInstruction, contents } = await serializeMessagesGoogle(this.ctx, options.messages, options.system, options.signal)
    const body = serializeRequestGoogle(options, systemInstruction, contents)
    const headers: Record<string, string> = {
      'x-goog-api-key': apiKey,
      'content-type': 'application/json',
      'accept': 'text/event-stream',
      ...attributionHeaders(),
    }
    const response = await this.fetchOrThrow(
      `${profile.baseURL}/models/${encodeURIComponent(options.model)}:streamGenerateContent?alt=sse`,
      headers,
      body,
      options,
    )
    if (response.body === null) {
      throw new LlmError('provider returned no response body', 'EMPTY_RESPONSE')
    }
    yield* translateGoogle(parseSse<GoogleSseEvent>(response.body))
  }

  /** OpenAI Responses request: `POST {baseURL}/responses` with Bearer auth. */
  private async *streamResponses(
    options: GenerateOptions,
    profile: TuiProviderProfile,
    apiKey: string,
  ): AsyncIterable<StreamChunk> {
    const body = await serializeRequestResponses(this.ctx, options, options.signal)
    const headers: Record<string, string> = {
      'authorization': `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'accept': 'text/event-stream',
      ...attributionHeaders(),
    }
    const response = await this.fetchOrThrow(`${profile.baseURL}/responses`, headers, body, options)
    if (response.body === null) {
      throw new LlmError('provider returned no response body', 'EMPTY_RESPONSE')
    }
    yield* translateResponses(parseSse<ResponsesSseEvent>(response.body))
  }

  /** OpenAI-compatible request: chat/completions with Bearer auth. */
  private async *streamOpenAI(
    options: GenerateOptions,
    profile: TuiProviderProfile,
    apiKey: string,
  ): AsyncIterable<StreamChunk> {
    const body = await serializeRequestOpenAI(this.ctx, options, profile, options.signal)
    const headers: Record<string, string> = {
      'authorization': `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'accept': 'text/event-stream',
      ...attributionHeaders(),
    }
    const response = await this.fetchOrThrow(`${profile.baseURL}/chat/completions`, headers, body, options)
    if (response.body === null) {
      throw new LlmError('provider returned no response body', 'EMPTY_RESPONSE')
    }
    yield* translate(parseSse<WireChunk>(response.body))
  }

  /** Anthropic Messages request: `/v1/messages` with `x-api-key` auth. */
  private async *streamAnthropic(
    options: GenerateOptions,
    profile: TuiProviderProfile,
    apiKey: string,
  ): AsyncIterable<StreamChunk> {
    const { systemText, messages } = await serializeMessagesAnthropic(this.ctx, options.messages, options.system, options.signal)
    const entry = profile.models?.find((model) => model.id === options.model)
    const maxTokens = options.maxTokens ?? entry?.maxTokens ?? 4096
    const body = serializeRequestAnthropic(options, systemText, messages, maxTokens)
    const headers: Record<string, string> = {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'accept': 'text/event-stream',
      ...attributionHeaders(),
    }
    const response = await this.fetchOrThrow(`${profile.baseURL}/v1/messages`, headers, body, options)
    if (response.body === null) {
      throw new LlmError('provider returned no response body', 'EMPTY_RESPONSE')
    }
    yield* translateAnthropic(parseSse<AnthropicSseEvent>(response.body))
  }

  /** POST one request and normalize transport/provider failures to LlmError. */
  private async fetchOrThrow(
    url: string,
    headers: Record<string, string>,
    body: Record<string, unknown>,
    options: GenerateOptions,
  ): Promise<Response> {
    let response: Response
    // S0 probe (session/optimization-plan.md §3): the payload string already
    // exists, so reporting its size to the app's submit probe is free — and the
    // moment this adapter is entered IS the end of the harness's synchronous
    // request assembly (prepareRequest + systemPrompt.project + buildRequest).
    const payload = JSON.stringify(body)
    const rawMessages = (body as { messages?: unknown }).messages
    // Read the probe OBJECT from globalThis (not a per-copy variable): the app
    // module can be bundler-duplicated, and the object identity is what carries
    // the state across copies.
    const probe = (globalThis as typeof globalThis & {
      __dshSubmitProbe?: { noteRequest: (bytes: number, messages: number) => void; noteFetch: () => void }
    }).__dshSubmitProbe
    probe?.noteRequest(payload.length, Array.isArray(rawMessages) ? rawMessages.length : -1)
    probe?.noteFetch() // payload built: everything after this is network + provider
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: payload,
        signal: options.signal,
      })
    } catch (error) {
      if (options.signal?.aborted) {
        throw new LlmError('request aborted by caller', 'ABORTED', { cause: error })
      }
      throw new LlmError(`request to ${url} failed`, 'TRANSPORT', { cause: error })
    }
    if (!response.ok) {
      let message = `provider error (HTTP ${response.status})`
      const raw = await response.text()
      try {
        const parsed = JSON.parse(raw) as { error?: { message?: string; code?: string; type?: string } }
        if (parsed.error?.message !== undefined && parsed.error.message !== '') message = parsed.error.message
        const code = parsed.error?.code ?? parsed.error?.type
        // Context-overflow must be classified as CONTEXT_WINDOW_EXCEEDED so the
        // harness's compaction-basic recovery (compact + retry) fires instead
        // of the request erroring as terminal and aborting the turn — web
        // parity (the standard llm-deepseek adapter does this through
        // isContextWindowExceededError). Provider wording varies
        // ("maximum context length", "input is too long for this model", ...),
        // so classify from the message, not the raw error code/type.
        const finalCode = isContextWindowExceededError(message)
          ? CONTEXT_WINDOW_EXCEEDED_CODE
          : (typeof code === 'string' && code !== '' ? code : httpErrorCode(response.status))
        throw new LlmError(message, finalCode, {
          cause: new Error(raw.length > 0 ? raw : `HTTP ${response.status}`),
          status: response.status,
        })
      } catch (error) {
        if (error instanceof LlmError) throw error
        throw new LlmError(
          message,
          isContextWindowExceededError(message) ? CONTEXT_WINDOW_EXCEEDED_CODE : httpErrorCode(response.status),
          {
            cause: new Error(raw.length > 0 ? raw : `HTTP ${response.status}`),
            status: response.status,
          },
        )
      }
    }
    return response
  }
}

/** Map an HTTP status to a stable harness error code. */
function httpErrorCode(status: number): string {
  if (status === 401 || status === 403) return 'UNAUTHORIZED'
  if (status === 429) return 'RATE_LIMITED'
  if (status === 404) return 'NOT_FOUND'
  if (status >= 500) return 'SERVER_ERROR'
  return 'BAD_REQUEST'
}

/** The configurable-provider directory: templates (core + plugin-registered)
 *  plus configured routes. */
function directoryEntries(
  profiles: Map<string, TuiProviderProfile>,
  templates: readonly TuiProviderTemplate[],
): LlmConfigurableProvider[] {
  const entries = new Map<string, LlmConfigurableProvider>()
  for (const template of templates) {
    entries.set(template.route, {
      provider: template.route,
      displayName: template.name,
      settingsNs: TUI_LLM_NS,
      settingsPath: ['providers', template.route],
      declared: false,
    })
  }
  for (const [route, profile] of profiles) {
    if (route === DEEPSEEK_OFFICIAL_ROUTE) continue // built-in, not a configurable addition
    entries.set(route, {
      provider: route,
      displayName: profile.displayName ?? route,
      settingsNs: TUI_LLM_NS,
      settingsPath: ['providers', route],
      declared: true,
    })
  }
  return [...entries.values()]
}

/** Register the adapter and directory, re-registering live on settings changes. */
export function apply(ctx: Context): void {
  const settings = ctx.get('settings') as {
    register(ns: unknown, schema: unknown, options?: unknown): SettingsScope<unknown>
    get(ns: unknown): unknown
    describe(): { ns: string; user?: unknown }[]
  } | undefined
  const llm = ctx.get('llm') as {
    registerAdapter(providers: readonly string[], adapter: LlmAdapter): { replace(providers: readonly string[]): void }
    registerConfigurableProviders(entries: readonly LlmConfigurableProvider[]): { replace(entries: readonly LlmConfigurableProvider[]): void }
  } | undefined
  if (settings === undefined || llm === undefined) return
  const scope = registerWithLegacy(settings, TUI_LLM_NS, TUI_LLM_LEGACY_NS, TuiLlmSchema as never)
  const section = (): TuiLlmSection => (scope.get() as TuiLlmSection | undefined) ?? {}
  const profiles = (): Map<string, TuiProviderProfile> => effectiveProviders(section())
  // The template directory is extensible: sibling plugins (e.g.
  // tui-opencode-gateways) register extra templates through this service,
  // which merges them with the core catalog. Every consumer — the adapter's
  // fallbacks, the directory, the adapter routes, and the /models dialog —
  // reads the merged list, so loading a plugin adds its providers app-wide.
  // A plugin switched OFF can also HIDE its routes (template or a
  // user-configured settings profile), so the whole feature unloads from the
  // UI and the adapter, not just the built-in templates.
  const extraTemplates: TuiProviderTemplate[] = []
  const hiddenRoutes = new Set<string>()
  let adapterReg: { replace(providers: readonly string[]): void } | undefined
  let directoryReg: { replace(entries: readonly LlmConfigurableProvider[]): void } | undefined
  const reRegister = (): void => {
    adapterReg?.replace(adapterRoutes())
    directoryReg?.replace(directoryEntries(profiles(), templateService.list()))
  }
  const templateService = {
    add(templates: readonly TuiProviderTemplate[]): void {
      const known = new Set(extraTemplates.map((t) => t.route))
      for (const template of templates) {
        if (known.has(template.route)) continue
        extraTemplates.push(template)
        known.add(template.route)
      }
      reRegister()
    },
    list(): readonly TuiProviderTemplate[] {
      return [...PROVIDER_TEMPLATES, ...extraTemplates].filter((t) => !hiddenRoutes.has(t.route))
    },
    /** Mark routes as unloaded (plugin disabled): they leave the adapter, the
     *  directory, and the /models list even when a settings profile exists. */
    hideRoutes(routes: readonly string[]): void {
      for (const route of routes) hiddenRoutes.add(route)
      reRegister()
    },
    hiddenRoutes(): readonly string[] { return [...hiddenRoutes] },
  }
  ctx.provide('tuiLlmTemplates', templateService)
  // Every provider the adapter can serve: the configured routes (built-in
  // deepseek-official + settings profiles) plus ALL template routes, so a
  // template route with an env/credential key alone is already serviceable —
  // its stream/listModels/resolveModel fall back to the template profile.
  // Hidden (unloaded) routes are excluded everywhere.
  const adapterRoutes = (): string[] => {
    const routes = new Set<string>([...profiles().keys()])
    for (const template of templateService.list()) routes.add(template.route)
    for (const route of hiddenRoutes) routes.delete(route)
    return [...routes]
  }
  const adapter = new TuiLlmAdapter(ctx, profiles)
  adapterReg = llm.registerAdapter(adapterRoutes(), adapter)
  directoryReg = llm.registerConfigurableProviders(directoryEntries(profiles(), templateService.list()))
  // Live reload: a settings edit (web or hand-written) re-registers routes and
  // the directory without a restart.
  scope.watch(() => {
    reRegister()
  })
}
