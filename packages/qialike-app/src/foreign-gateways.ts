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
 * `qialike-foreign-gateways` settings section (default: enabled):
 *
 *   ```yaml
 *   qialike-foreign-gateways:
 *     enabled: false   # unloads the gateways from the catalog
 *   ```
 *
 * Model lists mirror the models.dev catalog.
 * `needsBaseURL` rows (Cloudflare) keep the deployment-configured form.
 *
 * @module @qialike/qialike-app/foreign-gateways
 */

import type { Context } from '@deepseek-ai/cordis'
import type { TuiProviderTemplate } from './llm.ts'
import { readSection } from './config.ts'
import gatewayData from './foreign-gateway-templates.json' with { type: 'json' }

/** Stable Cordis plugin name. */
export const name = 'tui-foreign-gateways'

/** Services required: settings (the enabled switch) and the template registry. */
export const inject = ['settings', 'tuiLlmTemplates']


/** The gateway templates registered when the plugin is enabled (data file
 *  `foreign-gateway-templates.json`, generated from the models.dev catalog). */
export const FOREIGN_GATEWAY_TEMPLATES: readonly TuiProviderTemplate[] = gatewayData

export function apply(ctx: Context): void {
  const templates = ctx.get('tuiLlmTemplates') as {
    add(templates: readonly TuiProviderTemplate[]): void
    hideRoutes(routes: readonly string[]): void
  } | undefined
  if (templates === undefined) return
  // The switch lives in `qialike.json` since 0.1.7 (`readSection`).
  const enabled = readSection('foreign_gateways')?.enabled
  const routes = FOREIGN_GATEWAY_TEMPLATES.map((t) => t.route)
  if (enabled === false) {
    templates.hideRoutes(routes)
    return
  }
  templates.add(FOREIGN_GATEWAY_TEMPLATES)
}
