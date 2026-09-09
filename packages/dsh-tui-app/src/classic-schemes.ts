/**
 * Classic third-party colorschemes merged into dsh-tui's built-in set, so
 * `/theme` can switch to them like vim `:colorscheme` (they show up in the
 * picker dialog and in `resolveScheme` unique-prefix completion).
 *
 * 17-key mapping used for the classic schemes (roles resolved from
 * each theme's `dark` side — except `solarized-light`, which mirrors the
 * official `light` side of altercation/solarized; `defs` expanded):
 *   bg/panel/element        ← background / backgroundPanel / backgroundElement
 *   borderSubtle/border/…   ← borderSubtle / border / borderActive
 *   text/textMuted          ← text / textMuted
 *   primary/secondary/accent← primary / secondary / accent
 *   success/warning/info/error ← success / warning / info / error
 *   yellow (quote/emphasis) ← markdownEmph (fallback markdownBlockQuote,
 *                             syntaxType, warning)
 *
 * LICENSE NOTE: every skin here is MIT-licensed (permissive) so the set is
 * safe to bundle/redistribute. 12 palettes (catppuccin, dracula, everforest,
 * falcon, flexoki, gruvbox, kanagawa, nord, panda, rosepine, solarized,
 * solarized-light) are
 * the upstream projects' own palettes, sourced directly from their official
 * repos: catppuccin (Catppuccin), dracula (Dracula Theme), everforest
 * (sainnhe), falcon (fenetikm, MIT), flexoki (kepano/Steph Ango, MIT),
 * gruvbox (morhetz), kanagawa (rebelot), nord (arcticicestudio), panda
 * (siamak/atom-panda-syntax, MIT — the VSCode ports PandaTheme/ and
 * tinkertrain/ ship no LICENSE, so this skin tracks the Atom original),
 * rosepine (Rosé Pine), solarized (Ethan Schoonover — `solarized-light` is
 * the official light side of the same repo) — see THIRD_PARTY_NOTICES.md.
 * `jellybeans` is mapped from the MIT vim colorscheme by nanoTech.
 * - `jellybeans` maps canonical highlight groups onto our semantic roles:
 *   Normal → text, Comment → textMuted, Function → primary, Identifier →
 *   secondary, Type → accent, String/Title → success, Constant → warning,
 *   PreProc → info, plus a computed neutral ramp (bg→comment blend) for the
 *   panel/border roles (values from nanotech/jellybeans.vim, MIT).
 * `twilight` is mapped from the MIT theme XML bundled with the official
 * Notepad++ distribution (notepad-plus-plus/notepad-plus-plus,
 * `PowerEditor/installer/themes/`): that file carries its own MIT header
 * inside the GPL-3.0 repository — © 2008 Fabio Zendhi Nagao, 2011–2014
 * Renato Silva. Its own fg hexes are kept verbatim and mapped by syntax
 * role: text ← Default fg, textMuted ← comment fg, primary ← the main
 * keyword/instruction tone (tan CDA869), secondary ← the cool preprocessor
 * tone, accent ← the vivid instruction tone (cream F9EE98), success ← sage
 * strings 8F9D6A, warning ← warm numbers E9C062, info ← cool variable tone
 * 7587A6, error ← terracotta CF6A4C, yellow ← the muted FUNCTION tone
 * DAD085; the panel/element roles take the XML's own current-line and
 * selection colours (GlobalStyles), with the border steps computed as
 * neutral blends between them.
 *
 * @module @yourname/dsh-tui-app/classic-schemes
 */

import type { ThemePalette } from './theme.ts'

/** The merged classic set (alphabetical; built-in `dark`/`light` and these
 *  schemes win over user `~/.dsh/themes` files of the same name). */
export const CLASSIC_SCHEMES: Record<string, ThemePalette> = {
  /** Source: catppuccin/catppuccin (dark side). */
  catppuccin: {
    bg: '#1e1e2e', panel: '#181825', element: '#11111b', borderSubtle: '#585b70',
    border: '#313244', borderActive: '#45475a', text: '#cdd6f4', textMuted: '#9399b2',
    primary: '#89b4fa', secondary: '#cba6f7', accent: '#f5c2e7', success: '#a6e3a1',
    warning: '#f9e2af', info: '#94e2d5', error: '#f38ba8', yellow: '#f9e2af',
  },
  /** Source: dracula/dracula-theme (dark side). */
  dracula: {
    bg: '#282a36', panel: '#21222c', element: '#44475a', borderSubtle: '#191a21',
    border: '#44475a', borderActive: '#bd93f9', text: '#f8f8f2', textMuted: '#6272a4',
    primary: '#bd93f9', secondary: '#ff79c6', accent: '#8be9fd', success: '#50fa7b',
    warning: '#f1fa8c', info: '#ffb86c', error: '#ff5555', yellow: '#f1fa8c',
  },
  /** Source: sainnhe/everforest (dark side). */
  everforest: {
    bg: '#2d353b', panel: '#333c43', element: '#343f44', borderSubtle: '#7a8478',
    border: '#859289', borderActive: '#9da9a0', text: '#d3c6aa', textMuted: '#7a8478',
    primary: '#a7c080', secondary: '#7fbbb3', accent: '#d699b6', success: '#a7c080',
    warning: '#e69875', info: '#83c092', error: '#e67e80', yellow: '#dbbc7f',
  },
  /** Source: fenetikm/falcon (MIT © 2018 fenetikm) — colors/falcon.vim +
   *  alacritty/alacritty.toml ANSI table (dark only). */
  falcon: {
    bg: '#020221', panel: '#18182a', element: '#212127', borderSubtle: '#2f2f3a',
    border: '#36363a', borderActive: '#787882', text: '#b4b4b9', textMuted: '#787882',
    primary: '#ffc552', secondary: '#99a4bc', accent: '#bfdaff', success: '#b2bc55',
    warning: '#ff761a', info: '#34bfa4', error: '#ff3600', yellow: '#ffd392',
  },
  /** Source: kepano/flexoki (MIT © 2023 Steph Ango) — css/flexoki.css tones,
   *  UI/text layers from the official helix flexoki-dark.toml; borders
   *  interpolated along the grey ramp (dark only). */
  flexoki: {
    bg: '#100f0f', panel: '#1c1b1a', element: '#282726', borderSubtle: '#343331',
    border: '#403e3c', borderActive: '#6f6e69', text: '#cecdc3', textMuted: '#878580',
    primary: '#da702c', secondary: '#4385be', accent: '#8b7ec8', success: '#879a39',
    warning: '#d0a215', info: '#3aa99f', error: '#d14d41', yellow: '#d0a215',
  },
  /** Source: morhetz/gruvbox (dark side). */
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
  /** Source: rebelot/kanagawa.nvim (dark side). */
  kanagawa: {
    bg: '#1f1f28', panel: '#2a2a37', element: '#363646', borderSubtle: '#363646',
    border: '#54546d', borderActive: '#c38d9d', text: '#dcd7ba', textMuted: '#727169',
    primary: '#7e9cd8', secondary: '#957fb8', accent: '#d27e99', success: '#98bb6c',
    warning: '#d7a657', info: '#76946a', error: '#e82424', yellow: '#c38d9d',
  },
  /** Source: arcticicestudio/nord (dark side). */
  nord: {
    bg: '#2e3440', panel: '#3b4252', element: '#434c5e', borderSubtle: '#434c5e',
    border: '#434c5e', borderActive: '#4c566a', text: '#eceff4', textMuted: '#8b95a7',
    primary: '#88c0d0', secondary: '#81a1c1', accent: '#8fbcbb', success: '#a3be8c',
    warning: '#d08770', info: '#88c0d0', error: '#bf616a', yellow: '#d08770',
  },
  /** Source: siamak/atom-panda-syntax (MIT © 2016 Siamak Mokhtari) — the
   *  original Atom palette; neutral greys interpolated between its official
   *  ramps. NB: the popular VSCode ports (PandaTheme/, tinkertrain/) ship no
   *  LICENSE, so the clean MIT lineage is this Atom original (dark only). */
  panda: {
    bg: '#292a2b', panel: '#2e2f30', element: '#343537', borderSubtle: '#373b41',
    border: '#4b4d52', borderActive: '#757575', text: '#e6e6e6', textMuted: '#676b79',
    primary: '#ff75b5', secondary: '#45a9f9', accent: '#b084eb', success: '#19f9d8',
    warning: '#ffb86c', info: '#6fc1ff', error: '#ff2c6d', yellow: '#ffcc95',
  },
  /** Source: rose-pine/rose-pine-theme (dark side). */
  rosepine: {
    bg: '#191724', panel: '#1f1d2e', element: '#26233a', borderSubtle: '#21202e',
    border: '#403d52', borderActive: '#9ccfd8', text: '#e0def4', textMuted: '#6e6a86',
    primary: '#9ccfd8', secondary: '#c4a7e7', accent: '#ebbcba', success: '#31748f',
    warning: '#f6c177', info: '#9ccfd8', error: '#eb6f92', yellow: '#f6c177',
  },
  /** Source: altercation/solarized (dark side). */
  solarized: {
    bg: '#002b36', panel: '#073642', element: '#073642', borderSubtle: '#073642',
    border: '#073642', borderActive: '#586e75', text: '#839496', textMuted: '#586e75',
    primary: '#268bd2', secondary: '#6c71c4', accent: '#2aa198', success: '#859900',
    warning: '#b58900', info: '#cb4b16', error: '#dc322f', yellow: '#b58900',
  },
  /** Source: altercation/solarized (light side) — the official light mirror:
   *  bg base3 #fdf6e3, text base00 #657b83, layers base2 #eee8d5, muted /
   *  borderActive base1 #93a1a1; the accent roles are shared verbatim with
   *  the dark side above. */
  'solarized-light': {
    bg: '#fdf6e3', panel: '#eee8d5', element: '#eee8d5', borderSubtle: '#eee8d5',
    border: '#eee8d5', borderActive: '#93a1a1', text: '#657b83', textMuted: '#93a1a1',
    primary: '#268bd2', secondary: '#6c71c4', accent: '#2aa198', success: '#859900',
    warning: '#b58900', info: '#cb4b16', error: '#dc322f', yellow: '#b58900',
  },
  /** Source: the MIT Twilight.xml bundled with Notepad++ (© 2008 Fabio
   *  Zendhi Nagao, 2011–2014 Renato Silva — the TextMate Twilight palette).
   *  Accents verbatim: tan keywords CDA869, cream instructions F9EE98,
   *  terracotta numbers/identifiers CF6A4C, sage strings 8F9D6A, muted
   *  yellow functions DAD085 (yellow role); layers from its current-line
   *  292929 / selection 3E3E3E + computed blends. */
  twilight: {
    bg: '#141414', panel: '#292929', element: '#3e3e3e', borderSubtle: '#1f1f1f',
    border: '#2f2f2f', borderActive: '#cda869', text: '#f8f8f8', textMuted: '#5f5a60',
    primary: '#cda869', secondary: '#8996a8', accent: '#f9ee98', success: '#8f9d6a',
    warning: '#e9c062', info: '#7587a6', error: '#cf6a4c', yellow: '#dad085',
  },
}
