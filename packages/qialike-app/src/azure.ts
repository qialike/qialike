/**
 * The Azure provider plugin (`tui-azure`): a loadable sibling of `tui-llm`
 * that registers the Azure model catalog (models.dev `azure` — Azure AI
 * Foundry / Azure OpenAI hosted models, sold directly by Azure) through the
 * `tuiLlmTemplates` extension point. Azure is deployment-configured
 * (`needsBaseURL`: the user supplies their resource/deployment endpoint and
 * an `AZURE_API_KEY`), so it ships as a plugin row that can be unloaded
 * wholesale.
 *
 * Whether the plugin registers the template is decided by the
 * `qialike-azure` settings section (default: enabled):
 *
 *   ```yaml
 *   qialike-azure:
 *     enabled: false   # unloads Azure from the catalog
 *   ```
 *
 * @module @yourname/qialike-app/azure
 */

import type { Context } from '@deepseek-ai/cordis'
import type { TuiProviderTemplate } from './llm.ts'
import { readSection } from './config.ts'
import azureData from './azure-templates.json' with { type: 'json' }

/** Stable Cordis plugin name. */
export const name = 'tui-azure'

/** Services required: settings (the enabled switch) and the template registry. */
export const inject = ['settings', 'tuiLlmTemplates']


/** The Azure template registered when the plugin is enabled (data file
 *  `azure-templates.json`, generated from the models.dev catalog). */
export const AZURE_TEMPLATES: readonly TuiProviderTemplate[] = azureData

export function apply(ctx: Context): void {
  const templates = ctx.get('tuiLlmTemplates') as {
    add(templates: readonly TuiProviderTemplate[]): void
    hideRoutes(routes: readonly string[]): void
  } | undefined
  if (templates === undefined) return
  // The switch lives in `qialike.json` since 0.1.7 (`readSection`).
  const enabled = readSection('azure')?.enabled
  const routes = AZURE_TEMPLATES.map((t) => t.route)
  if (enabled === false) {
    templates.hideRoutes(routes)
    return
  }
  templates.add(AZURE_TEMPLATES)
}
