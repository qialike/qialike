# Third-Party Notices

The bundled executable and the `@yourname/dsh-tui-app` bundle draw on third-party packages. This
file lists the ones this repository adds directly; the DeepSeek Harness core and its vendored Cordis
dependencies carry their own notices in the harness checkout (see its `THIRD_PARTY_NOTICES.md`),
and the Bun runtime embeds its own license with the compiled binary.

| Package | Version (as bundled) | License | Used for |
|---|---|---|---|
| [@deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | workspace `lib/` | MIT | Agent harness, Cordis plugin tree, session/agent services |
| [DeepSeek AI](https://github.com/deepseek-ai) vendored Cordis (`@deepseek-ai/cordis`, `cordis-plugin-*`) | pinned source | MIT | Microkernel, include/group/hmr/timer/logger |
| [ink](https://www.npmjs.com/package/ink) | 4.x | MIT | Terminal UI rendering |
| [react](https://www.npmjs.com/package/react) | 18.x | MIT | Ink component model |
| [commander](https://www.npmjs.com/package/commander) | 15.x | MIT | TUI command-line parsing |
| [esbuild](https://www.npmjs.com/package/esbuild) | 0.25.x | MIT | Compiling `dsh-tui-app` source to `lib/` |
| [Bun](https://bun.sh) | 1.x | MIT | Single-file compilation (`bun build --compile`) |
| [js-yaml](https://www.npmjs.com/package/js-yaml) | 4.x | MIT | (dev) YAML parsing in the build |

## Classic colorschemes

The 10 classic colorschemes bundled in `packages/dsh-tui-app/src/classic-schemes.ts` are color
palettes imported from the following upstream projects (9 resolved from the theme files bundled
with [opencode](https://github.com/sst/opencode) — an MIT repo — at
`packages/tui/src/theme/assets/*.json`; 1 (`jellybeans`) mapped from an MIT vim colorscheme).
dsh-tui bundles only **resolved hex values** plus its own 17-role mapping — no upstream source
code is copied. The set is deliberately **MIT-only / permissive** so it is safe to bundle and
redistribute; each upstream license was verified against its repo LICENSE file before inclusion.
The rows below list the verified licenses.

| Colorscheme | Upstream | License | Source |
|---|---|---|---|
| catppuccin | [Catppuccin](https://github.com/catppuccin/catppuccin) | MIT | opencode assets/`catppuccin.json` |
| dracula | [Dracula Theme](https://github.com/dracula/dracula-theme) | MIT | opencode assets/`dracula.json` |
| gruvbox | [morhetz/gruvbox](https://github.com/morhetz/gruvbox) | MIT | opencode assets/`gruvbox.json` |
| monokai | Wimer Hazenberg (Monokai) | values bundled via opencode's MIT repo; upstream terms vary by port | opencode assets/`monokai.json` |
| nord | [arcticicestudio/nord](https://github.com/arcticicestudio/nord) | MIT | opencode assets/`nord.json` |
| solarized | [Ethan Schoonover / Solarized](https://github.com/altercation/solarized) | MIT | opencode assets/`solarized.json` |
| everforest | [sainnhe/everforest](https://github.com/sainnhe/everforest) | MIT | opencode assets/`everforest.json` |
| kanagawa | [rebelot/kanagawa.nvim](https://github.com/rebelot/kanagawa.nvim) | MIT | opencode assets/`kanagawa.json` |
| rosepine | [Rosé Pine](https://github.com/rose-pine/rose-pine-theme) | MIT | opencode assets/`rosepine.json` |
| jellybeans | [nanotech/jellybeans.vim](https://github.com/nanotech/jellybeans.vim) | MIT | vim colorscheme (semantic 17-key mapping) |

Transitive third-party dependencies of the above (e.g. `yoga-wasm-web`, `react-reconciler`,
`ansi-escapes`, `cli-cursor`, the DeepSeek Harness plugin dependencies such as `commander`,
`picomatch`, `chokidar`, OpenTelemetry, and optional native packages) are distributed under their
own licenses which their package manifests declare. Native and optional modules (`sharp`,
`node-pty`, `node-addon-landlock-run`) are stubbed out in the single-file build and are not
activated by this TUI.
