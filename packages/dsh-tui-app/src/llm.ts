/**
 * The self-hosted LLM provider layer (`tui-llm`): an OpenAI-compatible
 * multi-provider adapter that replaces the pi-ai twin (`dsh-llm-pi-ai`) in the
 * TUI composition. It owns its own provider directory (built-in templates plus
 * routes declared in the `dsh-tui-llm:` settings section), speaks one wire
 * protocol — OpenAI `chat/completions` — and registers through the same llm
 * seams the harness adapters use (`registerAdapter` +
 * `registerConfigurableProviders`), so the agent loop, the Models dialog, and
 * the session log need no changes.
 *
 * No third-party LLM SDK: requests are direct `fetch` + SSE, in the style of
 * `dsh-llm-deepseek`. Scope is deliberately OpenAI-compatible only, text-only
 * models, no response replay metadata.
 *
 * @module @yourname/dsh-tui-app/llm
 */

import { Context } from '@deepseek-ai/cordis'
import { settingsNamespace, type SettingsScope } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  LlmAdapter,
  LlmError,
  ToolCallId,
  attributionHeaders,
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

/** The `dsh-tui-llm:` settings namespace holding user provider profiles. */
export const TUI_LLM_NS = settingsNamespace('dsh-tui-llm')

/** One provider route profile as configured under `dsh-tui-llm.providers`. */
export interface TuiProviderProfile {
  /** Selector label; defaults to the route key. */
  displayName?: string
  /** Wire protocol the endpoint speaks; defaults to OpenAI-compatible. */
  api?: 'openai-completions' | 'anthropic-messages'
  /** Endpoint root; `/chat/completions` (OpenAI) or `/v1/messages` (Anthropic) is appended. */
  baseURL: string
  /** Credential reference the API key resolves through (env or the credentials store). */
  apiKeyEnv?: string
  /** Which output-cap field the endpoint reads; OpenAI-compatible only, defaults to `max_tokens`. */
  maxTokensField?: 'max_tokens' | 'max_completion_tokens'
  /** Model catalog this route serves. */
  models?: readonly TuiModelProfile[]
}

/** One model entry in a provider profile. */
export interface TuiModelProfile {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  /** Request modalities this model accepts; absent means text-only. */
  inputModalities?: readonly ('text' | 'image')[]
}

/** A built-in provider template offered by the Add-provider directory. */
export interface TuiProviderTemplate extends TuiProviderProfile {
  /** Route key the template activates. */
  route: string
  /** Human-readable provider name. */
  name: string
}

/**
 * Built-in OpenAI-compatible provider templates. Each carries the endpoint and
 * a small current-model catalog, so activating one (setting its key) yields a
 * working route immediately. The directory shows these beside the configured
 * routes, exactly like the catalog the pi-ai twin used to provide.
 */
export const PROVIDER_TEMPLATES: readonly TuiProviderTemplate[] = [
  {
    route: 'deepseek', name: 'DeepSeek',
    baseURL: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY',
    models: [
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', contextWindow: 128000, maxTokens: 8192 },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', contextWindow: 128000, maxTokens: 8192 },
      { id: 'deepseek-v4-flash-vision-exp', name: 'DeepSeek V4 Flash Vision Exp', contextWindow: 128000, maxTokens: 8192, inputModalities: ['text', 'image'] },
    ],
  },
  {
    route: 'openai', name: 'OpenAI',
    baseURL: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY',
    models: [
      { id: 'gpt-4o', name: 'GPT-4o', contextWindow: 128000, maxTokens: 16384, inputModalities: ['text', 'image'] },
      { id: 'gpt-4o-mini', name: 'GPT-4o mini', contextWindow: 128000, maxTokens: 16384, inputModalities: ['text', 'image'] },
      { id: 'gpt-4.1', name: 'GPT-4.1', contextWindow: 1047576, maxTokens: 32768, inputModalities: ['text', 'image'] },
    ],
  },
  {
    route: 'openrouter', name: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY',
    models: [
      { id: 'openrouter/auto', name: 'OpenRouter Auto', contextWindow: 128000, maxTokens: 8192, inputModalities: ['text', 'image'] },
    ],
  },
  {
    route: 'anthropic', name: 'Anthropic',
    api: 'anthropic-messages',
    baseURL: 'https://api.anthropic.com', apiKeyEnv: 'ANTHROPIC_API_KEY',
    models: [
      { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', contextWindow: 200000, maxTokens: 64000, inputModalities: ['text', 'image'] },
      { id: 'claude-opus-4-1', name: 'Claude Opus 4.1', contextWindow: 200000, maxTokens: 32000, inputModalities: ['text', 'image'] },
      { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', contextWindow: 200000, maxTokens: 32000, inputModalities: ['text', 'image'] },
    ],
  },
  {
    route: 'groq', name: 'Groq',
    baseURL: 'https://api.groq.com/openai/v1', apiKeyEnv: 'GROQ_API_KEY',
    models: [
      { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B Versatile', contextWindow: 131072, maxTokens: 8192 },
      { id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B Instant', contextWindow: 131072, maxTokens: 8192 },
    ],
  },
  {
    route: 'mistral', name: 'Mistral',
    baseURL: 'https://api.mistral.ai/v1', apiKeyEnv: 'MISTRAL_API_KEY',
    models: [
      { id: 'mistral-large-latest', name: 'Mistral Large', contextWindow: 128000, maxTokens: 8192 },
      { id: 'mistral-small-latest', name: 'Mistral Small', contextWindow: 128000, maxTokens: 8192 },
    ],
  },
  {
    route: 'together', name: 'Together',
    baseURL: 'https://api.together.xyz/v1', apiKeyEnv: 'TOGETHER_API_KEY',
    models: [
      { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', name: 'Llama 3.3 70B', contextWindow: 131072, maxTokens: 8192 },
    ],
  },
  {
    route: 'fireworks', name: 'Fireworks',
    baseURL: 'https://api.fireworks.ai/inference/v1', apiKeyEnv: 'FIREWORKS_API_KEY',
    models: [
      { id: 'accounts/fireworks/models/llama-v3p1-70b-instruct', name: 'Llama 3.1 70B', contextWindow: 131072, maxTokens: 8192 },
    ],
  },
  {
    route: 'xai', name: 'xAI',
    baseURL: 'https://api.x.ai/v1', apiKeyEnv: 'XAI_API_KEY',
    models: [
      { id: 'grok-4', name: 'Grok 4', contextWindow: 131072, maxTokens: 8192 },
      { id: 'grok-4-mini', name: 'Grok 4 mini', contextWindow: 131072, maxTokens: 8192 },
    ],
  },
  {
    route: 'cerebras', name: 'Cerebras',
    baseURL: 'https://api.cerebras.ai/v1', apiKeyEnv: 'CEREBRAS_API_KEY',
    models: [
      { id: 'llama-3.3-70b', name: 'Llama 3.3 70B', contextWindow: 131072, maxTokens: 8192 },
    ],
  },
]

/** The TUI's own provider: `deepseek-official` runs out of the box. */
const DEEPSEEK_OFFICIAL: TuiProviderProfile = {
  displayName: 'DeepSeek',
  baseURL: 'https://api.deepseek.com',
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  models: [
    { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', contextWindow: 128000, maxTokens: 8192 },
    { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', contextWindow: 128000, maxTokens: 8192 },
    { id: 'deepseek-v4-flash-vision-exp', name: 'DeepSeek V4 Flash Vision Exp', contextWindow: 128000, maxTokens: 8192 },
  ],
}

/** Route key of the built-in DeepSeek provider. */
export const DEEPSEEK_OFFICIAL_ROUTE = 'deepseek-official'

/** The `dsh-tui-llm` settings section shape. */
interface TuiLlmSection {
  providers?: Record<string, TuiProviderProfile>
}

const TuiModelSchema = z.object({
  id: z.string().required(),
  name: z.string(),
  contextWindow: z.number(),
  maxTokens: z.number(),
  inputModalities: z.array(z.union(['text', 'image'])),
})

const TuiProviderSchema = z.object({
  displayName: z.string(),
  api: z.union(['openai-completions', 'anthropic-messages']),
  baseURL: z.string().required(),
  apiKeyEnv: z.string(),
  maxTokensField: z.union(['max_tokens', 'max_completion_tokens']),
  models: z.array(TuiModelSchema),
})

const TuiLlmSchema = z.object({
  providers: z.dict(TuiProviderSchema),
})

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
      content?: string
      reasoning_content?: string
      tool_calls?: readonly {
        index?: number
        id?: string
        function?: { name?: string; arguments?: string }
      }[]
    }
    finish_reason?: string
  }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
    completion_tokens_details?: { reasoning_tokens?: number }
  }
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

/** Assemble the OpenAI chat/completions request body. Optional fields are omitted, never null. */
async function serializeRequestOpenAI(
  ctx: Context,
  options: GenerateOptions,
  profile: TuiProviderProfile,
  signal: AbortSignal | undefined,
): Promise<Record<string, unknown>> {
  const tools = options.tools?.map((tool) => ({
    type: 'function' as const,
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }))
  return {
    model: options.model,
    messages: await serializeMessagesOpenAI(ctx, options.messages, options.system, signal),
    stream: true,
    stream_options: { include_usage: true },
    ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.maxTokens === undefined ? {} : { [profile.maxTokensField ?? 'max_tokens']: options.maxTokens }),
    ...(options.stop !== undefined ? { stop: options.stop } : {}),
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
  const open = new Map<number, { type: 'text' | 'reasoning' | 'tool-call'; id?: string; name?: string }>()
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
          const entry = { type: 'tool-call' as const, id: block.id, name: block.name }
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
        if (delta.type === 'text_delta' && delta.text !== undefined && delta.text !== '') {
          if (!open.has(event.index)) {
            open.set(event.index, { type: 'text' })
            yield { type: 'block-start', index: event.index, blockType: 'text' }
          }
          yield { type: 'text-delta', index: event.index, text: delta.text }
        } else if (delta.type === 'thinking_delta' && delta.thinking !== undefined && delta.thinking !== '') {
          if (!open.has(event.index)) {
            open.set(event.index, { type: 'reasoning' })
            yield { type: 'block-start', index: event.index, blockType: 'reasoning' }
          }
          yield { type: 'reasoning-delta', index: event.index, text: delta.thinking }
        } else if (delta.type === 'input_json_delta' && delta.partial_json !== undefined) {
          const entry = open.get(event.index)
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
          yield { type: 'block-end', index: event.index, block: { type: 'text', text: '' } }
        } else if (entry.type === 'reasoning') {
          yield { type: 'block-end', index: event.index, block: { type: 'reasoning', text: '' } }
        } else {
          yield {
            type: 'block-end',
            index: event.index,
            block: { type: 'tool-call', id: ToolCallId(entry.id ?? ''), name: entry.name ?? '', arguments: '' },
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
  const open = new Map<number, { type: 'text' | 'reasoning' | 'tool-call'; id?: string; name?: string }>()
  let nextToolIndex = 2
  let pendingUsage: TokenUsage | undefined
  let finish: FinishReason = { kind: 'stop' }
  for await (const chunk of source) {
    const choice = chunk.choices?.[0]
    if (choice === undefined) {
      if (chunk.usage !== undefined) pendingUsage = mapUsage(chunk.usage)
      continue
    }
    const delta = choice.delta ?? {}
    if (delta.content !== undefined && delta.content !== '') {
      if (!open.has(0)) {
        open.set(0, { type: 'text' })
        yield { type: 'block-start', index: 0, blockType: 'text' }
      }
      yield { type: 'text-delta', index: 0, text: delta.content }
    }
    if (delta.reasoning_content !== undefined && delta.reasoning_content !== '') {
      if (!open.has(1)) {
        open.set(1, { type: 'reasoning' })
        yield { type: 'block-start', index: 1, blockType: 'reasoning' }
      }
      yield { type: 'reasoning-delta', index: 1, text: delta.reasoning_content }
    }
    for (const part of delta.tool_calls ?? []) {
      const index = part.index !== undefined ? part.index + 2 : nextToolIndex
      const id = part.id !== undefined && part.id !== '' ? ToolCallId(part.id) : undefined
      let entry = open.get(index)
      if (entry === undefined) {
        entry = { type: 'tool-call', id: part.id, name: part.function?.name }
        open.set(index, entry)
        yield {
          type: 'tool-call-delta',
          index,
          id: id ?? ToolCallId(''),
          ...(part.function?.name !== undefined ? { name: part.function.name } : {}),
          argumentsDelta: part.function?.arguments ?? '',
        }
      } else {
        yield {
          type: 'tool-call-delta',
          index,
          id: id ?? ToolCallId(entry.id ?? ''),
          ...(part.function?.name !== undefined ? { name: part.function.name } : {}),
          argumentsDelta: part.function?.arguments ?? '',
        }
      }
      if (index >= nextToolIndex) nextToolIndex = index + 1
    }
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      finish = mapFinishReason(choice.finish_reason)
    }
    if (chunk.usage !== undefined) pendingUsage = mapUsage(chunk.usage)
  }
  for (const [index, entry] of open) {
    if (entry.type === 'text') yield { type: 'block-end', index, block: { type: 'text', text: '' } }
    else if (entry.type === 'reasoning') yield { type: 'block-end', index, block: { type: 'reasoning', text: '' } }
    else yield { type: 'block-end', index, block: { type: 'tool-call', id: ToolCallId(entry.id ?? ''), name: entry.name ?? '', arguments: '' } }
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

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const profile = this.resolve().get(provider)
    return providerModels(profile).map((model) => ({
      provider,
      id: model.id,
      name: model.name ?? model.id,
      ...(model.inputModalities !== undefined ? { inputModalities: model.inputModalities } : {}),
    }))
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const profile = this.resolve().get(provider)
    const entry = providerModels(profile).find((candidate) => candidate.id === model)
    return {
      provider,
      id: model,
      name: entry?.name ?? model,
      ...(entry?.contextWindow !== undefined ? { context: { contextWindow: entry.contextWindow } } : {}),
      ...(entry?.maxTokens !== undefined ? { defaultMaxTokens: entry.maxTokens } : {}),
      ...(entry?.inputModalities !== undefined ? { inputModalities: entry.inputModalities } : {}),
    }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // One resolution per stream call: profile and key freeze here and hold for
    // this whole request, so an in-flight stream never observes a change.
    const profile = this.resolve().get(options.provider)
    if (profile === undefined) {
      throw new LlmError(`provider route "${options.provider}" is not configured`, 'UNKNOWN_PROVIDER')
    }
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
    if (profile.api === 'anthropic-messages') {
      yield* this.streamAnthropic(options, profile, apiKey)
    } else {
      yield* this.streamOpenAI(options, profile, apiKey)
    }
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
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
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
        throw new LlmError(message, typeof code === 'string' && code !== '' ? code : httpErrorCode(response.status), {
          cause: new Error(raw.length > 0 ? raw : `HTTP ${response.status}`),
          status: response.status,
        })
      } catch (error) {
        if (error instanceof LlmError) throw error
        throw new LlmError(message, httpErrorCode(response.status), {
          cause: new Error(raw.length > 0 ? raw : `HTTP ${response.status}`),
          status: response.status,
        })
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

/** The configurable-provider directory: built-in templates plus configured routes. */
function directoryEntries(profiles: Map<string, TuiProviderProfile>): LlmConfigurableProvider[] {
  const entries = new Map<string, LlmConfigurableProvider>()
  for (const template of PROVIDER_TEMPLATES) {
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
  } | undefined
  const llm = ctx.get('llm') as {
    registerAdapter(providers: readonly string[], adapter: LlmAdapter): { replace(providers: readonly string[]): void }
    registerConfigurableProviders(entries: readonly LlmConfigurableProvider[]): { replace(entries: readonly LlmConfigurableProvider[]): void }
  } | undefined
  if (settings === undefined || llm === undefined) return
  const scope = settings.register(TUI_LLM_NS, TuiLlmSchema as never, {})
  const section = (): TuiLlmSection => (scope.get() as TuiLlmSection | undefined) ?? {}
  const profiles = (): Map<string, TuiProviderProfile> => effectiveProviders(section())
  const adapter = new TuiLlmAdapter(ctx, profiles)
  const adapterReg = llm.registerAdapter([...profiles().keys()], adapter)
  const directoryReg = llm.registerConfigurableProviders(directoryEntries(profiles()))
  // Live reload: a settings edit (web or hand-written) re-registers routes and
  // the directory without a restart.
  scope.watch(() => {
    adapterReg.replace([...profiles().keys()])
    directoryReg.replace(directoryEntries(profiles()))
  })
}
