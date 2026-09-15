/**
 * Unit-suite preload (see `bunfig.toml`): pin the terminal colour depth to
 * 24-bit so tests assert the AUTHORED palette, not a 256-colour quantization of
 * it. Without this the suite's result would depend on the developer's `TERM` /
 * `COLORTERM` (`packages/dsh-tui-app/src/color-depth.ts` reads them).
 *
 * The quantization itself is tested directly (`tests/color-depth.test.ts`) by
 * calling `quantizePalette(palette, 2)` and `colorLevel({...})` with explicit
 * values, so pinning here costs no coverage.
 *
 * @module dsh-tui/tests-preload
 */

process.env.DSH_TUI_COLOR = '24bit'
