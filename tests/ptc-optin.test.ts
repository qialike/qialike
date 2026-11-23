/**
 * `DSH_TOOLS_MODE` is the EXECUTOR ROWS, and must never write `tools.config.mode`.
 *
 * WHY THIS IS A TEST. The variable has been wired three different ways across three
 * harness lines, and two of those wirings are now actively wrong:
 *
 *   * 0.2.1-rc.*: `dsh-tools` owned the presentation (`tools.config.mode`,
 *     `z.union(['native','ptc'])`) and the transport lived inside it. The executor
 *     rows this file flips did not exist in the base patch at all, so the flip alone
 *     was inert — `mode` was the half that did the work.
 *   * 0.2.2: the executors were SPLIT OUT into rows the base mounts (PTC disabled),
 *     and `mode` became `z.never()` ("Removed. Mount a native or PTC tool executor
 *     instead"). The PTC executor registers `run_code` and the "only run_code is
 *     callable" prompt section itself, so mounting it IS the presentation, and
 *     writing `mode` takes the whole tools row down at boot with
 *     `invalid config: $.mode expected nullable but got ptc`.
 *
 * That regression is what 0.12.0 hit and 0.13.0 re-introduced in the other direction,
 * so the shape is pinned rather than described: the two `disabled` expressions must be
 * complementary (or a run mounts zero or both executors), and the `tools` row must not
 * appear in this patch at all (or boot breaks).
 *
 * Run with `bun test tests/ptc-optin.test.ts`.
 *
 * @module qialike/ptc-optin-test
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..')
const PATCH = readFileSync(join(REPO, 'packages', 'qialike-app', 'cordis.patch.yml'), 'utf8')

/**
 * The block belonging to one `- id: <id>` row: from that line up to the next
 * top-level entry. Every top-level entry starts with `- ` in column 0 (`- id:` for
 * an override row, `- insert:` for a group), so that is the terminator — a slice
 * keyed on the next `- id:` alone would run past the end of the last row and drag
 * the following `insert:` groups into the assertions.
 */
function row(id: string): string {
  const lines = PATCH.split('\n')
  const start = lines.findIndex(line => line === `- id: ${id}`)
  expect(start, `the composition must carry a row named ${id}`).toBeGreaterThan(-1)
  // Stop at the next TOP-LEVEL entry: a row (`- `) or a section banner (`#`).
  // Terminating on `- ` alone drags the following comment block into the slice,
  // whose prose names the very providers and plugin ids these assertions look for.
  let end = start + 1
  while (end < lines.length && !lines[end]!.startsWith('- ') && !lines[end]!.startsWith('#')) end += 1
  return lines.slice(start, end).join('\n')
}

describe('the Code Mode opt-in is the executor rows, and only them', () => {
  test('the tools row is NOT patched — `mode` is z.never() on this harness line', () => {
    // A `- id: tools` row here would write `config`, and `mode` is the field that
    // killed the tools row at boot. No `config` key is legal on this row at all.
    expect(PATCH, 'patching the tools row breaks boot on 0.2.2')
      .not.toMatch(/^- id: tools\b/m)
  })

  test('both executor rows name a `disabled` predicate, not a `name`', () => {
    // A patch row that names `name` would REPLACE the base row's plugin; only
    // `disabled` should be overridden here.
    for (const id of ['tool-executor-native', 'tool-executor-ptc']) {
      const block = row(id)
      expect(block, `${id} must set disabled`).toContain('disabled:')
      expect(block, `${id} must not re-declare the plugin`).not.toContain('name:')
    }
  })

  test('exactly one executor is mounted per run, from the same variable', () => {
    const native = row('tool-executor-native')
    const ptc = row('tool-executor-ptc')
    expect(native).toContain('DSH_TOOLS_MODE')
    expect(ptc).toContain('DSH_TOOLS_MODE')
    // Complementary predicates: `==='ptc'` disables native, `!=='ptc'` disables PTC.
    expect(native).toContain("=== 'ptc'")
    expect(ptc).toContain("!== 'ptc'")
  })

  test('`both` — removed from the enum upstream — is never selected', () => {
    expect(row('tool-executor-native')).not.toContain("'both'")
    expect(row('tool-executor-ptc')).not.toContain("'both'")
  })
})
