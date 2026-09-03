/**
 * Classic third-party colorschemes merged into dsh-tui's built-in set, so
 * `/theme` can switch to them like vim `:colorscheme` (they show up in the
 * picker dialog and in `resolveScheme` unique-prefix completion).
 *
 * 17-key mapping used for the opencode-derived schemes (roles resolved from
 * each theme's `dark` side; `defs` references expanded):
 *   bg/panel/element        ← background / backgroundPanel / backgroundElement
 *   borderSubtle/border/…   ← borderSubtle / border / borderActive
 *   text/textMuted          ← text / textMuted
 *   primary/secondary/accent← primary / secondary / accent
 *   success/warning/info/error ← success / warning / info / error
 *   yellow (quote/emphasis) ← markdownEmph (fallback markdownBlockQuote,
 *                             syntaxType, warning)
 *
 * LICENSE NOTE: every skin here is MIT-licensed (permissive) so the set is
 * safe to bundle/redistribute. 9 palettes are resolved from the theme files
 * bundled with opencode (`packages/tui/src/theme/assets/<name>.json`, an MIT
 * repo, opencode-1.18.25 checkout); `jellybeans` is mapped from the MIT vim
 * colorscheme by nanoTech. Upstream projects: catppuccin (Catppuccin),
 * dracula (Dracula Theme), everforest (sainnhe), gruvbox (morhetz),
 * kanagawa (rebelot), monokai (Wimer Hazenberg; values via opencode's MIT
 * repo), nord (arcticicestudio), rosepine (Rosé Pine), solarized (Ethan
 * Schoonover) — see THIRD_PARTY_NOTICES.md.
 * - `jellybeans` maps canonical highlight groups onto our semantic roles:
 *   Normal → text, Comment → textMuted, Function → primary, Identifier →
 *   secondary, Type → accent, String/Title → success, Constant → warning,
 *   PreProc → info, plus a computed neutral ramp (bg→comment blend) for the
 *   panel/border roles (values from nanotech/jellybeans.vim, MIT).
 *
 * @module @yourname/dsh-tui-app/classic-schemes
 */

import type { ThemePalette } from './theme.ts'

/** The merged classic set (alphabetical; built-in `dark`/`light` and these
 *  schemes win over user `~/.dsh/themes` files of the same name). */
export const CLASSIC_SCHEMES: Record<string, ThemePalette> = {
  /** Source: opencode assets/catppuccin.json (dark side). */
  catppuccin: {
    bg: '#1e1e2e', panel: '#181825', element: '#11111b', borderSubtle: '#585b70',
    border: '#313244', borderActive: '#45475a', text: '#cdd6f4', textMuted: '#9399b2',
    primary: '#89b4fa', secondary: '#cba6f7', accent: '#f5c2e7', success: '#a6e3a1',
    warning: '#f9e2af', info: '#94e2d5', error: '#f38ba8', yellow: '#f9e2af',
  },
  /** Source: opencode assets/dracula.json (dark side). */
  dracula: {
    bg: '#282a36', panel: '#21222c', element: '#44475a', borderSubtle: '#191a21',
    border: '#44475a', borderActive: '#bd93f9', text: '#f8f8f2', textMuted: '#6272a4',
    primary: '#bd93f9', secondary: '#ff79c6', accent: '#8be9fd', success: '#50fa7b',
    warning: '#f1fa8c', info: '#ffb86c', error: '#ff5555', yellow: '#f1fa8c',
  },
  /** Source: opencode assets/everforest.json (dark side). */
  everforest: {
    bg: '#2d353b', panel: '#333c43', element: '#343f44', borderSubtle: '#7a8478',
    border: '#859289', borderActive: '#9da9a0', text: '#d3c6aa', textMuted: '#7a8478',
    primary: '#a7c080', secondary: '#7fbbb3', accent: '#d699b6', success: '#a7c080',
    warning: '#e69875', info: '#83c092', error: '#e67e80', yellow: '#dbbc7f',
  },
  /** Source: opencode assets/gruvbox.json (dark side). */
  gruvbox: {
    bg: '#282828', panel: '#3c3836', element: '#504945', borderSubtle: '#504945',
    border: '#665c54', borderActive: '#ebdbb2', text: '#ebdbb2', textMuted: '#928374',
    primary: '#83a598', secondary: '#d3869b', accent: '#8ec07c', success: '#b8bb26',
    warning: '#fe8019', info: '#fabd2f', error: '#fb4934', yellow: '#d3869b',
  },
  /** Source: vim colorscheme jellybeans.vim (nanotech, MIT) — semantic mapping (see header). */
  jellybeans: {
    bg: '#151515', panel: '#1c1c1c', element: '#232323', borderSubtle: '#3a3a3a',
    border: '#4e4e4e', borderActive: '#777777', text: '#e8e8d3', textMuted: '#888888',
    primary: '#fad07a', secondary: '#c6b6ee', accent: '#ffb964', success: '#99ad6a',
    warning: '#cf6a4c', info: '#8fbfdc', error: '#de5577', yellow: '#dad085',
  },
  /** Source: opencode assets/kanagawa.json (dark side). */
  kanagawa: {
    bg: '#1f1f28', panel: '#2a2a37', element: '#363646', borderSubtle: '#363646',
    border: '#54546d', borderActive: '#c38d9d', text: '#dcd7ba', textMuted: '#727169',
    primary: '#7e9cd8', secondary: '#957fb8', accent: '#d27e99', success: '#98bb6c',
    warning: '#d7a657', info: '#76946a', error: '#e82424', yellow: '#c38d9d',
  },
  /** Source: opencode assets/monokai.json (dark side). */
  monokai: {
    bg: '#272822', panel: '#1e1f1c', element: '#3e3d32', borderSubtle: '#1e1f1c',
    border: '#3e3d32', borderActive: '#66d9ef', text: '#f8f8f2', textMuted: '#75715e',
    primary: '#66d9ef', secondary: '#ae81ff', accent: '#a6e22e', success: '#a6e22e',
    warning: '#e6db74', info: '#fd971f', error: '#f92672', yellow: '#e6db74',
  },
  /** Source: opencode assets/nord.json (dark side). */
  nord: {
    bg: '#2e3440', panel: '#3b4252', element: '#434c5e', borderSubtle: '#434c5e',
    border: '#434c5e', borderActive: '#4c566a', text: '#eceff4', textMuted: '#8b95a7',
    primary: '#88c0d0', secondary: '#81a1c1', accent: '#8fbcbb', success: '#a3be8c',
    warning: '#d08770', info: '#88c0d0', error: '#bf616a', yellow: '#d08770',
  },
  /** Source: opencode assets/rosepine.json (dark side). */
  rosepine: {
    bg: '#191724', panel: '#1f1d2e', element: '#26233a', borderSubtle: '#21202e',
    border: '#403d52', borderActive: '#9ccfd8', text: '#e0def4', textMuted: '#6e6a86',
    primary: '#9ccfd8', secondary: '#c4a7e7', accent: '#ebbcba', success: '#31748f',
    warning: '#f6c177', info: '#9ccfd8', error: '#eb6f92', yellow: '#f6c177',
  },
  /** Source: opencode assets/solarized.json (dark side). */
  solarized: {
    bg: '#002b36', panel: '#073642', element: '#073642', borderSubtle: '#073642',
    border: '#073642', borderActive: '#586e75', text: '#839496', textMuted: '#586e75',
    primary: '#268bd2', secondary: '#6c71c4', accent: '#2aa198', success: '#859900',
    warning: '#b58900', info: '#cb4b16', error: '#dc322f', yellow: '#b58900',
  },
}
