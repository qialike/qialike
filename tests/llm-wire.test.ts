/**
 * Unit tests for the tui-llm wire layer: the OpenAI Responses adapter
 * (`serializeRequestResponses` / `translateResponses`) and the live-catalog
 * filter (`filterDynamicModels`, include whitelist + exclude list). These pin
 * the wire contract for the OpenCode Zen GPT route (gpt-/grok-/muse- families
 * riding `/v1/responses`).
 *
 * Run with `bun test tests/llm-wire.test.ts`.
 *
 * @module dsh-tui/llm-wire-test
 */

import { describe, expect, test } from 'bun:test'
import {
  PROVIDER_TEMPLATES,
  REASONING_EFFORTS,
  filterDynamicModels,
  resolveModelApi,
  serializeMessagesGoogle,
  serializeRequestOpenAI,
  serializeRequestResponses,
  translateGoogle,
  translateResponses,
} from '../packages/dsh-tui-app/src/llm.ts'
import { OPENCODE_TEMPLATES } from '../packages/dsh-tui-app/src/opencode.ts'

describe('filterDynamicModels', () => {
  const ids = ['gpt-5.4-mini', 'gpt-5', 'grok-4.6', 'muse-spark-1.2', 'claude-sonnet-5', 'deepseek-v4-flash']

  test('include whitelist keeps only matching families', () => {
    expect(filterDynamicModels(ids, { include: ['gpt-', 'grok-', 'muse-'] })).toEqual([
      'gpt-5.4-mini',
      'gpt-5',
      'grok-4.6',
      'muse-spark-1.2',
    ])
  })

  test('exclude list drops matching families', () => {
    expect(filterDynamicModels(ids, { exclude: ['claude-', 'gpt-'] })).toEqual([
      'grok-4.6',
      'muse-spark-1.2',
      'deepseek-v4-flash',
    ])
  })

  test('include then exclude both apply', () => {
    expect(filterDynamicModels(ids, { include: ['gpt-', 'grok-', 'muse-'], exclude: ['muse-'] })).toEqual([
      'gpt-5.4-mini',
      'gpt-5',
      'grok-4.6',
    ])
  })

  test('no filters returns the input unchanged', () => {
    expect(filterDynamicModels(ids, undefined)).toEqual(ids)
  })
})

describe('serializeRequestResponses', () => {
  test('system/user/assistant map to Responses input items', async () => {
    const options = {
      provider: 'opencode-zen-gpt',
      model: 'gpt-5.4-mini',
      system: 'You are helpful',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      ],
      tools: [{ name: 'read', description: 'read a file', parameters: { type: 'object' } }],
      maxTokens: 1000,
    } as never
    const body = await serializeRequestResponses(
      {} as never,
      options,
      { baseURL: 'https://opencode.ai/zen/v1', api: 'openai-responses' } as never,
      undefined,
    )
    expect(body.model).toBe('gpt-5.4-mini')
    expect(body.stream).toBe(true)
    const input = body.input as Record<string, unknown>[]
    expect(input[0]).toEqual({ role: 'system', content: [{ type: 'input_text', text: 'You are helpful' }] })
    expect(input[1]).toEqual({ role: 'user', content: [{ type: 'input_text', text: 'hi' }] })
    expect(input[2]).toEqual({ role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] })
    expect(body.tools).toEqual([{ type: 'function', name: 'read', description: 'read a file', parameters: { type: 'object' } }])
    expect(body.max_output_tokens).toBe(1000)
  })

  test('assistant tool call and tool result become function_call / function_call_output', async () => {
    const options = {
      provider: 'opencode-zen-gpt',
      model: 'gpt-5.4-mini',
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"path":"/a"}' }],
        },
        {
          role: 'user',
          content: [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'ok' }] }],
        },
      ],
    } as never
    const body = await serializeRequestResponses(
      {} as never,
      options,
      { baseURL: 'https://opencode.ai/zen/v1', api: 'openai-responses' } as never,
      undefined,
    )
    const input = body.input as Record<string, unknown>[]
    expect(input[0]).toEqual({
      role: 'assistant',
      content: [{ type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{"path":"/a"}' }],
    })
    expect(input[1]).toEqual({
      role: 'user',
      content: [{ type: 'function_call_output', call_id: 'call_1', output: 'ok' }],
    })
  })
})

describe('translateResponses', () => {
  test('text deltas assemble into a text block with usage and finish', async () => {
    const events = [
      { type: 'response.created' },
      { type: 'response.output_text.delta', delta: 'Hel' },
      { type: 'response.output_text.delta', delta: 'lo' },
      {
        type: 'response.completed',
        response: {
          status: 'completed',
          output: [],
          usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 2 } },
        },
      },
    ] as never
    const chunks: unknown[] = []
    for await (const chunk of translateResponses(events)) chunks.push(chunk)
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'Hel' },
      { type: 'text-delta', index: 0, text: 'lo' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello' } },
      { type: 'usage', usage: { inputTokens: 8, outputTokens: 5, totalTokens: 15, cacheReadTokens: 2 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  test('function-call item + argument deltas close as a tool-call block', async () => {
    const events = [
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call_1', name: 'read' } },
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"path":' },
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: '"/a"}' },
      {
        type: 'response.completed',
        response: {
          status: 'completed',
          output: [{ type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{"path":"/a"}' }],
          usage: { input_tokens: 5, output_tokens: 3 },
        },
      },
    ] as never
    const chunks: unknown[] = []
    for await (const chunk of translateResponses(events)) chunks.push(chunk)
    expect(chunks[0]).toEqual({ type: 'block-start', index: 2, blockType: 'tool-call' })
    expect(chunks[1]).toMatchObject({ type: 'tool-call-delta', index: 2, id: 'call_1', name: 'read', argumentsDelta: '' })
    expect(chunks[2]).toMatchObject({ type: 'tool-call-delta', index: 2, argumentsDelta: '{"path":' })
    expect(chunks[3]).toMatchObject({ type: 'tool-call-delta', index: 2, argumentsDelta: '"/a"}' })
    expect(chunks[4]).toEqual({
      type: 'block-end',
      index: 2,
      block: { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"path":"/a"}' },
    })
    expect(chunks[5]).toEqual({ type: 'usage', usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 } })
    expect(chunks[6]).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  test('stream error surfaces as LlmError', async () => {
    const events = [{ type: 'error', error: { message: 'boom' } }] as never
    const chunks: unknown[] = []
    const run = (async () => {
      for await (const chunk of translateResponses(events)) chunks.push(chunk)
    })()
    await expect(run).rejects.toThrow(/boom/)
  })
})

describe('serializeMessagesGoogle', () => {
  test('system becomes systemInstruction, user/assistant become contents', async () => {
    const { systemInstruction, contents } = await serializeMessagesGoogle(
      {} as never,
      [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      ] as never,
      'You are helpful',
      undefined,
    )
    expect(systemInstruction).toBe('You are helpful')
    expect(contents).toEqual([
      { role: 'user', parts: [{ text: 'hi' }] },
      { role: 'model', parts: [{ text: 'hello' }] },
    ])
  })

  test('tool call and tool result become functionCall / functionResponse parts', async () => {
    const { contents } = await serializeMessagesGoogle(
      {} as never,
      [
        {
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"path":"/a"}' }],
        },
        {
          role: 'user',
          content: [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: '{"ok":true}' }] }],
        },
      ] as never,
      undefined,
      undefined,
    )
    expect(contents[0]).toEqual({ role: 'model', parts: [{ functionCall: { name: 'read', args: { path: '/a' } } }] })
    expect(contents[1]).toEqual({
      role: 'user',
      parts: [{ functionResponse: { name: 'call_1', response: { ok: true } } }],
    })
  })
})

describe('translateGoogle', () => {
  test('text parts stream into a text block with usage and finish', async () => {
    const events = [
      { candidates: [{ content: { parts: [{ text: 'Hel' }] } }] },
      { candidates: [{ content: { parts: [{ text: 'lo' }] }, finishReason: 'STOP' }] },
      { usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 4, totalTokenCount: 11 } },
    ] as never
    const chunks: unknown[] = []
    for await (const chunk of translateGoogle(events)) chunks.push(chunk)
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'Hel' },
      { type: 'text-delta', index: 0, text: 'lo' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello' } },
      { type: 'usage', usage: { inputTokens: 7, outputTokens: 4, totalTokens: 11 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  test('functionCall part opens a tool-call block with a synthetic id', async () => {
    const events = [
      {
        candidates: [{
          content: { parts: [{ functionCall: { name: 'read', args: { path: '/a' } } }] },
          finishReason: 'TOOL_CALL',
        }],
      },
    ] as never
    const chunks: unknown[] = []
    for await (const chunk of translateGoogle(events)) chunks.push(chunk)
    expect(chunks[0]).toEqual({ type: 'block-start', index: 2, blockType: 'tool-call' })
    expect(chunks[1]).toMatchObject({ type: 'tool-call-delta', index: 2, name: 'read', argumentsDelta: '{"path":"/a"}' })
    expect(chunks[2]).toMatchObject({ type: 'block-end', index: 2, block: { type: 'tool-call', name: 'read', arguments: '{"path":"/a"}' } })
    expect(chunks[3]).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })
})

describe('PROVIDER_TEMPLATES zen routes', () => {
  test('single OpenCode Zen route serves all families via modelsApi routing', () => {
    // opencode gateways live in the loadable tui-opencode-gateways plugin,
    // not in the core catalog.
    expect(PROVIDER_TEMPLATES.some((t) => t.route.startsWith('opencode-'))).toBe(false)
    const zen = OPENCODE_TEMPLATES.filter((t) => t.route.startsWith('opencode-zen'))
    expect(zen.map((t) => t.route)).toEqual(['opencode-zen'])
    const z = zen[0]
    expect(z.api).toBeUndefined() // openai-completions default
    expect(z.baseURL).toBe('https://opencode.ai/zen/v1')
    expect(z.excludeModelPrefixes).toBeUndefined() // no filtering: all 63 models listed
    expect(z.modelsApi?.['claude-']).toEqual({ api: 'anthropic-messages', baseURL: 'https://opencode.ai/zen' })
    expect(z.modelsApi?.['qwen']).toEqual({ api: 'anthropic-messages', baseURL: 'https://opencode.ai/zen' })
    expect(z.modelsApi?.['gpt-']).toEqual({ api: 'openai-responses' })
    expect(z.modelsApi?.['grok-']).toEqual({ api: 'openai-responses' })
    expect(z.modelsApi?.['muse-']).toEqual({ api: 'openai-responses' })
    expect(z.modelsApi?.['gemini-']).toEqual({ api: 'google-generative' })
    expect(OPENCODE_TEMPLATES.find((t) => t.route === 'opencode-go')?.excludeModelPrefixes).toEqual([
      'gpt-', 'grok-', 'muse-', 'qwen', 'minimax',
    ])
  })

  test('resolveModelApi routes model families to their protocol', () => {
    const z = OPENCODE_TEMPLATES.find((t) => t.route === 'opencode-zen')!
    expect(resolveModelApi(z, 'claude-sonnet-5')).toEqual({ api: 'anthropic-messages', baseURL: 'https://opencode.ai/zen' })
    expect(resolveModelApi(z, 'qwen3.6-plus')).toEqual({ api: 'anthropic-messages', baseURL: 'https://opencode.ai/zen' })
    expect(resolveModelApi(z, 'gpt-5.4-mini')).toEqual({ api: 'openai-responses' })
    expect(resolveModelApi(z, 'grok-4.6')).toEqual({ api: 'openai-responses' })
    expect(resolveModelApi(z, 'muse-spark-1.2')).toEqual({ api: 'openai-responses' })
    expect(resolveModelApi(z, 'gemini-3.7-flash')).toEqual({ api: 'google-generative' })
    expect(resolveModelApi(z, 'deepseek-v4-flash')).toEqual({}) // route default
    expect(resolveModelApi({ baseURL: 'https://x' } as never, 'anything')).toEqual({}) // no map
  })
})

describe('serializeRequestOpenAI reasoning effort', () => {
  const effortProfile = {
    displayName: 'DeepSeek',
    baseURL: 'https://api.deepseek.com',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    models: [
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', reasoningEfforts: REASONING_EFFORTS },
    ],
    reasoningEffort: 'high',
  }
  const plainProfile = {
    displayName: 'Plain',
    baseURL: 'https://plain.example/v1',
    models: [{ id: 'plain-1', name: 'Plain 1' }],
  }
  const base = {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    messages: [],
    system: 'you are helpful',
  }

  test('off maps to thinking disabled with no wire reasoning_effort', async () => {
    const body = await serializeRequestOpenAI(undefined as never, { ...base, reasoningEffort: 'off' }, effortProfile, undefined)
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(body).not.toHaveProperty('reasoning_effort')
  })

  test.each(['low', 'high', 'max'] as const)('%s maps to thinking enabled + reasoning_effort', async (effort) => {
    const body = await serializeRequestOpenAI(undefined as never, { ...base, reasoningEffort: effort }, effortProfile, undefined)
    expect(body.thinking).toEqual({ type: 'enabled' })
    expect(body.reasoning_effort).toBe(effort)
  })

  test('an omitted effort falls back to the route default (high)', async () => {
    const body = await serializeRequestOpenAI(undefined as never, base, effortProfile, undefined)
    expect(body.thinking).toEqual({ type: 'enabled' })
    expect(body.reasoning_effort).toBe('high')
  })

  test('a route default of off disables thinking when no effort is set', async () => {
    const body = await serializeRequestOpenAI(
      undefined as never,
      base,
      { ...effortProfile, reasoningEffort: 'off' },
      undefined,
    )
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(body).not.toHaveProperty('reasoning_effort')
  })

  test('models without declared efforts never carry effort fields', async () => {
    const body = await serializeRequestOpenAI(undefined as never, { ...base, model: 'plain-1' }, plainProfile, undefined)
    expect(body).not.toHaveProperty('thinking')
    expect(body).not.toHaveProperty('reasoning_effort')
  })

  test('an explicit effort on a model without declared efforts is rejected before I/O', async () => {
    await expect(
      serializeRequestOpenAI(undefined as never, { ...base, model: 'plain-1', reasoningEffort: 'high' }, plainProfile, undefined),
    ).rejects.toThrow('does not support reasoning effort "high"')
  })
})

describe('serializeRequestOpenAI provider-specific effort sets', () => {
  // Another gateway declares its own levels (no Off/DeepSeek spelling).
  const genericProfile = {
    displayName: 'GW',
    baseURL: 'https://gw.example/v1',
    models: [{
      id: 'm1',
      name: 'M1',
      reasoningEfforts: [
        { id: 'low', name: 'Low' },
        { id: 'medium', name: 'Medium' },
        { id: 'high', name: 'High' },
        { id: 'xhigh', name: 'X-High' },
        { id: 'max', name: 'Max' },
      ],
    }],
  }
  const base = { provider: 'gw', model: 'm1', messages: [], system: 's' }

  test('declared ids ride verbatim as reasoning_effort (medium, xhigh)', async () => {
    const medium = await serializeRequestOpenAI(undefined as never, { ...base, reasoningEffort: 'medium' }, genericProfile, undefined)
    expect(medium.thinking).toEqual({ type: 'enabled' })
    expect(medium.reasoning_effort).toBe('medium')
    const xhigh = await serializeRequestOpenAI(undefined as never, { ...base, reasoningEffort: 'xhigh' }, genericProfile, undefined)
    expect(xhigh.thinking).toEqual({ type: 'enabled' })
    expect(xhigh.reasoning_effort).toBe('xhigh')
  })

  test('omitted effort defaults to the declared high (not a DeepSeek assumption)', async () => {
    const body = await serializeRequestOpenAI(undefined as never, base, genericProfile, undefined)
    expect(body.reasoning_effort).toBe('high')
  })

  test('a profile default present in the declared set wins', async () => {
    const body = await serializeRequestOpenAI(undefined as never, base, { ...genericProfile, reasoningEffort: 'xhigh' }, undefined)
    expect(body.reasoning_effort).toBe('xhigh')
  })

  test('a declared set without high defaults to its first level', async () => {
    const profile = {
      ...genericProfile,
      models: [{
        id: 'm2',
        name: 'M2',
        reasoningEfforts: [
          { id: 'low', name: 'Low' },
          { id: 'medium', name: 'Medium' },
          { id: 'max', name: 'Max' },
        ],
      }],
    }
    const body = await serializeRequestOpenAI(undefined as never, { ...base, model: 'm2' }, profile, undefined)
    expect(body.thinking).toEqual({ type: 'enabled' })
    expect(body.reasoning_effort).toBe('low')
  })

  test('a no-thinking level spelled differently (none) uses disablesThinking', async () => {
    const profile = {
      ...genericProfile,
      models: [{
        id: 'm3',
        name: 'M3',
        reasoningEfforts: [
          { id: 'none', name: 'None', disablesThinking: true },
          { id: 'low', name: 'Low' },
          { id: 'high', name: 'High' },
        ],
      }],
    }
    const off = await serializeRequestOpenAI(undefined as never, { ...base, model: 'm3', reasoningEffort: 'none' }, profile, undefined)
    expect(off.thinking).toEqual({ type: 'disabled' })
    expect(off).not.toHaveProperty('reasoning_effort')
    const high = await serializeRequestOpenAI(undefined as never, { ...base, model: 'm3', reasoningEffort: 'high' }, profile, undefined)
    expect(high.thinking).toEqual({ type: 'enabled' })
    expect(high.reasoning_effort).toBe('high')
  })
})
