/**
 * The China multi-model gateway plugin (`tui-china-gateways`): a loadable
 * sibling of `tui-llm` that registers the Chinese aggregation gateways —
 * Qiniu (`qiniu-ai`, api.qnaigc.com) and SiliconFlow (`siliconflow` /
 * `siliconflow-cn`, api.siliconflow.com/.cn) — through the `tuiLlmTemplates`
 * extension point. These platforms host many vendors' models (a model
 * gateway, not a single model vendor), so they live in a loadable plugin
 * instead of the built-in catalog: unload the whole family with one setting.
 *
 * Whether the plugin actually registers the templates is decided by the
 * `qialike-china-gateways` settings section (default: enabled):
 *
 *   ```yaml
 *   qialike-china-gateways:
 *     enabled: false   # unloads Qiniu / SiliconFlow from the catalog
 *   ```
 *
 * Model lists mirror the models.dev catalog.
 *
 * @module @yourname/qialike-app/china-gateways
 */

import type { Context } from '@deepseek-ai/cordis'
import type { TuiProviderTemplate } from './llm.ts'
import { readSection } from './config.ts'
import gatewayData from './china-gateway-templates.json' with { type: 'json' }

/** Stable Cordis plugin name. */
export const name = 'tui-china-gateways'

/** Services required: settings (the enabled switch) and the template registry. */
export const inject = ['settings', 'tuiLlmTemplates']


/** The gateway templates registered when the plugin is enabled (data file
 *  `china-gateway-templates.json`, generated from the models.dev catalog). */
export const CHINA_GATEWAY_TEMPLATES: readonly TuiProviderTemplate[] = gatewayData

export function apply(ctx: Context): void {
  const templates = ctx.get('tuiLlmTemplates') as {
    add(templates: readonly TuiProviderTemplate[]): void
    hideRoutes(routes: readonly string[]): void
  } | undefined
  if (templates === undefined) return
  // The switch lives in `qialike.json` since 0.1.7 (`readSection`).
  // Explicit `enabled: false` unloads the gateways — templates AND any
  // user-configured routes vanish from the /models list and the adapter;
  // absent (or true) keeps them, the default.
  const enabled = readSection('china_gateways')?.enabled
  const routes = CHINA_GATEWAY_TEMPLATES.map((t) => t.route)
  if (enabled === false) {
    templates.hideRoutes(routes)
    return
  }
  templates.add(CHINA_GATEWAY_TEMPLATES)
}
