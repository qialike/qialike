/**
 * Regression tests for the qialike "token 超额自动中止" (context-overflow
 * auto-abort) bug.
 *
 * Root cause: the TUI's own LLM adapter (`tui-llm`, @yourname/qialike-app/llm)
 * replaced the harness `llm-deepseek` adapter (cordis.patch.yml disables
 * `llm-deepseek`/`llm-pi-ai`), but its `fetchOrThrow` only surfaced the raw
 * provider `error.code`/`error.type` (e.g. `invalid_request_error`) or
 * `httpErrorCode(status)` (e.g. `BAD_REQUEST`) and never classified a
 * context-window-overflow into `CONTEXT_WINDOW_EXCEEDED`. The harness's
 * `compaction-basic` recovery (`agent/request-error` → compact + retry, up to
 * `maxOverflowRetries`) only fires on `failure.code === CONTEXT_WINDOW_EXCEEDED`;
 * without the classification the overflow became a terminal `LlmError` and the
 * turn aborted — unlike the web, which rides the standard `llm-deepseek` adapter
 * (see its `adapter.ts`: `isContextWindowExceededError(detail) ->
 * CONTEXT_WINDOW_EXCEEDED_CODE`).
 *
 * Fix: `fetchOrThrow` now classifies the error message with
 * `isContextWindowExceededError` BEFORE falling back to the raw code / HTTP
 * status, so the shared compaction recovery fires (web parity). These tests pin
 * the classification predicate the fix relies on.
 *
 * Run with `bun test tests/tui-llm-context-overflow.test.ts`.
 *
 * @module qialike/tui-llm-context-overflow-test
 */

import { describe, expect, test } from 'bun:test'
import { isContextWindowExceededError } from '@deepseek-ai/dsh-llm'

describe('context-overflow classification predicates (drives compaction recovery)', () => {
  test('recognises DeepSeek "maximum context length" wording', () => {
    expect(isContextWindowExceededError(
      "This model's maximum context length is 128000 tokens. However, you requested about 129000 tokens.",
    )).toBe(true)
  })

  test('recognises generic overflow phrasing', () => {
    expect(isContextWindowExceededError('max context length exceeded')).toBe(true)
    expect(isContextWindowExceededError('input is too long for this model')).toBe(true)
  })

  test('rejects a non-overflow provider error (must NOT trigger recovery)', () => {
    expect(isContextWindowExceededError('some random invalid_request_error')).toBe(false)
    expect(isContextWindowExceededError('Authentication failed')).toBe(false)
  })
})
