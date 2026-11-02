/**
 * `DSH_TOOLS_MODE` needs BOTH halves of the composition, on this harness line.
 *
 * WHY THIS IS A TEST. The variable is a temporary process-wide switch with two
 * independent consumers in the harness:
 *
 *   * `tools.config.mode` — what the model SEES. A `ptc` mode is what offers the
 *     reserved `run_code` transport and collapses the catalog behind it
 *     (`packages/core/tools/src/index.ts`: `this.defaultMode = config.mode`,
 *     then `if (this.defaultMode !== 'native')` registers the collapse and SDK
 *     prompt sections, and `requirePtcTransport` only surfaces `run_code` for
 *     scopes whose mode presents it).
 *   * the executor rows — what RUNS the program. The base bundle mounts both
 *     executors with PTC disabled, so a row must be flipped for the PTC one to
 *     exist at all.
 *
 * Set only the rows and a `ptc` run presents a native catalog: `run_code` is
 * never offered, so the PTC executor is never reached and the opt-in is inert
 * while still looking wired. Set only `mode` and the model is told only
 * `run_code` may be called, while no PTC executor is registered. Either half
 * alone is a silent regression — the kind this file exists to catch.
 *
 * 0.12.0 removed the `mode` write because the checkout it was adapted against
 * (harness `master`, whose `package.json` still read `0.2.1-rc.3`) had made the
 * field `z.never()`. Every released `0.2.1-rc.*` TAG still declares
 * `mode: z.union(['native', 'ptc'])`, which is what this tree ships against, so
 * the field is written again (0.13.0).
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

/** The block belonging to one `- id: <id>` row, up to the next top-level row. */
function row(id: string): string {
  const start = PATCH.indexOf(`- id: ${id}\n`)
  expect(start, `the composition must carry a row named ${id}`).toBeGreaterThan(-1)
  const rest = PATCH.slice(start + 1)
  const next = rest.indexOf('\n- id: ')
  return next === -1 ? rest : rest.slice(0, next)
}

describe('the Code Mode opt-in is wired on both halves', () => {
  test('the model-facing mode is written, and derives from the same variable', () => {
    const tools = row('tools')
    expect(tools, 'the tools row must set `mode`; without it `ptc` presents a native catalog').toContain('mode:')
    expect(tools).toContain('DSH_TOOLS_MODE')
  })

  test('the mode can only be `ptc` or `native` — `both` was removed upstream', () => {
    const tools = row('tools')
    expect(tools).toContain("'ptc'")
    expect(tools).toContain("'native'")
    // `both` may only appear in prose, never as a selected value.
    expect(tools).not.toMatch(/!==\s*'ptc'\s*\?\s*'both'/)
    expect(tools).not.toContain("? 'both'")
  })

  test('exactly one executor row is enabled per run, and by the same variable', () => {
    const native = row('tool-executor-native')
    const ptc = row('tool-executor-ptc')
    expect(native).toContain('DSH_TOOLS_MODE')
    expect(ptc).toContain('DSH_TOOLS_MODE')
    // The two `disabled` expressions must be complementary: `==='ptc'` for the
    // native row and `!=='ptc'` for the PTC one, or a run mounts zero or both.
    expect(native).toContain("=== 'ptc'")
    expect(ptc).toContain("!== 'ptc'")
  })
})
