/**
 * Package invariant for `@yourname/dsh-tui-app`.
 * @module @yourname/dsh-tui-app/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { TUI_STARTUP_SERVICE } from './startup.ts'

export const name = 'dsh-tui-invariant'

/**
 * Assert the owned relationship: when the TUI runtime is mounted, the startup
 * service it injects has been provided by the startup plugin.
 * @param ctx - the booted context to audit.
 */
export function apply(ctx: Context): void {
  ctx.on('internal/status', () => {
    if (ctx.get('tui-runtime') !== undefined && ctx.get(TUI_STARTUP_SERVICE) === undefined) {
      throw new Error('dsh-tui: tui-runtime mounted without the tuiStartup service')
    }
  })
}
