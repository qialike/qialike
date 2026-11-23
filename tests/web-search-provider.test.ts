/**
 * Web search stays on the DeepSeek Search API, whatever upstream's default becomes.
 *
 * WHY THIS IS A TEST. Harness 0.2.2-rc.5 deleted `searchProvider` from the base `web`
 * row, so an unconfigured deployment now selects per model route: a search serving a
 * request on `deepseek-official` / `deepseek-account` runs the `deepseek-official`
 * provider — an auxiliary Messages request carrying the server-side
 * `web_search_20250305` tool — and `deepseek-search-api` on every other route.
 * qialike pins the Search API for every route, which is what 0.15.0 shipped, and the
 * only thing saying so is one `web` row in the composition patch.
 *
 * Two independent reasons the pinned form is the right one here, neither of which is
 * visible from "which provider does upstream prefer":
 *
 *   * BILLING. A Messages search carries no per-search charge, but it IS a model
 *     request: up to `maxUses` (5) server-side searches land on the token bill, so a
 *     long session pays more than a flat per-search API call would. The Search API
 *     charge does not grow with context.
 *   * ENDPOINT. `web-search-deepseek` deliberately does NOT follow the model
 *     provider's base URL — it reads `baseURL`, else `$DEEPSEEK_SEARCH_BASE_URL`,
 *     else `https://api.deepseek.com/anthropic/v1`. qialike explicitly allows a user
 *     to override the built-in `deepseek-official` route's baseURL
 *     (`effectiveProviders` in `llm.ts`), so following the route default would send
 *     that gateway's key to the OFFICIAL endpoint — a credential failure, or a
 *     charge on the official account. Reproducing that requires a pin.
 *
 * A dropped row is silent: the deployment still boots, still searches, and only the
 * bill and the credential routing change. Hence this guard rather than a comment.
 *
 * Run with `bun test tests/web-search-provider.test.ts`.
 *
 * @module qialike/web-search-provider-test
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..')
const PATCH = readFileSync(join(REPO, 'packages', 'qialike-app', 'cordis.patch.yml'), 'utf8')

/** The block belonging to one `- id: <id>` row: up to the next top-level entry. */
function row(id: string): string | undefined {
  const lines = PATCH.split('\n')
  const start = lines.findIndex(line => line === `- id: ${id}`)
  if (start === -1) return undefined
  // Stop at the next TOP-LEVEL entry: a row (`- `) or a section banner (`#`).
  // Terminating on `- ` alone drags the following comment block into the slice,
  // whose prose names the very providers and plugin ids these assertions look for.
  let end = start + 1
  while (end < lines.length && !lines[end]!.startsWith('- ') && !lines[end]!.startsWith('#')) end += 1
  return lines.slice(start, end).join('\n')
}

describe('web search is pinned to the DeepSeek Search API', () => {
  test('the composition carries a `web` row — an absent row is the upstream default', () => {
    expect(row('web'), 'without this row `dsh-web` selects per model route').toBeDefined()
  })

  test('it pins `searchProvider: deepseek-search-api`', () => {
    // The exact id registered by `@deepseek-ai/dsh-web-deepseek-api`
    // (`DEEPSEEK_SEARCH_API_PROVIDER_ID`). A typo here fails at search time with
    // WEB_PROVIDER_CONFIGURED_MISSING, not at boot, so it is worth pinning literally.
    expect(row('web')).toContain('searchProvider: deepseek-search-api')
  })

  test('it does not silently switch to the Messages provider', () => {
    expect(row('web')).not.toContain('deepseek-official')
  })

  test('fetch stays on the same provider the base ships', () => {
    // A patch row replaces the row's WHOLE config, so omitting this would drop the
    // base's value rather than inherit it.
    expect(row('web')).toContain('fetchProvider: http')
  })
})
