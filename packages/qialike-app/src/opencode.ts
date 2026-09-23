/**
 * The OpenCode Zen / OpenCode Go gateways plugin (`tui-opencode-gateways`):
 * a loadable sibling of `tui-llm` that registers the two opencode gateway
 * provider templates (Zen — one key serving four wire protocols via
 * `modelsApi` routing; Go — chat/completions plus protocol filtering) through
 * the `tuiLlmTemplates` extension point, so the gateways appear in the /models
 * directory, the Add-provider list, and the adapter's fallbacks — and vanish
 * app-wide when disabled.
 *
 * Whether the plugin actually registers the templates is decided by the
 * `qialike-opencode` settings section (default: enabled):
 *
 *   ```yaml
 *   qialike-opencode:
 *     enabled: false   # unloads the opencode gateways from the catalog
 *   ```
 *
 * @module @yourname/qialike-app/opencode
 */

import type { Context } from '@deepseek-ai/cordis'
import type { TuiProviderTemplate } from './llm.ts'
import { readSection } from './config.ts'

/** Stable Cordis plugin name. */
export const name = 'tui-opencode-gateways'

/** Services required: settings (the enabled switch) and the template registry. */
export const inject = ['settings', 'tuiLlmTemplates']


/** The two opencode gateway templates registered when the plugin is enabled. */
export const OPENCODE_TEMPLATES: readonly TuiProviderTemplate[] = [
  {
    route: 'opencode-zen', name: 'OpenCode Zen',
    baseURL: 'https://opencode.ai/zen/v1', apiKeyEnv: 'OPENCODE_ZEN_API_KEY',
    // One gateway key serving FOUR wire protocols; the picker shows all 63
    // live models and the adapter routes each family at stream time:
    //   claude-/qwen   -> Anthropic messages (x-api-key; root baseURL so
    //                      {baseURL}/v1/messages resolves)
    //   gpt-/grok-/muse-> OpenAI Responses (Bearer)
    //   gemini-        -> Google generateContent (x-goog-api-key)
    //   everything else-> chat/completions (route default)
    // All authentications were verified against the live gateway.
    modelsApi: {
      'claude-': { api: 'anthropic-messages', baseURL: 'https://opencode.ai/zen' },
      'qwen': { api: 'anthropic-messages', baseURL: 'https://opencode.ai/zen' },
      'gpt-': { api: 'openai-responses' },
      'grok-': { api: 'openai-responses' },
      'muse-': { api: 'openai-responses' },
      'gemini-': { api: 'google-generative' },
    },
    models: [
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', contextWindow: 1000000, maxTokens: 384000 },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', contextWindow: 1000000, maxTokens: 384000 },
      { id: 'glm-5.2', name: 'GLM 5.2', contextWindow: 200000, maxTokens: 65536 },
      { id: 'kimi-k3', name: 'Kimi K3', contextWindow: 1048576, maxTokens: 131072 },
      { id: 'minimax-m3', name: 'MiniMax-M3', contextWindow: 1000000, maxTokens: 128000 },
      { id: 'big-pickle', name: 'Big Pickle (free)', contextWindow: 200000, maxTokens: 65536 },
    ],
  },
  {
    route: 'opencode-go', name: 'OpenCode Go',
    baseURL: 'https://opencode.ai/zen/go/v1', apiKeyEnv: 'OPENCODE_GO_API_KEY',
    // Unlike Zen, Go routes MiniMax and Qwen via /v1/messages; GPT/Grok/Muse
    // ride /v1/responses. Everything else (GLM/Kimi/LongCat/DeepSeek/MiMo/Hy)
    // is /chat/completions and survives the live-catalog filter below.
    excludeModelPrefixes: ['gpt-', 'grok-', 'muse-', 'qwen', 'minimax'],
    models: [
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', contextWindow: 1000000, maxTokens: 384000 },
      { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', contextWindow: 200000, maxTokens: 65536 },
      { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', contextWindow: 262144, maxTokens: 65536 },
      { id: 'longcat-2.0', name: 'LongCat-2.0', contextWindow: 200000, maxTokens: 65536 },
      { id: 'mimo-v2.5', name: 'MiMo-V2.5', contextWindow: 131072, maxTokens: 65536 },
      { id: 'hy4-preview', name: 'Hy4 preview', contextWindow: 131072, maxTokens: 65536 },
    ],
  },
]

export function apply(ctx: Context): void {
  const templates = ctx.get('tuiLlmTemplates') as {
    add(templates: readonly TuiProviderTemplate[]): void
    hideRoutes(routes: readonly string[]): void
  } | undefined
  if (templates === undefined) return
  // The switch lives in `qialike.json` since 0.1.7 (`readSection`).
  // Explicit `enabled: false` unloads the gateways — templates AND any
  // user-configured opencode-zen/opencode-go routes vanish from the /models
  // list and the adapter; absent (or true) keeps them, the default, so
  // upgrading never removes a gateway the user already uses.
  const enabled = readSection('opencode')?.enabled
  if (enabled === false) {
    templates.hideRoutes(['opencode-zen', 'opencode-go'])
    return
  }
  templates.add(OPENCODE_TEMPLATES)
}
