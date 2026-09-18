/**
 * The sidebar-toggle plugin (`tui-sidebar-toggle`): a human `/sidebar` command
 * (and the Steps-title click handled in panels/conversation.tsx) over the
 * conversation panel's right Steps sidebar visibility.
 *
 * The conversation panel draws the Steps sidebar when the terminal is wide
 * enough (`auto`) unless the user pins it `on`/`off`; this plugin exposes the
 * pin through the slash-command plane: `/sidebar` cycles auto → on → off,
 * `/sidebar on|off|auto` sets the mode directly. The choice persists in
 * `~/.dsh/qialike.json` (`sidebar_mode`).
 *
 * @module @yourname/qialike-app/sidebar-toggle
 */

import type { Context } from '@deepseek-ai/cordis'
import type { TuiService, Store } from './index.tsx'

/** Stable Cordis plugin name. */
export const name = 'tui-sidebar-toggle'

/** The `tui` service for command registration. */
export const inject = ['tui']

/** The store service, resolved at apply() from `tuiStore` (see
 *  panels/conversation.tsx for the why-behind-the-seam). */
let store!: Store

/** Register the `/sidebar` command on the `tui` command plane. */
export function apply(ctx: Context): void {
  store = ctx.get('tuiStore') as Store
  const tui = ctx.get('tui') as TuiService
  tui.commands.register({
    name: 'sidebar',
    hint: 'show/hide the right Steps sidebar (auto/on/off)',
    run: (arg) => {
      const mode = arg.trim().toLowerCase()
      if (mode === 'on' || mode === 'off' || mode === 'auto') {
        store.setSidebarMode(mode)
      } else {
        store.cycleSidebarMode()
      }
      const current = store.sidebarMode
      store.flashStatus(current === 'auto' ? 'Steps: auto (follows width)' : current === 'on' ? 'Steps: shown' : 'Steps: hidden')
    },
  })
}
