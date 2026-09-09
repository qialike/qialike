/**
 * The foreign multi-model gateway plugin (`tui-foreign-gateways`): a loadable
 * sibling of `tui-llm` that registers the international aggregation gateways /
 * model-hosting platforms — OpenRouter, Vercel AI Gateway, Cloudflare (AI
 * Gateway + Workers AI), Hugging Face, Baseten, Fireworks AI, Together AI,
 * Nvidia, Groq and Cerebras — through the `tuiLlmTemplates` extension point.
 * These platforms host many vendors' models (gateways, not single vendors),
 * so they live in a loadable plugin instead of the built-in catalog.
 *
 * Whether the plugin registers the templates is decided by the
 * `dsh-tui-foreign-gateways` settings section (default: enabled):
 *
 *   ```yaml
 *   dsh-tui-foreign-gateways:
 *     enabled: false   # unloads the gateways from the catalog
 *   ```
 *
 * Model lists mirror the models.dev catalog.
 * `needsBaseURL` rows (Cloudflare) keep the deployment-configured form.
 *
 * @module @yourname/dsh-tui-app/foreign-gateways
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import type { TuiProviderTemplate } from './llm.ts'
import gatewayData from './foreign-gateway-templates.json' with { type: 'json' }

/** Stable Cordis plugin name. */
export const name = 'tui-foreign-gateways'

/** Services required: settings (the enabled switch) and the template registry. */
export const inject = ['settings', 'tuiLlmTemplates']

/** The `dsh-tui-foreign-gateways:` settings namespace holding the enabled switch. */
const NS = 'dsh-tui-foreign-gateways'

/** Schema: `enabled` defaults to true when absent (explicit false unloads). */
const GatewaysSchema = z.object({ enabled: z.boolean() })

/** The gateway templates registered when the plugin is enabled (data file
 *  `foreign-gateway-templates.json`, generated from the models.dev catalog). */
export const FOREIGN_GATEWAY_TEMPLATES: readonly TuiProviderTemplate[] = gatewayData

export function apply(ctx: Context): void {
  const settings = ctx.get('settings') as {
    register(ns: unknown, schema: unknown, options?: unknown): SettingsScope<unknown>
    get(ns: unknown): unknown
  } | undefined
  const templates = ctx.get('tuiLlmTemplates') as {
    add(templates: readonly TuiProviderTemplate[]): void
    hideRoutes(routes: readonly string[]): void
  } | undefined
  if (settings === undefined || templates === undefined) return
  const scope = settings.register(NS, GatewaysSchema as never, {})
  const enabled = (scope.get() as { enabled?: boolean } | undefined)?.enabled
  const routes = FOREIGN_GATEWAY_TEMPLATES.map((t) => t.route)
  if (enabled === false) {
    templates.hideRoutes(routes)
    return
  }
  templates.add(FOREIGN_GATEWAY_TEMPLATES)
}
