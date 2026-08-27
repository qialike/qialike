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

Transitive third-party dependencies of the above (e.g. `yoga-wasm-web`, `react-reconciler`,
`ansi-escapes`, `cli-cursor`, the DeepSeek Harness plugin dependencies such as `commander`,
`picomatch`, `chokidar`, OpenTelemetry, and optional native packages) are distributed under their
own licenses which their package manifests declare. Native and optional modules (`sharp`,
`node-pty`, `node-addon-landlock-run`) are stubbed out in the single-file build and are not
activated by this TUI.
