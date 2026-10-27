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
 * @module @qialike/qialike-app/llm
 */

import { Context } from '@deepseek-ai/cordis'
import { onSectionChange, readSection, resolveBeeEnabled } from './config.ts'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { logErrorFileOnly } from './log.ts'
import { effortsFor } from './effort-catalog.ts'
import providerTemplatesData from './provider-templates.json' with { type: 'json' }
import keyUrlsData from './key-urls.json' with { type: 'json' }
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
  type RequestMessage,
  type TokenUsage,
  type FinishReason,
} from '@deepseek-ai/dsh-llm'

/** Stable Cordis plugin name. */
export const name = 'tui-llm'

/** Services required before adapter registration can run. */
export const inject = ['credentials', 'llm']

/** Identifier the provider directory reports for these profiles; the values
 *  themselves live at `qialike.json`'s `llm` key since 0.1.7 (which removed the
 *  harness's runtime settings namespaces — see `config.ts`). */
export const TUI_LLM_NS = 'qialike-llm'

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
    // model whose whole point is vision).
    //
    // THE LIMITS ARE THE OFFICIAL ENDPOINT'S, not a rounded "1M". Measured 2026-10-27
    // against `api.deepseek.com/models`:
    //     context_window: 1048576     max_output_tokens: 393216
    // The rows used to say 1_000_000 / 256_000 — the harness's `DEFAULT_CONTEXT_WINDOW`
    // and `DEFAULT_MAX_TOKENS`, which are round approximations, and which disagree with
    // the harness's OWN `DEFAULT_MODELS` (`OFFICIAL_CONTEXT_WINDOW = 1_048_576`, labelled
    // "as the official `/models` listing declares it"). Being 4.6% low on the context
    // only mattered when the probe failed, but the 35% low output ceiling was a real cap
    // on every request until the parser learned `max_output_tokens`.
    { id: 'deepseek-flash', name: 'DeepSeek-V41-Flash', contextWindow: 1048576, maxTokens: 393216, inputModalities: ['text', 'image'], reasoningEfforts: REASONING_EFFORTS },
    { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', contextWindow: 1048576, maxTokens: 393216, reasoningEfforts: REASONING_EFFORTS },
    { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', contextWindow: 1048576, maxTokens: 393216, reasoningEfforts: REASONING_EFFORTS },
    { id: 'deepseek-v4-flash-vision-exp', name: 'DeepSeek V4 Flash Vision Exp', contextWindow: 1048576, maxTokens: 393216, inputModalities: ['text', 'image'], reasoningEfforts: REASONING_EFFORTS },
  ],
}

/** Route key of the built-in DeepSeek provider. */
export const DEEPSEEK_OFFICIAL_ROUTE = 'deepseek-official'

/**
 * Route key of **QiaLike Bee**, qialike's own model gateway
 * (`https://qialike.com/bee/v1`).
 *
 * NAMED AFTER THE PRODUCT, like every other row in the catalogue: `alibaba-cn`,
 * `opencode-zen`, `moonshotai-cn`. It was `qialike` through 0.11.3 — a route key
 * that read like the program rather than a provider, and that made
 * `--model qialike/<id>` look like a path inside qialike instead of a provider
 * pick. 0.11.4 renamed it; `qialike` is no longer reserved.
 *
 * It is a template row like any other provider — the row in
 * `provider-templates.json` carries the endpoint, the `QIALIKE_API_KEY`
 * credential reference and the model catalogue — but the gateway serves FOUR
 * wire protocols under one key, so the row also carries a `modelsApi` map (the
 * same mechanism OpenCode Zen uses). Bee's published endpoints decide it:
 *
 *   claude-*  → Anthropic Messages (`x-api-key`; root baseURL so the appended
 *               `/v1/messages` lands on `/bee/v1/messages`)
 *   qwen*     → Anthropic Messages (Bee fronts Qwen that way, not via chat)
 *   gpt-*     → OpenAI Responses (`/bee/v1/responses`)
 *   gemini-*  → Google generateContent (`/bee/v1/models/<id>:…`)
 *   the rest  → chat/completions (the route default, `/bee/v1/chat/completions`)
 *
 * Because the row is multi-protocol the adapter shows Bee's live
 * `GET /bee/v1/models` catalogue unfiltered: every family it lists has a wire
 * route. The TUI treats these routes as qialike-owned — always listed in
 * `/models` (even before a key is set, so the dialog can ask for one), never
 * deactivatable with `Ctrl+D`. See `PROTECTED_PROVIDER_ROUTES` in `index.tsx`
 * and `listConfigured` in `models.ts`.
 *
 * TWO ROWS, ONE PRODUCT. Bee runs two independent deployments — `qialike.com`
 * (international) and `qialike.cn` (mainland) — with their own consoles, key
 * stores and catalogues; a key issued by one answers `Invalid API key` on the
 * other. They are therefore two rows, the same way `alibaba` and `alibaba-cn`
 * are, and each carries its own `apiKeyEnv` so a user can hold both keys at once.
 */
export const QIALIKE_BEE_ROUTE = 'qialike-bee'

/** Route key of Bee's mainland deployment (`https://qialike.cn/bee/v1`). */
export const QIALIKE_BEE_CN_ROUTE = 'qialike-bee-cn'

/**
 * Every route qialike owns, in catalogue order.
 *
 * One list, not two literals: the switch that hides Bee (`hiddenRoutes`), the
 * dialog's never-removable set, the keyless-but-listed flag and the reserved
 * name all have to agree, and they agree by reading this.
 */
export const QIALIKE_BEE_ROUTES: readonly string[] = [QIALIKE_BEE_ROUTE, QIALIKE_BEE_CN_ROUTE]

/**
 * Headers every streaming provider request carries.
 *
 * `accept-encoding: identity` is not a preference, it is a correctness
 * requirement. A gateway behind nginx (Bee is one) is free to compress a
 * `text/event-stream` body when the client advertises support — and the
 * runtime's `fetch` advertises `zstd` on its own. Bee answers with a zstd body
 * (magic `28 b5 2f fd`) while the `content-encoding` header is gone by the time
 * the app sees the response, so nothing decodes it: no line starts with
 * `data:`, the turn ends with an empty assistant message and the screen shows
 * nothing at all. Asking for identity keeps the bytes exactly as the provider
 * wrote them — SSE is already a streaming format, so compression buys nothing
 * a reader can use anyway.
 *
 * Attribution stays: it is the harness's own contract (`attributionHeaders()`),
 * and omitting it would misreport the client.
 * @returns the header set to merge into a provider request.
 */
function wireHeaders(): Record<string, string> {
  return { 'accept-encoding': 'identity', ...attributionHeaders() }
}

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
  // The explicit type annotation on the CONST (not just the arrow's return type) is
  // what makes TypeScript treat a `fail(...)` call as a control-flow terminator, so
  // the `if (typeof baseURL !== 'string') fail(...)` below narrows `baseURL` to
  // `string`. Without it the narrowing silently does not happen.
  const fail: (index: number, reason: string) => never = (index, reason) => {
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
    // A row with no endpoint and no prompt activates a route that cannot work. The
    // adapter builds its URL by appending the protocol path to `baseURL`, so an empty
    // value sends `fetch()` a relative URL — which throws before any network call and
    // surfaces as `request to /chat/completions failed`, naming neither the provider
    // nor the missing endpoint. `needsBaseURL` is the one way an empty value is right:
    // the Add-provider flow then asks for the endpoint instead of activating it.
    if (baseURL.trim() === '' && needsBaseURL !== true) {
      fail(
        index,
        `baseURL is empty and needsBaseURL is not set — the route would activate with a relative `
        + 'URL and every request would fail. Give the endpoint, or set needsBaseURL to make the '
        + 'Add-provider flow ask for one.',
      )
    }
    if (baseURL.trim() !== '' && !/^https?:\/\/[^\s]+$/iu.test(baseURL)) {
      fail(index, `baseURL "${baseURL}" is not an absolute http(s) URL`)
    }
    // `anthropic-messages` appends `/v1/messages`, so a baseURL that already ends in a
    // version segment produces `/v1/v1/messages`: a 404 the provider reports as such,
    // with nothing pointing back at the template row.
    if (api === 'anthropic-messages' && /\/v\d+[a-z]*\/?$/iu.test(baseURL)) {
      fail(index, `baseURL "${baseURL}" already ends in a version segment, and the anthropic-messages protocol appends "/v1/messages" — use the root endpoint instead`)
    }
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

/**
 * Timeout for the `/models` probe on the DIALOG path; a slow gateway degrades to the
 * static catalog.
 *
 * SIZED FROM MEASUREMENT, not guessed. The 14 catalogue gateways that answer a
 * `/models` probe were timed from this host: the slowest (minimax) took 1.03 s, and
 * everything else landed between 0.13 s (deepseek) and 0.97 s (Bee `.com`). 1.5 s
 * therefore covers every gateway observed to serve, with 45% headroom — while the old
 * 4 s only ever bought patience for gateways that were not going to answer.
 *
 * The dialog is the one place a user is deliberately looking at the list, so it gets
 * the longer budget. The request path does not — see {@link MODEL_LIMITS_TIMEOUT}.
 */
const DYNAMIC_MODELS_TIMEOUT = 1_500

/**
 * Timeout for the same probe when it is consulted to fill in a model's LIMITS
 * (`resolveModel`), i.e. while a request is being assembled.
 *
 * DELIBERATELY SHORTER. A failure here costs nothing a user can see: the limits simply
 * come from the static catalog instead of the endpoint. Spending 4 s — or even 1.5 s —
 * of a request's latency to maybe refine a context window is not a trade worth making,
 * so this budget only covers a gateway that answers promptly (13 of the 14 measured
 * gateways answer in under 1 s; the one that does not keeps its static limits).
 */
const MODEL_LIMITS_TIMEOUT = 800

/**
 * Why a probe produced no catalog.
 *
 * `undefined` used to be the only answer, which made "this gateway has no `/models`"
 * indistinguishable from "it did not answer in time" — and the dialog could not tell a
 * genuinely short list from one it failed to refresh. The dialog reports a timeout;
 * the request path ignores both.
 */
export type DynamicModelsFailure = 'timeout' | 'unavailable'

/**
 * The per-model metadata a gateway's `/models` endpoint can report.
 *
 * WHY THE ID LIST IS NOT ENOUGH. A live list answers "which models exist", but the
 * harness also needs "how big is this model and what can it take" — `contextWindow`,
 * `maxTokens`, `inputModalities` — to size requests, enforce the image gate and report
 * limits. Those live in the *static* catalog, so a model the snapshot never saw was
 * advertised by the endpoint yet resolved with no limits at all, and every model in
 * the snapshot carried whatever ceiling it had on the day the snapshot was taken.
 *
 * All fields optional: a gateway that reports only ids stays supported, and each
 * consumer falls back to the static catalog per field rather than per entry.
 */
export interface DynamicModelInfo {
  readonly id: string
  readonly name?: string
  readonly contextWindow?: number
  readonly maxTokens?: number
  readonly inputModalities?: readonly ('text' | 'image')[]
}

/**
 * Cached gateway catalogs, keyed by the endpoint root AND whether the probe was
 * authenticated (shared across routes).
 *
 * `models: undefined` is a cached FAILURE, not an absent entry. That distinction is
 * load-bearing: `resolveModel` consults the probe on the request path, so an endpoint
 * that is down or slow would otherwise cost the full timeout on every single request.
 *
 * WHY THE KEY IS PART OF THE CACHE KEY. Most gateways return 401 to an anonymous
 * `/models` (measured: 40 of the 54 routes with a resolvable baseURL), and the first
 * look at a provider usually happens BEFORE its key is stored — the Add-provider list
 * is what prompts for one. Sharing one cache slot would let that early anonymous 401
 * mask the authenticated answer for the whole TTL, so the two are kept apart. The
 * credential itself never enters the key: a boolean says "authenticated", which is all
 * the cache needs to know.
 */
const dynamicModelsCache = new Map<
  string,
  { at: number; models: readonly DynamicModelInfo[] | undefined; failure?: DynamicModelsFailure }
>()

/** Cache key for one endpoint: root plus whether the probe carried a credential. */
const dynamicModelsCacheKey = (root: string, authenticated: boolean): string =>
  `${authenticated ? 'auth' : 'anon'}:${root}`

/**
 * How long a FAILED probe is remembered.
 *
 * Shorter than {@link DYNAMIC_MODELS_TTL} on purpose: a gateway that was briefly
 * unreachable should be retried soon, but not once per request. Without this the
 * request path paid {@link DYNAMIC_MODELS_TIMEOUT} every time — the failure was
 * never the thing being cached.
 */
const DYNAMIC_MODELS_FAILURE_TTL = 30_000

/** Read a finite positive number, or undefined. Gateways are inconsistent about types. */
const positiveNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined

/**
 * Read one gateway entry's metadata.
 *
 * FIELD NAMES ARE THE OPENAI-STYLE ONES WHERE THEY EXIST, plus the two OpenRouter
 * actually serves (`architecture.input_modalities`, `top_provider.max_completion_tokens`).
 * Unknown shapes yield a bare id rather than an error: this is a catalogue probe, and
 * a gateway that changes its schema should lose the extra fields, not the model list.
 *
 * @param entry - one element of the endpoint's `data` array.
 * @returns the metadata it carries, always with an id.
 */
function dynamicModelInfo(entry: unknown): DynamicModelInfo | undefined {
  if (entry === null || typeof entry !== 'object') return undefined
  const row = entry as {
    id?: unknown
    name?: unknown
    context_length?: unknown
    context_window?: unknown
    top_provider?: { max_completion_tokens?: unknown } | undefined
    /** DeepSeek's own spelling of the output ceiling (OpenRouter uses `top_provider`). */
    max_output_tokens?: unknown
    architecture?: { input_modalities?: unknown } | undefined
    /** DeepSeek also states the input modalities at the TOP level, not under `architecture`. */
    input_modalities?: unknown
  }
  const id = typeof row.id === 'string' ? row.id : ''
  if (id === '') return undefined

  const name = typeof row.name === 'string' && row.name !== '' ? row.name : undefined
  // TWO GATEWAY DIALECTS, one parser. Every field is read in both spellings because a
  // live catalogue is the truth about what the endpoint serves, and half-reading it
  // silently substitutes the static table:
  //   OpenRouter / Bee  context_length | context_window · top_provider.max_completion_tokens · architecture.input_modalities
  //   DeepSeek official context_window                        · max_output_tokens                       · input_modalities
  // Measured 2026-10-27 against `api.deepseek.com/models`: it reports
  // `context_window: 1048576`, `max_output_tokens: 393216`, top-level
  // `input_modalities`. Before these two fallbacks existed the probe returned
  // `maxTok=undefined` for BOTH official models, so every request was capped by the
  // static 256_000 while the API allowed 393_216.
  const contextWindow = positiveNumber(row.context_length) ?? positiveNumber(row.context_window)
  const maxTokens = positiveNumber(row.top_provider?.max_completion_tokens)
    ?? positiveNumber(row.max_output_tokens)

  let inputModalities: readonly ('text' | 'image')[] | undefined
  const rawModalities = row.architecture?.input_modalities ?? row.input_modalities
  if (Array.isArray(rawModalities)) {
    const tagged = rawModalities.filter(
      (m): m is 'text' | 'image' => m === 'text' || m === 'image',
    )
    // Only meaningful when the endpoint names at least one modality we model.
    if (tagged.length > 0) inputModalities = [...new Set(tagged)]
  }

  return {
    id,
    ...(name === undefined ? {} : { name }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(inputModalities === undefined ? {} : { inputModalities }),
  }
}

/**
 * Probe an OpenAI-compatible gateway's live model catalog (`GET {baseURL}/models`,
 * the standard OpenAI list endpoint — OpenCode Zen/Go, OpenRouter, DeepSeek …
 * all serve it; some gateways expose it without auth, e.g. Zen). Returns the
 * catalog with whatever metadata the endpoint reports, or `undefined` when the
 * endpoint is missing/unauthorized/slow, so callers fall back to the static
 * profile catalog.
 *
 * BOTH OUTCOMES ARE CACHED, with different lifetimes: a successful catalog for
 * {@link DYNAMIC_MODELS_TTL}, a failure for {@link DYNAMIC_MODELS_FAILURE_TTL}. Caching
 * the failure is what keeps `resolveModel` cheap on the request path — see
 * {@link dynamicModelsCache}.
 *
 * @param baseURL - the route's endpoint root; `/models` is appended.
 * @param apiKey - the route's credential, when one is configured.
 * @param timeoutMs - budget for this probe. The dialog passes
 *   {@link DYNAMIC_MODELS_TIMEOUT}, the request path {@link MODEL_LIMITS_TIMEOUT};
 *   they differ because only the dialog's wait is something a user is watching.
 * @returns the catalogue with whatever metadata the endpoint reports, or `undefined`
 *   when it is missing/unauthorized/slow — callers fall back to the static catalog.
 */
export async function fetchDynamicModelInfo(
  baseURL: string,
  apiKey?: string,
  timeoutMs: number = DYNAMIC_MODELS_TIMEOUT,
): Promise<readonly DynamicModelInfo[] | undefined> {
  const root = baseURL.replace(/\/+$/, '')
  // A credential changes the ANSWER, not just the odds of getting one: an anonymous
  // probe of a gateway that requires auth is a 401, while the same request with the
  // key returns the catalogue. Caching them together would let the early anonymous
  // failure hide the authenticated list for the whole TTL — see {@link dynamicModelsCache}.
  const authenticated = apiKey !== undefined && apiKey !== ''
  const cacheKey = dynamicModelsCacheKey(root, authenticated)
  const hit = dynamicModelsCache.get(cacheKey)
  if (hit !== undefined) {
    const ttl = hit.models === undefined ? DYNAMIC_MODELS_FAILURE_TTL : DYNAMIC_MODELS_TTL
    if (Date.now() - hit.at < ttl) return hit.models
  }
  try {
    // OpenAI-compatible gateways expect `Bearer`. Anthropic-protocol routes never reach
    // here (the caller skips them: they have no `/models`), so one scheme is enough.
    // `accept-encoding: identity` for the same reason {@link wireHeaders} carries it:
    // a gateway that compresses with a codec the runtime advertises but cannot decode
    // would otherwise answer 200 with a body `response.json()` cannot read.
    const headers: Record<string, string> = { accept: 'application/json', 'accept-encoding': 'identity' }
    if (authenticated) headers.authorization = `Bearer ${apiKey}`
    const response = await fetch(`${root}/models`, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) {
      dynamicModelsCache.set(cacheKey, { at: Date.now(), models: undefined, failure: 'unavailable' })
      return undefined
    }
    const body = (await response.json()) as { data?: readonly unknown[] } | undefined
    const models: DynamicModelInfo[] = []
    const seen = new Set<string>()
    for (const entry of body?.data ?? []) {
      const info = dynamicModelInfo(entry)
      if (info === undefined || seen.has(info.id)) continue
      seen.add(info.id)
      models.push(info)
    }
    if (models.length === 0) {
      dynamicModelsCache.set(cacheKey, { at: Date.now(), models: undefined, failure: 'unavailable' })
      return undefined
    }
    dynamicModelsCache.set(cacheKey, { at: Date.now(), models })
    return models
  } catch (error) {
    // A TIMEOUT is reported separately from every other failure: it is the one the
    // dialog can act on ("this gateway is slow — the list below is the cached one"),
    // while a 404/401 is simply "this endpoint does not serve a catalog".
    //
    // Matched by NAME, not `instanceof DOMException`: the identity of that constructor
    // is not guaranteed across the runtime the binary actually ships on (a compiled
    // Bun binary resolves globals differently from a script under test), and a check
    // that silently stops matching would demote every timeout to `unavailable` — which
    // is exactly the distinction this field exists to carry.
    const name = (error as { name?: unknown } | null)?.name
    const timedOut = name === 'TimeoutError' || name === 'AbortError'
    dynamicModelsCache.set(cacheKey, {
      at: Date.now(),
      models: undefined,
      failure: timedOut ? 'timeout' : 'unavailable',
    })
    return undefined
  }
}

/**
 * The same probe, returning ids alone.
 *
 * Kept because it is exported and used by callers that only need the list; it reads
 * the same cache as {@link fetchDynamicModelInfo}, so the two never disagree and only
 * one request is made per TTL window.
 */
export async function fetchDynamicModels(baseURL: string): Promise<readonly string[] | undefined> {
  const models = await fetchDynamicModelInfo(baseURL)
  return models === undefined ? undefined : models.map((model) => model.id)
}

/**
 * Why the last probe for this endpoint produced no catalog, or `undefined` when it has
 * not failed (it either succeeded or was never attempted).
 *
 * Reads the same cache as {@link fetchDynamicModelInfo}, so a caller that has just
 * probed can ask "was that a timeout?" without a second request. This is what lets the
 * `/models` dialog say the list it is showing is cached because a gateway was slow,
 * instead of leaving the user to guess whether the short list is the truth.
 * @param baseURL - the route's endpoint root.
 * @param authenticated - whether the probe carried a credential (part of the cache key).
 * @returns `'timeout'` for a probe that ran out of time, `'unavailable'` for any other
 *   failure, `undefined` when the last probe succeeded or never ran.
 */
export function dynamicModelsFailure(
  baseURL: string,
  authenticated: boolean,
): DynamicModelsFailure | undefined {
  const root = baseURL.replace(/\/+$/, '')
  const hit = dynamicModelsCache.get(dynamicModelsCacheKey(root, authenticated))
  if (hit === undefined || hit.models !== undefined) return undefined
  const ttl = DYNAMIC_MODELS_FAILURE_TTL
  if (Date.now() - hit.at >= ttl) return undefined
  return hit.failure ?? 'unavailable'
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
/**
 * Where a user obtains an API key for a route, or `undefined` when we do not know.
 *
 * WHY THIS EXISTS. The Add-provider flow ends at a bare "paste your key" prompt: the
 * dialog names the provider and nothing else, so the next question ("from where?") is
 * left entirely to the user — who has to leave the TUI, find the right console page and
 * work out which of that vendor's several key types applies (a coding-plan key and a
 * pay-as-you-go key are different strings from the same vendor). One URL removes all of
 * that. Measured need: 62 routes in the catalogue, each with its own console.
 *
 * `undefined` is a deliberate answer, not a gap to paper over — a wrong URL wastes more
 * of the user's time than no URL, so routes whose page we cannot state confidently are
 * simply absent from the map and the dialog falls back to generic wording.
 * @param route - the provider route (template `route` / profile key).
 * @returns the console URL, or undefined when unknown.
 */
export function keyUrlFor(route: string): string | undefined {
  const url = (keyUrlsData as Record<string, string | undefined>)[route]
  return typeof url === 'string' && url !== '' ? url : undefined
}

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

/**
 * The same lookup, but `undefined` when no credential is configured instead of throwing.
 *
 * The catalog probe is a best-effort read that must never turn a missing key into a
 * failed dialog, so it cannot call {@link resolveApiKey} directly. Sending the key when
 * one exists is what makes the probe useful at all: of the 54 routes with a resolvable
 * baseURL, 40 answer 401 anonymously (measured 2026-10-19), so without this the
 * majority of providers could only ever show their static snapshot.
 * @param ctx - the Cordis context holding the credentials service.
 * @param route - provider route, for the fallback env name.
 * @param envName - the profile's `apiKeyEnv`.
 * @returns the key, or undefined when none is stored and none is exported.
 */
async function optionalApiKey(
  ctx: Context,
  route: string,
  envName: string | undefined,
): Promise<string | undefined> {
  try {
    return await resolveApiKey(ctx, route, envName)
  } catch {
    // MISSING_CREDENTIAL is the expected case for a provider the user has not set up
    // yet; any other failure (a broken credentials store) should degrade the same way
    // rather than break the model list.
    return undefined
  }
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
function hasImages(messages: readonly RequestMessage[]): boolean {
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
  messages: readonly RequestMessage[],
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
    // 0.1.7 models a tool RESULT as its own message (`role: 'tool'`), not as a
    // `tool-result` content block carried by the user/assistant message, so it
    // becomes one wire message here instead of being filtered out of `content`.
    if (message.role === 'tool') {
      wire.push({
        role: 'tool',
        tool_call_id: message.toolCallId,
        content: flattenText(message.content) || '(no output)',
      })
      continue
    }
    const parts = await userContentParts(ctx, message, signal)
    if (parts.length > 0) {
      wire.push({
        role: 'user',
        content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts,
      })
    }
  }
  return wire
}

/** One user message's text/image content parts (OpenAI). */
async function userContentParts(
  ctx: Context,
  message: RequestMessage,
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
  messages: readonly RequestMessage[],
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
    // Tool results are their own message in 0.1.7 (see the OpenAI path above).
    if (message.role === 'tool') {
      wire.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: message.toolCallId,
          content: flattenText(message.content) || '(no output)',
        }],
      })
      continue
    }
    // user role: text/images.
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
    if (content.length > 0) {
      wire.push({ role: 'user', content })
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
  messages: readonly RequestMessage[],
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
    if (message.role === 'tool') {
      // Tool results are their own message in 0.1.7; Gemini answers them with a
      // `functionResponse` part on a user turn (see the OpenAI/Anthropic paths).
      const text = flattenText(message.content)
      let response: unknown = {}
      try { response = JSON.parse(text || '{}') as unknown } catch { response = text }
      contents.push({ role: 'user', parts: [{ functionResponse: { name: message.toolCallId, response } }] })
      continue
    }
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

/**
 * Parse an SSE body into wire chunks.
 *
 * Exported for the wire tests: the failure it now refuses to hide (below) is a
 * transport problem that only a body-shaped stub can reproduce.
 */
export async function* parseSse<T>(body: ReadableStream<Uint8Array>): AsyncIterable<T> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  // A body that is not SSE at all — an HTML error page, or a COMPRESSED stream
  // the runtime advertised support for and then failed to decode — parses into
  // zero chunks: no line starts with `data:`, or every payload dies in the
  // JSON.parse catch below. The turn then "succeeds" with an empty assistant
  // message and NOTHING on screen, which reads as a hung app. Count both sides
  // so that one specific case (payload-shaped lines, none of them parseable)
  // becomes an error the status line can show.
  let parsed = 0
  let unparseable = 0
  let dataLines = 0
  let received = 0
  // A compressed body is not just "no data: lines" — it decodes to replacement
  // characters, which is what separates garbage from a comment-only keepalive.
  let binaryish = false
  // First few KB of decoded text, kept only to judge a body that yielded no
  // payload at all (see the guard after the loop).
  let head = ''
  let sawDone = false
  try {
    while (!sawDone) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.length
      const text = decoder.decode(value, { stream: true })
      if (text.includes('\uFFFD')) binaryish = true
      if (head.length < 4096) head += text
      buffer += text
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        dataLines++
        const data = trimmed.slice(5).trim()
        if (data === '[DONE]') { sawDone = true; break }
        let payload: T
        try {
          payload = JSON.parse(data) as T
        } catch {
          // A single malformed payload is not a request failure; skip the line
          // but remember it (see the guards after the loop).
          unparseable++
          continue
        }
        parsed++
        yield payload
      }
    }
  } finally {
    reader.releaseLock()
  }
  if (parsed === 0 && unparseable > 0) {
    throw new LlmError(
      `provider stream carried ${unparseable} unparseable payload(s) and no usable chunk — the body is compressed or not server-sent events`,
      'PROVIDER_ERROR',
    )
  }
  // Bytes arrived but not one of them was an SSE field: a compressed body (the
  // runtime strips `content-encoding` when it *claims* to have decoded), an HTML
  // error page, or a proxy's own envelope. An honestly empty stream — comments
  // only, or a bare `data: [DONE]` — is SSE-shaped and stays a quiet empty
  // answer, so the judgement is "is this body an SSE document at all".
  if (parsed === 0 && unparseable === 0 && dataLines === 0 && received > 0) {
    const lines = head.split('\n').map((line) => line.trim()).filter((line) => line !== '')
    const sseShaped = lines.every((line) => line.startsWith(':') || /^[a-z]+:/i.test(line))
    if (!sseShaped) {
      throw new LlmError(
        binaryish
          ? `provider returned ${received} undecodable byte(s) — the stream body is compressed and the runtime did not decode it`
          : `provider returned ${received} byte(s) that are not server-sent events — the body is compressed or an error page`,
        'PROVIDER_ERROR',
      )
    }
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
/**
 * The limits Bee's `/models` UNDER-DECLARES for the DeepSeek family, with the
 * evidence for each number.
 *
 * Bee fronts DeepSeek (`providers: [{ id: "deepseek", model: "deepseek-chat" }]` in its
 * own `models.json`), and every DeepSeek official model reports
 * `context_window: 1048576`, `max_output_tokens: 393216`. Bee publishes `1000000` and
 * `256000` — the same round approximations the harness carries as
 * `DEFAULT_CONTEXT_WINDOW` / `DEFAULT_MAX_TOKENS` — even though the schema comment on
 * its own `contextWindow` field says "⚠️ 必须真实 … 报小了则会过早压缩上下文".
 *
 * MEASURED, 2026-10-27, through Bee itself: `max_tokens: 393216` is accepted and
 * `393217` is rejected with "Error from provider (DeepSeek): … the valid range of
 * max_tokens is [1, 393216]". So the real ceiling is the official one and Bee applies
 * no cap of its own — the declaration is simply stale. The context window is the same
 * upstream model, so it is the official 1048576.
 *
 * WHY A FLOOR AND NOT A REPLACEMENT: `Math.max`. The moment Bee fixes its catalogue
 * (its template in `site-code/deploy/models.example.json` already carries the corrected
 * numbers), the reported value wins on its own and this table stops mattering — so it
 * cannot rot into a wrong override. It is also keyed to the DeepSeek family only: a Bee
 * route that later fronts `claude-*` or `gpt-*` keeps whatever those endpoints declare.
 */
const BEE_UNDER_DECLARED: { readonly contextWindow: number; readonly maxTokens: number } = {
  contextWindow: 1_048_576,
  maxTokens: 393_216,
}

/** The floor that applies to one route/model pair, or `undefined` when none does.
 *  @param provider - the route key.
 *  @param model - the model id on that route.
 *  @returns the DeepSeek limits when this is a Bee route serving a DeepSeek model. */
function beeUnderDeclaredFloor(
  provider: string,
  model: string,
): { contextWindow: number; maxTokens: number } | undefined {
  if (!QIALIKE_BEE_ROUTES.includes(provider)) return undefined
  if (!model.toLowerCase().startsWith('deepseek')) return undefined
  return BEE_UNDER_DECLARED
}

/** Raise a limit to a floor, keeping whatever is larger.
 *  @param value - the limit resolved from the endpoint or the static catalog.
 *  @param floor - the minimum this route/model is known to support.
 *  @returns the larger of the two, or `undefined` when neither is known. */
function raisedTo(value: number | undefined, floor: number | undefined): number | undefined {
  if (floor === undefined) return value
  if (value === undefined) return floor
  return Math.max(value, floor)
}

class TuiLlmAdapter extends LlmAdapter {
  /**
   * The outcome of the last `/models` probe per route, as this ADAPTER saw it.
   *
   * WHY THE ADAPTER HAS TO REMEMBER IT. `models.ts` used to ask the module-level
   * `dynamicModelsFailure()` — and that silently returned nothing, because the plugins
   * are separate bundles: the `tui-models` bundle carries its OWN copy of this file,
   * with its own `dynamicModelsCache`. The probe ran in the `tui-llm` bundle and wrote
   * that bundle's cache; the reader looked in the other one and always saw an empty map
   * (verified against a packaged binary: two `dynamicModelsFailure` definitions, two
   * caches). A service reached through `ctx` is bundle-independent, so the outcome
   * travels with the adapter instance the dialog actually talks to.
   */
  private readonly probeOutcomes = new Map<string, DynamicModelsFailure>()

  constructor(
    private readonly ctx: Context,
    private readonly resolve: () => Map<string, TuiProviderProfile>,
  ) {
    super()
  }

  /** The last probe outcome for a route: `'timeout'` means the list shown is the
   *  static catalog because the gateway did not answer in the dialog's budget. */
  lastProbeFailure(route: string): DynamicModelsFailure | undefined {
    return this.probeOutcomes.get(route)
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
    //
    // ONLY A PROVIDER THE USER HAS A KEY FOR IS PROBED — and that is not an optimisation of a
    // path that already worked, it is what keeps the model list responsive at all.
    //
    // `buildModelCatalog` calls `listModels` for EVERY registered provider (62 in the packaged
    // build) and this loop probed each one over the network whether or not a credential
    // existed. A gateway with no key eventually answers 401; an unreachable or slow one costs
    // the full probe budget, and the whole list waits for the slowest.
    // Measured on a packaged build before the key gate: 4,041 ms for the set — vercel-ai-gateway
    // 4,038, nvidia 4,035, sakana 3,648, openrouter 3,512 — so the total was the timeout, not the
    // gateways. That is the "loading models" wait on every cold start and every 5-minute TTL expiry.
    //
    // Without a key there is nothing to learn from the endpoint anyway: a live catalogue is
    // useful because it is the truth about what THAT ACCOUNT can call. No key, no account, so
    // the static catalogue is not a degraded fallback here — it is the correct answer.
    const probeKey = effective !== undefined && (effective.api ?? 'openai-completions') !== 'anthropic-messages'
      ? await optionalApiKey(this.ctx, provider, effective.apiKeyEnv)
      : undefined
    if (probeKey !== undefined && effective !== undefined) {
      // The DIALOG budget: this is the list the user asked to see, so a slow gateway
      // gets the longer timeout. The outcome is recorded on the adapter (not just in the
      // module cache) so the dialog can ask this instance why the list is short.
      const dynamic = await fetchDynamicModelInfo(effective.baseURL, probeKey, DYNAMIC_MODELS_TIMEOUT)
      if (dynamic === undefined) {
        const reason = dynamicModelsFailure(effective.baseURL, true)
        if (reason !== undefined) this.probeOutcomes.set(provider, reason)
        else this.probeOutcomes.delete(provider)
      } else {
        this.probeOutcomes.delete(provider)
      }
      if (dynamic !== undefined) {
        // A modelsApi route is multi-protocol: every family routes to a wire
        // protocol at stream time, so the live catalog is NOT filtered (a
        // stale profile may still carry include/exclude lists from an older
        // template — the template's modelsApi semantics win).
        const multiProtocol = template?.modelsApi !== undefined
        const ids = multiProtocol
          ? dynamic.map((model) => model.id)
          : filterDynamicModels(dynamic.map((model) => model.id), {
              include: effective.includeModelPrefixes,
              exclude: effective.excludeModelPrefixes,
            })
        if (ids.length > 0) {
          const staticById = new Map(staticModels.map((m) => [m.id, m]))
          const liveById = new Map(dynamic.map((m) => [m.id, m]))
          return ids.map((id) => {
            const live = liveById.get(id)
            const known = staticById.get(id)
            // The live catalogue wins on name and modalities: it is the endpoint's
            // current answer, and the static entry may predate a modality change.
            // The static catalogue is the fallback for gateways that report ids only.
            const name = live?.name ?? known?.name ?? id
            const inputModalities = live?.inputModalities ?? known?.inputModalities
            return {
              provider,
              id,
              name,
              ...(inputModalities !== undefined ? { inputModalities } : {}),
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
    // LIMITS COME FROM THE ENDPOINT WHEN IT REPORTS THEM, and from the static catalog
    // otherwise. Without this a model the snapshot never carried resolved with no
    // context window and no output ceiling at all — it streamed, but the harness had
    // nothing to size a request against — and every model in the snapshot kept the
    // ceiling it had on the day the snapshot was taken. Measured on OpenRouter: 145 of
    // its 471 live models were absent from the snapshot (no limits), and 16 of the 326
    // present ones disagreed on contextWindow.
    //
    // Per-field fallback, not per-entry: an endpoint that reports a context window but
    // no output ceiling still contributes the one it knows.
    const live = await this.liveModelInfo(effective, model, provider)
    // …EXCEPT WHERE THE ENDPOINT UNDER-DECLARES A LIMIT WE CAN PROVE. See
    // {@link beeUnderDeclaredFloor}: Bee publishes DeepSeek's round approximations
    // while its own upstream enforces the real range, so trusting the report costs the
    // user 35% of the output budget.
    const floor = beeUnderDeclaredFloor(provider, model)
    const contextWindow = raisedTo(live?.contextWindow ?? entry?.contextWindow, floor?.contextWindow)
    const maxTokens = raisedTo(live?.maxTokens ?? entry?.maxTokens, floor?.maxTokens)
    const inputModalities = live?.inputModalities ?? entry?.inputModalities
    // Effort-capable models advertise their levels + route default to the
    // harness, which then validates explicit efforts and materializes the
    // default into every request before this adapter streams it.
    const reasoning = modelReasoning(effective, provider, model)
    return {
      provider,
      id: model,
      name: entry?.name ?? live?.name ?? model,
      ...(contextWindow !== undefined ? { context: { contextWindow } } : {}),
      ...(maxTokens !== undefined ? { defaultMaxTokens: maxTokens } : {}),
      ...(inputModalities !== undefined ? { inputModalities } : {}),
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

  /**
   * One model's entry in the route's live catalogue, or undefined.
   *
   * Guarded exactly like {@link listModels}: Anthropic-protocol routes have no
   * `/models` endpoint to ask, and a route with no base URL cannot be asked either.
   * Both fall back to the static catalog. Never throws — the probe itself already
   * converts every failure into `undefined`.
   *
   * @param effective - the profile or template the route resolves to.
   * @param model - the model id to look up.
   * @returns the live metadata, or undefined when the endpoint cannot supply it.
   */
  private async liveModelInfo(
    effective: TuiProviderProfile | undefined,
    model: string,
    provider: string,
  ): Promise<DynamicModelInfo | undefined> {
    if (effective === undefined || effective.baseURL === '') return undefined
    if ((effective.api ?? 'openai-completions') === 'anthropic-messages') return undefined
    // SAME RULE AS `listModels`: no credential, no probe. `buildModelCatalog` resolves EVERY
    // MODEL of EVERY provider through here, so leaving this one unguarded kept the whole
    // catalogue waiting on network timeouts even after the list itself was fixed — measured at
    // 1,176 ms for the set, with the cost scaling with the number of models in the slowest
    // route rather than with anything the user had configured.
    const key = await optionalApiKey(this.ctx, provider, effective.apiKeyEnv)
    if (key === undefined) return undefined
    // The REQUEST budget, not the dialog's: this runs while a request is being assembled
    // and only refines `contextWindow` / `maxTokens`. A gateway that does not answer
    // inside {@link MODEL_LIMITS_TIMEOUT} keeps its static limits — a trade nobody sees,
    // unlike making the user wait.
    const live = await fetchDynamicModelInfo(effective.baseURL, key, MODEL_LIMITS_TIMEOUT)
    if (live === undefined) return undefined
    return live.find((candidate) => candidate.id === model)
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
      // Synthesised probe, not a stored message: 0.1.7's assistant content union
      // no longer structurally overlaps a hand-built text block, so go through
      // `unknown` (the meter only reads role + text).
      return meter?.estimateMessage?.({
        role: 'assistant',
        content: [{ type: 'text', text }],
      } as unknown as Message)
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
      ...wireHeaders(),
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
      ...wireHeaders(),
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
      ...wireHeaders(),
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
      ...wireHeaders(),
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
  const llm = ctx.get('llm') as {
    registerAdapter(providers: readonly string[], adapter: LlmAdapter): { replace(providers: readonly string[]): void }
    registerConfigurableProviders(entries: readonly LlmConfigurableProvider[]): { replace(entries: readonly LlmConfigurableProvider[]): void }
  } | undefined
  if (llm === undefined) return
  const section = (): TuiLlmSection => (readSection('llm') as TuiLlmSection | undefined) ?? {}
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
  // QiaLike Bee ships ON (0.11.4). Seeding the hidden set here — rather than
  // removing the template rows — is what keeps the rows (their reserved names,
  // their keyless "ask for a key" behaviour and their Ctrl+D protection) in one
  // place, ready for the switch to turn them back on. BOTH deployments follow
  // the one switch: they are one product, and a user who turned Bee off does not
  // want the mainland row left behind.
  if (!resolveBeeEnabled()) for (const route of QIALIKE_BEE_ROUTES) hiddenRoutes.add(route)
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
  // WHY A SERVICE AND NOT A FUNCTION CALL. Every plugin in this build is its own bundle,
  // so `tui-models` holds a separate copy of this module — including a separate
  // `dynamicModelsCache`. Reading that cache from the dialog's bundle always found it
  // empty (two definitions, two caches in the packaged binary). A service reached
  // through the context is the one thing both bundles share, so the probe outcome
  // travels over it.
  ctx.provide('tuiLlmProbe', {
    /** Why the last probe for this route produced no catalogue, if it failed. */
    lastFailure(route: string): DynamicModelsFailure | undefined {
      return adapter.lastProbeFailure(route)
    },
  })
  adapterReg = llm.registerAdapter(adapterRoutes(), adapter)
  directoryReg = llm.registerConfigurableProviders(directoryEntries(profiles(), templateService.list()))
  // Live reload: an edit to `qialike.json` (hand-written, or by /models
  // activating a dormant route) re-registers routes and the directory without a
  // restart. `ctx.effect` ties the subscription to this plugin's lifetime.
  ctx.effect(() => onSectionChange('llm', reRegister))
}
