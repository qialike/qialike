/**
 * Source guards for the USER overlay — `$DSH_HOME/profiles/tui/cordis.patch.yml`.
 *
 * This is the one layer qialike does not own, and the extension point of the
 * single-file build: an `insert` row can mount any BUNDLED plugin (the MCP
 * client is bundled rowless for exactly that — one file cannot resolve a name it
 * never bundled). The loader is SILENT about both ways a hand-written layer goes
 * wrong, so the wiring guarded here is what turns them into messages:
 *   ① the user layer is read as an optional overlay and applied LAST;
 *   ② it is validated against the built-in row ids and the bundled plugin map;
 *   ③ `--dump-config` reports it — before any terminal state is touched.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const BIN = readFileSync(new URL('../apps/tui-bin/src/bin.ts', import.meta.url), 'utf-8')
const STARTUP = readFileSync(new URL('../packages/qialike-app/src/startup.ts', import.meta.url), 'utf-8')
const BUILD = readFileSync(new URL('../apps/tui-bin/build.mjs', import.meta.url), 'utf-8')

const body = (source: string, marker: string): string =>
  source.slice(source.indexOf(marker), source.indexOf('\n}\n', source.indexOf(marker)))

describe('user overlay', () => {
  test('① it is optional, read from the profile dir, and applied LAST', () => {
    const path = body(BIN, 'function userPatchPath(')
    expect(path, 'lives next to the built-in layers').toContain("join(profileDir(), 'cordis.patch.yml')")
    expect(BIN, 'read as an OPTIONAL overlay').toContain('loadOptionalPatches(NAME, userFile) ?? []')
    // Order is the contract: a user row may re-target any built-in row.
    expect(BIN, 'applied after both embedded layers').toContain('...structuredClone(base), ...structuredClone(tui),')
  })

  test('② a wrong layer fails loud instead of no-opping', () => {
    const validate = body(BIN, 'function validateUserLayer(')
    expect(validate, 'unbundled names are rejected against the bundle map').toContain('!isBundledPlugin(row.name)')
    expect(validate, 'cordis: builtins stay allowed').toContain("startsWith('cordis:')")
    expect(validate, 'rows without insert must match a built-in id').toContain('known.has(row.id)')
    // The file is a PARAMETER (the same validator guards the project overlay)
    // — the message must interpolate it, not hardcode the personal path.
    expect(validate, 'the message names the file it rejected').toContain('invalid overlay ${file}')
    // And it actually runs (only when there IS a user layer).
    expect(BIN, 'validation is wired into the boot path').toContain('if (user.length > 0) validateUserLayer(user, known, userFile)')
  })

  test('③ --dump-config is a declared flag, handled before the terminal is touched', () => {
    expect(STARTUP, 'declared so commander accepts it').toContain("'--dump-config'")
    const dump = BIN.indexOf("if (args.includes('--dump-config'))")
    const alt = BIN.indexOf("process.stdout.write('\\x1b[?1049h')")
    expect(dump, 'handled').toBeGreaterThan(-1)
    expect(alt, 'the alternate screen is entered').toBeGreaterThan(-1)
    expect(dump, 'handled BEFORE the alternate screen (piped output stays clean)').toBeLessThan(alt)
  })

  test('④ the MCP client ships bundled (rowless) so a user row can name it', () => {
    const specs = body(BUILD, 'function pluginSpecifiers(')
    expect(specs, 'the MCP client is in the specifier list').toContain("'@deepseek-ai/dsh-mcp-client'")
  })
})
