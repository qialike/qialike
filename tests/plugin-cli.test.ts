/**
 * Source guards for `qialike plugin …` and the PROJECT overlay.
 *
 * Step 4 of the composition follow-up (research/ai-agent-code-loading-survey.md
 * §7.8) productizes the overlay: `plugin list` for discovery, `add-mcp` /
 * `remove-mcp` for the one row shape a hand-written file gets wrong most often,
 * and a per-repository scope (`<projectRoot>/.dsh/tui.cordis.patch.yml`) applied
 * after the personal one.
 *
 * Two runtime bugs found while building it are pinned here, because both were
 * invisible in the happy path: appending a row to a file that parses to ZERO
 * rows emitted a SECOND YAML document (`[]` then `- insert:`), and deleting a
 * block's last row left the `- insert:` header dangling.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const BIN = readFileSync(new URL('../apps/tui-bin/src/bin.ts', import.meta.url), 'utf-8')
const MODES = readFileSync(new URL('../apps/tui-bin/src/launcher-modes.ts', import.meta.url), 'utf-8')

const body = (source: string, marker: string): string =>
  source.slice(source.indexOf(marker), source.indexOf('\n}\n', source.indexOf(marker)))

describe('plugin CLI', () => {
  test('① it is a launcher mode, dispatched before the terminal is touched', () => {
    expect(MODES, 'the mode exists').toContain("export const PLUGIN_MODE = 'plugin'")
    expect(MODES, 'and is registered in the single source of truth').toContain('LAUNCHER_MODES = [UNINSTALL_MODE, WEB_MODE, PLUGIN_MODE]')
    const dispatch = BIN.indexOf('runPlugin(args)')
    const alt = BIN.indexOf("process.stdout.write('\\x1b[?1049h')")
    expect(dispatch, 'dispatched').toBeGreaterThan(-1)
    expect(dispatch, 'before the alternate screen').toBeLessThan(alt)
    const help = body(BIN, 'const PLUGIN_HELP')
    for (const cmd of ['list', 'add-mcp', 'remove-mcp']) {
      expect(help, `\`${cmd}\` is documented`).toContain(cmd)
    }
  })

  test('② the project overlay mirrors the skill provider and is applied LAST', () => {
    const walk = body(BIN, 'function projectPatchPath(')
    expect(walk, 'walks up to the first .git').toContain("join(current, '.git')")
    expect(walk, 'stays at cwd when there is no marker').toContain('return join(cwd')
    expect(walk, 'uses a distinct filename').toContain("'.dsh', 'tui.cordis.patch.yml'")
    // Project outranks personal: it is the last layer in the list.
    expect(BIN, 'applied after the user overlay').toContain('...structuredClone(user), ...structuredClone(project)]')
    // Validated like the personal overlay AND policed: a repository may not
    // change safety rows, and its process-running rows need the overlay ledger.
    expect(BIN, 'validated like it').toContain('if (project.length > 0) {')
    expect(BIN).toContain('validateUserLayer(project, known, projectFile)')
    expect(BIN).toContain('assertProjectOverlaySafe(projectFile, projectPolicy)')
    expect(BIN).toContain('assertProjectOverlayTrusted(projectFile, projectPolicy)')
  })

  test('②b `trust-overlay` refuses a MIXED layer instead of reporting success', () => {
    // Measured before the fix: a layer with a safety row AND an execution row made
    // the command print "this layer will be REJECTED at boot", write the trust
    // ledger and exit 0 — while the boot with that ledger exited 1. A script doing
    // `trust-overlay && qialike` saw success and then a refused launch, and the
    // record was worthless anyway (removing the safety row changes the file hash).
    const from = BIN.indexOf("if (command === 'trust-overlay'")
    // Slice to the END of the command block (the next command's dispatch), so the
    // guard cannot be satisfied by an unrelated later `return 1`.
    const trust = BIN.slice(from, BIN.indexOf('unknown plugin command', from))
    const safetyReturn = trust.indexOf('return 1')
    const ledgerWrite = trust.indexOf('ledger[overlayKey(file)] =')
    expect(safetyReturn, 'the safety branch returns non-zero').toBeGreaterThan(-1)
    expect(ledgerWrite, 'and there is still a ledger write for the clean case').toBeGreaterThan(-1)
    expect(safetyReturn, 'safety is decided BEFORE anything is recorded').toBeLessThan(ledgerWrite)
    // The refusal must not be guarded by "no execution rows either" any more: the
    // old shape was `if (execution.length === 0) { … return safety.length > 0 ? 1 : 0 }`.
    expect(trust).not.toContain('return safety.length > 0 ? 1 : 0')
    expect(trust, 'and it says what was NOT recorded').toContain('not trusted:')
  })

  test('③ add-mcp writes atomically, validates before installing, and cleans up', () => {
    expect(BIN, 'refuses a duplicate server').toContain('definesMcpServer(overlay.patches, serverName)')
    expect(BIN, 'validates the server name').toContain('is not a valid server name')
    // A zero-row overlay (e.g. the `[]` left by remove-mcp) must NOT be appended
    // to: that emitted a SECOND YAML document and failed to parse.
    expect(BIN, 'treats a zero-row overlay as empty').toContain('overlay.patches.length === 0')
    // Install = write temp -> PARSE IT -> rename, and never leave the temp behind.
    // (`writeTrustLedger` also uses a `.tmp`, so anchor on the overlay writer's
    // own parse and look for the rename AFTER it.)
    const parsed = BIN.indexOf('loadOptionalPatches(NAME, temp)')
    expect(parsed, 'the overlay temp is parsed').toBeGreaterThan(-1)
    expect(BIN.slice(parsed), 'removes the temp on failure').toContain('rmSync(temp, { force: true })')
    expect(BIN.indexOf('renameSync(temp, file)', parsed), 'rename AFTER the parse').toBeGreaterThan(parsed)
  })

  test('④ remove-mcp is conservative: line surgery, no dangling insert, no guessing', () => {
    const remove = body(BIN, 'function removeMcpRowText(')
    expect(remove, 'refuses an ambiguous match').toContain('remove the rows by hand')
    expect(remove, 'drops an `insert:` header left without children').toContain('insert:')
    expect(remove, 'leaves a valid empty list').toContain("'[]\\n'")
    expect(remove, 'locates the row by serverName (hand-written files keep their formatting)').toContain('serverName')
  })

  test('⑤ an empty `insert` is rejected by the validator', () => {
    const validate = body(BIN, 'function validateUserLayer(')
    expect(validate, 'empty insert is a problem').toContain("'insert' in row && !Array.isArray(row.insert)")
    expect(validate, 'and it says why').toContain('it needs at least one child row')
  })
})
