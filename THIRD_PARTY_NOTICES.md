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

The 13 classic colorschemes bundled in `packages/dsh-tui-app/src/classic-schemes.ts` are color
palettes from MIT upstream projects; dsh-tui bundles only **resolved hex values** plus its own
17-role mapping — no upstream source code is copied. 11 of them (catppuccin, dracula,
everforest, falcon, flexoki, gruvbox, kanagawa, nord, panda, rosepine, solarized) are the
upstream projects' own palettes, referenced directly from their official repos. The
catppuccin/dracula/everforest/gruvbox/kanagawa/nord/rosepine/solarized values were additionally
verified against the theme files bundled with [opencode](https://github.com/sst/opencode) — an
MIT repo — at `packages/tui/src/theme/assets/<name>.json` and are byte-identical to the
upstream palettes. `monokai` has no single official repository, so its values are taken via
opencode's MIT theme assets (upstream terms vary by port); `jellybeans` is mapped from the MIT
vim colorscheme by nanoTech. `panda` tracks the original Atom colorscheme by Siamak Mokhtari
(`siamak/atom-panda-syntax`, MIT © 2016): the popular VSCode ports (`PandaTheme/panda-syntax-
vscode`, `tinkertrain/panda-syntax-vscode`) ship no LICENSE file and no package.json `license`
field, so — per this repo's MIT-only policy — they are **not** used as a source.
The set is deliberately **MIT-only / permissive** so it is safe to bundle and redistribute; each
upstream license was verified against its repo LICENSE file before inclusion.
The rows below list the verified licenses.

| Colorscheme | Upstream | License | Source |
|---|---|---|---|
| catppuccin | [Catppuccin](https://github.com/catppuccin/catppuccin) | MIT | catppuccin/catppuccin |
| dracula | [Dracula Theme](https://github.com/dracula/dracula-theme) | MIT | dracula/dracula-theme |
| gruvbox | [morhetz/gruvbox](https://github.com/morhetz/gruvbox) | MIT | morhetz/gruvbox |
| monokai | Wimer Hazenberg (Monokai) | values bundled via opencode's MIT repo; upstream terms vary by port | opencode assets/`monokai.json` |
| nord | [arcticicestudio/nord](https://github.com/arcticicestudio/nord) | MIT | arcticicestudio/nord |
| solarized | [Ethan Schoonover / Solarized](https://github.com/altercation/solarized) | MIT | altercation/solarized |
| everforest | [sainnhe/everforest](https://github.com/sainnhe/everforest) | MIT | sainnhe/everforest |
| falcon | [fenetikm/falcon](https://github.com/fenetikm/falcon) | MIT (Copyright (c) 2018 fenetikm) | `colors/falcon.vim` + `alacritty/alacritty.toml` (dark side) |
| flexoki | [kepano/flexoki](https://github.com/kepano/flexoki) | MIT (Copyright (c) 2023 Steph Ango) | `css/flexoki.css` + `helix/flexoki-dark.toml` (dark side) |
| kanagawa | [rebelot/kanagawa.nvim](https://github.com/rebelot/kanagawa.nvim) | MIT | rebelot/kanagawa.nvim |
| panda | [siamak/atom-panda-syntax](https://github.com/siamak/atom-panda-syntax) | MIT (Copyright (c) 2016 Siamak Mokhtari) | Atom original `styles/colors.less` + `syntax-variables.less` (VSCode ports license-unclean, not used) |
| rosepine | [Rosé Pine](https://github.com/rose-pine/rose-pine-theme) | MIT | rose-pine/rose-pine-theme |
| jellybeans | [nanotech/jellybeans.vim](https://github.com/nanotech/jellybeans.vim) | MIT | vim colorscheme (semantic 17-key mapping) |

## Default colorscheme (`dark` / `light`) and Atom skins (`one-dark` / `one-light`)

The built-in default schemes `dark` (`packages/dsh-tui-app/src/theme.ts`) and `light`
(`theme-plugin.ts`) are **opencode's own default theme**: dsh-tui bundles only **resolved hex
values** plus its own 17-role mapping — no upstream source code is copied. Values map 1:1 from
the `dark*`/`light*` defs of opencode's theme file (repo [sst/opencode](https://github.com/sst/opencode),
MIT — `packages/tui/src/theme/assets/opencode.json`). The `light` semantic text colors are
deepened one step *within the official hue family* so they hold WCAG AA (≥4.5:1) on the white
background (documented in theme-plugin.ts): primary #3b7dd8→#3473c6, accent/warning
#d68c27→#a96410, success #3d9a57→#2f7d45, info #318795→#2b7884, yellow #b0851f→#8f6c13, muted
#8a8a8a→#707070.

The optional skins `one-dark`/`one-light` are the classic **Atom One Dark / One Light**
palettes: hues come from Atom's official repos by GitHub Inc. (both archived, which does not
affect their MIT grant), structure steps cross-checked against
[navarasu/onedark.nvim](https://github.com/navarasu/onedark.nvim) (MIT); hexes are kept verbatim
(optional skins are not held to the AA bar the two defaults are).

| Default scheme | Upstream | License | Source |
|---|---|---|---|
| dark | [sst/opencode](https://github.com/sst/opencode) — opencode's default theme | MIT | `packages/tui/src/theme/assets/opencode.json` (`dark*` defs) |
| light | [sst/opencode](https://github.com/sst/opencode) — opencode's default theme | MIT | `opencode.json` (`light*` defs), semantic text AA-deepened (see above) |
| one-dark | GitHub Inc. (Atom) — [atom/one-dark-syntax](https://github.com/atom/one-dark-syntax) + [atom/one-dark-ui](https://github.com/atom/one-dark-ui) | MIT (Copyright (c) 2016 GitHub Inc.) | official repos (hex from their LESS hsl definitions); structure steps cross-checked with navarasu/onedark.nvim (MIT) |
| one-light | GitHub Inc. (Atom) — [atom/one-light-syntax](https://github.com/atom/one-light-syntax) + [atom/one-light-ui](https://github.com/atom/one-light-ui) | MIT (Copyright (c) 2016 GitHub Inc.) | official repos (hex from their LESS hsl definitions); structure steps cross-checked with navarasu/onedark.nvim (MIT) |

## DeepSeek Harness web skins (`dsh-dark` / `dsh-light`)

The optional skins `dsh-dark`/`dsh-light` mirror the web UI of the sibling MIT project
[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (Copyright (c) 2026 DeepSeek):
its design tokens in `packages/client/ui-theme/src/styles/design-platform.css`. dsh-tui bundles
only **resolved hex values** plus its own 17-role mapping — no CSS source is copied. `dsh-dark`
resolves the `body[data-ds-dark-theme]` alias block, `dsh-light` the light alias defaults; every
hex comes from one of its static ramps (background layers `neutral-bluish 950/900/850` and
`50/100`, text `neutral-bluish 50`/`1000`, muted `neutral-bluish 600`, brand `deepseek
400/450/500/600`, semantic `green-500`/`amber-400/600`/`blue-400/600/800`/`red-400/600`);
border hexes are the alias white/black alpha ramps composited over each scheme background.
Optional skins are not held to the AA bar the two defaults are.

| Default scheme | Upstream | License | Source |
|---|---|---|---|
| dsh-dark | [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) web design tokens | MIT (Copyright (c) 2026 DeepSeek) | `packages/client/ui-theme/src/styles/design-platform.css` (`body[data-ds-dark-theme]` alias block) |
| dsh-light | [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) web design tokens | MIT (Copyright (c) 2026 DeepSeek) | `design-platform.css` (light alias defaults) |

## Permissive third-party licenses

Most of the harness and Cordis dependencies this project bundles are MIT. A small number are under
other **permissive** licenses (Apache-2.0 / BSD-3-Clause / ISC). These are all redistributable as
long as their copyright notice and license text are preserved, so they are safe to bundle — but they
are listed here explicitly so the license of every bundled module is auditable.

All the packages below are bundled into the single-file executable via the DeepSeek Harness plugins
the TUI composition activates. Each carries its own upstream `LICENSE`/copyright notice; the
Apache-2.0 / BSD-3-Clause / ISC full texts are reproduced in the upstream packages and in the
`deepseek-harness` checkout, not inlined here.

| Package (as bundled) | Version | License | Bundled via | Purpose |
|---|---|---|---|---|
| [@opentelemetry/api](https://github.com/open-telemetry/opentelemetry-js) | 1.9.1 | Apache-2.0 | `@deepseek-ai/dsh-session-telemetry-otel` | OTLP log telemetry API |
| [@opentelemetry/api-logs](https://github.com/open-telemetry/opentelemetry-js) | 0.220.0 | Apache-2.0 | `@deepseek-ai/dsh-session-telemetry-otel` | OpenTelemetry logs bridge |
| [@opentelemetry/core](https://github.com/open-telemetry/opentelemetry-js) | 2.9.0 | Apache-2.0 | `@deepseek-ai/dsh-session-telemetry-otel` | OpenTelemetry core internals |
| [@opentelemetry/exporter-logs-otlp-http](https://github.com/open-telemetry/opentelemetry-js) | 0.220.0 | Apache-2.0 | `@deepseek-ai/dsh-session-telemetry-otel` | OTLP/HTTP log exporter |
| [@opentelemetry/otlp-exporter-base](https://github.com/open-telemetry/opentelemetry-js) | 0.220.0 | Apache-2.0 | `@deepseek-ai/dsh-session-telemetry-otel` | OTLP transport base |
| [@opentelemetry/resources](https://github.com/open-telemetry/opentelemetry-js) | 2.10.0 | Apache-2.0 | `@deepseek-ai/dsh-session-telemetry-otel` | OpenTelemetry resource attributes |
| [@opentelemetry/sdk-logs](https://github.com/open-telemetry/opentelemetry-js) | 0.220.0 | Apache-2.0 | `@deepseek-ai/dsh-session-telemetry-otel` | Logs SDK |
| [@opentelemetry/otlp-transformer](https://github.com/open-telemetry/opentelemetry-js) | 0.220.0 | Apache-2.0 | `@deepseek-ai/dsh-session-telemetry-otel` | OTLP payload transformer |
| [diff](https://github.com/kpdecker/jsdiff) | 9.0.0 | BSD-3-Clause | `@deepseek-ai/dsh-tool-fs` | `structuredPatch` hunk splitting for the editor |
| [yaml](https://github.com/eemeli/yaml) | 2.9.0 | ISC | `@deepseek-ai/dsh-credentials-local`, `@deepseek-ai/dsh-settings-file`, `@deepseek-ai/dsh-skill-filesystem` | comment-preserving YAML config round-trip |

**Native and optional modules** (`sharp` 0.35.3 — Apache-2.0, `node-pty`, `node-addon-landlock-run`,
`react-devtools-core`) are stubbed out in the single-file build and are not activated by this TUI.
`koffi` (MIT) is replaced with a `bun:ffi` shim. They therefore carry their own upstream licenses
but are not part of the shipped binary's runtime.

Other transitive third-party dependencies of the above (e.g. `yoga-wasm-web`, `react-reconciler`,
`ansi-escapes`, `cli-cursor`, and the DeepSeek Harness plugin dependencies such as `commander`,
`picomatch`, `chokidar`) are distributed under their own licenses, which their package manifests
declare — the vast majority are MIT or another permissive license. No copyleft (GPL / AGPL / LGPL /
MPL) or source-available network-restrictive license was found in the bundled tree.
