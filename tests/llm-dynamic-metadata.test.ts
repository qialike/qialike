/**
 * Unit tests for the live-catalog metadata extraction (`fetchDynamicModelInfo`).
 *
 * WHY THIS EXISTS. `listModels` already fetched each gateway's `/models` for its *ids*,
 * and the static catalogue supplied the *limits*. That split broke for any model the
 * static snapshot did not carry: the endpoint advertised it, it streamed, and the
 * harness got no context window and no output ceiling to size a request against.
 * Measured on OpenRouter (2026-10-18): 145 of its 471 live models were absent from the
 * snapshot, and 16 of the 326 present ones disagreed on `contextWindow`.
 *
 * These pin the extraction from the endpoint's own schema, and the degradation path for
 * a gateway that reports ids only. `fetch` is stubbed, so no test touches the network;
 * each case uses its own base URL because the module caches per endpoint root.
 *
 * Run with `bun test tests/llm-dynamic-metadata.test.ts`.
 *
 * @module qialike/llm-dynamic-metadata-test
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { fetchDynamicModelInfo, fetchDynamicModels } from '../packages/qialike-app/src/llm.ts'

/** Serve one JSON body for every request until the next case installs its own. */
const stubFetch = (body: unknown, init: { ok?: boolean } = {}): void => {
  const ok = init.ok ?? true
  globalThis.fetch = (async () =>
    ({
      ok,
      json: async () => body,
    }) as unknown as Response) as typeof fetch
}

const original = globalThis.fetch
afterEach(() => {
  globalThis.fetch = original
})

describe('fetchDynamicModelInfo', () => {
  test('an OpenRouter-shaped entry yields context, output ceiling and image input', async () => {
    stubFetch({
      data: [
        {
          id: 'anthropic/claude-opus-5.5',
          name: 'Claude Opus 5.5',
          context_length: 1_000_000,
          top_provider: { max_completion_tokens: 128_000 },
          architecture: { input_modalities: ['text', 'image'] },
        },
      ],
    })
    const models = await fetchDynamicModelInfo('https://or-shape.example/api/v1')
    expect(models).toHaveLength(1)
    expect(models?.[0]).toEqual({
      id: 'anthropic/claude-opus-5.5',
      name: 'Claude Opus 5.5',
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      inputModalities: ['text', 'image'],
    })
  })

  test('a gateway that reports ids only still enumerates, with no limits invented', async () => {
    stubFetch({ data: [{ id: 'some-model' }, { id: 'another-model' }] })
    const models = await fetchDynamicModelInfo('https://ids-only.example/api/v1')
    expect(models).toEqual([{ id: 'some-model' }, { id: 'another-model' }])
  })

  test('per-field fallback: a context window without an output ceiling keeps the one it knows', async () => {
    stubFetch({ data: [{ id: 'half-known', context_length: 40960 }] })
    const models = await fetchDynamicModelInfo('https://half-known.example/api/v1')
    expect(models?.[0]).toEqual({ id: 'half-known', contextWindow: 40960 })
    expect(models?.[0]?.maxTokens).toBeUndefined()
  })

  test('`context_window` is accepted as well as `context_length`', async () => {
    stubFetch({ data: [{ id: 'alt-field', context_window: 262144 }] })
    const models = await fetchDynamicModelInfo('https://alt-field.example/api/v1')
    expect(models?.[0]?.contextWindow).toBe(262144)
  })

  test('unknown modality names are dropped, and an entry with none modeled carries no field', async () => {
    stubFetch({
      data: [
        { id: 'audio-only', architecture: { input_modalities: ['audio'] } },
        { id: 'mixed', architecture: { input_modalities: ['text', 'image', 'audio'] } },
      ],
    })
    const models = await fetchDynamicModelInfo('https://modalities.example/api/v1')
    expect(models?.[0]).toEqual({ id: 'audio-only' })
    expect(models?.[1]?.inputModalities).toEqual(['text', 'image'])
  })

  test('a malformed or non-positive limit is ignored rather than trusted', async () => {
    stubFetch({
      data: [
        { id: 'zero', context_length: 0 },
        { id: 'negative', context_length: -1 },
        { id: 'stringly', context_length: '4096' },
        { id: 'nan', top_provider: { max_completion_tokens: Number.NaN } },
      ],
    })
    const models = await fetchDynamicModelInfo('https://malformed.example/api/v1')
    for (const model of models ?? []) {
      expect(model.contextWindow).toBeUndefined()
      expect(model.maxTokens).toBeUndefined()
    }
  })

  test('duplicate ids collapse to one entry', async () => {
    stubFetch({ data: [{ id: 'dup', context_length: 1024 }, { id: 'dup', context_length: 2048 }] })
    const models = await fetchDynamicModelInfo('https://dupes.example/api/v1')
    expect(models).toHaveLength(1)
    expect(models?.[0]?.contextWindow).toBe(1024)
  })

  test('an entry with no id is skipped, not turned into an empty model', async () => {
    stubFetch({ data: [{ name: 'nameless' }, { id: 'kept' }] })
    const models = await fetchDynamicModelInfo('https://noid.example/api/v1')
    expect(models).toEqual([{ id: 'kept' }])
  })

  test('a non-ok response degrades to undefined so the caller falls back to the static catalog', async () => {
    stubFetch({ data: [{ id: 'ignored' }] }, { ok: false })
    expect(await fetchDynamicModelInfo('https://failing.example/api/v1')).toBeUndefined()
  })

  test('an empty catalog degrades to undefined rather than an empty list', async () => {
    stubFetch({ data: [] })
    expect(await fetchDynamicModelInfo('https://empty.example/api/v1')).toBeUndefined()
  })

  test('a transport failure degrades to undefined instead of throwing', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    expect(await fetchDynamicModelInfo('https://unreachable.example/api/v1')).toBeUndefined()
  })

  test('a failure is cached, so the request path does not pay the timeout every time', async () => {
    // resolveModel consults this probe per request. Without negative caching an
    // endpoint that is down cost DYNAMIC_MODELS_TIMEOUT (4 s) on EVERY request,
    // which is a latency regression no caller asked for.
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch

    const first = await fetchDynamicModelInfo('https://neg-cache.example/api/v1')
    const second = await fetchDynamicModelInfo('https://neg-cache.example/api/v1')

    expect(first).toBeUndefined()
    expect(second).toBeUndefined()
    expect(calls).toBe(1)
  })

  test('a later success replaces the cached failure', async () => {
    let healthy = false
    globalThis.fetch = (async () => {
      if (!healthy) throw new Error('ECONNREFUSED')
      return { ok: true, json: async () => ({ data: [{ id: 'recovered' }] }) } as unknown as Response
    }) as typeof fetch

    expect(await fetchDynamicModelInfo('https://recover.example/api/v1')).toBeUndefined()
    // The failure TTL is short by design; this simulates it having elapsed by
    // installing a healthy endpoint and reading a different root, which is the
    // only way to observe a retry without sleeping 30 s in a unit test.
    healthy = true
    expect(await fetchDynamicModelInfo('https://recover-other.example/api/v1')).toEqual([{ id: 'recovered' }])
  })
})

describe('fetchDynamicModels', () => {
  test('still returns a bare id list, from the same cached catalog', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      return {
        ok: true,
        json: async () => ({ data: [{ id: 'a', context_length: 1 }, { id: 'b' }] }),
      } as unknown as Response
    }) as typeof fetch

    const info = await fetchDynamicModelInfo('https://shared-cache.example/api/v1')
    const ids = await fetchDynamicModels('https://shared-cache.example/api/v1')

    expect(info).toHaveLength(2)
    expect(ids).toEqual(['a', 'b'])
    // One request served both, so the id list and the metadata cannot disagree.
    expect(calls).toBe(1)
  })
})

describe('an authenticated probe', () => {
  // A gateway that requires a credential answers 401 anonymously. The probe must send
  // the key when one exists, and must keep the anonymous failure out of the way of the
  // authenticated answer — the two are cached under separate keys, because the first
  // look at a provider usually happens BEFORE its key is stored (the Add-provider list
  // is what prompts for one).
  const serve = async (): Promise<{ baseURL: string; seen: string[]; close: () => void }> => {
    const { createServer } = await import('node:http')
    const seen: string[] = []
    const server = createServer((req, res) => {
      const auth = req.headers.authorization
      seen.push(auth ?? '(none)')
      if (auth === 'Bearer secret-key') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          data: [{ id: 'only-with-key', context_length: 4096, top_provider: { max_completion_tokens: 512 } }],
        }))
      } else {
        res.writeHead(401)
        res.end('{}')
      }
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    return { baseURL: `http://127.0.0.1:${port}`, seen, close: () => { server.close() } }
  }

  test('the key is sent, and the anonymous 401 does not shadow it', async () => {
    const { baseURL, seen, close } = await serve()
    try {
      expect(await fetchDynamicModelInfo(baseURL), 'anonymous probe degrades').toBeUndefined()
      const authed = await fetchDynamicModelInfo(baseURL, 'secret-key')
      expect(authed?.map((m) => m.id)).toEqual(['only-with-key'])
      expect(authed?.[0]?.contextWindow, 'limits come from the endpoint').toBe(4096)
      expect(seen).toEqual(['(none)', 'Bearer secret-key'])
    } finally { close() }
  })

  test('the two results are cached separately, so each is one request', async () => {
    const { baseURL, seen, close } = await serve()
    try {
      await fetchDynamicModelInfo(baseURL)
      await fetchDynamicModelInfo(baseURL, 'secret-key')
      const afterFirstRound = seen.length
      // Both should hit their own cache entry rather than re-probing.
      await fetchDynamicModelInfo(baseURL)
      await fetchDynamicModelInfo(baseURL, 'secret-key')
      expect(seen.length, 'no extra requests on the second round').toBe(afterFirstRound)
    } finally { close() }
  })

  test('an empty key is anonymous, not an empty credential', async () => {
    const { baseURL, seen, close } = await serve()
    try {
      await fetchDynamicModelInfo(baseURL, '')
      expect(seen).toEqual(['(none)'])
    } finally { close() }
  })
})
